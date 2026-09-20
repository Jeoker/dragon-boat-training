import { DurableObject } from "cloudflare:workers";
import { sha256Base64Url } from "./crypto";
import { ApiError, apiFailure, jsonResponse, readJsonObject, requireRequestId, requireString } from "./http";
import { APPLICATION_SCHEMA_VERSION, applySchema } from "./schema";

interface C0CommitInput {
  requestId: string;
  actorScope: string;
  action: string;
  amount: number;
  enqueueJob: boolean;
  jobDueAtMs: number;
  failAttempts: number;
  retryDelayMs: number;
  simulateFailure: boolean;
}

interface ClaimedJob {
  job_id: string;
  payload_json: string;
  attempt_count: number;
  lease_token: string;
}

interface JobPayload {
  outbox_id: string;
  fail_attempts: number;
  retry_delay_ms: number;
}

const JOB_BATCH_LIMIT = 8;
const JOB_LEASE_MS = 30_000;
const RECOVERY_ALARM_MS = 60_000;

export class TeamState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      applySchema(ctx.storage);
      await this.repairScheduledWork();
    });
  }

  async repairScheduledWork(): Promise<void> {
    await this.ensureNextAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/c0/commit") {
        return jsonResponse({ ok: true, data: await this.commit(await readJsonObject(request)) });
      }
      if (request.method === "GET" && url.pathname === "/internal/c0/state") {
        return jsonResponse({ ok: true, data: await this.readState() });
      }
      throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    } catch (error) {
      return apiFailure(error);
    }
  }

  async alarm(): Promise<void> {
    try {
      const jobs = this.claimDueJobs(Date.now(), JOB_BATCH_LIMIT);
      for (const job of jobs) await this.processClaimedJob(job);
    } catch (error) {
      console.error("C0 alarm batch failed", error instanceof Error ? error.message : "unknown error");
    } finally {
      await this.ensureNextAlarm();
    }
  }

  private parseCommit(input: Record<string, unknown>): C0CommitInput {
    const amount = Number(input.amount ?? 1);
    const due = Number(input.job_due_at_ms ?? 0);
    const failAttempts = Number(input.fail_attempts ?? 0);
    const retryDelay = Number(input.retry_delay_ms ?? 1_000);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100) {
      throw new ApiError("INVALID_REQUEST", "amount must be an integer from 1 to 100.");
    }
    if (!Number.isSafeInteger(due) || due < 0) {
      throw new ApiError("INVALID_REQUEST", "job_due_at_ms is invalid.");
    }
    if (!Number.isSafeInteger(failAttempts) || failAttempts < 0 || failAttempts > 100) {
      throw new ApiError("INVALID_REQUEST", "fail_attempts is invalid.");
    }
    if (!Number.isSafeInteger(retryDelay) || retryDelay < 0 || retryDelay > 3_600_000) {
      throw new ApiError("INVALID_REQUEST", "retry_delay_ms is invalid.");
    }
    return {
      requestId: requireRequestId(input),
      actorScope: requireString(input, "actor_scope", 1, 128),
      action: requireString(input, "action", 1, 80),
      amount,
      enqueueJob: input.enqueue_job === true,
      jobDueAtMs: due,
      failAttempts,
      retryDelayMs: retryDelay,
      simulateFailure: input.simulate_failure === true
    };
  }

  private async commit(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = this.parseCommit(raw);
    const payloadJson = JSON.stringify({
      amount: input.amount,
      enqueue_job: input.enqueueJob,
      job_due_at_ms: input.jobDueAtMs,
      fail_attempts: input.failAttempts,
      retry_delay_ms: input.retryDelayMs
    });
    const requestKey = `req_v2_${await sha256Base64Url(
      `${this.env.TEAM_ID}\n${input.actorScope}\n${input.action}\n${input.requestId}`
    )}`;
    const payloadDigest = `sha256_v1:${await sha256Base64Url(payloadJson)}`;

    if (input.enqueueJob) {
      const alarm = await this.ctx.storage.getAlarm();
      const recoveryAt = Date.now() + RECOVERY_ALARM_MS;
      if (alarm === null || alarm > recoveryAt) await this.ctx.storage.setAlarm(recoveryAt);
    }

    const committedAt = new Date().toISOString();
    const effectiveJobDueAt = input.jobDueAtMs === 0 ? Date.parse(committedAt) : input.jobDueAtMs;
    const result = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existing = sql
        .exec<{ payload_digest: string; result_json: string }>(
          "SELECT payload_digest, result_json FROM system_requests WHERE request_key = ?",
          requestKey
        )
        .toArray()[0];
      if (existing) {
        if (existing.payload_digest !== payloadDigest) {
          throw new ApiError(
            "IDEMPOTENCY_CONFLICT",
            "This request identifier was already used with different input.",
            409
          );
        }
        return JSON.parse(existing.result_json) as Record<string, unknown>;
      }

      const prior = sql
        .exec<{ value: number }>("SELECT value FROM c0_counters WHERE counter_name = 'atomic_commits'")
        .toArray()[0];
      const nextValue = Number(prior?.value ?? 0) + input.amount;
      const storedResult = {
        request_id: input.requestId,
        request_key: requestKey,
        counter_value: nextValue,
        committed_at: committedAt,
        replayed: false
      };
      sql.exec(
        `INSERT INTO c0_counters(counter_name, value) VALUES ('atomic_commits', ?)
         ON CONFLICT(counter_name) DO UPDATE SET value = excluded.value`,
        nextValue
      ).toArray();
      sql.exec(
        `INSERT INTO system_requests(
           request_key, actor_scope, action, request_id, payload_digest, status,
           result_json, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)`,
        requestKey,
        input.actorScope,
        input.action,
        input.requestId,
        payloadDigest,
        JSON.stringify(storedResult),
        committedAt,
        committedAt
      ).toArray();
      sql.exec(
        `INSERT INTO audit_events(event_id, request_key, actor_scope, action, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        `evt_${requestKey.slice(7)}`,
        requestKey,
        input.actorScope,
        input.action,
        JSON.stringify({ amount: input.amount, counter_value: nextValue }),
        committedAt
      ).toArray();

      if (input.enqueueJob) {
        const suffix = requestKey.slice(7);
        const outboxId = `out_${suffix}`;
        const jobId = `job_${suffix}`;
        sql.exec(
          `INSERT INTO sync_outbox(
             outbox_id, request_key, topic, payload_json, status, due_at_ms, created_at
           ) VALUES (?, ?, 'C0_MOCK_SYNC', ?, 'PENDING', ?, ?)`,
          outboxId,
          requestKey,
          payloadJson,
          effectiveJobDueAt,
          committedAt
        ).toArray();
        sql.exec(
          `INSERT INTO scheduled_jobs(
             job_id, job_type, payload_json, status, due_at_ms, created_at, updated_at
           ) VALUES (?, 'C0_MOCK_SYNC', ?, 'PENDING', ?, ?, ?)`,
          jobId,
          JSON.stringify({
            outbox_id: outboxId,
            fail_attempts: input.failAttempts,
            retry_delay_ms: input.retryDelayMs
          }),
          effectiveJobDueAt,
          committedAt,
          committedAt
        ).toArray();
      }

      if (input.simulateFailure) throw new Error("Simulated failure before transaction commit.");
      return storedResult;
    });

    if (input.enqueueJob) await this.ensureNextAlarm();
    return result;
  }

  private claimDueJobs(now: number, limit: number): ClaimedJob[] {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql
        .exec<{
          job_id: string;
          payload_json: string;
          attempt_count: number;
        }>(
          `SELECT job_id, payload_json, attempt_count
             FROM scheduled_jobs
            WHERE (status = 'PENDING' AND due_at_ms <= ?)
               OR (status = 'RUNNING' AND lease_until_ms <= ?)
            ORDER BY due_at_ms, job_id
            LIMIT ?`,
          now,
          now,
          limit
        )
        .toArray();
      return rows.map((row) => {
        const leaseToken = crypto.randomUUID();
        const nextAttempt = Number(row.attempt_count) + 1;
        this.ctx.storage.sql.exec(
          `UPDATE scheduled_jobs
              SET status = 'RUNNING', attempt_count = ?, lease_token = ?, lease_until_ms = ?,
                  updated_at = ?
            WHERE job_id = ?`,
          nextAttempt,
          leaseToken,
          now + JOB_LEASE_MS,
          new Date(now).toISOString(),
          row.job_id
        ).toArray();
        return {
          job_id: row.job_id,
          payload_json: row.payload_json,
          attempt_count: nextAttempt,
          lease_token: leaseToken
        };
      });
    });
  }

  private async processClaimedJob(job: ClaimedJob): Promise<void> {
    const payload = JSON.parse(job.payload_json) as JobPayload;
    try {
      await Promise.resolve();
      if (job.attempt_count <= payload.fail_attempts) {
        throw new Error("Simulated downstream failure.");
      }
      const completedAt = new Date().toISOString();
      this.ctx.storage.transactionSync(() => {
        const current = this.ctx.storage.sql
          .exec<{ lease_token: string; status: string }>(
            "SELECT lease_token, status FROM scheduled_jobs WHERE job_id = ?",
            job.job_id
          )
          .toArray()[0];
        if (!current || current.status !== "RUNNING" || current.lease_token !== job.lease_token) return;
        this.ctx.storage.sql.exec(
          `UPDATE scheduled_jobs
              SET status = 'COMPLETED', lease_token = NULL, lease_until_ms = NULL,
                  updated_at = ?, completed_at = ?, last_error = ''
            WHERE job_id = ?`,
          completedAt,
          completedAt,
          job.job_id
        ).toArray();
        this.ctx.storage.sql.exec(
          `UPDATE sync_outbox
              SET status = 'CONFIRMED', attempt_count = ?, completed_at = ?, last_error = ''
            WHERE outbox_id = ?`,
          job.attempt_count,
          completedAt,
          payload.outbox_id
        ).toArray();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown downstream failure.";
      const retryAt = Date.now() + payload.retry_delay_ms;
      this.ctx.storage.transactionSync(() => {
        const current = this.ctx.storage.sql
          .exec<{ lease_token: string; status: string }>(
            "SELECT lease_token, status FROM scheduled_jobs WHERE job_id = ?",
            job.job_id
          )
          .toArray()[0];
        if (!current || current.status !== "RUNNING" || current.lease_token !== job.lease_token) return;
        this.ctx.storage.sql.exec(
          `UPDATE scheduled_jobs
              SET status = 'PENDING', due_at_ms = ?, lease_token = NULL, lease_until_ms = NULL,
                  updated_at = ?, last_error = ?
            WHERE job_id = ?`,
          retryAt,
          new Date().toISOString(),
          message,
          job.job_id
        ).toArray();
        this.ctx.storage.sql.exec(
          `UPDATE sync_outbox
              SET attempt_count = ?, last_error = ?
            WHERE outbox_id = ?`,
          job.attempt_count,
          message,
          payload.outbox_id
        ).toArray();
      });
    }
  }

  private nextJobDueAt(): number | null {
    const row = this.ctx.storage.sql
      .exec<{ next_due_at: number | null }>(
        `SELECT MIN(
           CASE WHEN status = 'RUNNING' THEN lease_until_ms ELSE due_at_ms END
         ) AS next_due_at
         FROM scheduled_jobs
         WHERE status IN ('PENDING', 'RUNNING')`
      )
      .toArray()[0];
    return row?.next_due_at === null || row?.next_due_at === undefined
      ? null
      : Number(row.next_due_at);
  }

  private async ensureNextAlarm(): Promise<void> {
    const nextDueAt = this.nextJobDueAt();
    const current = await this.ctx.storage.getAlarm();
    if (nextDueAt === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current === null || current !== nextDueAt) await this.ctx.storage.setAlarm(nextDueAt);
  }

  private async readState(): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const counter = sql
      .exec<{ value: number }>("SELECT value FROM c0_counters WHERE counter_name = 'atomic_commits'")
      .toArray()[0];
    return {
      schema_version: APPLICATION_SCHEMA_VERSION,
      counter_value: Number(counter?.value ?? 0),
      request_count: Number(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM system_requests").one().count),
      audit_count: Number(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM audit_events").one().count),
      outbox: sql
        .exec("SELECT outbox_id, status, attempt_count, last_error FROM sync_outbox ORDER BY outbox_id")
        .toArray(),
      jobs: sql
        .exec(
          `SELECT job_id, status, attempt_count, due_at_ms, lease_token, last_error
             FROM scheduled_jobs ORDER BY job_id`
        )
        .toArray(),
      alarm_at_ms: await this.ctx.storage.getAlarm(),
      database_size_bytes: sql.databaseSize
    };
  }
}
