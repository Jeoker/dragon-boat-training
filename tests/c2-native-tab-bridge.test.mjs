import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createBackend, post } from "./backend-test-runtime.mjs";

const secret = "fixture-native-tab-bridge-secret";
const properties = { DRAGON_BOAT_BRIDGE_SECRET: secret, DRAGON_BOAT_BRIDGE_TEAM_ID: "pentasus",
  DRAGON_BOAT_BRIDGE_BINDING_VERSION: "c0", DRAGON_BOAT_BRIDGE_WRITER_EPOCH: "0" };
const sha = value => crypto.createHash("sha256").update(value).digest("base64url");
const hmac = value => crypto.createHmac("sha256", secret).update(value).digest("base64url");
function envelope(input, id = "native_proof_request_001") {
  const payload_json = JSON.stringify({ ...input, request_id: id });
  const value = { action: "cloudflareReadNativeTabProof", request_id: id, protocol_version: "2026-09-19.bridge.v1",
    direction: "CLOUDFLARE_TO_GOOGLE", team_id: "pentasus", binding_version: `${input.season_id}:${input.binding_version}`,
    writer_epoch: 0, timestamp_ms: Date.now(), nonce: `transport_${id}`, operation_id: `native_${id}`,
    payload_json, payload_digest: sha(payload_json) };
  value.signature = hmac([value.protocol_version, value.direction, value.team_id, value.binding_version,
    value.writer_epoch, value.timestamp_ms, value.nonce, value.operation_id, value.payload_digest].join("\n"));
  return value;
}
async function fixture() {
  const backend = await createBackend({ properties });
  const token = post(backend.context, { action: "coachLogin", request_id: "native_coach_login", coach_code: "coach-code-123" }).data.session_token;
  const season = post(backend.context, { action: "createSeason", request_id: "native_create_season", session_token: token,
    name: "Native Tab Fixture", start_date: "2026-09-01", end_date: "2026-12-31", timezone: "America/New_York" }).data.season;
  const binding = backend.createFormBinding();
  assert.equal(post(backend.context, { action: "initializeSeason", request_id: "native_initialize", session_token: token,
    season_id: season.season_id, season_version: season.season_version, form: binding.formId,
    spreadsheet: binding.spreadsheetId, response_sheet: binding.responseSheet.getName(), display_name_header: "Display Name" }).ok, true);
  binding.form.getId = () => binding.formId;
  binding.form.getDestinationType = () => "SPREADSHEET";
  backend.context.FormApp.DestinationType = { SPREADSHEET: "SPREADSHEET" };
  const urls = [];
  backend.context.FormApp.openByUrl = url => {
    urls.push(url);
    if (url === binding.responseSheet.getFormUrl() && !url.includes("wrong-form")) return binding.form;
    return { getId: () => "other_form_id" };
  };
  const input = { season_id: season.season_id, binding_version: 1, form_id: binding.formId,
    spreadsheet_id: binding.spreadsheetId, sheet_id: binding.responseSheet.getSheetId(), team_id: "pentasus",
    backend_generation: "fixture_generation", writer_epoch: 0, source_operation_id: "source_native_fixture",
    authority_digest: "a".repeat(43), nonce: "native_proof_nonce_001",
    proof_action: "READ_NATIVE_TAB_LINK", proof_direction: "CLOUDFLARE_TO_GOOGLE_NATIVE_TAB" };
  return { backend, binding, input, urls };
}

test("signed native proof resolves the exact numeric Tab's Google URL and exposes only bound metadata", async () => {
  const { backend, binding, input, urls } = await fixture();
  const published = "https://docs.google.com/forms/d/e/published-id-distinct-from-edit-id/viewform";
  binding.responseSheet.setFormUrl(published);
  // A same-name tab is not evidence; numeric identity selects the native tab.
  const sameName = binding.runtimeSpreadsheet.insertSheet("Copied Responses");
  sameName.name = binding.responseSheet.getName();
  sameName.setFormUrl("https://docs.google.com/forms/d/wrong-form/edit");
  const before = JSON.stringify(binding.runtimeSpreadsheet.getSheets().map(sheet => sheet.rows));
  const response = post(backend.context, envelope(input));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(urls, [published]);
  const proof = JSON.parse(response.data.proof_text);
  assert.equal(proof.evidence, "GOOGLE_NATIVE_TAB_LINK_OBSERVED");
  assert.equal(proof.action, "READ_NATIVE_TAB_LINK"); assert.equal(proof.direction, "GOOGLE_TO_CLOUDFLARE_NATIVE_TAB");
  assert.equal(proof.form_id, binding.formId); assert.equal(proof.sheet_id, input.sheet_id);
  assert.equal(proof.authority_digest, input.authority_digest); assert.equal(proof.nonce, input.nonce);
  assert.equal(response.data.signature, hmac(`c2-native-tab-proof-v1\n${response.data.proof_text}`));
  assert.doesNotMatch(response.data.proof_text, /coach_code|session_token|Display Name|raw_answers|annual_export_authorized/);
  assert.equal(JSON.stringify(binding.runtimeSpreadsheet.getSheets().map(sheet => sheet.rows)), before);
});

for (const mode of ["unlinked", "wrong-native-form", "wrong-destination", "duplicate-numeric-tab", "wrong-tab",
  "wrong-form", "wrong-spreadsheet", "binding", "nonce", "signature", "blank-binding-tab", "null-binding-tab", "direction"]) {
  test(`native bridge rejects ${mode} instead of accepting the tab name or client declaration`, async () => {
    const { backend, binding, input } = await fixture();
    if (mode === "unlinked") binding.responseSheet.setFormUrl("");
    if (mode === "wrong-native-form") binding.responseSheet.setFormUrl("https://docs.google.com/forms/d/wrong-form/edit");
    if (mode === "wrong-destination") binding.form.destinationId = "other_spreadsheet";
    if (mode === "duplicate-numeric-tab") binding.runtimeSpreadsheet.insertSheet("Other tab").id = input.sheet_id;
    if (mode === "wrong-tab") input.sheet_id++;
    if (mode === "wrong-form") input.form_id = "other_form";
    if (mode === "wrong-spreadsheet") input.spreadsheet_id = "other_spreadsheet";
    if (mode === "binding") input.binding_version = 2;
    if (mode === "nonce") input.nonce = "short";
    if (mode === "direction") input.proof_direction = "GOOGLE_TO_CLOUDFLARE_NATIVE_TAB";
    if (mode === "blank-binding-tab" || mode === "null-binding-tab") {
      const seasons = backend.spreadsheet.getSheetByName("Seasons"), column = seasons.rows[0].indexOf("response_sheet_id");
      assert.ok(column >= 0); seasons.rows[1][column] = mode === "blank-binding-tab" ? "" : null;
      binding.responseSheet.id = 0; input.sheet_id = 0;
    }
    const request = envelope(input, `native_reject_${mode.replaceAll("-", "_")}`);
    if (mode === "signature") request.signature = "a".repeat(43);
    const result = post(backend.context, request);
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.doesNotMatch(JSON.stringify(result), /fixture-native-tab-bridge-secret|coach-code-123/);
  });
}
