import { ApiError } from "./http";
import { firstRow, type SqlRow } from "./c1-support";
import { parseAssociatedEvent } from "./c2-associated-projection";
import { unfinishedExport, exportPauseRequested } from "./c2-export-control";

// Exact text anchors permit synchronous SQLite transaction verification.
export interface IndexedEvent extends SqlRow {
  outbox_id: string; event_sequence: number; season_id: string; payload_anchor: string; topic_anchor: string;
  handler_kind: "ASSOCIATED" | "BARRIER"; practice_id: string | null; classification_anchor: string;
  topic: string; payload_json: string; due_at_ms: number;
}
export function exportClassificationAnchor(id: string, sequence: number, season: string, kind: string, practice: string | null): string {
  return JSON.stringify([id, sequence, season, kind, practice]);
}
function classification(topic: string, payload: string): { season: string; kind: "ASSOCIATED" | "BARRIER"; practice: string | null } {
  let data: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(payload); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { /* Unknown ownership fails closed. */ }
  // A fixed operational counter-test shape proves this event has no season references.
  if (topic === "C0_MOCK_SYNC" && Object.keys(data).sort().join(",") === "amount,enqueue_job,fail_attempts,job_due_at_ms,retry_delay_ms" &&
      Number.isSafeInteger(data.amount) && Number(data.amount) >= 1 && Number(data.amount) <= 100 && typeof data.enqueue_job === "boolean" && Number.isSafeInteger(data.job_due_at_ms) && Number(data.job_due_at_ms) >= 0 &&
      Number.isSafeInteger(data.fail_attempts) && Number(data.fail_attempts) >= 0 && Number(data.fail_attempts) <= 100 && Number.isSafeInteger(data.retry_delay_ms) &&
      Number(data.retry_delay_ms) >= 1000 && Number(data.retry_delay_ms) <= 3600000) return { season: "@NON_SEASON_C0", kind: "BARRIER", practice: null };
  const entity = data.entity && typeof data.entity === "object" && !Array.isArray(data.entity) ? data.entity as Record<string, unknown> : {};
  const season = typeof entity.season_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(entity.season_id) ? entity.season_id : "";
  if (season && ["SIGNUPS_CHANGED", "SEATING_CHANGED"].includes(topic)) {
    try {
      const parsed = parseAssociatedEvent(topic, payload, season);
      // The old complete draft shape can still be drained as a global barrier,
      // but it never gains permission to bypass another practice.
      if (topic === "SEATING_CHANGED" && entity.published_revision === undefined) throw new Error("legacy");
      return { season, kind: "ASSOCIATED", practice: parsed.practice_id };
    } catch { /* Unknown/old snapshots remain barriers. */ }
  }
  return { season, kind: "BARRIER", practice: null };
}
export function indexExportEvent(sql: SqlStorage, outboxId: string): void {
  const row = firstRow<SqlRow>(sql, "SELECT * FROM sync_outbox WHERE outbox_id=?", outboxId);
  if (!row) throw new ApiError("SYNC_EVENT_INDEX_INVALID", "The event to index is missing.", 409);
  const anchor = String(row.payload_json);
  const existing = firstRow<SqlRow>(sql, "SELECT * FROM sync_export_event_index WHERE outbox_id=?", outboxId);
  if (existing) {
    if (existing.payload_anchor !== anchor || existing.topic_anchor !== row.topic || existing.classification_anchor !== exportClassificationAnchor(outboxId, Number(existing.event_sequence), String(existing.season_id), String(existing.handler_kind), existing.practice_id as string | null)) throw new ApiError("SYNC_EVENT_INDEX_INVALID", "An indexed event changed.", 409);
    return;
  }
  const sequence = Number(firstRow<{ maximum: number }>(sql,
    "SELECT COALESCE(MAX(event_sequence),0) AS maximum FROM sync_export_event_index")!.maximum) + 1;
  if (!Number.isSafeInteger(sequence)) throw new ApiError("SYNC_EVENT_INDEX_INVALID", "Event sequence exhausted.", 409);
  const c = classification(String(row.topic), String(row.payload_json));
  sql.exec(`INSERT INTO sync_export_event_index(outbox_id,event_sequence,season_id,payload_anchor,topic_anchor,
    handler_kind,practice_id,classification_anchor,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  outboxId, sequence, c.season, anchor, String(row.topic), c.kind, c.practice, exportClassificationAnchor(outboxId, sequence, c.season, c.kind, c.practice), String(row.created_at)).toArray();
}
export interface LaneSelection {
  event: IndexedEvent | null; binding_version: number | null; batch_id: string | null;
  reason: string; coverage: "complete" | "incomplete"; next_due_at_ms: number | null;
}
export function selectExportLane(sql: SqlStorage, seasonId: string, now = Date.now()): LaneSelection {
  const empty = (reason: string, coverage: "complete" | "incomplete" = "complete"): LaneSelection =>
    ({ event: null, binding_version: null, batch_id: null, reason, coverage, next_due_at_ms: null });
  const binding = firstRow<SqlRow>(sql, `SELECT b.binding_version,b.export_paused FROM sync_bindings b
    JOIN seasons s ON s.season_id=b.season_id AND s.binding_version=b.binding_version WHERE b.season_id=?`, seasonId);
  if (!binding || Number(binding.export_paused)) return empty("BINDING_UNAVAILABLE");
  const version = Number(binding.binding_version);
  const retry = firstRow<SqlRow>(sql, "SELECT * FROM sync_export_retries WHERE season_id=? AND binding_version=?", seasonId, version);
  if (Number(retry?.action_required ?? 0)) return { ...empty("GLOBAL_ACTION_REQUIRED"), binding_version: version };
  if (Number(retry?.next_attempt_at_ms ?? 0) > now) return { ...empty("GLOBAL_BACKOFF"), binding_version: version,
    next_due_at_ms: Number(retry!.next_attempt_at_ms) };
  const batch = unfinishedExport(sql, seasonId);
  if (batch) {
    const event = firstRow<IndexedEvent>(sql, `SELECT i.*,o.topic,o.payload_json,o.due_at_ms FROM sync_export_event_index i
      JOIN sync_outbox o ON o.outbox_id=i.outbox_id JOIN sync_batches b ON b.first_outbox_id=o.outbox_id WHERE b.batch_id=?`, batch.batch_id);
    if (!event || !Number.isSafeInteger(event.event_sequence) || event.event_sequence < 1 ||
        event.classification_anchor !== exportClassificationAnchor(event.outbox_id, event.event_sequence, event.season_id, event.handler_kind, event.practice_id) || event.season_id !== seasonId || event.payload_anchor !== event.payload_json || event.topic_anchor !== event.topic ||
        classification(event.topic, event.payload_json).season !== seasonId ||
        classification(event.topic, event.payload_json).kind !== event.handler_kind ||
        classification(event.topic, event.payload_json).practice !== event.practice_id) return empty("INDEX_INCOMPLETE", "incomplete");
    return { event, binding_version: version, batch_id: batch.batch_id, reason: "DRAIN_BATCH", coverage: "complete", next_due_at_ms: now };
  }
  if (exportPauseRequested(sql, seasonId)) return { ...empty("PAUSED"), binding_version: version };
  // Prove ownership and immutable anchors across all pending rows in SQLite;
  // this does not materialize an unbounded set of private payloads.
  const unsafe = firstRow<{ count: number }>(sql, `SELECT COUNT(*) AS count FROM sync_outbox o
    LEFT JOIN sync_export_event_index i ON i.outbox_id=o.outbox_id WHERE o.status='PENDING' AND
    (i.outbox_id IS NULL OR typeof(i.event_sequence)<>'integer' OR i.event_sequence<1 OR i.event_sequence>9007199254740991 OR
     i.payload_anchor<>o.payload_json OR i.topic_anchor<>o.topic OR
     i.classification_anchor<>json_array(i.outbox_id,i.event_sequence,i.season_id,i.handler_kind,i.practice_id) OR
     i.handler_kind NOT IN ('ASSOCIATED','BARRIER') OR (i.handler_kind='BARRIER' AND i.practice_id IS NOT NULL) OR
     (i.handler_kind='ASSOCIATED' AND (o.topic NOT IN ('SIGNUPS_CHANGED','SEATING_CHANGED') OR i.practice_id IS NULL OR
       CASE WHEN json_valid(o.payload_json) THEN json_type(o.payload_json,'$.entity.practice_id')='text' AND
         json_extract(o.payload_json,'$.entity.practice_id')=i.practice_id ELSE 0 END IS NOT 1)) OR
     CASE WHEN json_valid(o.payload_json) THEN CASE WHEN i.season_id='@NON_SEASON_C0' THEN
       o.topic='C0_MOCK_SYNC' AND (SELECT COUNT(*) FROM json_each(o.payload_json))=5 AND
       json_type(o.payload_json,'$.amount')='integer' AND json_extract(o.payload_json,'$.amount') BETWEEN 1 AND 100 AND
       json_type(o.payload_json,'$.enqueue_job') IN ('true','false') AND
       json_type(o.payload_json,'$.job_due_at_ms')='integer' AND json_extract(o.payload_json,'$.job_due_at_ms')>=0 AND
       json_type(o.payload_json,'$.fail_attempts')='integer' AND json_extract(o.payload_json,'$.fail_attempts') BETWEEN 0 AND 100 AND
       json_type(o.payload_json,'$.retry_delay_ms')='integer' AND json_extract(o.payload_json,'$.retry_delay_ms') BETWEEN 1000 AND 3600000
     ELSE json_type(o.payload_json,'$.entity')='object' AND json_type(o.payload_json,'$.entity.season_id')='text' AND
       json_extract(o.payload_json,'$.entity.season_id')=i.season_id AND length(i.season_id) BETWEEN 8 AND 128 AND
       i.season_id NOT GLOB '*[^A-Za-z0-9_-]*' AND EXISTS(SELECT 1 FROM seasons s WHERE s.season_id=i.season_id)
     END ELSE 0 END IS NOT 1)`);
  if (Number(unsafe?.count)) return empty("INDEX_INCOMPLETE", "incomplete");
  // Validate all current-binding local blocks before they can hide a head.
  const invalidBlock = firstRow<{ count: number }>(sql, `SELECT COUNT(*) AS count FROM sync_export_event_blocks b
    LEFT JOIN sync_export_event_index i ON i.outbox_id=b.outbox_id
    LEFT JOIN sync_outbox o ON o.outbox_id=b.outbox_id
    WHERE b.season_id=? AND b.binding_version=? AND
      (i.outbox_id IS NULL OR i.season_id<>b.season_id OR i.handler_kind<>'ASSOCIATED' OR
       i.practice_id<>b.practice_id OR i.payload_anchor<>b.payload_anchor OR i.payload_anchor<>o.payload_json)`, seasonId, version);
  if (Number(invalidBlock?.count)) return empty("BLOCK_INVALID", "incomplete");
  // MIN is computed before due/block filtering: a future or blocked head still
  // seals every successor of that practice. A barrier seals all later heads.
  const prefix = `WITH pending AS (
    SELECT i.outbox_id,i.event_sequence,i.handler_kind,i.practice_id,o.due_at_ms
    FROM sync_export_event_index i JOIN sync_outbox o ON o.outbox_id=i.outbox_id
    WHERE i.season_id=? AND o.status='PENDING'
  ), barrier AS (SELECT MIN(event_sequence) AS sequence FROM pending WHERE handler_kind='BARRIER'),
  heads AS (SELECT MIN(event_sequence) AS sequence FROM pending WHERE handler_kind='ASSOCIATED' GROUP BY practice_id),
  candidates AS (
    SELECT p.*,b.action_required,b.next_attempt_at_ms FROM pending p
    LEFT JOIN sync_export_event_blocks b ON b.outbox_id=p.outbox_id AND b.season_id=? AND b.binding_version=?
    WHERE (p.handler_kind='ASSOCIATED' AND p.event_sequence IN (SELECT sequence FROM heads)
       AND ((SELECT sequence FROM barrier) IS NULL OR p.event_sequence<(SELECT sequence FROM barrier)))
      OR (p.handler_kind='BARRIER' AND p.event_sequence=(SELECT sequence FROM barrier)
       AND NOT EXISTS(SELECT 1 FROM pending earlier WHERE earlier.event_sequence<p.event_sequence))
  )`;
  const args = [seasonId, seasonId, version] as const;
  const selected = firstRow<{ outbox_id: string }>(sql, `${prefix} SELECT outbox_id FROM candidates
    WHERE COALESCE(action_required,0)=0 AND COALESCE(next_attempt_at_ms,0)<=? AND due_at_ms<=?
    ORDER BY event_sequence LIMIT 1`, ...args, now, now);
  const next = firstRow<{ due: number | null }>(sql, `${prefix} SELECT MIN(MAX(due_at_ms,COALESCE(next_attempt_at_ms,0))) AS due
    FROM candidates WHERE COALESCE(action_required,0)=0`, ...args);
  let event: IndexedEvent | null = null;
  if (selected) {
    const size = firstRow<{ size: number }>(sql, "SELECT LENGTH(CAST(payload_json AS BLOB)) AS size FROM sync_outbox WHERE outbox_id=?", selected.outbox_id)!;
    if (Number(size.size)>2_000_000) return empty("SCAN_LIMIT", "incomplete");
    event = firstRow<IndexedEvent>(sql, `SELECT i.*,o.topic,o.payload_json,o.due_at_ms FROM sync_export_event_index i
      JOIN sync_outbox o ON o.outbox_id=i.outbox_id WHERE i.outbox_id=?`, selected.outbox_id)!;
    const c = classification(event.topic,event.payload_json);
    if (c.season!==event.season_id || c.kind!==event.handler_kind || c.practice!==event.practice_id)
      return empty("INDEX_INCOMPLETE", "incomplete");
  }
  const pending = firstRow<{ count: number }>(sql, "SELECT COUNT(*) AS count FROM sync_export_event_index i JOIN sync_outbox o ON o.outbox_id=i.outbox_id WHERE i.season_id=? AND o.status='PENDING'",seasonId)!.count;
  return { event, binding_version: version, batch_id: null, reason: event ? "LANE_HEAD" : pending ? "WAITING_OR_BLOCKED" : "IDLE",
    coverage: "complete", next_due_at_ms: next?.due ?? null };
}
export function assertLaneSelected(sql: SqlStorage, selected: IndexedEvent, version: number): void {
  const current = selectExportLane(sql, selected.season_id);
  if (current.coverage !== "complete" || current.event?.outbox_id !== selected.outbox_id ||
      current.event.payload_anchor !== selected.payload_anchor || current.binding_version !== version || current.batch_id) {
    throw new ApiError("SYNC_EXPORT_STALE", "The selected lane changed during inspection.", 409, true);
  }
}
export class LocalExportConflict extends ApiError {
  localBlockSaved = false;
  constructor(code: string, message: string, readonly scope: string, readonly entityId: string) { super(code, message, 409); }
}
export function blockExportLane(ctx: DurableObjectState, selected: IndexedEvent, version: number,
  error: LocalExportConflict, digest: string): void {
  ctx.storage.transactionSync(() => {
    assertLaneSelected(ctx.storage.sql, selected, version);
    if (selected.handler_kind !== "ASSOCIATED") throw new ApiError("SYNC_OUTBOX_INVALID", "Only trusted associated events can be locally blocked.", 409);
    const at = new Date().toISOString();
    ctx.storage.sql.exec(`INSERT INTO sync_export_event_blocks(season_id,binding_version,outbox_id,practice_id,
      payload_anchor,payload_digest,error_code,failure_count,next_attempt_at_ms,action_required,blocked_scope,blocked_entity_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,1,0,1,?,?,?,?) ON CONFLICT(season_id,binding_version,outbox_id) DO UPDATE SET
      error_code=excluded.error_code,failure_count=failure_count+1,next_attempt_at_ms=0,action_required=1,
      blocked_scope=excluded.blocked_scope,blocked_entity_id=excluded.blocked_entity_id,updated_at=excluded.updated_at`,
    selected.season_id, version, selected.outbox_id, selected.practice_id, selected.payload_anchor, digest,
    error.code, error.scope, error.entityId, at, at).toArray();
  });
}

export function assertSelectedOutbox(sql: SqlStorage, seasonId: string, outboxId: string, payload: string, version: number): void {
  const current = selectExportLane(sql, seasonId);
  if (current.coverage !== "complete") throw new ApiError("SYNC_EVENT_INDEX_INCOMPLETE", "The event dependency scan is incomplete.", 409);
  if (current.batch_id || current.event?.outbox_id !== outboxId || current.event.payload_anchor !== payload || current.binding_version !== version)
    throw new ApiError("SYNC_EXPORT_STALE", "The selected event changed during inspection.", 409, true);
}

export function persistExportSelection(ctx: DurableObjectState, requestKey: string, requestDigest: string,
  event: IndexedEvent, version: number, digest: string, recoveringBatchId: string | null = null): void {
  ctx.storage.transactionSync(() => {
    const sql = ctx.storage.sql;
    if (recoveringBatchId) {
      const current = selectExportLane(sql, event.season_id);
      if (current.coverage !== "complete" || current.batch_id !== recoveringBatchId || current.event?.outbox_id !== event.outbox_id ||
          current.event.payload_anchor !== event.payload_anchor || current.binding_version !== version)
        throw new ApiError("SYNC_EXPORT_STALE", "The recovering event changed before selection was saved.", 409, true);
    } else assertLaneSelected(sql, event, version);
    sql.exec(`INSERT OR IGNORE INTO sync_export_request_selections(request_key,season_id,binding_version,outbox_id,
      event_anchor,event_digest,request_digest,created_at) VALUES (?,?,?,?,?,?,?,?)`, requestKey, event.season_id,
    version, event.outbox_id, event.payload_anchor, digest, requestDigest, new Date().toISOString()).toArray();
    const saved = firstRow<SqlRow>(sql, "SELECT * FROM sync_export_request_selections WHERE request_key=?", requestKey)!;
    if (saved.season_id !== event.season_id || Number(saved.binding_version) !== version || saved.outbox_id !== event.outbox_id ||
        saved.event_anchor !== event.payload_anchor || saved.event_digest !== digest || saved.request_digest !== requestDigest)
      throw new ApiError("IDEMPOTENCY_CONFLICT", "The original export selection cannot change.", 409);
  });
}
