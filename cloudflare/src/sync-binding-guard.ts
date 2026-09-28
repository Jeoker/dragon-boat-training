import { ApiError } from "./http";
import { firstRow, type SqlRow } from "./c1-support";

// Both core and sync imports may advance the binding. Neither can strand an in-flight export.
export function assertNoUnfinishedExportBeforeRebinding(sql: SqlStorage, seasonId: string,
  previousVersion: number, nextVersion: number): void {
  if (nextVersion <= previousVersion) return;
  // Older C1-only databases do not have the C2 batch table yet.
  const table = firstRow<SqlRow>(sql,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_batches'");
  if (!table) return;
  const unfinished = firstRow<SqlRow>(sql,
    `SELECT batch_id FROM sync_batches WHERE season_id=?
     AND direction='CLOUDFLARE_TO_GOOGLE'
     AND status IN ('PREPARED','SENT','PARTIAL','FAILED') LIMIT 1`, seasonId);
  if (unfinished) {
    throw new ApiError("IMPORT_CONFLICT",
      "An unfinished Google export must be verified before advancing the season binding.", 409);
  }
}
