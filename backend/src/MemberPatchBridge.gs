// One bounded batch is durable in the private system file before any member row changes.
// Replays inspect the cells again, so a lost response cannot cause a blind second write.
function cloudflarePatchMemberSheet_(request) {
  var verified = verifyBridgeEnvelope_(request, null);
  var input = verified.payload;
  var seasonId = requireRequestString_(input, "season_id", 8, 128);
  var batchId = requireRequestString_(input, "batch_id", 8, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(batchId) || batchId !== verified.operation_id ||
      !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 4) {
    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "The member patch batch is invalid.");
  }
  var season = requireSeason_(seasonId);
  var bindingVersion = Number(season.binding_version);
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 1 ||
      verified.binding_version !== seasonId + ":" + bindingVersion) {
    throw dragonBoatRequestError_("BRIDGE_OWNERSHIP_INVALID", "The member patch has the wrong season binding.");
  }
  var spreadsheet = getSeasonSpreadsheet_(season);
  var tab = spreadsheet.getSheetByName("Members");
  var headers = DRAGON_BOAT_RUNTIME_SHEET_HEADERS_.Members;
  if (!tab || spreadsheet.getId() !== input.spreadsheet_id ||
      String(tab.getSheetId()) !== input.tab_id || tab.getLastColumn() !== headers.length ||
      tab.getLastRow() < 1 || tab.getLastRow() > 5001 ||
      JSON.stringify(tab.getRange(1, 1, 1, headers.length).getDisplayValues()[0]) !== JSON.stringify(headers)) {
    throw dragonBoatRequestError_("SHEET_PATCH_STRUCTURE", "The registered member tab changed.");
  }
  var seen = {};
  input.items.forEach(function (item) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.member_id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(item.member_id) ||
        seen[item.member_id] || !Array.isArray(item.target) || item.target.length !== headers.length ||
        item.expected !== null && (!Array.isArray(item.expected) || item.expected.length !== headers.length)) {
      throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "A member patch item is invalid.");
    }
    seen[item.member_id] = true;
    [item.target].concat(item.expected === null ? [] : [item.expected]).forEach(function (cells) {
      if (cells.some(function (cell) { return typeof cell !== "string" || cell.length > 10000 ||
          cell.charAt(0) === "="; }) ||
          cells[0] !== seasonId || cells[1] !== item.member_id) {
        throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "A member patch row is invalid.");
      }
    });
  });
  return withBridgeScriptLock_(function () {
    // Recheck ownership after obtaining the lock; another script action may have changed the binding.
    var seasonSheet = getSystemSheet_("Seasons");
    var seasonHeaders = DRAGON_BOAT_SHEET_HEADERS_.Seasons;
    var currentRows = seasonSheet.getLastRow() > 1 ? seasonSheet.getRange(
      2, 1, seasonSheet.getLastRow() - 1, seasonHeaders.length).getDisplayValues() : [];
    var matching = currentRows.filter(function (cells) { return cells[0] === seasonId; });
    if (matching.length !== 1 ||
        Number(matching[0][seasonHeaders.indexOf("binding_version")]) !== bindingVersion ||
        matching[0][seasonHeaders.indexOf("runtime_spreadsheet_id")] !== spreadsheet.getId()) {
      throw dragonBoatRequestError_("BRIDGE_OWNERSHIP_INVALID", "The member patch binding changed.");
    }
    var system = getSystemSpreadsheet_();
    var receipts = system.getSheetByName("BridgeExportReceipts");
    if (!receipts) receipts = system.insertSheet("BridgeExportReceipts");
    ensureSheetHeader_(receipts, DRAGON_BOAT_SHEET_HEADERS_.BridgeExportReceipts);
    var receiptRow = 0;
    var prior = null;
    if (receipts.getLastRow() > 1) {
      var matches = receipts.getRange(2, 1, receipts.getLastRow() - 1, 1)
        .createTextFinder(batchId).matchEntireCell(true).matchCase(true).findAll();
      matches.forEach(function (match) {
        if (prior) throw dragonBoatRequestError_("BRIDGE_STATE_INVALID", "The batch receipt is duplicated.");
        receiptRow = match.getRow();
        prior = receipts.getRange(receiptRow, 1, 1, 9).getDisplayValues()[0];
      });
    }
    if (prior && (prior[1] !== verified.payload_digest || prior[2] !== seasonId ||
        prior[3] !== String(bindingVersion) || prior[4] !== String(verified.writer_epoch))) {
      throw dragonBoatRequestError_("BRIDGE_OPERATION_CONFLICT", "The batch ID has different input.");
    }
    if (prior && prior[5] === "VERIFIED") return JSON.parse(prior[6]);
    var at = new Date().toISOString();
    if (!prior) {
      receiptRow = receipts.getLastRow() + 1;
      receipts.getRange(receiptRow, 1, 1, 9).setValues([[
        batchId, verified.payload_digest, seasonId, String(bindingVersion),
        String(verified.writer_epoch), "PREPARED", "[]", at, at
      ]]);
    }
    var rows = tab.getLastRow() > 1 ?
      tab.getRange(2, 1, tab.getLastRow() - 1, headers.length).getDisplayValues() : [];
    var positions = {};
    rows.forEach(function (cells, index) {
      if (cells[0] !== seasonId || !/^[A-Za-z0-9_-]{8,128}$/.test(cells[1]) || positions[cells[1]]) {
        throw dragonBoatRequestError_("SHEET_PATCH_STRUCTURE", "The member tab has invalid or duplicate IDs.");
      }
      positions[cells[1]] = index + 2;
    });
    var verifiedIds = [];
    input.items.forEach(function (item) {
      var rowNumber = positions[item.member_id] || 0;
      var current = rowNumber ? tab.getRange(rowNumber, 1, 1, headers.length).getDisplayValues()[0] : null;
      if (item.expected === null) {
        if (current && JSON.stringify(current) !== JSON.stringify(item.target)) {
          throw dragonBoatRequestError_("SHEET_PATCH_CONFLICT", "A new member row already has different data.");
        }
        if (!current) {
          if (tab.getLastRow() >= 5001) {
            throw dragonBoatRequestError_("SHEET_SCAN_LIMIT", "The member tab is full.");
          }
          rowNumber = tab.getLastRow() + 1;
          tab.getRange(rowNumber, 1, 1, headers.length).setNumberFormat("@").setValues([item.target]);
          positions[item.member_id] = rowNumber;
        }
      } else {
        if (!current) throw dragonBoatRequestError_("SHEET_PATCH_CONFLICT", "The member row was removed.");
        current.forEach(function (cell, index) {
          if (cell !== item.expected[index] && cell !== item.target[index]) {
            throw dragonBoatRequestError_("SHEET_PATCH_CONFLICT", "A member cell changed since inspection.");
          }
        });
        current.forEach(function (cell, index) {
          if (cell === item.expected[index] && cell !== item.target[index]) {
            tab.getRange(rowNumber, index + 1, 1, 1).setNumberFormat("@").setValues([[item.target[index]]]);
          }
        });
      }
      SpreadsheetApp.flush();
      var after = tab.getRange(rowNumber, 1, 1, headers.length).getDisplayValues()[0];
      if (JSON.stringify(after) !== JSON.stringify(item.target)) {
        throw dragonBoatRequestError_("SHEET_PATCH_UNVERIFIED", "The member row did not match the target.", true);
      }
      verifiedIds.push(item.member_id);
      receipts.getRange(receiptRow, 6, 1, 3).setValues([[
        "PARTIAL", JSON.stringify(verifiedIds), new Date().toISOString()
      ]]);
    });
    var result = {
      status: "verified", protocol_version: verified.protocol, team_id: verified.team_id,
      season_id: seasonId, binding_version: bindingVersion, writer_epoch: verified.writer_epoch,
      operation_id: batchId, payload_digest: verified.payload_digest,
      spreadsheet_id: spreadsheet.getId(), tab_id: String(tab.getSheetId()),
      verified_member_ids: verifiedIds, acknowledged_at: new Date().toISOString()
    };
    receipts.getRange(receiptRow, 6, 1, 3).setValues([[
      "VERIFIED", JSON.stringify(result), result.acknowledged_at
    ]]);
    return result;
  });
}
