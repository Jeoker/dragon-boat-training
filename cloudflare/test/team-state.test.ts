import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TeamState } from "../src/team-state";

function objectFor(name: string): DurableObjectStub {
  return env.TEAM_STATE.getByName(name);
}

async function commit(
  stub: DurableObjectStub,
  requestId: string,
  overrides: Record<string, unknown> = {}
): Promise<Response> {
  return stub.fetch("https://team.internal/internal/c0/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      actor_scope: "test_actor",
      action: "c0AtomicCommit",
      amount: 1,
      ...overrides
    })
  });
}

async function state(stub: DurableObjectStub): Promise<Record<string, any>> {
  const response = await stub.fetch("https://team.internal/internal/c0/state");
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: Record<string, any> }).data;
}

describe("TeamState C0 persistence", () => {
  it("commits concurrent duplicate requests exactly once", async () => {
    const stub = objectFor("concurrent-idempotency");
    const [left, right] = await Promise.all([
      commit(stub, "request_concurrent_001", { amount: 3 }),
      commit(stub, "request_concurrent_001", { amount: 3 })
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const leftBody = await left.json();
    const rightBody = await right.json();
    expect(leftBody).toEqual(rightBody);
    await expect(state(stub)).resolves.toMatchObject({
      schema_version: 1,
      counter_value: 3,
      request_count: 1,
      audit_count: 1
    });
  });

  it("rejects reuse of a request ID with different input", async () => {
    const stub = objectFor("idempotency-conflict");
    expect((await commit(stub, "request_conflict_001", { amount: 2 })).status).toBe(200);
    const conflict = await commit(stub, "request_conflict_001", { amount: 4 });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", retryable: false }
    });
    await expect(state(stub)).resolves.toMatchObject({ counter_value: 2, request_count: 1 });
  });

  it("rolls back all rows when the transaction fails", async () => {
    const stub = objectFor("transaction-rollback");
    const failed = await commit(stub, "request_rollback_001", { simulate_failure: true });
    expect(failed.status).toBe(500);
    await expect(state(stub)).resolves.toMatchObject({
      counter_value: 0,
      request_count: 0,
      audit_count: 0,
      outbox: [],
      jobs: []
    });
    expect((await commit(stub, "request_rollback_001")).status).toBe(200);
    await expect(state(stub)).resolves.toMatchObject({ counter_value: 1, request_count: 1 });
  });

  it("repairs a missing alarm from the persisted task table", async () => {
    const stub = objectFor("eviction-recovery");
    expect((await commit(stub, "request_eviction_001")).status).toBe(200);
    await runInDurableObject(stub, async (_instance: TeamState, durableState) => {
      const createdAt = new Date().toISOString();
      durableState.storage.sql.exec(
        `INSERT INTO scheduled_jobs(
           job_id, job_type, payload_json, status, due_at_ms, created_at, updated_at
         ) VALUES (?, 'C0_MOCK_SYNC', ?, 'PENDING', ?, ?, ?)`,
        "job_fault_injected",
        JSON.stringify({ outbox_id: "out_missing", fail_attempts: 0, retry_delay_ms: 1_000 }),
        Date.now() + 60_000,
        createdAt,
        createdAt
      ).toArray();
      expect(await durableState.storage.getAlarm()).toBeNull();
      await _instance.repairScheduledWork();
      expect(await durableState.storage.getAlarm()).not.toBeNull();
    });
    await expect(state(stub)).resolves.toMatchObject({
      counter_value: 1,
      request_count: 1,
      outbox: [],
      jobs: [{ status: "PENDING" }]
    });
  });

  it("keeps application retries running beyond the platform retry window", async () => {
    const stub = objectFor("alarm-retry");
    expect(
      (
        await commit(stub, "request_alarm_retry_001", {
          enqueue_job: true,
          job_due_at_ms: Date.now() + 60_000,
          fail_attempts: 7,
          retry_delay_ms: 60_000
        })
      ).status
    ).toBe(200);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await runInDurableObject(stub, async (_instance: TeamState, durableState) => {
        const now = Date.now();
        durableState.storage.sql.exec(
          "UPDATE scheduled_jobs SET due_at_ms = ? WHERE status = 'PENDING'",
          now - 1
        ).toArray();
        await durableState.storage.setAlarm(now + 60_000);
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    }
    await expect(state(stub)).resolves.toMatchObject({
      outbox: [{ status: "CONFIRMED", attempt_count: 8, last_error: "" }],
      jobs: [{ status: "COMPLETED", attempt_count: 8, last_error: "" }],
      alarm_at_ms: null
    });
  }, 45_000);
});
