// Read-only C2 bridge. This file is excluded from the isolated C0 probe build.
function cloudflareReadFormResponses_(request) {
  var verified = verifyBridgeEnvelope_(request, null);
  var input = verified.payload;
  var seasonId = requireRequestString_(input, "season_id", 8, 128);
  var season = requireSeason_(seasonId);
  var bindingVersion = Number(season.binding_version);
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 1 ||
      verified.binding_version !== seasonId + ":" + bindingVersion) {
    throw dragonBoatRequestError_("BRIDGE_OWNERSHIP_INVALID", "The Form read has the wrong season binding.");
  }
  var windowStartMs = input.window_start_ms;
  var afterAtMs = input.after_at_ms;
  var afterId = input.after_id;
  var limit = input.limit;
  if (!Number.isSafeInteger(windowStartMs) || windowStartMs < 0 ||
      !Number.isSafeInteger(afterAtMs) || afterAtMs < 0 ||
      typeof afterId !== "string" || afterId.length > 256 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      afterAtMs < windowStartMs) {
    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "The Form read cursor is invalid.");
  }
  var formId = String(season.form_id || "");
  var form;
  try { form = FormApp.openById(formId); }
  catch (error) {
    throw dragonBoatRequestError_("BINDING_FORM_UNAVAILABLE", "The bound Form cannot be opened.", true);
  }
  if (String(form.getDestinationId() || "") !== String(season.runtime_spreadsheet_id)) {
    throw dragonBoatRequestError_("BINDING_DESTINATION_MISMATCH", "The Form destination changed.");
  }
  var mapping = parseJsonObject_(season.field_mapping_json);
  var nameHeader = String(mapping.display_name_header || "");
  if (!nameHeader) throw dragonBoatRequestError_("BINDING_FIELD_MISSING", "The display-name mapping is missing.");
  var answers;
  // FormApp's timestamp boundary is not relied on for equality; the tuple filter below is authoritative.
  try { answers = form.getResponses(new Date(Math.max(0, windowStartMs - 1))); }
  catch (error) {
    throw dragonBoatRequestError_("FORM_READ_FAILED", "The bound Form responses could not be read.", true);
  }
  var rows = answers.map(function (response) {
    var responseId = String(response.getId() || "");
    var submittedAt = response.getTimestamp();
    var submittedMs = submittedAt instanceof Date ? submittedAt.getTime() : NaN;
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(responseId) || !Number.isSafeInteger(submittedMs) || submittedMs < 0) {
      throw dragonBoatRequestError_("FORM_RESPONSE_INVALID", "A Form response has no stable ID or time.");
    }
    var matched = response.getItemResponses().filter(function (itemResponse) {
      return String(itemResponse.getItem().getTitle()) === nameHeader;
    });
    if (matched.length > 1) {
      throw dragonBoatRequestError_("BINDING_FIELD_MISSING", "The Form name question is ambiguous.");
    }
    var answer = matched.length ? matched[0].getResponse() : "";
    var displayName = typeof answer === "string" ? answer.trim() : "";
    return { response_id: responseId, submitted_at: new Date(submittedMs).toISOString(),
      submitted_at_ms: submittedMs, display_name: displayName };
  }).filter(function (row) {
    return row.submitted_at_ms >= windowStartMs &&
      (row.submitted_at_ms > afterAtMs ||
        row.submitted_at_ms === afterAtMs && row.response_id > afterId);
  }).sort(function (left, right) {
    return left.submitted_at_ms - right.submitted_at_ms ||
      (left.response_id < right.response_id ? -1 : left.response_id > right.response_id ? 1 : 0);
  });
  var seenIds = {};
  rows.forEach(function (row) {
    if (seenIds[row.response_id]) {
      throw dragonBoatRequestError_("FORM_RESPONSE_INVALID", "The Form returned a duplicate response ID.");
    }
    seenIds[row.response_id] = true;
  });
  var page = rows.slice(0, limit);
  var last = page.length ? page[page.length - 1] : null;
  return {
    protocol_version: verified.protocol,
    team_id: verified.team_id,
    season_id: seasonId,
    form_id: formId,
    binding_version: bindingVersion,
    writer_epoch: verified.writer_epoch,
    operation_id: verified.operation_id,
    payload_digest: verified.payload_digest,
    window_start_ms: windowStartMs,
    after_at_ms: afterAtMs,
    after_id: afterId,
    read_at_ms: new Date().getTime(),
    has_more: rows.length > limit,
    next_after_at_ms: last ? last.submitted_at_ms : afterAtMs,
    next_after_id: last ? last.response_id : afterId,
    responses: page.map(function (row) {
      return { response_id: row.response_id, submitted_at: row.submitted_at,
        display_name: row.display_name };
    })
  };
}
