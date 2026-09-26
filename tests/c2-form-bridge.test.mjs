import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createBackend, post } from "./backend-test-runtime.mjs";

const secret = "test-form-bridge-secret";
const properties = {
  DRAGON_BOAT_BRIDGE_SECRET: secret,
  DRAGON_BOAT_BRIDGE_TEAM_ID: "pentasus",
  DRAGON_BOAT_BRIDGE_BINDING_VERSION: "c0",
  DRAGON_BOAT_BRIDGE_WRITER_EPOCH: "0"
};

function signedRead(seasonId, bindingVersion, cursor, requestId = "form_bridge_read_001") {
  const payload_json = JSON.stringify({ season_id: seasonId, ...cursor });
  const request = {
    action: "cloudflareReadFormResponses", request_id: requestId,
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: "pentasus", binding_version: `${seasonId}:${bindingVersion}`,
    writer_epoch: 0, timestamp_ms: Date.now(), nonce: `nonce_${requestId}`,
    operation_id: `operation_${requestId}`, payload_json,
    payload_digest: crypto.createHash("sha256").update(payload_json).digest("base64url")
  };
  request.signature = crypto.createHmac("sha256", secret).update([
    request.protocol_version, request.direction, request.team_id, request.binding_version,
    request.writer_epoch, request.timestamp_ms, request.nonce, request.operation_id,
    request.payload_digest
  ].join("\n")).digest("base64url");
  return request;
}

test("signed Form reader pages equal-time answers by stable response ID", async () => {
  const backend = await createBackend({ properties });
  const login = post(backend.context, {
    action: "coachLogin", request_id: "form_bridge_login_001", coach_code: "coach-code-123"
  });
  const token = login.data.session_token;
  const season = post(backend.context, {
    action: "createSeason", request_id: "form_bridge_season_001", session_token: token,
    name: "Form Import 2026", start_date: "2026-09-01", end_date: "2026-12-31",
    timezone: "America/New_York"
  }).data.season;
  const fixture = backend.createFormBinding({ formResponses: [
    { responseId: "response_0002", submittedAt: "2026-09-20T12:00:00.000Z", displayName: "Bob" },
    { responseId: "response_0001", submittedAt: "2026-09-20T12:00:00.000Z", displayName: "Alice" },
    { responseId: "response_0003", submittedAt: "2026-09-21T12:00:00.000Z", displayName: "Alice" }
  ] });
  const initialized = post(backend.context, {
    action: "initializeSeason", request_id: "form_bridge_initialize_001", session_token: token,
    season_id: season.season_id, season_version: season.season_version,
    form: fixture.formId, spreadsheet: fixture.spreadsheetId,
    response_sheet: fixture.responseSheet.getName(), display_name_header: "Display Name"
  });
  assert.equal(initialized.ok, true);
  const firstRequest = signedRead(season.season_id, 1,
    { window_start_ms: 0, after_at_ms: 0, after_id: "", limit: 2 });
  const first = post(backend.context, firstRequest);
  assert.equal(first.ok, true);
  assert.deepEqual([...first.data.responses.map((row) => row.response_id)],
    ["response_0001", "response_0002"]);
  assert.equal(first.data.has_more, true);
  const second = post(backend.context, signedRead(season.season_id, 1, {
    window_start_ms: 0, after_at_ms: first.data.next_after_at_ms,
    after_id: first.data.next_after_id, limit: 2
  }, "form_bridge_read_002"));
  assert.equal(second.ok, true);
  assert.deepEqual([...second.data.responses.map((row) => row.response_id)], ["response_0003"]);
  assert.equal(second.data.has_more, false);
  assert.equal(post(backend.context, { ...firstRequest, signature: "a".repeat(43) }).error.code,
    "BRIDGE_SIGNATURE_INVALID");
  assert.equal(post(backend.context, signedRead(season.season_id, 2,
    { window_start_ms: 0, after_at_ms: 0, after_id: "", limit: 2 }, "form_bridge_read_003"))
    .error.code, "BRIDGE_OWNERSHIP_INVALID");
});
