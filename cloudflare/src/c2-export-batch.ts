import { selectExportLane } from "./c2-export-lanes";
import { canonicalJson } from "../../shared/c1-rules";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";
import { firstRow, type SqlRow } from "./c1-support";

export interface ExportBatch extends SqlRow {
  batch_id: string; season_id: string; binding_version: number; writer_epoch: number;
  status: string; direction: string; payload_digest: string; first_outbox_id: string;
}
// Cleanup is best effort and conservative after a crash: a fresh resend observes
// the current retry again. Never remove a failure created while Google was awaited.
const observedRetries = new WeakMap<ExportBatch, string>();

export async function verifyStoredPatch(batch: ExportBatch, saved: SqlRow, payload: unknown,
  expected: string[] | null, target: string[], writerEpoch: number): Promise<void> {
  if (await sha256Base64Url(JSON.stringify(payload)) !== String(batch.payload_digest) ||
      `sha256_v1:${await sha256Base64Url(canonicalJson(expected))}` !== String(saved.expected_sheet_digest) ||
      `sha256_v1:${await sha256Base64Url(canonicalJson(target))}` !== String(saved.target_digest) ||
      Number(batch.writer_epoch) !== writerEpoch) {
    throw new ApiError("SYNC_BATCH_INVALID", "The prepared batch or writer epoch changed.", 409);
  }
}

// A completed or superseded batch must never be sent again, even through an old request ID.
export function beginExportSend(ctx: DurableObjectState, batch: ExportBatch): boolean {
  return ctx.storage.transactionSync(() => {
    const sql = ctx.storage.sql;
    const current = firstRow<ExportBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batch.batch_id);
    if (!current || current.payload_digest !== batch.payload_digest ||
        current.season_id !== batch.season_id ||
        Number(current.binding_version) !== Number(batch.binding_version) ||
        Number(current.writer_epoch) !== Number(batch.writer_epoch) ||
        current.first_outbox_id !== batch.first_outbox_id ||
        current.direction !== "CLOUDFLARE_TO_GOOGLE") {
      throw new ApiError("SYNC_BATCH_INVALID", "The prepared batch changed before sending.", 409);
    }
    if (current.status === "CONFIRMED") return true;
    if (!["PREPARED", "SENT", "PARTIAL", "FAILED"].includes(current.status)) {
      throw new ApiError("SYNC_BATCH_INVALID", "The batch is not eligible for sending.", 409);
    }
    const selection = selectExportLane(sql, current.season_id);
    if (selection.coverage !== "complete") throw new ApiError("SYNC_EVENT_INDEX_INCOMPLETE", "The recovering batch has no valid indexed source.", 409);
    if (selection.batch_id !== current.batch_id || Number(selection.binding_version) !== Number(current.binding_version))
      throw new ApiError("SYNC_OUTBOX_BLOCKED", "The original batch is halted or another batch must drain first.", 409);
    sql.exec(
      "UPDATE sync_batches SET status='SENT',attempt_count=attempt_count+1,updated_at=? WHERE batch_id=?",
      new Date().toISOString(), batch.batch_id).toArray();
    observedRetries.set(batch, JSON.stringify(firstRow<SqlRow>(sql,
      "SELECT * FROM sync_export_retries WHERE season_id=? AND binding_version=?", batch.season_id, batch.binding_version)));
    return false;
  });
}

export function recordExportFailure(sql: SqlStorage, batchId: string, error: unknown): void {
  sql.exec("UPDATE sync_batches SET status='FAILED',last_error=?,updated_at=? WHERE batch_id=? AND status='SENT'",
    error instanceof Error ? error.message.slice(0, 400) : "Unknown bridge error.",
    new Date().toISOString(), batchId).toArray();
}

export function recordExportPartial(sql: SqlStorage, batchId: string, message: string): void {
  sql.exec("UPDATE sync_batches SET status='PARTIAL',last_error=?,updated_at=? WHERE batch_id=? AND status='SENT'",
    message, new Date().toISOString(), batchId).toArray();
}

export function assertSentBatch(batch: ExportBatch | null): void {
  if (!batch || batch.status !== "SENT") {
    throw new ApiError("SYNC_BATCH_INVALID", "The batch changed before receipt confirmation.", 409);
  }
}

// Call only inside the same transaction that advances the corresponding baselines.
export function confirmExportReceipt(sql: SqlStorage, batch: ExportBatch, receipt: unknown,
  at: string, completion: "BATCH" | "EVENT", itemCount = 1): void {
  sql.exec("UPDATE sync_batch_items SET status='VERIFIED',receipt_json=?,updated_at=? WHERE batch_id=? AND item_index<?",
    JSON.stringify(receipt), at, batch.batch_id, itemCount).toArray();
  sql.exec("UPDATE sync_batches SET status='CONFIRMED',last_error='',updated_at=?,completed_at=? WHERE batch_id=? AND status='SENT'",
    at, at, batch.batch_id).toArray();
  const currentRetry = firstRow<SqlRow>(sql, "SELECT * FROM sync_export_retries WHERE season_id=? AND binding_version=?", batch.season_id, batch.binding_version);
  if (observedRetries.get(batch) === JSON.stringify(currentRetry) && !Number(currentRetry?.action_required ?? 0)) {
    sql.exec("DELETE FROM sync_export_retries WHERE season_id=? AND binding_version=?", batch.season_id, batch.binding_version).toArray();
  }
  if (completion === "EVENT") {
    sql.exec("UPDATE sync_outbox SET status='CONFIRMED',completed_at=?,last_error='' WHERE outbox_id=? AND status='PENDING'",
      at, batch.first_outbox_id).toArray();
  }
  sql.exec("UPDATE sync_bindings SET last_push_at=?,updated_at=? WHERE season_id=? AND binding_version=?",
    at, at, batch.season_id, batch.binding_version).toArray();
}
