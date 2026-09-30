import { sha256Base64Url } from "./crypto";
import { ApiError, requireRequestId } from "./http";
import { firstRow, type SqlRow } from "./c1-support";
import { unfinishedExport } from "./c2-export-control";
import { C2MemberExportService } from "./c2-member-export";
import { C2ScheduleExportService } from "./c2-schedule-export";

export async function pollDueExports(ctx: DurableObjectState, env: Env, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = requireRequestId(raw);
  if (env.ENVIRONMENT === "production" || env.C2_EXPORT_POLL_ENABLED !== "true") {
    throw new ApiError("EXPORT_POLL_DISABLED", "Automatic Google export is disabled.", 409);
  }
  const sql = ctx.storage.sql;
  const now = Date.now();
  const seasons = sql.exec<{ season_id: string; binding_version: number }>(
    `SELECT b.season_id,b.binding_version FROM sync_bindings b
     JOIN seasons s ON s.season_id=b.season_id AND s.binding_version=b.binding_version
     LEFT JOIN sync_export_controls c ON c.season_id=b.season_id
     LEFT JOIN sync_export_retries r ON r.season_id=b.season_id
       AND r.binding_version=b.binding_version
     WHERE b.export_paused=0 AND COALESCE(r.action_required,0)=0
       AND COALESCE(r.next_attempt_at_ms,0)<=?
       AND (COALESCE(c.pause_requested,0)=0 OR EXISTS (
         SELECT 1 FROM sync_batches x WHERE x.season_id=b.season_id
         AND x.direction='CLOUDFLARE_TO_GOOGLE'
         AND x.status IN ('PREPARED','SENT','PARTIAL','FAILED')))
       AND (EXISTS (SELECT 1 FROM sync_batches x WHERE x.season_id=b.season_id
         AND x.direction='CLOUDFLARE_TO_GOOGLE'
         AND x.status IN ('PREPARED','SENT','PARTIAL','FAILED'))
         OR EXISTS (SELECT 1 FROM sync_outbox o WHERE o.status='PENDING'
           AND o.due_at_ms<=? AND json_extract(o.payload_json,'$.entity.season_id')=b.season_id))
     ORDER BY COALESCE(r.next_attempt_at_ms,0), b.season_id LIMIT 4`, now, now).toArray();
  const results: Array<{ season_id: string; status: string; error_code?: string }> = [];
  for (const season of seasons) {
    const seasonId = season.season_id;
    try {
      const batch = unfinishedExport(sql, seasonId);
      const event = batch ? firstRow<SqlRow>(sql,
        `SELECT topic,payload_json FROM sync_outbox WHERE outbox_id=(
           SELECT first_outbox_id FROM sync_batches WHERE batch_id=?)`, batch.batch_id) :
        firstRow<SqlRow>(sql,
          `SELECT topic,payload_json FROM sync_outbox WHERE status='PENDING'
           AND json_extract(payload_json,'$.entity.season_id')=? ORDER BY rowid LIMIT 1`, seasonId);
      if (!event) throw new ApiError("SYNC_OUTBOX_INVALID", "An export batch lost its source event.", 409);
      const topic = String(event.topic);
      const action = (JSON.parse(String(event.payload_json)) as { action?: unknown }).action;
      const member = topic === "MEMBERS_IMPORTED" || topic === "CORE_CHANGED" && action === "updateMember";
      const schedule = topic === "SCHEDULE_CHANGED";
      if (!member && !schedule) throw new ApiError("SYNC_OUTBOX_BLOCKED",
        "The oldest event has no enabled exporter.", 409);
      if (member && env.C2_MEMBER_EXPORT_ENABLED !== "true" ||
          schedule && env.C2_SCHEDULE_EXPORT_ENABLED !== "true") {
        throw new ApiError("EXPORT_HANDLER_DISABLED", "The required export handler is disabled.", 409);
      }
      const exportRequestId = `c2_${await sha256Base64Url(`${requestId}\n${seasonId}`)}`;
      const result = member
        ? await new C2MemberExportService(ctx, env).process({ request_id: exportRequestId,
          season_id: seasonId })
        : await new C2ScheduleExportService(ctx, env).process({ request_id: exportRequestId,
          season_id: seasonId });
      const current = firstRow<{ binding_version: number }>(sql,
        `SELECT b.binding_version FROM sync_bindings b JOIN seasons s
         ON s.season_id=b.season_id AND s.binding_version=b.binding_version
         WHERE b.season_id=?`, seasonId);
      if (Number(current?.binding_version) !== Number(season.binding_version)) {
        results.push({ season_id: seasonId, status: "STALE_BINDING" });
        continue;
      }
      const at = new Date().toISOString();
      sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at,action_required)
        VALUES (?,?,0,?,'',?,0) ON CONFLICT(season_id) DO UPDATE SET
        binding_version=excluded.binding_version,failure_count=0,
        next_attempt_at_ms=excluded.next_attempt_at_ms,last_error='',updated_at=excluded.updated_at,
        action_required=0`,
      seasonId, season.binding_version, Date.now() + 60_000, at).toArray();
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
      if (error instanceof ApiError && error.code === "SYNC_EXPORT_PAUSED") {
        results.push({ season_id: seasonId, status: "PAUSED" });
        continue;
      }
      const previous = firstRow<{ failure_count: number }>(sql,
        "SELECT failure_count FROM sync_export_retries WHERE season_id=? AND binding_version=?",
        seasonId, season.binding_version);
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
      results.push({ season_id: seasonId,
        status: actionRequired ? "ACTION_REQUIRED" : "RETRY_REQUIRED", error_code: errorCode });
    }
  }
  return { polled: results.length, results };
}
