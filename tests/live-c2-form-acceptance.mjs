import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const allowedHost = "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const url = required("C2_TEST_URL");
const parsedUrl = new URL(url);
if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== allowedHost || parsedUrl.pathname !== "/") {
  throw new Error("C2 acceptance only runs against the dedicated test Worker.");
}
if (!process.argv.includes("--write-test-data")) {
  throw new Error("Pass --write-test-data after checking the isolated Google Form and Worker ownership.");
}
const c1Key = required("C1_TEST_KEY");
const c2Key = required("C2_TEST_KEY");
const formId = required("C2_FORM_ID");
const spreadsheetId = required("C2_RUNTIME_SHEET_ID");
const responseSheetId = required("C2_RESPONSE_SHEET_ID");
const responseSheetName = required("C2_RESPONSE_SHEET_NAME");
const seasonId = "season_c2_isolated_2026";
const coachId = "coach_c2_isolated_2026";
const at = "2026-09-25T12:00:00.000Z";

function required(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} must be set in an ignored local environment file.`);
  return value;
}

function digest(value) {
  return `sha256_v1:${createHash("sha256").update(value).digest("base64url")}`;
}

async function api(path, generation, body) {
  const response = await fetch(`${parsedUrl.origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${generation === "C1" ? c1Key : c2Key}`,
      "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  let value;
  try { value = await response.json(); }
  catch { throw new Error(`${path} returned non-JSON HTTP ${response.status}.`); }
  if (!response.ok || value.ok !== true) {
    throw new Error(`${path} failed with HTTP ${response.status} / ${value.error?.code ?? "unknown"}.`);
  }
  assert.equal(value.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(value.meta?.writer_epoch, 0);
  return value.data;
}

const health = await fetch(`${parsedUrl.origin}/health`);
const healthBody = await health.json();
assert.equal(health.status, 200);
assert.equal(healthBody.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(healthBody.meta?.service_version, "0.9.0-c2-form-import");

await api("/internal/c1/import-core", "C1", {
  request_id: "c2_live_core_001", source_snapshot_id: "c2_live_core_snapshot_001",
  settings_version: 1, default_season_id: seasonId,
  coaches: [{ coach_id: coachId, display_name: "C2 Isolated Coach",
    code_salt: "c2_isolated_salt_2026", code_digest: digest("unused-c2-coach-credential"),
    credential_version: 1, active: true, created_at: at, updated_at: at }],
  seasons: [{ season_id: seasonId, name: "C2 Isolated Test 2026",
    start_date: "2026-09-01", end_date: "2026-12-31", timezone: "America/New_York",
    season_ends_at: "2027-01-01T05:00:00.000Z", status: "OPEN", binding_version: 1,
    season_version: 1, roster_version: 0, created_by: coachId, created_at: at, updated_at: at }],
  members: []
});

await api("/internal/c2/import-sync-foundation", "C2", {
  request_id: "c2_live_binding_001", source_snapshot_id: "c2_live_binding_snapshot_001",
  bindings: [{ season_id: seasonId, binding_version: 1,
    form_id: formId, runtime_spreadsheet_id: spreadsheetId,
    response_sheet_id: responseSheetId, response_sheet_name: responseSheetName,
    field_mapping: { display_name_header: "Display Name" },
    schema_fingerprint: digest("c2-isolated-form-schema-v1"), export_paused: false,
    last_pull_at: null, last_push_at: null, created_at: at, updated_at: at }],
  baselines: [], source_imports: []
});

const first = await api("/internal/c2/pull-form-responses", "C2", {
  request_id: "c2_live_pull_001", season_id: seasonId, limit: 1
});
assert.equal(first.result.created, 1);
assert.equal(first.result.has_more, true);
const replay = await api("/internal/c2/pull-form-responses", "C2", {
  request_id: "c2_live_pull_001", season_id: seasonId, limit: 1
});
assert.deepEqual(replay, first);
const second = await api("/internal/c2/pull-form-responses", "C2", {
  request_id: "c2_live_pull_002", season_id: seasonId, limit: 1
});
assert.equal(second.result.created, 1);
assert.equal(second.result.has_more, false);
const overlap = await api("/internal/c2/pull-form-responses", "C2", {
  request_id: "c2_live_pull_003", season_id: seasonId, limit: 100
});
assert.equal(overlap.result.created, 0);
assert.equal(overlap.result.unchanged, 2);
console.log(JSON.stringify({ status: "passed", first_created: first.result.created,
  second_created: second.result.created, overlap_unchanged: overlap.result.unchanged,
  season_id: seasonId, worker: allowedHost }));
