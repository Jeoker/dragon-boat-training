import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createBackend, post } from "./backend-test-runtime.mjs";

const secret = "test-sheet-bridge-secret";
const properties = {
  DRAGON_BOAT_BRIDGE_SECRET: secret,
  DRAGON_BOAT_BRIDGE_TEAM_ID: "pentasus",
  DRAGON_BOAT_BRIDGE_BINDING_VERSION: "c0",
  DRAGON_BOAT_BRIDGE_WRITER_EPOCH: "0"
};

function signedSheetRead(seasonId, bindingVersion, entityType, suffix) {
  const payload_json = JSON.stringify({ season_id: seasonId, entity_type: entityType });
  const request = {
    action: "cloudflareReadSheetRecords", request_id: `sheet_read_${suffix}`,
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: "pentasus", binding_version: `${seasonId}:${bindingVersion}`,
    writer_epoch: 0, timestamp_ms: Date.now(), nonce: `nonce_sheet_${suffix}`,
    operation_id: `operation_sheet_${suffix}`, payload_json,
    payload_digest: crypto.createHash("sha256").update(payload_json).digest("base64url")
  };
  request.signature = crypto.createHmac("sha256", secret).update([
    request.protocol_version, request.direction, request.team_id, request.binding_version,
    request.writer_epoch, request.timestamp_ms, request.nonce, request.operation_id,
    request.payload_digest
  ].join("\n")).digest("base64url");
  return request;
}

test("signed Sheet inspection reads only registered bound tabs without repairing edits", async () => {
  const backend = await createBackend({ properties });
  const login = post(backend.context, {
    action: "coachLogin", request_id: "sheet_bridge_login_001", coach_code: "coach-code-123"
  });
  const token = login.data.session_token;
  const season = post(backend.context, {
    action: "createSeason", request_id: "sheet_bridge_season_001", session_token: token,
    name: "Sheet Read 2026", start_date: "2026-09-01", end_date: "2026-12-31",
    timezone: "America/New_York"
  }).data.season;
  const fixture = backend.createFormBinding();
  const initialized = post(backend.context, {
    action: "initializeSeason", request_id: "sheet_bridge_initialize_001", session_token: token,
    season_id: season.season_id, season_version: season.season_version,
    form: fixture.formId, spreadsheet: fixture.spreadsheetId,
    response_sheet: fixture.responseSheet.getName(), display_name_header: "Display Name"
  });
  assert.equal(initialized.ok, true);
  const members = fixture.runtimeSpreadsheet.getSheetByName("Members");
  members.rows.push([season.season_id, "member_sheet_test_01", "source_test_01", "2", "Alice",
    "", "ACTIVE", "LEFT", "1", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
  const first = post(backend.context, signedSheetRead(season.season_id, 1, "MEMBER", "valid_001"));
  assert.equal(first.ok, true);
  assert.equal(first.data.spreadsheet_id, fixture.spreadsheetId);
  assert.equal(first.data.tab_name, "Members");
  assert.equal(first.data.rows[0].cells[4], "Alice");
  assert.equal(first.data.rows[0].row_number, 2);
  const seating = post(backend.context, signedSheetRead(season.season_id, 1,
    "SEAT_PLAN_DRAFT", "seating_001"));
  assert.equal(seating.ok, true);
  assert.equal(seating.data.tab_name, "SeatPlanState");
  assert.equal(seating.data.secondary.tab_name, "SeatPlanCurrent");
  members.rows[0].push("unknown_admin_column");
  members.rows[1].push("untouched");
  const changed = post(backend.context, signedSheetRead(season.season_id, 1, "MEMBER", "changed_002"));
  assert.equal(changed.ok, true);
  assert.equal(changed.data.headers.at(-1), "unknown_admin_column");
  assert.equal(members.rows[1].at(-1), "untouched");
  assert.equal(post(backend.context, signedSheetRead(season.season_id, 1, "FORM_RESPONSE", "invalid_003"))
    .error.code, "BRIDGE_PAYLOAD_INVALID");
  assert.equal(post(backend.context, signedSheetRead(season.season_id, 2, "MEMBER", "stale_004"))
    .error.code, "BRIDGE_OWNERSHIP_INVALID");
  fixture.runtimeSpreadsheet.sheets.delete("Members");
  assert.equal(post(backend.context, signedSheetRead(season.season_id, 1, "MEMBER", "missing_005"))
    .error.code, "BINDING_SHEET_MISSING");
  assert.equal(fixture.runtimeSpreadsheet.getSheetByName("Members"), null,
    "A diagnostic read must not recreate a missing tab.");
  fixture.runtimeSpreadsheet.sheets.set("Members", members);
  members.rows.length = 5002;
  members.rows[5001] = [season.season_id, "member_sheet_over_limit"];
  assert.equal(post(backend.context, signedSheetRead(season.season_id, 1, "MEMBER", "limit_006"))
    .error.code, "SHEET_SCAN_LIMIT");
});
