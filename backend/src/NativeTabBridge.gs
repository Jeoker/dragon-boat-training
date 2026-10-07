// Read-only native Sheet/Form linkage. No raw responses, rows, writes or caches.
function cloudflareReadNativeTabProof_(request) {
  var verified = verifyBridgeEnvelope_(request, null);
  var input = verified.payload;
  var seasonId = requireRequestString_(input, "season_id", 8, 128);
  var season = requireSeason_(seasonId);
  var version = Number(season.binding_version);
  var formId = String(season.form_id || "");
  var spreadsheetId = String(season.runtime_spreadsheet_id || "");
  var rawSheetId = String(season.response_sheet_id);
  var sheetId = Number(rawSheetId);
  if (request.action !== "cloudflareReadNativeTabProof" || input.proof_action !== "READ_NATIVE_TAB_LINK" ||
      input.proof_direction !== "CLOUDFLARE_TO_GOOGLE_NATIVE_TAB" || verified.binding_version !== seasonId + ":" + version ||
      !Number.isSafeInteger(version) || version < 1 || !/^(0|[1-9]\d*)$/.test(rawSheetId) || !Number.isSafeInteger(sheetId) || sheetId < 0 ||
      input.form_id !== formId || input.spreadsheet_id !== spreadsheetId || input.sheet_id !== sheetId ||
      input.binding_version !== version || input.writer_epoch !== verified.writer_epoch ||
      input.team_id !== verified.team_id || input.request_id !== request.request_id ||
      typeof input.backend_generation !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.authority_digest) ||
      typeof input.source_operation_id !== "string" || typeof input.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce)) {
    throw dragonBoatRequestError_("NATIVE_TAB_PROOF_UNCONFIRMED", "Native response tab proof could not be confirmed.");
  }
  var form = FormApp.openById(formId);
  if (form.getDestinationType() !== FormApp.DestinationType.SPREADSHEET ||
      String(form.getId()) !== formId || String(form.getDestinationId()) !== spreadsheetId) {
    throw dragonBoatRequestError_("NATIVE_TAB_PROOF_UNCONFIRMED", "Native response tab proof could not be confirmed.");
  }
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var tabs = spreadsheet.getSheets().filter(function (sheet) { return Number(sheet.getSheetId()) === sheetId; });
  if (String(spreadsheet.getId()) !== spreadsheetId || tabs.length !== 1) {
    throw dragonBoatRequestError_("NATIVE_TAB_PROOF_UNCONFIRMED", "Native response tab proof could not be confirmed.");
  }
  var nativeUrl = tabs[0].getFormUrl();
  // Resolve the native URL through Google; published /d/e IDs aren't edit IDs.
  if (!nativeUrl || String(FormApp.openByUrl(nativeUrl).getId()) !== formId) {
    throw dragonBoatRequestError_("NATIVE_TAB_PROOF_UNCONFIRMED", "Native response tab proof could not be confirmed.");
  }
  var core = { format: "c2-native-tab-proof-v1", evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED",
    action: "READ_NATIVE_TAB_LINK", direction: "GOOGLE_TO_CLOUDFLARE_NATIVE_TAB",
    request_id: input.request_id, nonce: input.nonce, team_id: input.team_id,
    backend_generation: input.backend_generation, writer_epoch: input.writer_epoch,
    season_id: seasonId, binding_version: version, source_operation_id: input.source_operation_id,
    authority_digest: input.authority_digest, form_id: formId, spreadsheet_id: spreadsheetId,
    sheet_id: sheetId, observed_at_ms: new Date().getTime() };
  var text = JSON.stringify(core);
  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_SECRET);
  var bytes = Utilities.computeHmacSha256Signature("c2-native-tab-proof-v1\n" + text, secret, Utilities.Charset.UTF_8);
  return { proof_text: text, signature: Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, "") };
}
