import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { build } from "esbuild";

const compiled = await build({ entryPoints: ["backend/backup/runtime.ts"], bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent" });
const r = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=c2-bootstrap-reconcile-runtime.mjs\n").toString("base64")}`);
const hash = v => `sha256_v1:${createHash("sha256").update(r.canonicalJson(v)).digest("base64url")}`;
const at = "2026-10-07T15:00:00.000Z", later = "2026-10-07T15:01:00.000Z";
const context = { actor_id: "coach_c2_isolated_2026", backup_request_id: "backup_first_release_01", generation: "cf-c2-isolated-1", writer_epoch: 0 };
const requestKey = "req_v2_" + createHash("sha256").update(`pentasus-c2-test\n${context.actor_id}\ncreateBackupSnapshot\n${context.backup_request_id}`).digest("base64url");
const snapshot = `backup_${requestKey.slice(-32)}`;
function row(table, values) { return { ...Object.fromEntries(r.BUSINESS_BACKUP_COLUMNS[table].map(key => [key, null])), ...values }; }
function pack(tables, version, time, id) {
  const chunks = [], descriptors = [], definitions = [];
  for (const [table, rows] of Object.entries(tables)) {
    const indices = [];
    for (let offset = 0; offset < rows.length; offset += 100) {
      const payload = { table, row_offset: offset, rows: rows.slice(offset, offset + 100) };
      const descriptor = { chunk_index: chunks.length, table_name: table, row_offset: offset, row_count: payload.rows.length, payload_digest: hash(payload) };
      indices.push(chunks.length); chunks.push({ ...descriptor, payload }); descriptors.push(descriptor);
    }
    definitions.push({ name: table, row_count: rows.length, chunk_indices: indices });
  }
  const core = { snapshot_id: id, schema_version: version, format: "sqlite-json-chunks-v1", created_at: time,
    tables: definitions, table_count: definitions.length, record_count: definitions.reduce((n, t) => n + t.row_count, 0), chunk_count: chunks.length, chunks: descriptors };
  return { manifest: { ...core, content_digest: hash(core) }, chunks };
}
function fixture() {
  const old = Object.fromEntries(r.BACKUP_TABLES.slice(0, 47).map(table => [table, []]));
  old.app_meta = [{ key: "schema_version", value: "14" }];
  old.members = [row("members", { season_id: "season_test_01", member_id: "member_test_01", display_name_override: "PRIVATE_ROW_SENTINEL" })];
  const before = pack(old, 14, at, snapshot), current = Object.fromEntries(r.BACKUP_TABLES.map(table => [table, structuredClone(old[table] ?? [])]));
  current.app_meta[0].value = "16";
  const saved = { operation: { action: "createBackupSnapshot", request_id: context.backup_request_id, committed_at: later }, result: { snapshot_id: snapshot, manifest: before.manifest } };
  current.system_requests.push(row("system_requests", { request_key: requestKey, actor_scope: context.actor_id, action: "createBackupSnapshot", request_id: context.backup_request_id,
    payload_digest: hash({schema_version:14,backup_format:"sqlite-json-chunks-v1"}), status: "COMPLETED", result_json: JSON.stringify(saved), created_at: later, completed_at: later }));
  current.audit_events.push(row("audit_events", { event_id: "event_" + createHash("sha256").update(`${requestKey}\nsucceeded`).digest("base64url"), request_key: requestKey, actor_scope: context.actor_id, action: "createBackupSnapshot",
    details_json: JSON.stringify({ snapshot_id: snapshot, record_count: before.manifest.record_count, content_digest: before.manifest.content_digest }), created_at: later }));
  current.scheduled_jobs.push(row("scheduled_jobs", { job_id: `backup_finalize:${snapshot}`, job_type: "FINALIZE_BACKUP_SNAPSHOT", status: "COMPLETED",
    payload_json: JSON.stringify({ backend_generation: context.generation, writer_epoch: 0, snapshot_id: snapshot }), last_error: "",
    created_at: later, updated_at: later, completed_at: later }));
  return { before, current, after: () => pack(current, 16, "2026-10-07T15:02:00.000Z", "backup_after_release_01") };
}
const verify = (f, overrides = {}) => { const a = f.after(); return r.reconcileBootstrapBackups(f.before,
  overrides.beforeDigest ?? f.before.manifest.content_digest, a, overrides.afterDigest ?? a.manifest.content_digest, overrides.context ?? context); };

test("independently verified first-release snapshots preserve all business rows and admit only the original snapshot bookkeeping", async () => {
  const result = await verify(fixture());
  assert.equal(result.status, "BOOTSTRAP_RECONCILIATION_CONFIRMED");
  assert.equal(result.original_rows_preserved, 2); assert.equal(result.original_tables, 47);
  assert.equal(result.operational_appends.length, 3); assert.equal(result.annual_export_authorized, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ROW_SENTINEL/u);
});
for (const [name, mutate] of [
  ["changed original business row", f => { f.current.members[0].display_name_override = "changed"; }],
  ["missing original row", f => { f.current.members = []; }],
  ["unexpected business append", f => { f.current.members.push(f.current.members[0]); }],
  ["changed actor", f => { f.current.system_requests[0].actor_scope = "another_coach"; }],
  ["unrelated request", f => { f.current.system_requests[0].action = "rotateCoachCode"; }],
  ["wrong audit association", f => { f.current.audit_events[0].request_key = "different_request"; }],
  ["wrong finalization payload", f => { f.current.scheduled_jobs[0].payload_json = "{}"; }],
  ["incomplete job", f => { f.current.scheduled_jobs[0].status = "PENDING"; }],
  ["modified retained manifest", f => { const v = JSON.parse(f.current.system_requests[0].result_json); v.result.manifest.record_count++; f.current.system_requests[0].result_json = JSON.stringify(v); }],
  ["unaccounted second audit", f => { f.current.audit_events.push(f.current.audit_events[0]); }],
  ["added source pin", f => { f.current.source_authority_pins.push(row("source_authority_pins", {})); }],
  ["old operational row mutated", f => { f.before = pack({ ...Object.fromEntries(r.BACKUP_TABLES.slice(0, 47).map(t => [t, []])), app_meta: [{ key: "schema_version", value: "14" }],
    members: f.current.members, usage_snapshots: [row("usage_snapshots", { usage_date: "2026-10-07" })] }, 14, at, snapshot); }]
]) test(`reconciliation rejects ${name} even when the modified package has valid digests`, async () => {
  const f = fixture(); mutate(f);
  await r.verifyBusinessBackup(f.before); await r.verifyBusinessBackup(f.after());
  await assert.rejects(verify(f), /BOOTSTRAP_RECONCILIATION_UNCONFIRMED/u);
});
test("independent digests and fixed authority cannot be adopted from an untrusted package", async () => {
  await assert.rejects(verify(fixture(), { beforeDigest: "sha256_v1:wrong" }));
  await assert.rejects(verify(fixture(), { afterDigest: "sha256_v1:wrong" }));
  await assert.rejects(verify(fixture(), { context: { ...context, writer_epoch: 1 } }));
});
