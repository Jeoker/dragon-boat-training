import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createBackend, post } from "./backend-test-runtime.mjs";

const secret = "associated-patch-test-secret";
const properties = {
  DRAGON_BOAT_BRIDGE_SECRET: secret,
  DRAGON_BOAT_BRIDGE_TEAM_ID: "pentasus",
  DRAGON_BOAT_BRIDGE_BINDING_VERSION: "c0",
  DRAGON_BOAT_BRIDGE_WRITER_EPOCH: "0"
};

function signed(action, seasonId, payload, operationId) {
  const payload_json = JSON.stringify(payload);
  const request = {
    action, request_id: `request_${operationId}`,
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: "pentasus", binding_version: `${seasonId}:1`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: `nonce_${crypto.randomUUID().replaceAll("-", "_")}`,
    operation_id: operationId, payload_json,
    payload_digest: crypto.createHash("sha256").update(payload_json).digest("base64url")
  };
  request.signature = crypto.createHmac("sha256", secret).update([
    request.protocol_version, request.direction, request.team_id, request.binding_version,
    request.writer_epoch, request.timestamp_ms, request.nonce, request.operation_id,
    request.payload_digest
  ].join("\n")).digest("base64url");
  return request;
}

test("associated bridge uses scoped composite IDs and recovers partial rows", async () => {
  const backend = await createBackend({ properties });
  const login = post(backend.context, {
    action: "coachLogin", request_id: "associated_login", coach_code: "coach-code-123"
  });
  const season = post(backend.context, {
    action: "createSeason", request_id: "associated_season", session_token: login.data.session_token,
    name: "Associated Patch 2026", start_date: "2026-09-01", end_date: "2026-12-31",
    timezone: "America/New_York"
  }).data.season;
  const fixture = backend.createFormBinding();
  assert.equal(post(backend.context, {
    action: "initializeSeason", request_id: "associated_initialize",
    session_token: login.data.session_token, season_id: season.season_id,
    season_version: season.season_version, form: fixture.formId,
    spreadsheet: fixture.spreadsheetId, response_sheet: fixture.responseSheet.getName(),
    display_name_header: "Display Name"
  }).ok, true);

  const practiceId = "practice_associated_001";
  const cases = [
    { scope: "SIGNUP", action: "cloudflarePatchSignupSheet", tab: "SignupsCurrent",
      ids: [`${practiceId}:member_associated_001`, `${practiceId}:member_associated_002`],
      records: [{ practice_id: practiceId, member_id: "member_associated_001", preference: "LEFT",
        status: "CONFIRMED", queue_at: "2026-09-01T00:00:00.000Z", queue_sequence: "1" },
      { practice_id: practiceId, member_id: "member_associated_002", preference: "RIGHT",
        status: "WAITLIST", queue_at: "2026-09-01T00:01:00.000Z", queue_sequence: "2" }] },
    { scope: "SEAT_PLAN_DRAFT", action: "cloudflarePatchSeatPlanStateSheet", tab: "SeatPlanState",
      ids: [practiceId], records: [{ practice_id: practiceId, seat_plan_version: "1",
        coach_member_id: "member_associated_001", published_revision: "0" }] },
    { scope: "SEAT_PLAN_CURRENT", action: "cloudflarePatchSeatPlanCurrentSheet", tab: "SeatPlanCurrent",
      ids: [`${practiceId}:1:LEFT`, `${practiceId}:1:RIGHT`],
      records: [{ practice_id: practiceId, row_number: "1", side: "LEFT",
        member_id: "member_associated_001", seat_plan_version: "1" },
      { practice_id: practiceId, row_number: "1", side: "RIGHT", seat_plan_version: "1" }] },
    { scope: "SEAT_PLAN_REVISION", action: "cloudflarePatchSeatPlanRevisionSheet", tab: "SeatPlanRevisions",
      ids: [`${practiceId}:1`], records: [{ practice_id: practiceId, revision_number: "1",
        revision_id: "revision_associated_001", source: "MANUAL", seat_plan_version: "1",
        seats_json: "[]", names_json: "{}" }] }
  ];

  for (const [index, entry] of cases.entries()) {
    const sheet = fixture.runtimeSpreadsheet.getSheetByName(entry.tab);
    assert.ok(sheet, entry.tab);
    const headers = sheet.rows[0];
    const rows = entry.records.map((record) => headers.map((header) =>
      header === "season_id" ? season.season_id : record[header] ?? ""));
    const batchId = `batch_associated_${index}_001`;
    const payload = { season_id: season.season_id, batch_id: batchId, entity_type: entry.scope,
      spreadsheet_id: fixture.spreadsheetId, tab_id: String(sheet.getSheetId()),
      items: rows.map((row, offset) => ({ row_id: entry.ids[offset], expected: null, target: row })) };
    const result = post(backend.context, signed(entry.action, season.season_id, payload, batchId));
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.entity_type, entry.scope);
    assert.deepEqual(result.data.verified_row_ids, entry.ids);
    assert.deepEqual(sheet.rows.slice(1), rows);
    assert.equal(post(backend.context, signed(entry.action, season.season_id, payload, batchId)).ok, true);
    assert.equal(sheet.rows.length, rows.length + 1);
    const read = post(backend.context, signed("cloudflareReadSheetRecords", season.season_id,
      { season_id: season.season_id, entity_type: entry.scope }, `read_associated_${index}`));
    assert.equal(read.ok, true, JSON.stringify(read.error));
    assert.deepEqual(read.data.rows.map((row) => row.cells), rows);
    if (entry.scope === "SEAT_PLAN_DRAFT") {
      assert.equal(read.data.secondary.tab_name, "SeatPlanCurrent");
    }

    const wrongKeyId = `batch_associated_bad_key_${index}`;
    assert.equal(post(backend.context, signed(entry.action, season.season_id,
      { ...payload, batch_id: wrongKeyId,
        items: [{ row_id: "wrong_associated_001", expected: rows[0], target: rows[0] }] },
      wrongKeyId)).error.code, "BRIDGE_PAYLOAD_INVALID");
  }

  const signup = cases[0];
  const signupSheet = fixture.runtimeSpreadsheet.getSheetByName(signup.tab);
  const first = [...signupSheet.rows[1]];
  const next = [...first]; next[signupSheet.rows[0].indexOf("preference")] = "AMBIENT";
  const beforeSecond = [...signupSheet.rows[2]];
  const afterSecond = [...beforeSecond];
  afterSecond[signupSheet.rows[0].indexOf("status")] = "CONFIRMED";
  const conflicting = [...beforeSecond];
  conflicting[signupSheet.rows[0].indexOf("status")] = "CANCELLED";
  signupSheet.rows[2] = conflicting;
  const partialId = "batch_associated_partial_001";
  const partialPayload = { season_id: season.season_id, batch_id: partialId,
    entity_type: "SIGNUP", spreadsheet_id: fixture.spreadsheetId,
    tab_id: String(signupSheet.getSheetId()), items: [
      { row_id: signup.ids[0], expected: first, target: next },
      { row_id: signup.ids[1], expected: beforeSecond, target: afterSecond }
    ] };
  assert.equal(post(backend.context, signed(signup.action, season.season_id,
    partialPayload, partialId)).error.code, "SHEET_PATCH_CONFLICT");
  assert.deepEqual(signupSheet.rows[1], next);
  assert.deepEqual(signupSheet.rows[2], conflicting);
  signupSheet.rows[2] = beforeSecond;
  assert.equal(post(backend.context, signed(signup.action, season.season_id,
    partialPayload, partialId)).ok, true);
  assert.deepEqual(signupSheet.rows[2], afterSecond);

  const revision = cases[3];
  const revisionSheet = fixture.runtimeSpreadsheet.getSheetByName(revision.tab);
  const revisionRow = [...revisionSheet.rows[1]];
  const illegalId = "batch_associated_revision_update";
  assert.equal(post(backend.context, signed(revision.action, season.season_id,
    { season_id: season.season_id, batch_id: illegalId, entity_type: revision.scope,
      spreadsheet_id: fixture.spreadsheetId, tab_id: String(revisionSheet.getSheetId()),
      items: [{ row_id: revision.ids[0], expected: revisionRow, target: revisionRow }] },
    illegalId)).error.code, "BRIDGE_PAYLOAD_INVALID");
});
