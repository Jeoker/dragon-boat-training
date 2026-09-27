import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createBackend, post } from "./backend-test-runtime.mjs";

const secret = "member-patch-test-secret";
const properties = {
  DRAGON_BOAT_BRIDGE_SECRET: secret,
  DRAGON_BOAT_BRIDGE_TEAM_ID: "pentasus",
  DRAGON_BOAT_BRIDGE_BINDING_VERSION: "c0",
  DRAGON_BOAT_BRIDGE_WRITER_EPOCH: "0"
};

function patchRequest(seasonId, payload, batchId) {
  const payload_json = JSON.stringify(payload);
  const request = {
    action: "cloudflarePatchMemberSheet", request_id: `patch_${batchId}`,
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: "pentasus", binding_version: `${seasonId}:1`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: `nonce_${batchId}_${crypto.randomUUID().slice(0, 8)}`,
    operation_id: batchId, payload_json,
    payload_digest: crypto.createHash("sha256").update(payload_json).digest("base64url")
  };
  request.signature = crypto.createHmac("sha256", secret).update([
    request.protocol_version, request.direction, request.team_id, request.binding_version,
    request.writer_epoch, request.timestamp_ms, request.nonce, request.operation_id,
    request.payload_digest
  ].join("\n")).digest("base64url");
  return request;
}

test("member patch writes minimally, verifies, and resumes the same batch without duplicate rows", async () => {
  const backend = await createBackend({ properties });
  const login = post(backend.context, {
    action: "coachLogin", request_id: "patch_login_001", coach_code: "coach-code-123"
  });
  const season = post(backend.context, {
    action: "createSeason", request_id: "patch_season_001", session_token: login.data.session_token,
    name: "Patch 2026", start_date: "2026-09-01", end_date: "2026-12-31",
    timezone: "America/New_York"
  }).data.season;
  const fixture = backend.createFormBinding();
  assert.equal(post(backend.context, {
    action: "initializeSeason", request_id: "patch_initialize_001",
    session_token: login.data.session_token, season_id: season.season_id,
    season_version: season.season_version, form: fixture.formId,
    spreadsheet: fixture.spreadsheetId, response_sheet: fixture.responseSheet.getName(),
    display_name_header: "Display Name"
  }).ok, true);
  const sheet = fixture.runtimeSpreadsheet.getSheetByName("Members");
  const memberId = "member_patch_001";
  const row = [season.season_id, memberId, "source_patch_001", "", "Alice", "",
    "ACTIVE", "LEFT", "1", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"];
  const batchId = "batch_patch_001";
  const payload = { season_id: season.season_id, batch_id: batchId,
    spreadsheet_id: fixture.spreadsheetId, tab_id: String(sheet.getSheetId()),
    items: [{ member_id: memberId, expected: null, target: row }] };
  const first = post(backend.context, patchRequest(season.season_id, payload, batchId));
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "verified");
  assert.deepEqual([...sheet.rows[1]], row);
  const replay = post(backend.context, patchRequest(season.season_id, payload, batchId));
  assert.equal(replay.ok, true);
  assert.equal(sheet.rows.length, 2);
  assert.equal(replay.data.payload_digest, first.data.payload_digest);
  const receipts = backend.spreadsheet.getSheetByName("BridgeExportReceipts");
  assert.equal(receipts.rows.length, 2);
  assert.equal(receipts.rows[1][5], "VERIFIED");

  const changed = [...row];
  changed[5] = "Ali";
  changed[8] = "2";
  const secondId = "batch_patch_002";
  const second = post(backend.context, patchRequest(season.season_id, {
    ...payload, batch_id: secondId,
    items: [{ member_id: memberId, expected: row, target: changed }]
  }, secondId));
  assert.equal(second.ok, true);
  assert.equal(sheet.rows[1][5], "Ali");
  assert.equal(sheet.rows[1][8], "2");

  const conflictingId = "batch_patch_003";
  const conflicting = post(backend.context, patchRequest(season.season_id, {
    ...payload, batch_id: conflictingId,
    items: [{ member_id: memberId, expected: row, target: [...row.slice(0, 5), "Other", ...row.slice(6)] }]
  }, conflictingId));
  assert.equal(conflicting.error.code, "SHEET_PATCH_CONFLICT");
  assert.equal(sheet.rows[1][5], "Ali");
  assert.equal(receipts.rows.at(-1)[5], "PREPARED");

  const firstNew = [...row];
  firstNew[1] = "member_patch_004";
  const secondNew = [...row];
  secondNew[1] = "member_patch_005";
  sheet.rows.push([...secondNew.slice(0, 4), "Manual edit", ...secondNew.slice(5)]);
  const partialId = "batch_patch_partial_001";
  const partialPayload = { ...payload, batch_id: partialId,
    items: [{ member_id: firstNew[1], expected: null, target: firstNew },
      { member_id: secondNew[1], expected: null, target: secondNew }] };
  const partial = post(backend.context, patchRequest(season.season_id, partialPayload, partialId));
  assert.equal(partial.error.code, "SHEET_PATCH_CONFLICT");
  assert.equal(receipts.rows.at(-1)[5], "PARTIAL");
  assert.equal(sheet.rows.filter((cells) => cells[1] === firstNew[1]).length, 1);
  sheet.rows = sheet.rows.filter((cells) => cells[1] !== secondNew[1]);
  const resumed = post(backend.context, patchRequest(season.season_id, partialPayload, partialId));
  assert.equal(resumed.ok, true);
  assert.equal(receipts.rows.at(-1)[5], "VERIFIED");
  assert.equal(sheet.rows.filter((cells) => cells[1] === firstNew[1]).length, 1);
  assert.equal(sheet.rows.filter((cells) => cells[1] === secondNew[1]).length, 1);
  const changedPayload = { ...partialPayload,
    items: [{ ...partialPayload.items[0], target: [...firstNew.slice(0, 4), "Wrong", ...firstNew.slice(5)] }] };
  assert.equal(post(backend.context, patchRequest(season.season_id, changedPayload, partialId))
    .error.code, "BRIDGE_OPERATION_CONFLICT");
  const formula = [...row];
  formula[1] = "member_patch_formula_006";
  formula[4] = "=1+1";
  const formulaId = "batch_patch_formula_001";
  assert.equal(post(backend.context, patchRequest(season.season_id, {
    ...payload, batch_id: formulaId,
    items: [{ member_id: formula[1], expected: null, target: formula }]
  }, formulaId)).error.code, "BRIDGE_PAYLOAD_INVALID");
  assert.equal(sheet.rows.some((cells) => cells[1] === formula[1]), false);
});
