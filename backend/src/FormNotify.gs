// C2 notification is installed only for a Cloudflare-owned season. The legacy
// Spreadsheet trigger remains the production path until the C4 cutover.
function ensureCloudflareFormSubmitTrigger_(seasonId) {
  var season = requireSeason_(seasonId);
  var formId = String(season.form_id || "");
  if (seasonEffectiveStatus_(season) !== "OPEN" || !formId) {
    throw dragonBoatRequestError_("FORM_NOTIFICATION_UNAVAILABLE", "The season is not open or bound to a Form.");
  }
  cloudflareFormNotificationUrl_();
  var form = FormApp.openById(formId);
  var projectTriggers = ScriptApp.getProjectTriggers();
  if (projectTriggers.some(function (trigger) {
    return trigger.getHandlerFunction() === "handleDragonBoatFormSubmit" &&
      String(trigger.getTriggerSourceId() || "") === String(season.runtime_spreadsheet_id);
  })) {
    throw dragonBoatRequestError_("FORM_NOTIFICATION_DUPLICATE", "The legacy Spreadsheet trigger still owns this Form.");
  }
  var matches = projectTriggers.filter(function (trigger) {
    return trigger.getHandlerFunction() === "handleCloudflareFormSubmit" &&
      trigger.getEventType() === ScriptApp.EventType.ON_FORM_SUBMIT &&
      String(trigger.getTriggerSourceId() || "") === formId;
  });
  if (matches.length > 1) {
    throw dragonBoatRequestError_("FORM_NOTIFICATION_DUPLICATE", "Multiple Form notification triggers exist.");
  }
  return matches.length ? String(matches[0].getUniqueId()) :
    String(ScriptApp.newTrigger("handleCloudflareFormSubmit")
      .forForm(form).onFormSubmit().create().getUniqueId());
}

function cloudflareFormNotificationUrl_() {
  var url = getScriptProperties_().getProperty("DRAGON_BOAT_C2_NOTIFY_URL") || "";
  if (!/^https:\/\/[^/]+\/internal\/c2\/form-submit-notification$/.test(url)) {
    throw new Error("The Cloudflare Form notification URL is not configured.");
  }
  return url;
}

function handleCloudflareFormSubmit(event) {
  if (!event || !event.source || !event.response) {
    throw new Error("A Google Forms submit event is required.");
  }
  var formId = String(event.source.getId());
  var responseId = String(event.response.getId() || "");
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(responseId)) throw new Error("The Form response ID is invalid.");
  var season = getSheetRecords_("Seasons").filter(function (candidate) {
    return String(candidate.form_id || "") === formId && seasonEffectiveStatus_(candidate) === "OPEN";
  });
  if (season.length !== 1) throw new Error("The submitted Form has no unique open season.");
  var bindingVersion = Number(season[0].binding_version);
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 1) throw new Error("Invalid Form binding version.");
  var url = cloudflareFormNotificationUrl_();
  var unsigned = {
    protocol_version: "2026-09-25.form-notify.v1",
    team_id: getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_TEAM_ID),
    writer_epoch: Number(getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_WRITER_EPOCH)),
    season_id: String(season[0].season_id), binding_version: bindingVersion,
    form_id: formId, response_id: responseId,
    timestamp_ms: new Date().getTime(),
    nonce: Utilities.getUuid().replace(/-/g, "_")
  };
  var signatureInput = [unsigned.protocol_version, unsigned.team_id, unsigned.writer_epoch,
    unsigned.season_id, unsigned.binding_version, unsigned.form_id, unsigned.response_id,
    unsigned.timestamp_ms, unsigned.nonce].join("\n");
  var request = Object.assign({}, unsigned, {
    signature: hmacDigest_(signatureInput,
      getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_SECRET))
  });
  var response = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json", payload: JSON.stringify(request),
    muteHttpExceptions: true
  });
  var result;
  try { result = JSON.parse(response.getContentText()); }
  catch (error) { throw new Error("The Cloudflare Form notification response is unreadable."); }
  if (response.getResponseCode() !== 200 || !result || result.ok !== true ||
      !result.data || result.data.observed !== true || result.data.response_id !== responseId) {
    throw new Error("The Cloudflare Form notification was not acknowledged.");
  }
  console.log(JSON.stringify({ form_notification: "acknowledged", season_id: unsigned.season_id,
    response_id: responseId, pages: result.data.pages.length }));
}
