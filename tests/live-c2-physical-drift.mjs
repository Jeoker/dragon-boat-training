// C2 fictitious-season single-cell Google drift and exact CAS recovery.
// Phases are intentionally separate; no Google write without --write-test-data.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
assert.ok(["prepare", "inject", "retry-inject", "inspect-state", "inspect-drift",
  "restore", "retry-restore", "final"].includes(phase), "Choose one drift phase.");
if (["inject", "retry-inject", "restore", "retry-restore"].includes(phase)) {
  assert.ok(process.argv.includes("--write-test-data"), "Explicit Google test-write flag required.");
}
if (["inspect-drift", "final"].includes(phase)) {
  assert.ok(process.argv.includes("--allow-semantic-inspection-write"),
    "The old semantic API maintains sync_conflicts; acknowledge this separate write.");
}
if (phase === "final") assert.ok(process.argv.includes("--capture-private-backup"),
  "Final whole-table B comparison requires an explicit private backup flag.");

const root = new URL("../../.c2-form-test/", import.meta.url);
const artifactDir = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
const stateUrl = new URL("c2-physical-drift-state.json", artifactDir);
const reference = JSON.parse(readFileSync(new URL("c2-physical-backup-reference.json", artifactDir), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("private-test-config.json", root), "utf8")).fixture;
const identities = JSON.parse(readFileSync(new URL("isolated-identities.json", root), "utf8"));
const { coach_code: coachCode } = JSON.parse(readFileSync(new URL("review-private.json", root), "utf8"));
const { GOOGLE_BRIDGE_URL: bridgeUrlText, GOOGLE_BRIDGE_SECRET: bridgeSecret } = JSON.parse(
  readFileSync(new URL("worker-secrets.json", root), "utf8"));
const worker = new URL(process.env.C2_TEST_URL || "");
const bridge = new URL(bridgeUrlText);
const seasonId = "season_c2_isolated_2026";
const teamId = "pentasus-c2-test";
const version = "0.16.2-c2-physical-diagnostics";
const config = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
assert.equal(worker.href, "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/");
assert.equal(fixture.seasonId, seasonId);
assert.equal(fixture.runtimeSheetId, process.env.C2_RUNTIME_SHEET_ID);
assert.ok(fixture.systemSheetId && fixture.runtimeSheetId !== fixture.systemSheetId);
assert.equal(bridge.hostname, "script.google.com");
assert.equal(bridge.protocol, "https:");
assert.ok(bridge.pathname.includes(identities.deployment_id));
assert.equal(config.env.c2test.name, "dragon-boat-training-api-c2-test");
assert.equal(config.env.c2test.vars.BACKEND_INSTANCE, "dragon-boat-training-c2-test");
assert.equal(config.env.c2test.vars.TEAM_ID, teamId);
assert.equal(config.env.c2test.vars.SERVICE_VERSION, version);
assert.equal(config.env.c2test.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.deepEqual(config.env.c2test.triggers.crons, []);
assert.equal(config.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.equal(config.env.production.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.ok(coachCode && bridgeSecret && process.env.C1_TEST_KEY && process.env.C2_TEST_KEY);
assert.equal(reference.worker_url, worker.href);
assert.equal(reference.backend_instance, "dragon-boat-training-c2-test");
assert.equal(reference.team_id, teamId);
assert.equal(reference.season_id, seasonId);
assert.equal(reference.runtime_spreadsheet_id, fixture.runtimeSheetId);
assert.equal(reference.system_spreadsheet_id, fixture.systemSheetId);
assert.equal(reference.google_deployment_id, identities.deployment_id);
assert.match(reference.snapshot_id, /^backup_[A-Za-z0-9_-]+$/u);

const specs = {
  SIGNUP: { tab: "SignupsCurrent", count: 1, headers: ["season_id", "practice_id", "member_id",
    "preference", "status", "queue_at", "queue_sequence", "updated_at", "last_request_id"] },
  SEAT_PLAN_DRAFT: { tab: "SeatPlanState", count: 1, headers: ["season_id", "practice_id",
    "seat_plan_version", "coach_member_id", "steerer_member_id", "published_revision",
    "frozen_revision", "frozen_at", "updated_by", "updated_at"] },
  SEAT_PLAN_CURRENT: { tab: "SeatPlanCurrent", count: 20, headers: ["season_id", "practice_id",
    "row_number", "side", "member_id", "seat_plan_version", "updated_by", "updated_at"] },
  SEAT_PLAN_REVISION: { tab: "SeatPlanRevisions", count: 1, headers: ["season_id", "practice_id",
    "revision_number", "revision_id", "source", "seat_plan_version", "coach_member_id",
    "steerer_member_id", "seats_json", "names_json", "published_by", "published_at", "request_id"] }
};
const id = (name) => `c2_drift_${name}_${randomUUID().replaceAll("-", "")}`;
const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` :
  value && typeof value === "object" ? `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}` :
    JSON.stringify(value);
const sha = (value) => createHash("sha256").update(value).digest("base64url");
const cellsDigest = (cells) => `sha256_v1:${sha(canonicalJson(cells))}`;
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);

function saveState(state, create = false) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (create) return writeFileSync(stateUrl, text, { flag: "wx" });
  const temporary = new URL(`c2-physical-drift-state.${randomUUID()}.tmp`, artifactDir);
  writeFileSync(temporary, text, { flag: "wx" });
  renameSync(fileURLToPath(temporary), fileURLToPath(stateUrl));
}
function loadState() {
  const state = JSON.parse(readFileSync(stateUrl, "utf8"));
  assert.equal(state.season_id, seasonId);
  assert.equal(state.runtime_spreadsheet_id, fixture.runtimeSheetId);
  assert.equal(state.deployment_id, identities.deployment_id);
  assert.equal(state.backup_snapshot_id, reference.snapshot_id);
  assert.equal(state.backup_content_digest, reference.content_digest);
  assert.equal(state.original.length, specs.SIGNUP.headers.length);
  assert.equal(state.target.length, specs.SIGNUP.headers.length);
  assert.equal(state.original[0], seasonId);
  assert.equal(state.original[1], state.practice_id);
  assert.equal(state.original[2], state.member_id);
  assert.equal(state.target[0], seasonId);
  assert.equal(state.target[1], state.practice_id);
  assert.equal(state.target[2], state.member_id);
  assert.equal(state.row_id, `${state.practice_id}:${state.member_id}`);
  assert.equal(state.baseline_digest, cellsDigest(state.original));
  assert.notEqual(state.original[8], state.target[8]);
  assert.ok(state.original.every((cell, index) => index === 8 || cell === state.target[index]));
  assert.equal(state.inject_batch_id, "c2_phys_20260930_inject_alpha");
  assert.equal(state.restore_batch_id, "c2_phys_20260930_restore_alpha");
  return state;
}
async function api(path, key, payload) {
  const response = await fetch(new URL(path, worker), { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: id("api"), ...payload }), signal: AbortSignal.timeout(45_000) });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(body.meta?.service_version, version);
  if (!response.ok || !body.ok) throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  return body.data;
}
async function signedBridge(action, payload, operationId, requestId) {
  const payload_json = JSON.stringify(payload);
  const envelope = { action, request_id: requestId,
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: teamId, binding_version: `${seasonId}:1`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: id("nonce"), operation_id: operationId,
    payload_json, payload_digest: sha(payload_json) };
  const signature = createHmac("sha256", bridgeSecret).update([
    envelope.protocol_version, envelope.direction, envelope.team_id, envelope.binding_version,
    envelope.writer_epoch, envelope.timestamp_ms, envelope.nonce, envelope.operation_id,
    envelope.payload_digest
  ].join("\n")).digest("base64url");
  const response = await fetch(bridge, { method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...envelope, signature }), redirect: "follow",
    signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  if (response.status !== 200 || body.ok !== true) {
    throw new Error(`${action}: HTTP ${response.status}, ${body.error?.code ?? "UNKNOWN"}`);
  }
  assert.equal(body.meta?.request_id, envelope.request_id);
  assert.equal(body.data.team_id, teamId);
  assert.equal(body.data.season_id, seasonId);
  assert.equal(body.data.binding_version, 1);
  assert.equal(body.data.writer_epoch, 0);
  assert.equal(body.data.operation_id, operationId);
  assert.equal(body.data.payload_digest, envelope.payload_digest);
  return body.data;
}
async function bridgeRead(scope) {
  const page = await signedBridge("cloudflareReadSheetRecords",
    { season_id: seasonId, entity_type: scope }, id("read_operation"), id("read_request"));
  assert.equal(page.entity_type, scope);
  assert.equal(page.spreadsheet_id, fixture.runtimeSheetId);
  assert.equal(page.tab_name, specs[scope].tab);
  assert.deepEqual(page.headers, specs[scope].headers);
  assert.match(page.tab_id, /^\d+$/u);
  assert.equal(page.rows.length, specs[scope].count);
  assert.ok(page.rows.every((row) => row.cells[0] === seasonId));
  return page;
}
async function pagesNow() {
  const pages = {};
  for (const scope of Object.keys(specs)) pages[scope] = await bridgeRead(scope);
  return pages;
}
function assertPages(state, pages) {
  for (const scope of Object.keys(specs)) {
    assert.equal(pages[scope].tab_id, state.tab_ids[scope]);
    assert.ok(pages[scope].rows.every((row) => row.cells[1] === state.practice_id));
    if (scope !== "SIGNUP") assert.equal(sha(canonicalJson(pages[scope].rows)), state.other_page_digests[scope]);
  }
  assert.equal(pages.SIGNUP.rows[0].cells[2], state.member_id);
  assert.equal(pages.SIGNUP.rows[0].row_number, state.google_row_number);
  const current = pages.SIGNUP.rows[0].cells;
  if (equal(current, state.original)) return "ORIGINAL";
  if (equal(current, state.target)) return "MARKER";
  throw new Error("The isolated Google signup row differs from both saved CAS states; stop and inspect.");
}
async function overview(token) {
  const value = await api("/internal/c2/get-sync-overview", process.env.C2_TEST_KEY,
    { session_token: token, season_id: seasonId });
  assert.equal(value.schema_version, 13);
  assert.equal(value.binding_current, true);
  assert.equal(value.binding.binding_version, 1);
  assert.equal(value.binding.runtime_spreadsheet_id, fixture.runtimeSheetId);
  assert.equal(value.counts.pending_outbox, 0);
  assert.equal(value.counts.pending_batches, 0);
  assert.equal(value.counts.open_conflicts, 0);
  assert.equal(value.export_control.status, "RUNNING");
  assert.equal(value.export_control.pause_requested, false);
  assert.equal(value.export_control.retry, null); // UI filter, not DB deletion proof.
  return value;
}
async function physical(token, scope) {
  return api("/internal/c2/check-associated-physical-differences", process.env.C2_TEST_KEY,
    { session_token: token, season_id: seasonId, scope });
}
async function physicalOk(token, scope, count) {
  const value = await physical(token, scope);
  assert.equal(value.scope, scope);
  assert.equal(value.status, "OK");
  assert.equal(value.coverage, "complete");
  assert.equal(value.rows_read, count);
  assert.equal(value.baselines_checked, count);
  assert.equal(value.findings_count, 0);
  assert.equal(value.truncated, false);
}
async function physicalSignupDrift(token, state) {
  const current = await physical(token, "SIGNUP");
  assert.equal(current.status, "DRIFT");
  assert.equal(current.coverage, "complete");
  assert.equal(current.rows_read, 1);
  assert.equal(current.baselines_checked, 1);
  assert.equal(current.findings_count, 1);
  assert.equal(current.truncated, false);
  assert.equal(current.findings[0].type, "CELL_CHANGED");
  assert.equal(current.findings[0].row_id, state.row_id);
  assert.deepEqual(current.findings[0].changed_columns, ["last_request_id"]);
  assert.equal(current.findings[0].baseline_digest, state.baseline_digest);
  assert.equal(current.findings[0].google_digest, cellsDigest(state.target));
  return current;
}
async function semantic(token, expectedPhysical) {
  const value = await api("/internal/c2/check-sheet-differences", process.env.C2_TEST_KEY,
    { session_token: token, season_id: seasonId, entity_type: "SIGNUP" });
  assert.equal(value.status, "OK");
  assert.equal(value.findings_count, 0);
  assert.equal(value.truncated, false);
  assert.equal(value.rows_read, 1);
  assert.equal(value.physical_integrity?.status, expectedPhysical);
  return value;
}
function baselineRows(snapshotId) {
  const { manifest, chunks } = JSON.parse(readFileSync(new URL(`${snapshotId}.json`, artifactDir), "utf8"));
  assert.equal(manifest.schema_version, 13);
  assert.equal(manifest.snapshot_id, snapshotId);
  const { content_digest: contentDigest, ...core } = manifest;
  assert.equal(contentDigest, `sha256_v1:${sha(canonicalJson(core))}`);
  assert.equal(chunks.length, manifest.chunk_count);
  const rows = [];
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.chunk_index, index);
    assert.equal(chunk.payload_digest, `sha256_v1:${sha(canonicalJson(chunk.payload))}`);
    assert.deepEqual(manifest.chunks[index], { chunk_index: index, table_name: chunk.table_name,
      row_offset: chunk.row_offset, row_count: chunk.row_count,
      payload_digest: chunk.payload_digest });
    if (chunk.table_name === "sync_associated_physical_baselines") rows.push(...chunk.payload.rows);
  }
  return { manifest, rows: rows.filter((row) => row.season_id === seasonId && row.binding_version === 1)
    .sort((a, b) => `${a.scope}:${a.row_id}`.localeCompare(`${b.scope}:${b.row_id}`)) };
}
async function verifyReference(token) {
  const { manifest, rows } = baselineRows(reference.snapshot_id);
  assert.equal(manifest.content_digest, reference.content_digest);
  assert.equal(manifest.created_at, reference.created_at);
  const verified = await api("/internal/c1/verify-backup-snapshot", process.env.C1_TEST_KEY,
    { session_token: token, snapshot_id: reference.snapshot_id,
      content_digest: reference.content_digest });
  assert.equal(verified.verified, true);
  assert.equal(verified.snapshot_id, reference.snapshot_id);
  assert.equal(verified.expected_content_digest, reference.content_digest);
  assert.equal(rows.length, 23);
  return rows;
}
function assertSavedSignupBaseline(rows, state) {
  const matches = rows.filter((row) => row.scope === "SIGNUP" && row.row_id === state.row_id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].cells_digest, state.baseline_digest);
  assert.deepEqual(JSON.parse(matches[0].cells_json), state.original);
}
async function alphaMember() {
  const url = new URL("/internal/c1/public-roster", worker);
  url.searchParams.set("request_id", id("roster"));
  url.searchParams.set("season_id", seasonId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${process.env.C1_TEST_KEY}` },
    signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(body.data?.members?.length, 10);
  assert.ok(body.data.members.every((member) => /^C2 Test Member /u.test(member.display_name)));
  const matches = body.data.members.filter((member) => member.display_name === "C2 Test Member Alpha");
  assert.equal(matches.length, 1);
  return matches[0].member_id;
}
async function patchSignup(state, direction) {
  const injection = direction === "inject";
  const batchId = injection ? state.inject_batch_id : state.restore_batch_id;
  const expected = injection ? state.original : state.target;
  const target = injection ? state.target : state.original;
  const receipt = await signedBridge("cloudflarePatchSignupSheet", {
    season_id: seasonId, batch_id: batchId, entity_type: "SIGNUP",
    spreadsheet_id: fixture.runtimeSheetId, tab_id: state.tab_ids.SIGNUP,
    items: [{ row_id: state.row_id, expected, target }]
  }, batchId, injection ? "c2_phys_20260930_inject_request" : "c2_phys_20260930_restore_request");
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.entity_type, "SIGNUP");
  assert.equal(receipt.spreadsheet_id, fixture.runtimeSheetId);
  assert.equal(receipt.tab_id, state.tab_ids.SIGNUP);
  assert.deepEqual(receipt.verified_row_ids, [state.row_id]);
}
function mark(state, status) {
  state.status = status;
  state.updated_at = new Date().toISOString();
  saveState(state);
}
function cooldown(state) {
  assert.ok(Date.now() - Date.parse(state.updated_at) >= 90_000,
    "Wait at least 90 seconds after an uncertain bridge result before a same-batch retry.");
}
async function makeFinalBackup(token, originalBaselines) {
  const created = await api("/internal/c1/create-backup-snapshot", process.env.C1_TEST_KEY,
    { session_token: token });
  const manifest = created.result.manifest;
  assert.equal(manifest.schema_version, 13);
  const verified = await api("/internal/c1/verify-backup-snapshot", process.env.C1_TEST_KEY,
    { session_token: token, snapshot_id: manifest.snapshot_id, content_digest: manifest.content_digest });
  assert.equal(verified.verified, true);
  const chunks = [];
  for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index += 1) {
    const read = await api("/internal/c1/get-backup-chunk", process.env.C1_TEST_KEY,
      { session_token: token, snapshot_id: manifest.snapshot_id, chunk_index });
    assert.equal(read.chunk.payload_digest, `sha256_v1:${sha(canonicalJson(read.chunk.payload))}`);
    chunks.push(read.chunk);
  }
  writeFileSync(new URL(`${manifest.snapshot_id}.json`, artifactDir),
    `${JSON.stringify({ manifest, chunks }, null, 2)}\n`, { flag: "wx" });
  const after = baselineRows(manifest.snapshot_id);
  assert.ok(equal(after.rows, originalBaselines), "The whole associated physical B table changed.");
  return { chunk_count: chunks.length, physical_baseline_rows_unchanged: after.rows.length };
}

const healthResponse = await fetch(new URL("/health", worker), { signal: AbortSignal.timeout(20_000) });
const health = await healthResponse.json();
assert.equal(healthResponse.status, 200);
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.service_version, version);
assert.equal(health.meta?.writer_epoch, 0);
const login = await api("/internal/c1/coach-login", process.env.C1_TEST_KEY, { coach_code: coachCode });
const token = login.result.session_token;
let result;
try {
  await overview(token);
  const originalBaselines = await verifyReference(token);
  const pages = await pagesNow();
  const alphaId = await alphaMember();
  if (phase === "prepare") {
    assert.equal(existsSync(stateUrl), false, "A prior private drift state must be resolved first.");
    const signup = pages.SIGNUP.rows[0];
    assert.equal(signup.cells[2], alphaId);
    assert.equal(signup.cells[0], seasonId);
    assert.equal(signup.cells[3], "LEFT");
    assert.equal(signup.cells[4], "CONFIRMED");
    const rowId = `${signup.cells[1]}:${alphaId}`;
    const matches = originalBaselines.filter((row) => row.scope === "SIGNUP" && row.row_id === rowId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].cells_digest, cellsDigest(signup.cells));
    assert.deepEqual(JSON.parse(matches[0].cells_json), signup.cells);
    for (const [scope, count] of [["SIGNUP", 1], ["SEAT_PLAN_DRAFT", 21],
      ["SEAT_PLAN_CURRENT", 20], ["SEAT_PLAN_REVISION", 1]]) await physicalOk(token, scope, count);
    const target = [...signup.cells];
    target[8] = "c2_phys_drift_20260930_alpha";
    assert.notEqual(target[8], signup.cells[8]);
    const state = { status: "PREPARED", created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), season_id: seasonId,
      runtime_spreadsheet_id: fixture.runtimeSheetId, deployment_id: identities.deployment_id,
      backup_snapshot_id: reference.snapshot_id, backup_content_digest: reference.content_digest,
      practice_id: signup.cells[1], member_id: alphaId, row_id: rowId,
      google_row_number: signup.row_number,
      tab_ids: Object.fromEntries(Object.entries(pages).map(([scope, page]) => [scope, page.tab_id])),
      other_page_digests: Object.fromEntries(Object.entries(pages)
        .filter(([scope]) => scope !== "SIGNUP").map(([scope, page]) =>
          [scope, sha(canonicalJson(page.rows))])),
      original: [...signup.cells], target, baseline_digest: matches[0].cells_digest,
      baseline_table_digest: sha(canonicalJson(originalBaselines)),
      inject_batch_id: "c2_phys_20260930_inject_alpha",
      restore_batch_id: "c2_phys_20260930_restore_alpha" };
    saveState(state, true);
    result = { phase, status: "PREPARED", single_row_locked: true,
      single_column: "last_request_id", baseline_rows: originalBaselines.length };
  } else {
    const state = loadState();
    assert.equal(state.member_id, alphaId);
    assert.equal(sha(canonicalJson(originalBaselines)), state.baseline_table_digest);
    assertSavedSignupBaseline(originalBaselines, state);
    const google = assertPages(state, pages);
    if (phase === "inspect-state") {
      if (["INJECTION_ATTEMPTED", "INJECTION_UNKNOWN"].includes(state.status) && google === "MARKER") {
        mark(state, "INJECTED");
      } else if (["RESTORE_ATTEMPTED", "RESTORE_UNKNOWN"].includes(state.status) && google === "ORIGINAL") {
        mark(state, "RESTORED");
      }
      result = { phase, saved_status: state.status, google_state: google,
        single_row_locked: true };
    } else if (phase === "inject" || phase === "retry-inject") {
      assert.equal(google, "ORIGINAL");
      if (phase === "inject") assert.equal(state.status, "PREPARED");
      else {
        assert.ok(["INJECTION_UNKNOWN", "INJECTION_ATTEMPTED"].includes(state.status));
        cooldown(state);
      }
      await physicalOk(token, "SIGNUP", 1);
      mark(state, "INJECTION_ATTEMPTED");
      let error;
      try { await patchSignup(state, "inject"); } catch (caught) { error = caught; }
      const after = assertPages(state, await pagesNow());
      if (after === "MARKER") mark(state, "INJECTED");
      else { mark(state, "INJECTION_UNKNOWN"); throw new Error("Injection has no verified Google marker; stop and inspect later."); }
      result = { phase, google_state: "MARKER", saved_status: state.status,
        recovered_after_uncertain_receipt: Boolean(error) };
    } else if (phase === "inspect-drift") {
      assert.equal(state.status, "INJECTED");
      assert.equal(google, "MARKER");
      await physicalSignupDrift(token, state);
      const old = await semantic(token, "DRIFT");
      assert.equal(old.physical_integrity.findings_count, 1);
      assert.deepEqual(old.physical_integrity.findings[0].changed_columns, ["last_request_id"]);
      await overview(token);
      mark(state, "DRIFT_VERIFIED");
      result = { phase, physical_status: "DRIFT", changed_columns: ["last_request_id"],
        semantic_status: "OK", semantic_findings: 0, semantic_physical_status: "DRIFT" };
    } else if (phase === "restore" || phase === "retry-restore") {
      assert.equal(google, "MARKER", "A marker must be present before restoration CAS.");
      if (phase === "restore") assert.ok(["INJECTED", "DRIFT_VERIFIED"].includes(state.status));
      else { assert.ok(["RESTORE_UNKNOWN", "RESTORE_ATTEMPTED"].includes(state.status)); cooldown(state); }
      await physicalSignupDrift(token, state);
      mark(state, "RESTORE_ATTEMPTED");
      let error;
      try { await patchSignup(state, "restore"); } catch (caught) { error = caught; }
      const after = assertPages(state, await pagesNow());
      if (after === "ORIGINAL") mark(state, "RESTORED");
      else { mark(state, "RESTORE_UNKNOWN"); throw new Error("Restore has no verified original row; stop and inspect later."); }
      result = { phase, google_state: "ORIGINAL", saved_status: state.status,
        recovered_after_uncertain_receipt: Boolean(error) };
    } else if (phase === "final") {
      assert.equal(state.status, "RESTORED");
      assert.equal(google, "ORIGINAL");
      for (const [scope, count] of [["SIGNUP", 1], ["SEAT_PLAN_DRAFT", 21],
        ["SEAT_PLAN_CURRENT", 20], ["SEAT_PLAN_REVISION", 1]]) await physicalOk(token, scope, count);
      const old = await semantic(token, "OK");
      assert.equal(old.physical_integrity.findings_count, 0);
      await overview(token);
      const backup = await makeFinalBackup(token, originalBaselines);
      await overview(token);
      mark(state, "FINAL_VERIFIED");
      result = { phase, physical: "OK_ALL_FOUR", semantic_status: "OK",
        pending_outbox: 0, open_conflicts: 0, backup };
    }
  }
} finally {
  await api("/internal/c1/coach-logout", process.env.C1_TEST_KEY, { session_token: token });
}
console.log(JSON.stringify({ result: "passed", ...result, coach_logged_out: true }));
