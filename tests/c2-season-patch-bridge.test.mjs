import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createBackend, post } from "./backend-test-runtime.mjs";

const secret = "season-patch-test-secret";
const properties = {
  DRAGON_BOAT_BRIDGE_SECRET: secret,
  DRAGON_BOAT_BRIDGE_TEAM_ID: "pentasus",
  DRAGON_BOAT_BRIDGE_BINDING_VERSION: "c0",
  DRAGON_BOAT_BRIDGE_WRITER_EPOCH: "0"
};

function signedPatch(seasonId, payload, batchId) {
  const payload_json = JSON.stringify(payload);
  const request = {
    action: "cloudflarePatchSeasonSheet", request_id: `patch_${batchId}`,
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

test("season patch changes only business cells and preserves bound Google metadata", async () => {
  const backend = await createBackend({ properties });
  const login = post(backend.context, {
    action: "coachLogin", request_id: "season_patch_login", coach_code: "coach-code-123"
  });
  const season = post(backend.context, {
    action: "createSeason", request_id: "season_patch_create", session_token: login.data.session_token,
    name: "Old Season", start_date: "2026-09-01", end_date: "2026-12-31",
    timezone: "America/New_York"
  }).data.season;
  const fixture = backend.createFormBinding();
  assert.equal(post(backend.context, {
    action: "initializeSeason", request_id: "season_patch_initialize",
    session_token: login.data.session_token, season_id: season.season_id,
    season_version: season.season_version, form: fixture.formId,
    spreadsheet: fixture.spreadsheetId, response_sheet: fixture.responseSheet.getName(),
    display_name_header: "Display Name"
  }).ok, true);
  const sheet = backend.spreadsheet.getSheetByName("Seasons");
  const headers = sheet.rows[0];
  const rowNumber = sheet.rows.findIndex((row) => row[0] === season.season_id);
  assert.ok(rowNumber > 0);
  const original = [...sheet.rows[rowNumber]];
  const target = [...original];
  target[headers.indexOf("name")] = "New Season";
  target[headers.indexOf("season_version")] = String(Number(original[headers.indexOf("season_version")]) + 1);
  target[headers.indexOf("updated_at")] = "2026-09-03T00:00:00.000Z";
  const batchId = "batch_season_patch_001";
  const payload = { season_id: season.season_id, batch_id: batchId,
    spreadsheet_id: backend.spreadsheet.getId(), tab_id: String(sheet.getSheetId()),
    items: [{ season_id: season.season_id, expected: original, target }] };
  const first = post(backend.context, signedPatch(season.season_id, payload, batchId));
  assert.equal(first.ok, true);
  assert.deepEqual(first.data.verified_season_ids, [season.season_id]);
  assert.deepEqual([...sheet.rows[rowNumber]], target);
  assert.equal(post(backend.context, signedPatch(season.season_id, payload, batchId)).ok, true);
  assert.equal(sheet.rows.length, 2);
  assert.equal(backend.spreadsheet.getSheetByName("BridgeExportReceipts").rows.length, 2);

  const forbidden = [...target];
  forbidden[headers.indexOf("form_id")] = "other_form_identity";
  const rejectedId = "batch_season_patch_reject";
  const rejected = post(backend.context, signedPatch(season.season_id, {
    ...payload, batch_id: rejectedId,
    items: [{ season_id: season.season_id, expected: target, target: forbidden }]
  }, rejectedId));
  assert.equal(rejected.error.code, "BRIDGE_PAYLOAD_INVALID");
  assert.equal(sheet.rows[rowNumber][headers.indexOf("form_id")], original[headers.indexOf("form_id")]);

  sheet.rows[rowNumber][headers.indexOf("name")] = "Manual edit";
  const conflictId = "batch_season_patch_conflict";
  const conflict = post(backend.context, signedPatch(season.season_id, {
    ...payload, batch_id: conflictId,
    items: [{ season_id: season.season_id, expected: target, target: original }]
  }, conflictId));
  assert.equal(conflict.error.code, "SHEET_PATCH_CONFLICT");
  assert.equal(sheet.rows[rowNumber][headers.indexOf("name")], "Manual edit");
  assert.equal(post(backend.context, signedPatch(season.season_id, payload, batchId))
    .error.code, "SHEET_PATCH_CONFLICT");
});
