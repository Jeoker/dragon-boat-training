import { DurableObject } from "cloudflare:workers";
import { sha256Base64Url } from "./crypto";
import { ApiError, apiFailure, apiSuccess, optionalBoolean, optionalInteger, readJsonObject, requireRequestId, requireString } from "./http";
import { APPLICATION_SCHEMA_VERSION, applySchema } from "./schema";
import {
  C1_ACTIONS, C1_CONTRACT_VERSION, C1_SCHEDULE_ACTIONS, C1_SEATING_ACTIONS, C1_SIGNUP_ACTIONS
} from "../../shared/c1-actions";
import { C1Service } from "./c1-service";
import { C1ScheduleService } from "./c1-schedule-service";
import { C1SeatingService } from "./c1-seating-service";
import { C1SignupService } from "./c1-signup-service";

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
  job_type: string;
  payload_json: string;
  attempt_count: number;
  lease_token: string;
}

interface C0MockSyncJobPayload {
  outbox_id: string;
  fail_attempts: number;
  retry_delay_ms: number;
}

function parseJobJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Scheduled job payload is not valid JSON.");
  }
}

function parseC0MockSyncJob(value: unknown): C0MockSyncJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid C0_MOCK_SYNC payload.");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.outbox_id !== "string" || !row.outbox_id ||
      typeof row.fail_attempts !== "number" || !Number.isSafeInteger(row.fail_attempts) || row.fail_attempts < 0 ||
      typeof row.retry_delay_ms !== "number" || !Number.isSafeInteger(row.retry_delay_ms) ||
      row.retry_delay_ms < 1_000 || row.retry_delay_ms > 3_600_000) {
    throw new Error("Invalid C0_MOCK_SYNC payload.");
  }
  return row as unknown as C0MockSyncJobPayload;
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
    let requestId: string | null = null;
    const isC1 = url.pathname.startsWith("/internal/c1/");
    try {
      if (request.method === "POST" && url.pathname === "/internal/c0/commit") {
        const input = await readJsonObject(request);
        requestId = requireRequestId(input);
        return apiSuccess(await this.commit(input), this.env, requestId);
      }
      if (request.method === "GET" && url.pathname === "/internal/c0/state") {
        if (url.searchParams.has("request_id")) requestId = requireRequestId({ request_id: url.searchParams.get("request_id") });
        return apiSuccess(await this.readState(), this.env, requestId);
      }
      const c1Action = isC1 ? C1_ACTIONS[url.pathname as keyof typeof C1_ACTIONS] : undefined;
      if (isC1 && !c1Action) throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
      if (c1Action && request.method !== c1Action.method) {
        throw new ApiError("METHOD_NOT_ALLOWED", `This action requires ${c1Action.method}.`, 405);
      }
      if (isC1 && request.method === "GET" && url.pathname === "/internal/c1/public-roster") {
        requestId = requireRequestId({ request_id: url.searchParams.get("request_id") });
        return apiSuccess(new C1Service(this.ctx, this.env).publicRoster(url.searchParams.get("season_id") || ""),
          this.env, requestId, C1_CONTRACT_VERSION);
      }
      if (isC1 && request.method === "GET" && url.pathname === "/internal/c1/public-schedule") {
        requestId = requireRequestId({ request_id: url.searchParams.get("request_id") });
        return apiSuccess(new C1ScheduleService(this.ctx, this.env)
          .publicSchedule(url.searchParams.get("season_id") || ""), this.env, requestId, C1_CONTRACT_VERSION);
      }
      if (isC1 && request.method === "GET" && url.pathname === "/internal/c1/public-practice") {
        requestId = requireRequestId({ request_id: url.searchParams.get("request_id") });
        return apiSuccess(new C1SignupService(this.ctx, this.env).publicPractice(
          url.searchParams.get("season_id") || "", url.searchParams.get("practice_id") || ""),
        this.env, requestId, C1_CONTRACT_VERSION);
      }
      if (isC1 && request.method === "POST") {
        const input = await readJsonObject(request);
        requestId = requireRequestId(input);
        const data = Object.hasOwn(C1_SCHEDULE_ACTIONS, url.pathname)
          ? await new C1ScheduleService(this.ctx, this.env).handle(url.pathname, input)
          : Object.hasOwn(C1_SEATING_ACTIONS, url.pathname)
            ? await new C1SeatingService(this.ctx, this.env).handle(url.pathname, input)
          : Object.hasOwn(C1_SIGNUP_ACTIONS, url.pathname)
            ? await new C1SignupService(this.ctx, this.env).handle(url.pathname, input)
            : await new C1Service(this.ctx, this.env).handle(url.pathname, input);
        await this.ensureNextAlarm();
        return apiSuccess(data, this.env, requestId, C1_CONTRACT_VERSION);
      }
      throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    } catch (error) {
      return apiFailure(error, this.env, requestId, isC1 ? C1_CONTRACT_VERSION : this.env.CONTRACT_VERSION);
    }
  }

  async alarm(): Promise<void> {
    try {
      const jobs = this.claimDueJobs(Date.now(), JOB_BATCH_LIMIT);
      for (const job of jobs) await this.processClaimedJob(job);
    } catch (error) {
      console.error("Alarm batch failed", error instanceof Error ? error.message : "unknown error");
    } finally {
      await this.ensureNextAlarm();
    }
  }

  private parseCommit(input: Record<string, unknown>): C0CommitInput {
    return {
      requestId: requireRequestId(input),
      actorScope: requireString(input, "actor_scope", 1, 128),
      action: requireString(input, "action", 1, 80),
      amount: optionalInteger(input, "amount", 1, 1, 100),
      enqueueJob: optionalBoolean(input, "enqueue_job"),
      jobDueAtMs: optionalInteger(input, "job_due_at_ms", 0, 0, Number.MAX_SAFE_INTEGER),
      failAttempts: optionalInteger(input, "fail_attempts", 0, 0, 100),
      retryDelayMs: optionalInteger(input, "retry_delay_ms", 1_000, 1_000, 3_600_000),
      simulateFailure: optionalBoolean(input, "simulate_failure")
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
          job_type: string;
          payload_json: string;
          attempt_count: number;
        }>(
          `SELECT job_id, job_type, payload_json, attempt_count
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
          job_type: String(row.job_type),
          payload_json: row.payload_json,
          attempt_count: nextAttempt,
          lease_token: leaseToken
        };
      });
    });
  }

  private async processClaimedJob(job: ClaimedJob): Promise<void> {
    let outboxId: string | null = null;
    let retryDelayMs = RECOVERY_ALARM_MS;
    try {
      const payload = parseJobJson(job.payload_json);
      if (job.job_type === "OPEN_TRAINING_WEEK") {
        await new C1ScheduleService(this.ctx, this.env).publishDueWeek(payload);
      } else if (job.job_type === "C0_MOCK_SYNC") {
        const c0Payload = parseC0MockSyncJob(payload);
        outboxId = c0Payload.outbox_id;
        retryDelayMs = c0Payload.retry_delay_ms;
        await Promise.resolve();
        if (job.attempt_count <= c0Payload.fail_attempts) throw new Error("Simulated downstream failure.");
      } else throw new Error(`Unsupported scheduled job type ${job.job_type}.`);
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
        if (outboxId) this.ctx.storage.sql.exec(
          `UPDATE sync_outbox SET status = 'CONFIRMED', attempt_count = ?, completed_at = ?, last_error = ''
            WHERE outbox_id = ?`, job.attempt_count, completedAt, outboxId).toArray();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown downstream failure.";
      const retryAt = Date.now() + retryDelayMs;
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
        if (outboxId) this.ctx.storage.sql.exec(
          `UPDATE sync_outbox SET attempt_count = ?, last_error = ? WHERE outbox_id = ?`,
          job.attempt_count, message, outboxId).toArray();
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
