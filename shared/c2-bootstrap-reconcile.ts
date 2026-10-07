import { verifyBusinessBackup } from "./c2-business-backup";
import { BACKUP_TABLES } from "./c2-business-backup-tables";
import { canonicalJson } from "./c1-rules";
import { sha256Base64Url } from "../cloudflare/src/crypto";

const fail = (): never => { throw Error("BOOTSTRAP_RECONCILIATION_UNCONFIRMED"); };
type Row = Record<string, string | number | null>;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function time(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) fail();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail();
  return parsed;
}

/** Fixed first-release protocol: no business edits, login/logout or rotation
 * between snapshots. Only the first snapshot's own append-only bookkeeping
 * can have appeared by the time the second snapshot captures its rows. */
export async function reconcileBootstrapBackups(beforeBundle: unknown, beforeDigest: string,
  afterBundle: unknown, afterDigest: string, expected: { actor_id: string; backup_request_id: string; generation: string; writer_epoch: number }) {
  const before = await verifyBusinessBackup(beforeBundle), after = await verifyBusinessBackup(afterBundle);
  if (before.sourceSchemaVersion !== 14 || after.sourceSchemaVersion !== 16 ||
    before.manifest.content_digest !== beforeDigest || after.manifest.content_digest !== afterDigest ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(expected.actor_id) || !/^[A-Za-z0-9_-]{8,128}$/u.test(expected.backup_request_id) ||
    expected.generation !== "cf-c2-isolated-1" || expected.writer_epoch !== 0) fail();
  const start = time(before.manifest.created_at), end = time(after.manifest.created_at);
  if (end <= start || end - start > 3_600_000) fail();
  const within = (value: unknown) => { const at = time(value); if (at < start || at > end) fail(); };
  const differences: Array<{ table: string; appended_rows: number }> = [];
  let originalCount = 0;
  const appends = new Map<string, Row[]>();
  for (const table of BACKUP_TABLES.slice(0, 47)) {
    const original = before.tables.get(table)!;
    originalCount += original.length;
    const remaining = new Map<string, number>();
    for (const row of original) {
      const changed = table === "app_meta" && row.key === "schema_version" ? { ...row, value: "16" } : row;
      const text = canonicalJson(changed); remaining.set(text, (remaining.get(text) ?? 0) + 1);
    }
    const added: Row[] = [];
    for (const row of after.tables.get(table)!) {
      const text = canonicalJson(row), n = remaining.get(text) ?? 0;
      if (n) remaining.set(text, n - 1); else added.push(row);
    }
    if ([...remaining.values()].some(n => n !== 0)) fail();
    if (added.length && !["system_requests", "audit_events", "scheduled_jobs"].includes(table)) fail();
    if (added.length) { appends.set(table, added); differences.push({ table, appended_rows: added.length }); }
  }
  for (const table of BACKUP_TABLES.slice(47)) if (after.tables.get(table)!.length) fail();
  const requests = appends.get("system_requests") ?? [], audits = appends.get("audit_events") ?? [], jobs = appends.get("scheduled_jobs") ?? [];
  if (requests.length !== 1 || audits.length !== 1 || jobs.length !== 1) fail();
  const request = requests[0], audit = audits[0], job = jobs[0];
  const requestKey = `req_v2_${await sha256Base64Url(`pentasus-c2-test\n${expected.actor_id}\ncreateBackupSnapshot\n${expected.backup_request_id}`)}`;
  if (request.actor_scope !== expected.actor_id || request.action !== "createBackupSnapshot" || request.request_id !== expected.backup_request_id ||
    request.status !== "COMPLETED" || request.request_key !== requestKey || before.manifest.snapshot_id !== `backup_${requestKey.slice(-32)}` ||
    request.payload_digest !== `sha256_v1:${await sha256Base64Url(canonicalJson({ schema_version: 14, backup_format: "sqlite-json-chunks-v1" }))}` ||
    audit.actor_scope !== expected.actor_id || audit.action !== "createBackupSnapshot" || audit.request_key !== request.request_key ||
    audit.event_id !== `event_${await sha256Base64Url(`${requestKey}\nsucceeded`)}` || audit.season_id !== null ||
    job.job_id !== `backup_finalize:${before.manifest.snapshot_id}` || job.job_type !== "FINALIZE_BACKUP_SNAPSHOT" || job.status !== "COMPLETED" ||
    job.last_error !== "" || job.lease_token !== null || job.lease_until_ms !== null) fail();
  within(request.created_at); within(request.completed_at); within(audit.created_at); within(job.created_at); within(job.updated_at); within(job.completed_at);
  let saved: any, details: any, payload: any;
  try { saved = JSON.parse(String(request.result_json)); details = JSON.parse(String(audit.details_json)); payload = JSON.parse(String(job.payload_json)); }
  catch { fail(); }
  if (!equal(saved, { operation: { action: "createBackupSnapshot", request_id: expected.backup_request_id, committed_at: request.completed_at },
      result: { snapshot_id: before.manifest.snapshot_id, manifest: before.manifest } }) ||
    !equal(details, { snapshot_id: before.manifest.snapshot_id, record_count: before.manifest.record_count, content_digest: beforeDigest }) ||
    !equal(payload, { backend_generation: expected.generation, writer_epoch: expected.writer_epoch, snapshot_id: before.manifest.snapshot_id })) fail();
  return { status: "BOOTSTRAP_RECONCILIATION_CONFIRMED", from_schema: 14, to_schema: 16, original_tables: 47,
    original_rows_preserved: originalCount, schema_marker_only_changed: true, operational_appends: differences,
    new_tables_empty: [...BACKUP_TABLES.slice(47)], before_digest: beforeDigest, after_digest: afterDigest,
    source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, verification: "PROTECTED_SNAPSHOT_COMPARISON_ONLY" };
}
