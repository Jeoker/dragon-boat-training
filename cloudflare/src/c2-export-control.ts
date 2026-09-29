import { ApiError } from "./http";
import { firstRow } from "./c1-support";

export function exportPauseRequested(sql: SqlStorage, seasonId: string): boolean {
  return Number(firstRow<{ pause_requested: number }>(sql,
    "SELECT pause_requested FROM sync_export_controls WHERE season_id=?", seasonId)?.pause_requested ?? 0) === 1;
}

// Checked again inside the transaction that creates a batch, after its Google preflight read.
export function assertExportMayPrepare(sql: SqlStorage, seasonId: string): void {
  if (exportPauseRequested(sql, seasonId)) {
    throw new ApiError("SYNC_EXPORT_PAUSED", "New Google export batches are paused for this season.", 409);
  }
}

export function unfinishedExport(sql: SqlStorage, seasonId: string): { batch_id: string; status: string } | null {
  return firstRow<{ batch_id: string; status: string }>(sql,
    `SELECT batch_id,status FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
     AND status IN ('PREPARED','SENT','PARTIAL','FAILED') ORDER BY created_at,batch_id LIMIT 1`, seasonId) ?? null;
}
