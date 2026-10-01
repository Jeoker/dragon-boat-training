import { C1Service } from "./c1-service";
import { selectExportLane, LocalExportConflict, type IndexedEvent } from "./c2-export-lanes";
import { sha256Base64Url } from "./crypto";
import { ApiError, requireRequestId } from "./http";
import { firstRow, type SqlRow } from "./c1-support";
import { unfinishedExport } from "./c2-export-control";
import { C2MemberExportService } from "./c2-member-export";
import { C2ScheduleExportService } from "./c2-schedule-export";
import { C2AssociatedExportService } from "./c2-associated-export";

interface PollTarget {
  season_id: string; binding_version: number; outbox_id: string | null;
  topic: string | null; event_anchor: string | null; event_digest: string | null;
  coverage: "complete" | "incomplete";
}

export async function pollDueExports(ctx: DurableObjectState, env: Env, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = requireRequestId(raw);
  if (env.ENVIRONMENT === "production" || env.C2_EXPORT_POLL_ENABLED !== "true") {
    throw new ApiError("EXPORT_POLL_DISABLED", "Automatic Google export is disabled.", 409);
  }
  const core = new C1Service(ctx, env);
  const identity = await core.createRequestIdentity("C2:EXPORT", "pollDueExports", requestId, {});
  const replay = core.replayRequest(identity.requestKey, identity.payloadDigest);
  if (replay) return replay;
  const remember = (result: Record<string, unknown>) => ctx.storage.transactionSync(() => {
    const prior = core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (prior) return prior;
    core.recordRequest(identity, "C2:EXPORT", "pollDueExports", requestId, result,
      { polled: result.polled }, new Date().toISOString());
    return result;
  });
  const sql = ctx.storage.sql;
  const now = Date.now();
  let plan = firstRow<SqlRow>(sql, "SELECT * FROM sync_export_poll_plans WHERE request_key=?", identity.requestKey);
  if (!plan) {
    const candidates = sql.exec<{ season_id: string; binding_version: number }>(
      `SELECT b.season_id,b.binding_version FROM sync_bindings b JOIN seasons s
       ON s.season_id=b.season_id AND s.binding_version=b.binding_version ORDER BY b.season_id LIMIT 101`).toArray();
    if (candidates.length > 100) return remember({ polled: 0, results: [], coverage: "incomplete", reason: "SEASON_SCAN_LIMIT" });
    const choices = candidates.map(season => ({ season, selection: selectExportLane(sql, season.season_id, now) }))
      .filter(choice => choice.selection.event !== null || choice.selection.coverage === "incomplete").slice(0, 4);
    const targets: PollTarget[] = await Promise.all(choices.map(async ({ season, selection }) => ({
      ...season, outbox_id: selection.event?.outbox_id ?? null, topic: selection.event?.topic ?? null,
      event_anchor: selection.event?.payload_anchor ?? null, coverage: selection.coverage,
      event_digest: selection.event ? `sha256_v1:${await sha256Base64Url(selection.event.payload_anchor)}` : null
    })));
    const text = JSON.stringify(targets);
    const digest = `sha256_v1:${await sha256Base64Url(text)}`;
    plan = ctx.storage.transactionSync(() => {
      const existing = firstRow<SqlRow>(sql, "SELECT * FROM sync_export_poll_plans WHERE request_key=?", identity.requestKey);
      if (existing) return existing;
      for (const target of targets) {
        const current = selectExportLane(sql, target.season_id, now);
        if (current.coverage !== target.coverage || (current.event?.outbox_id ?? null) !== target.outbox_id ||
            (current.event?.payload_anchor ?? null) !== target.event_anchor ||
            target.coverage === "complete" && Number(current.binding_version) !== target.binding_version)
          throw new ApiError("SYNC_EXPORT_STALE", "The poll plan changed before it was persisted.", 409, true);
      }
      sql.exec("INSERT INTO sync_export_poll_plans(request_key,request_digest,plan_json,plan_digest,created_at) VALUES (?,?,?,?,?)",
        identity.requestKey, identity.payloadDigest, text, digest, new Date().toISOString()).toArray();
      return firstRow<SqlRow>(sql, "SELECT * FROM sync_export_poll_plans WHERE request_key=?", identity.requestKey)!;
    });
  }
  if (plan.request_digest !== identity.payloadDigest || `sha256_v1:${await sha256Base64Url(String(plan.plan_json))}` !== plan.plan_digest)
    throw new ApiError("SYNC_EVENT_INDEX_INVALID", "The original poll plan changed.", 409);
  let seasons: PollTarget[];
  try {
    const parsed: unknown = JSON.parse(String(plan.plan_json));
    if (!Array.isArray(parsed) || parsed.length > 4 || !parsed.every(target => target && typeof target === "object" &&
        typeof target.season_id === "string" && Number.isSafeInteger(target.binding_version) && target.binding_version >= 1 &&
        ["complete", "incomplete"].includes(target.coverage) && (target.outbox_id === null || typeof target.outbox_id === "string"))) throw new Error("shape");
    seasons = parsed as PollTarget[];
  } catch { throw new ApiError("SYNC_EVENT_INDEX_INVALID", "The original poll plan is invalid.", 409); }
  const results: Array<{ season_id: string; status: string; error_code?: string }> = [];
  for (const season of seasons) {
    const seasonId = season.season_id;
    let observedRetry = JSON.stringify(firstRow<SqlRow>(sql,
      "SELECT * FROM sync_export_retries WHERE season_id=? AND binding_version=?", seasonId, season.binding_version));
    try {
      const selected = selectExportLane(sql, seasonId, now);
      if (selected.coverage !== "complete") throw new ApiError("SYNC_EVENT_INDEX_INCOMPLETE", "The dependency scan is incomplete.", 409);
      if (season.coverage !== "complete") throw new ApiError("SYNC_EVENT_INDEX_INCOMPLETE", "The original poll dependency scan was incomplete.", 409);
      if (Number(selected.binding_version) !== season.binding_version) {
        results.push({ season_id: seasonId, status: "ORIGINAL_EVENT_UNAVAILABLE" });
        continue;
      }
      let event = firstRow<IndexedEvent>(sql, `SELECT i.*,o.topic,o.payload_json,o.due_at_ms FROM sync_export_event_index i JOIN sync_outbox o ON o.outbox_id=i.outbox_id WHERE i.outbox_id=?`, season.outbox_id!);
      if (!event || event.payload_json !== season.event_anchor || event.payload_anchor !== season.event_anchor ||
          event.topic !== season.topic || event.topic_anchor !== season.topic || event.season_id !== seasonId ||
          `sha256_v1:${await sha256Base64Url(event.payload_json)}` !== season.event_digest) throw new ApiError("SYNC_EVENT_INDEX_INVALID", "The poll's original event changed.", 409);
      // Resume an interrupted poll's original associated lane even after local block
      // permits another practice to become today's candidate.
      const firstInnerId = `c2_${await sha256Base64Url(`${requestId}\n${seasonId}\n0`)}`;
      const originalAction = ["SIGNUPS_CHANGED", "SEATING_CHANGED"].includes(season.topic ?? "") ? "exportNextAssociated" : season.topic === "SCHEDULE_CHANGED" ? "exportNextSchedule" : "exportNextMember";
      const innerIdentity = await core.createRequestIdentity("C2:EXPORT", originalAction, firstInnerId, { season_id: seasonId });
      const original = firstRow<SqlRow>(sql, "SELECT * FROM sync_export_request_selections WHERE request_key=?", innerIdentity.requestKey);
      if (original) {
        const block = firstRow<SqlRow>(sql, "SELECT * FROM sync_export_event_blocks WHERE season_id=? AND binding_version=? AND outbox_id=? AND action_required=1", seasonId, original.binding_version, original.outbox_id);
        if (block) {
          results.push({ season_id: seasonId, status: "LOCAL_ACTION_REQUIRED", error_code: String(block.error_code) });
          continue;
        }
        event = firstRow(sql, `SELECT i.*,o.topic,o.payload_json,o.due_at_ms FROM sync_export_event_index i JOIN sync_outbox o ON o.outbox_id=i.outbox_id WHERE i.outbox_id=?`, String(original.outbox_id));
      }
      const innerCompleted = firstRow<SqlRow>(sql, "SELECT * FROM system_requests WHERE request_key=?", innerIdentity.requestKey);
      const innerBatch = firstRow<SqlRow>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", `batch_${innerIdentity.requestKey.slice(7)}`);
      if (selected.event?.outbox_id !== season.outbox_id && !innerCompleted && !innerBatch) {
        results.push({ season_id: seasonId, status: "ORIGINAL_EVENT_UNAVAILABLE" });
        continue;
      }
      if (!event) { results.push({ season_id: seasonId, status: "ORIGINAL_EVENT_UNAVAILABLE" }); continue; }
      const topic = String(event.topic);
      let action: unknown;
      try { action = (JSON.parse(String(event.payload_json)) as { action?: unknown }).action; }
      catch { throw new ApiError("SYNC_OUTBOX_INVALID", "The oldest export event is invalid JSON.", 409); }
      const member = topic === "MEMBERS_IMPORTED" || topic === "CORE_CHANGED" && action === "updateMember";
      const schedule = topic === "SCHEDULE_CHANGED";
      const associated = topic === "SIGNUPS_CHANGED" || topic === "SEATING_CHANGED";
      if (!member && !schedule && !associated) throw new ApiError("SYNC_OUTBOX_BLOCKED",
        "The oldest event has no enabled exporter.", 409);
      if (member && env.C2_MEMBER_EXPORT_ENABLED !== "true" ||
          schedule && env.C2_SCHEDULE_EXPORT_ENABLED !== "true" ||
          associated && env.C2_ASSOCIATED_EXPORT_ENABLED !== "true") {
        throw new ApiError("EXPORT_HANDLER_DISABLED", "The required export handler is disabled.", 409);
      }
      // One associated event can contain a full boat. Drain a bounded number of
      // four-row batches in one poll; every call needs its own idempotency key.
      // Stop at the event boundary so a subsequent event gets a fresh preflight.
      let result: Record<string, unknown> = { status: "IDLE" };
      let attemptedWork = false;
      const callLimit = associated ? 8 : 1;
      for (let index = 0; index < callLimit; index += 1) {
        if (firstRow<{ status: string }>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", event.outbox_id)?.status === "CONFIRMED") {
          result = { season_id: seasonId, status: "EVENT_CONFIRMED", outbox_id: event.outbox_id };
          break;
        }
        const exportRequestId = `c2_${await sha256Base64Url(`${requestId}\n${seasonId}\n${index}`)}`;
        const stepIdentity = await core.createRequestIdentity("C2:EXPORT", originalAction, exportRequestId, { season_id: seasonId });
        const stepCompleted = firstRow(sql, "SELECT 1 AS present FROM system_requests WHERE request_key=?", stepIdentity.requestKey);
        const stepConfirmed = firstRow(sql, "SELECT 1 AS present FROM sync_batches WHERE batch_id=? AND status='CONFIRMED'", `batch_${stepIdentity.requestKey.slice(7)}`);
        const currentLane = selectExportLane(sql, seasonId);
        if (!stepCompleted && !stepConfirmed && (currentLane.coverage !== "complete" || currentLane.event?.outbox_id !== event.outbox_id ||
            Number(currentLane.binding_version) !== season.binding_version)) {
          result = { season_id: seasonId, status: "ORIGINAL_EVENT_UNAVAILABLE", outbox_id: event.outbox_id };
          break;
        }
        if (!stepCompleted && !stepConfirmed) {
          attemptedWork = true;
          observedRetry = JSON.stringify(firstRow<SqlRow>(sql,
            "SELECT * FROM sync_export_retries WHERE season_id=? AND binding_version=?", seasonId, season.binding_version));
        }
        result = member
          ? await new C2MemberExportService(ctx, env).process({ request_id: exportRequestId,
            season_id: seasonId })
          : schedule ? await new C2ScheduleExportService(ctx, env).process({ request_id: exportRequestId,
            season_id: seasonId })
          : await new C2AssociatedExportService(ctx, env).process({ request_id: exportRequestId,
            season_id: seasonId, outbox_id: event.outbox_id });
        if (!associated || result.status !== "BATCH_CONFIRMED") break;
      }
      if (result.status === "ORIGINAL_EVENT_UNAVAILABLE") {
        results.push({ season_id: seasonId, status: "ORIGINAL_EVENT_UNAVAILABLE" });
        continue;
      }
      if (!attemptedWork) {
        results.push({ season_id: seasonId, status: String(result.status ?? "COMMITTED") });
        continue;
      }
      const current = firstRow<{ binding_version: number }>(sql,
        `SELECT b.binding_version FROM sync_bindings b JOIN seasons s
         ON s.season_id=b.season_id AND s.binding_version=b.binding_version
         WHERE b.season_id=?`, seasonId);
      if (Number(current?.binding_version) !== Number(season.binding_version)) {
        results.push({ season_id: seasonId, status: "STALE_BINDING" });
        continue;
      }
      ctx.storage.transactionSync(() => {
        const retryAt = Date.now();
        const unfinished = unfinishedExport(sql, seasonId);
        const next = selectExportLane(sql, seasonId, retryAt);
        const dueOutbox = next.event !== null || next.reason === "PAUSED" && Boolean(firstRow(sql,
          `SELECT 1 AS present FROM sync_export_event_index i JOIN sync_outbox o ON o.outbox_id=i.outbox_id
           WHERE i.season_id=? AND o.status='PENDING' AND o.due_at_ms<=? LIMIT 1`, seasonId, retryAt));
        const concurrentFailure = firstRow<SqlRow>(sql,
          "SELECT * FROM sync_export_retries WHERE season_id=? AND binding_version=?", seasonId, season.binding_version);
        // A Coach rearm is also a newer decision, even though its counters are zero.
        // Confirmation may have deleted our own observed retry; it cannot overwrite
        // a different row left by another request while Google was awaited.
        if (concurrentFailure && JSON.stringify(concurrentFailure) !== observedRetry) return;
        if (unfinished || dueOutbox) {
          sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at,action_required)
            VALUES (?,?,0,?,'',?,0) ON CONFLICT(season_id) DO UPDATE SET
            binding_version=excluded.binding_version,failure_count=0,
            next_attempt_at_ms=excluded.next_attempt_at_ms,last_error='',updated_at=excluded.updated_at,
            action_required=0`, seasonId, season.binding_version, retryAt + 60_000,
          new Date(retryAt).toISOString()).toArray();
        } else {
          sql.exec("DELETE FROM sync_export_retries WHERE season_id=? AND binding_version=?",
            seasonId, season.binding_version).toArray();
        }
      });
      results.push({ season_id: seasonId, status: String(result.status ?? "COMMITTED") });
    } catch (error) {
      const current = firstRow<{ binding_version: number }>(sql,
        `SELECT b.binding_version FROM sync_bindings b JOIN seasons s
         ON s.season_id=b.season_id AND s.binding_version=b.binding_version
         WHERE b.season_id=?`, seasonId);
      if (Number(current?.binding_version) !== Number(season.binding_version)) {
        results.push({ season_id: seasonId, status: "STALE_BINDING" });
        continue;
      }
      if (error instanceof LocalExportConflict && error.localBlockSaved) {
        results.push({ season_id: seasonId, status: "LOCAL_ACTION_REQUIRED", error_code: error.code });
        continue;
      }
      if (error instanceof ApiError && error.code === "SYNC_EXPORT_PAUSED") {
        results.push({ season_id: seasonId, status: "PAUSED" });
        continue;
      }
      const outcome = ctx.storage.transactionSync(() => {
        const previous = firstRow<SqlRow>(sql,
          "SELECT * FROM sync_export_retries WHERE season_id=? AND binding_version=?", seasonId, season.binding_version);
        if (JSON.stringify(previous) !== observedRetry) {
          return Number(previous?.action_required ?? 0) === 1
            ? { season_id: seasonId, status: "ACTION_REQUIRED", error_code: String(previous!.last_error) }
            : { season_id: seasonId, status: "ORIGINAL_EVENT_UNAVAILABLE" };
        }
        const failures = Number(previous?.failure_count ?? 0) + 1;
        const delay = Math.min(21_600_000, 600_000 * 2 ** Math.min(failures - 1, 6));
        const errorCode = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
        const actionRequired = error instanceof ApiError && !error.retryable;
        sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at,action_required)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(season_id) DO UPDATE SET
          binding_version=excluded.binding_version,failure_count=excluded.failure_count,
          next_attempt_at_ms=excluded.next_attempt_at_ms,
          last_error=excluded.last_error,updated_at=excluded.updated_at,
          action_required=excluded.action_required`,
        seasonId, season.binding_version, failures, actionRequired ? 0 : Date.now() + delay,
        errorCode, new Date().toISOString(), actionRequired ? 1 : 0).toArray();
        return { season_id: seasonId,
          status: actionRequired ? "ACTION_REQUIRED" : "RETRY_REQUIRED", error_code: errorCode };
      });
      results.push(outcome);
    }
  }
  return remember({ polled: results.length, results });
}
