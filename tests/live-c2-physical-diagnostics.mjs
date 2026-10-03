// Isolated c2test-only diagnostic acceptance. Backup phase writes DO backup
// metadata/chunks and a private local file, but no Google or business rows.
// The optional legacy semantic check can update sync_conflicts (the existing API contract).
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
assert.ok(["preflight", "backup", "diagnose"].includes(phase), "Choose a diagnostic phase.");
const semantic = process.argv.includes("--include-semantic-check");
assert.ok(!semantic || phase === "diagnose", "Legacy semantic check is only part of diagnose.");
if (phase === "backup") assert.ok(process.argv.includes("--capture-private-backup"),
  "A private backup requires an explicit flag.");
const root = new URL("../../.c2-form-test/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("private-test-config.json", root), "utf8")).fixture;
const identities = JSON.parse(readFileSync(new URL("isolated-identities.json", root), "utf8"));
const { coach_code: coachCode } = JSON.parse(readFileSync(new URL("review-private.json", root), "utf8"));
const { GOOGLE_BRIDGE_URL: bridgeUrlText, GOOGLE_BRIDGE_SECRET: bridgeSecret } = JSON.parse(
  readFileSync(new URL("worker-secrets.json", root), "utf8"));
const worker = new URL(process.env.C2_TEST_URL || "");
const bridge = new URL(bridgeUrlText);
const seasonId = "season_c2_isolated_2026";
const teamId = "pentasus-c2-test";
const expectedVersion = phase === "diagnose" ? "0.16.2-c2-physical-diagnostics" :
  "0.16.1-c2-associated-export";
assert.equal(worker.href, "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/");
assert.equal(fixture.seasonId, seasonId);
assert.equal(fixture.runtimeSheetId, process.env.C2_RUNTIME_SHEET_ID);
assert.ok(fixture.systemSheetId && fixture.runtimeSheetId && fixture.systemSheetId !== fixture.runtimeSheetId);
assert.equal(bridge.protocol, "https:");
assert.equal(bridge.hostname, "script.google.com");
assert.ok(/^[A-Za-z0-9_-]{30,}$/u.test(identities.deployment_id));
assert.ok(bridge.pathname.includes(identities.deployment_id));
assert.ok(coachCode && bridgeSecret && process.env.C1_TEST_KEY && process.env.C2_TEST_KEY);

const config = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
assert.equal(config.env.c2test.name, "dragon-boat-training-api-c2-test");
assert.equal(config.env.c2test.vars.BACKEND_INSTANCE, "dragon-boat-training-c2-test");
assert.equal(config.env.c2test.vars.TEAM_ID, teamId);
assert.equal(config.env.c2test.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.deepEqual(config.env.c2test.triggers.crons, []);
assert.equal(config.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.equal(config.vars.C2_ASSOCIATED_EXPORT_ENABLED, "false");
assert.equal(config.env.production.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.equal(config.env.production.vars.C2_ASSOCIATED_EXPORT_ENABLED, "false");
assert.deepEqual(config.env.production.triggers.crons, []);
if (phase === "diagnose") assert.equal(config.env.c2test.vars.SERVICE_VERSION, expectedVersion);

const id = (label) => `c2_phys_${label}_${randomUUID().replaceAll("-", "")}`;
const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` :
  value && typeof value === "object" ? `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}` :
    JSON.stringify(value);
const sha = (value) => createHash("sha256").update(value).digest("base64url");
const expected = {
  SIGNUP: { tab: "SignupsCurrent", rows: 1, headers: ["season_id", "practice_id", "member_id",
    "preference", "status", "queue_at", "queue_sequence", "updated_at", "last_request_id"] },
  SEAT_PLAN_DRAFT: { tab: "SeatPlanState", rows: 1, physicalRows: 21,
    headers: ["season_id", "practice_id", "seat_plan_version", "coach_member_id",
      "steerer_member_id", "published_revision", "frozen_revision", "frozen_at", "updated_by", "updated_at"] },
  SEAT_PLAN_CURRENT: { tab: "SeatPlanCurrent", rows: 20,
    headers: ["season_id", "practice_id", "row_number", "side", "member_id",
      "seat_plan_version", "updated_by", "updated_at"] },
  SEAT_PLAN_REVISION: { tab: "SeatPlanRevisions", rows: 1,
    headers: ["season_id", "practice_id", "revision_number", "revision_id", "source",
      "seat_plan_version", "coach_member_id", "steerer_member_id", "seats_json", "names_json",
      "published_by", "published_at", "request_id"] }
};
const artifactDir = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
const backupReference = new URL("c2-physical-backup-reference.json", artifactDir);

async function api(path, key, payload) {
  const response = await fetch(new URL(path, worker), { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: id("api"), ...payload }), signal: AbortSignal.timeout(45_000) });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(body.meta?.service_version, expectedVersion);
  if (!response.ok || !body.ok) throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  return body.data;
}
async function bridgeRead(scope) {
  const payload_json = JSON.stringify({ season_id: seasonId, entity_type: scope });
  const request = { action: "cloudflareReadSheetRecords", request_id: id("bridge"),
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE", team_id: teamId,
    binding_version: `${seasonId}:1`, writer_epoch: 0, timestamp_ms: Date.now(),
    nonce: id("nonce"), operation_id: id("operation"), payload_json,
    payload_digest: sha(payload_json) };
  const signature = createHmac("sha256", bridgeSecret).update([
    request.protocol_version, request.direction, request.team_id, request.binding_version,
    request.writer_epoch, request.timestamp_ms, request.nonce, request.operation_id,
    request.payload_digest
  ].join("\n")).digest("base64url");
  const response = await fetch(bridge, { method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...request, signature }), redirect: "follow",
    signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${scope}: ${body.error?.code}`);
  assert.equal(body.ok, true, `${scope}: ${body.error?.code}`);
  const page = body.data;
  assert.equal(page.team_id, teamId);
  assert.equal(page.season_id, seasonId);
  assert.equal(page.entity_type, scope);
  assert.equal(body.meta?.request_id, request.request_id);
  assert.equal(page.operation_id, request.operation_id);
  assert.equal(page.payload_digest, request.payload_digest);
  assert.equal(page.binding_version, 1);
  assert.equal(page.writer_epoch, 0);
  assert.equal(page.spreadsheet_id, fixture.runtimeSheetId);
  assert.equal(page.tab_name, expected[scope].tab);
  assert.deepEqual(page.headers, expected[scope].headers);
  assert.ok(/^\d+$/u.test(page.tab_id));
  assert.equal(page.rows.length, expected[scope].rows);
  assert.ok(page.rows.every((row) => row.cells?.[0] === seasonId));
  return page;
}
function validateBackupFile(path) {
  const { manifest, chunks } = JSON.parse(readFileSync(path, "utf8"));
  const { content_digest: contentDigest, ...core } = manifest;
  assert.equal(contentDigest, `sha256_v1:${sha(canonicalJson(core))}`,
    "The full local manifest digest changed.");
  assert.equal(manifest.format, "sqlite-json-chunks-v1");
  assert.ok(Number.isFinite(Date.parse(manifest.created_at)));
  assert.ok(Date.parse(manifest.created_at) <= Date.now() + 5 * 60_000);
  assert.equal(manifest.schema_version, 13);
  assert.equal(manifest.table_count, manifest.tables.length);
  assert.equal(chunks.length, manifest.chunk_count);
  assert.equal(manifest.chunks.length, chunks.length);
  assert.ok(manifest.tables.some((table) => table.name === "sync_associated_physical_baselines"));
  assert.ok(manifest.tables.some((table) => table.name === "sync_associated_cursors"));
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.chunk_index, index);
    assert.equal(chunk.payload_digest, `sha256_v1:${sha(canonicalJson(chunk.payload))}`);
    assert.deepEqual(manifest.chunks[index], {
      chunk_index: chunk.chunk_index, table_name: chunk.table_name,
      row_offset: chunk.row_offset, row_count: chunk.row_count,
      payload_digest: chunk.payload_digest
    });
  }
  return { manifest, summary: { captured_at: manifest.created_at,
    schema_version: 13, chunk_count: chunks.length, manifest_and_chunks_verified: true } };
}
function latestBackup() {
  const dir = fileURLToPath(artifactDir);
  const files = readdirSync(dir).filter((name) => /^backup_.*\.json$/u.test(name))
    .map((name) => ({ path: join(dir, name), time: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  assert.ok(files.length, "A private predeployment backup is required.");
  return { ...validateBackupFile(files[0].path).summary,
    captured_at_local_file: new Date(files[0].time).toISOString() };
}
async function verifyReferencedBackup(token) {
  const reference = JSON.parse(readFileSync(backupReference, "utf8"));
  assert.equal(reference.worker_url, worker.href);
  assert.equal(reference.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(reference.team_id, teamId);
  assert.equal(reference.season_id, seasonId);
  assert.equal(reference.runtime_spreadsheet_id, fixture.runtimeSheetId);
  assert.equal(reference.system_spreadsheet_id, fixture.systemSheetId);
  assert.equal(reference.google_deployment_id, identities.deployment_id);
  assert.equal(reference.schema_version, 13);
  assert.equal(reference.service_version_at_capture, "0.16.1-c2-associated-export");
  assert.match(reference.snapshot_id, /^backup_[A-Za-z0-9_-]+$/u);
  const { manifest, summary } = validateBackupFile(new URL(`${reference.snapshot_id}.json`, artifactDir));
  assert.equal(reference.snapshot_id, manifest.snapshot_id);
  assert.equal(reference.content_digest, manifest.content_digest);
  assert.equal(reference.created_at, manifest.created_at);
  const verified = await api("/internal/c1/verify-backup-snapshot", process.env.C1_TEST_KEY,
    { session_token: token, snapshot_id: reference.snapshot_id,
      content_digest: reference.content_digest });
  assert.equal(verified.snapshot_id, reference.snapshot_id);
  assert.equal(verified.verified, true);
  assert.equal(verified.expected_content_digest, reference.content_digest);
  assert.equal(verified.chunk_count, manifest.chunk_count);
  return { ...summary, same_isolated_do_verified: true };
}

const healthResponse = await fetch(new URL("/health", worker), { signal: AbortSignal.timeout(20_000) });
const health = await healthResponse.json();
assert.equal(healthResponse.status, 200);
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.service_version, expectedVersion);
assert.equal(health.meta?.writer_epoch, 0);
const login = await api("/internal/c1/coach-login", process.env.C1_TEST_KEY, { coach_code: coachCode });
const token = login.result.session_token;
let result;
try {
  const overview = await api("/internal/c2/get-sync-overview", process.env.C2_TEST_KEY,
    { session_token: token, season_id: seasonId });
  assert.equal(overview.schema_version, 13);
  assert.equal(overview.binding_current, true);
  assert.equal(overview.binding.binding_version, 1);
  assert.equal(overview.binding.runtime_spreadsheet_id, fixture.runtimeSheetId);
  assert.equal(overview.counts.pending_outbox, 0);
  assert.equal(overview.counts.pending_batches, 0);
  assert.equal(overview.counts.open_conflicts, 0);
  assert.equal(overview.export_control.status, "RUNNING");
  assert.equal(overview.export_control.pause_requested, false);
  // 0.16.1 can expose a historical idle retry row; 0.16.2 hides it in overview
  // without silently claiming that the persisted row was deleted.
  if (overview.export_control.retry) {
    assert.ok(["preflight", "backup"].includes(phase));
    assert.equal(overview.export_control.retry.failure_count, 0);
    assert.equal(overview.export_control.retry.action_required, false);
    assert.equal(overview.export_control.retry.last_error, "");
  }
  const pages = {};
  for (const scope of Object.keys(expected)) pages[scope] = await bridgeRead(scope);
  const rosterUrl = new URL("/internal/c1/public-roster", worker);
  rosterUrl.searchParams.set("request_id", id("roster"));
  rosterUrl.searchParams.set("season_id", seasonId);
  const rosterResponse = await fetch(rosterUrl, {
    headers: { authorization: `Bearer ${process.env.C1_TEST_KEY}` }, signal: AbortSignal.timeout(30_000) });
  const roster = await rosterResponse.json();
  assert.equal(rosterResponse.status, 200);
  assert.equal(roster.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(roster.data?.members?.length, 10);
  assert.ok(roster.data.members.every((member) => /^C2 Test Member /u.test(member.display_name)));
  const practiceIds = new Set(pages.SEAT_PLAN_CURRENT.rows.map((row) => row.cells[1]));
  assert.equal(practiceIds.size, 1);
  const practiceId = [...practiceIds][0];
  assert.ok(Object.keys(expected).every((scope) =>
    pages[scope].rows.every((row) => row.cells[1] === practiceId)));
  assert.equal(pages.SEAT_PLAN_CURRENT.rows.filter((row) => row.cells[4]).length, 1);
  assert.equal(pages.SEAT_PLAN_REVISION.rows[0].cells[2], "1");
  const backup = phase === "diagnose" ? await verifyReferencedBackup(token) : latestBackup();
  if (phase === "backup") {
    const created = await api("/internal/c1/create-backup-snapshot", process.env.C1_TEST_KEY,
      { session_token: token });
    const manifest = created.result.manifest;
    assert.equal(manifest.schema_version, 13);
    assert.ok(Date.parse(manifest.created_at) >= Date.now() - 2 * 60_000);
    const verified = await api("/internal/c1/verify-backup-snapshot", process.env.C1_TEST_KEY,
      { session_token: token, snapshot_id: manifest.snapshot_id,
        content_digest: manifest.content_digest });
    assert.equal(verified.verified, true);
    assert.equal(verified.snapshot_id, manifest.snapshot_id);
    assert.equal(verified.expected_content_digest, manifest.content_digest);
    assert.equal(verified.chunk_count, manifest.chunk_count);
    const chunks = [];
    for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index += 1) {
      const read = await api("/internal/c1/get-backup-chunk", process.env.C1_TEST_KEY,
        { session_token: token, snapshot_id: manifest.snapshot_id, chunk_index });
      assert.equal(read.chunk.payload_digest, `sha256_v1:${sha(canonicalJson(read.chunk.payload))}`);
      chunks.push(read.chunk);
    }
    mkdirSync(fileURLToPath(artifactDir), { recursive: true });
    const snapshotFile = new URL(`${manifest.snapshot_id}.json`, artifactDir);
    writeFileSync(snapshotFile,
      `${JSON.stringify({ manifest, chunks }, null, 2)}\n`, { flag: "wx" });
    validateBackupFile(snapshotFile);
    const afterBackup = await api("/internal/c2/get-sync-overview", process.env.C2_TEST_KEY,
      { session_token: token, season_id: seasonId });
    assert.equal(afterBackup.counts.pending_outbox, 0);
    assert.equal(afterBackup.counts.pending_batches, 0);
    assert.equal(afterBackup.counts.open_conflicts, 0);
    writeFileSync(backupReference, `${JSON.stringify({
      snapshot_id: manifest.snapshot_id, content_digest: manifest.content_digest,
      created_at: manifest.created_at, schema_version: 13,
      service_version_at_capture: expectedVersion, worker_url: worker.href,
      backend_instance: "dragon-boat-training-c2-test", team_id: teamId,
      season_id: seasonId, runtime_spreadsheet_id: fixture.runtimeSheetId,
      system_spreadsheet_id: fixture.systemSheetId,
      google_deployment_id: identities.deployment_id
    }, null, 2)}\n`);
    await verifyReferencedBackup(token);
    result = { phase, verified: true, downloaded_private: true,
      chunk_count: chunks.length, schema_version: 13, same_isolated_do_verified: true };
  } else if (phase === "preflight") {
    result = { phase, service_version: expectedVersion, schema_version: 13,
      google_rows: Object.fromEntries(Object.entries(expected).map(([scope, value]) =>
        [scope, value.rows])), pending_outbox: 0, pending_batches: 0,
      historical_idle_retry_visible: Boolean(overview.export_control.retry), backup };
  } else {
    assert.equal(overview.export_control.retry, null);
    const physical = {};
    for (const scope of Object.keys(expected)) {
      const checked = await api("/internal/c2/check-associated-physical-differences",
        process.env.C2_TEST_KEY, { session_token: token, season_id: seasonId, scope });
      assert.equal(checked.scope, scope);
      assert.equal(checked.status, "OK", `${scope} physical status`);
      assert.equal(checked.coverage, "complete");
      assert.equal(checked.findings_count, 0);
      assert.equal(checked.truncated, false);
      assert.equal(checked.rows_read, expected[scope].physicalRows ?? expected[scope].rows);
      assert.equal(checked.baselines_checked, checked.rows_read);
      physical[scope] = { status: checked.status, rows_read: checked.rows_read,
        baselines_checked: checked.baselines_checked };
    }
    const legacy = {};
    if (semantic) for (const entity_type of ["SIGNUP", "SEAT_PLAN_DRAFT"]) {
      const checked = await api("/internal/c2/check-sheet-differences", process.env.C2_TEST_KEY,
        { session_token: token, season_id: seasonId, entity_type });
      assert.equal(checked.status, "OK");
      assert.equal(checked.findings_count, 0);
      assert.equal(checked.truncated, false);
      assert.equal(checked.rows_read, expected[entity_type].physicalRows ?? expected[entity_type].rows);
      assert.equal(checked.physical_integrity?.status, "OK");
      assert.equal(checked.physical_integrity?.rows_read,
        expected[entity_type].physicalRows ?? expected[entity_type].rows);
      assert.equal(checked.physical_integrity?.findings_count, 0);
      legacy[entity_type] = { semantic_status: checked.status, findings_count: 0,
        physical_status: checked.physical_integrity.status,
        rows_read: checked.rows_read };
    }
    const after = await api("/internal/c2/get-sync-overview", process.env.C2_TEST_KEY,
      { session_token: token, season_id: seasonId });
    assert.equal(after.counts.pending_outbox, 0);
    assert.equal(after.counts.pending_batches, 0);
    assert.equal(after.counts.open_conflicts, 0);
    result = { phase, physical, legacy: semantic ? legacy : "not_requested",
      pending_outbox: 0, pending_batches: 0, open_conflicts: 0,
      historical_idle_retry_hidden_in_overview: after.export_control.retry === null, backup };
  }
} finally {
  await api("/internal/c1/coach-logout", process.env.C1_TEST_KEY, { session_token: token });
}
console.log(JSON.stringify({ status: "passed", ...result, coach_logged_out: true }));
