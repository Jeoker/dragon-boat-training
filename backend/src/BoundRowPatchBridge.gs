// One bounded, resumable patch protocol for bound runtime rows and the system season row.
// Existing season rows are never created by this bridge.
function cloudflarePatchMemberSheet_(request) {
  return cloudflarePatchBoundRows_(request, "MEMBER");
}

function cloudflarePatchSeasonSheet_(request) {
  return cloudflarePatchBoundRows_(request, "SEASON");
}

function cloudflarePatchScheduleTemplateSheet_(request) {
  return cloudflarePatchBoundRows_(request, "SCHEDULE_TEMPLATE");
}

function cloudflarePatchTrainingWeekSheet_(request) {
  return cloudflarePatchBoundRows_(request, "TRAINING_WEEK");
}

function cloudflarePatchPracticeSheet_(request) {
  return cloudflarePatchBoundRows_(request, "PRACTICE");
}

function cloudflarePatchBoundRows_(request, scope) {
  var verified = verifyBridgeEnvelope_(request, null);
  var input = verified.payload;
  var seasonId = requireRequestString_(input, "season_id", 8, 128);
  var batchId = requireRequestString_(input, "batch_id", 8, 128);
  var seasonScope = scope === "SEASON";
  var scheduleScopes = {
    SCHEDULE_TEMPLATE: { idKey: "template_id", tabName: "ScheduleTemplates" },
    TRAINING_WEEK: { idKey: "week_id", tabName: "TrainingWeeks" },
    PRACTICE: { idKey: "practice_id", tabName: "Practices" }
  };
  var scheduleScope = scheduleScopes[scope] || null;
  var idKey = seasonScope ? "season_id" : scheduleScope ? scheduleScope.idKey : "member_id";
  var tabName = seasonScope ? "Seasons" : scheduleScope ? scheduleScope.tabName : "Members";
  var headers = seasonScope ? DRAGON_BOAT_SHEET_HEADERS_.Seasons : DRAGON_BOAT_RUNTIME_SHEET_HEADERS_[tabName];
  var identityColumn = seasonScope ? 0 : 1;
  if (!/^[A-Za-z0-9_-]+$/.test(batchId) || batchId !== verified.operation_id ||
      (scheduleScope && input.entity_type !== scope) ||
      !Array.isArray(input.items) || input.items.length < 1 ||
      input.items.length > (seasonScope ? 1 : 4)) {
    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "The row patch batch is invalid.");
  }
  var season = requireSeason_(seasonId);
  var bindingVersion = Number(season.binding_version);
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 1 ||
      verified.binding_version !== seasonId + ":" + bindingVersion) {
    throw dragonBoatRequestError_("BRIDGE_OWNERSHIP_INVALID", "The row patch has the wrong season binding.");
  }
  var spreadsheet = seasonScope ? getSystemSpreadsheet_() : getSeasonSpreadsheet_(season);
  var tab = spreadsheet.getSheetByName(tabName);
  var rowCount = tab ? tab.getLastRow() : 0;
  if (!tab || spreadsheet.getId() !== input.spreadsheet_id ||
      String(tab.getSheetId()) !== input.tab_id || tab.getLastColumn() !== headers.length ||
      rowCount < 1 || rowCount > 5001 ||
      JSON.stringify(tab.getRange(1, 1, 1, headers.length).getDisplayValues()[0]) !== JSON.stringify(headers)) {
    throw dragonBoatRequestError_("SHEET_PATCH_STRUCTURE", "The registered patch tab changed.");
  }
  if (rowCount * headers.length > 100000) {
    throw dragonBoatRequestError_("SHEET_SCAN_LIMIT", "The patch tab exceeds the bounded scan size.");
  }
  var seen = Object.create(null);
  var seasonMutable = {
    name: true, start_date: true, end_date: true, timezone: true,
    season_ends_at: true, status: true, season_version: true,
    roster_version: true, updated_at: true
  };
  input.items.forEach(function (item) {
    var id = item && item[idKey];
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(id) ||
        (seasonScope && id !== seasonId) || seen[id] ||
        !Array.isArray(item.target) || item.target.length !== headers.length ||
        item.expected !== null && (!Array.isArray(item.expected) || item.expected.length !== headers.length) ||
        (seasonScope && item.expected === null)) {
      throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "A row patch item is invalid.");
    }
    seen[id] = true;
    [item.target].concat(item.expected === null ? [] : [item.expected]).forEach(function (cells) {
      if (cells.some(function (cell) { return typeof cell !== "string" || cell.length > 10000 ||
          cell.charAt(0) === "="; }) ||
          cells[0] !== seasonId || cells[identityColumn] !== id) {
        throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "A row patch value is invalid.");
      }
    });
    if (seasonScope && item.target.some(function (cell, index) {
      return !seasonMutable[headers[index]] && cell !== item.expected[index];
    })) {
      throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "A season patch cannot change Google binding fields.");
    }
  });
  return withBridgeScriptLock_(function () {
    var seasonSheet = getSystemSheet_("Seasons");
    var seasonHeaders = DRAGON_BOAT_SHEET_HEADERS_.Seasons;
    var currentRows = seasonSheet.getLastRow() > 1 ? seasonSheet.getRange(
      2, 1, seasonSheet.getLastRow() - 1, seasonHeaders.length).getDisplayValues() : [];
    var matching = currentRows.filter(function (cells) { return cells[0] === seasonId; });
    if (matching.length !== 1 ||
        Number(matching[0][seasonHeaders.indexOf("binding_version")]) !== bindingVersion ||
        matching[0][seasonHeaders.indexOf("runtime_spreadsheet_id")] !== season.runtime_spreadsheet_id) {
      throw dragonBoatRequestError_("BRIDGE_OWNERSHIP_INVALID", "The row patch binding changed.");
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
    var completedReceipt = prior && prior[5] === "VERIFIED" ? JSON.parse(prior[6]) : null;
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
    var inspectedCharacters = 0;
    rows.forEach(function (cells) {
      cells.forEach(function (cell) {
        inspectedCharacters += cell.length;
        if (cell.length > 10000 || inspectedCharacters > 2000000) {
          throw dragonBoatRequestError_("SHEET_SCAN_LIMIT", "The patch tab exceeds the bounded content size.");
        }
      });
    });
    var positions = Object.create(null);
    rows.forEach(function (cells, index) {
      if ((!seasonScope && cells[0] !== seasonId) ||
          !/^[A-Za-z0-9_-]{8,128}$/.test(cells[identityColumn]) || positions[cells[identityColumn]]) {
        throw dragonBoatRequestError_("SHEET_PATCH_STRUCTURE", "The patch tab has invalid or duplicate IDs.");
      }
      positions[cells[identityColumn]] = index + 2;
    });
    if (completedReceipt) {
      input.items.forEach(function (item) {
        var rowNumber = positions[item[idKey]] || 0;
        var current = rowNumber ? tab.getRange(rowNumber, 1, 1, headers.length).getDisplayValues()[0] : null;
        if (!current || JSON.stringify(current) !== JSON.stringify(item.target)) {
          throw dragonBoatRequestError_("SHEET_PATCH_CONFLICT", "A verified row changed after its receipt.");
        }
      });
      return completedReceipt;
    }
    var verifiedIds = [];
    input.items.forEach(function (item) {
      var id = item[idKey];
      var rowNumber = positions[id] || 0;
      var current = rowNumber ? tab.getRange(rowNumber, 1, 1, headers.length).getDisplayValues()[0] : null;
      if (item.expected === null) {
        if (current && JSON.stringify(current) !== JSON.stringify(item.target)) {
          throw dragonBoatRequestError_("SHEET_PATCH_CONFLICT", "A new row already has different data.");
        }
        if (!current) {
          if (tab.getLastRow() >= 5001 || (tab.getLastRow() + 1) * headers.length > 100000) {
            throw dragonBoatRequestError_("SHEET_SCAN_LIMIT", "The patch tab is full.");
          }
          rowNumber = tab.getLastRow() + 1;
          tab.getRange(rowNumber, 1, 1, headers.length).setNumberFormat("@").setValues([item.target]);
          positions[id] = rowNumber;
        }
      } else {
        if (!current) throw dragonBoatRequestError_("SHEET_PATCH_CONFLICT", "The row was removed.");
        current.forEach(function (cell, index) {
          if (cell !== item.expected[index] && cell !== item.target[index]) {
            throw dragonBoatRequestError_("SHEET_PATCH_CONFLICT", "A cell changed since inspection.");
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
        throw dragonBoatRequestError_("SHEET_PATCH_UNVERIFIED", "The row did not match the target.", true);
      }
      verifiedIds.push(id);
      receipts.getRange(receiptRow, 6, 1, 3).setValues([[
        "PARTIAL", JSON.stringify(verifiedIds), new Date().toISOString()
      ]]);
    });
    var result = {
      status: "verified", protocol_version: verified.protocol, team_id: verified.team_id,
      season_id: seasonId, binding_version: bindingVersion, writer_epoch: verified.writer_epoch,
      operation_id: batchId, payload_digest: verified.payload_digest,
      spreadsheet_id: spreadsheet.getId(), tab_id: String(tab.getSheetId()),
      acknowledged_at: new Date().toISOString()
    };
    result[seasonScope ? "verified_season_ids" : scheduleScope ? "verified_row_ids" : "verified_member_ids"] = verifiedIds;
    if (scheduleScope) result.entity_type = scope;
    receipts.getRange(receiptRow, 6, 1, 3).setValues([[
      "VERIFIED", JSON.stringify(result), result.acknowledged_at
    ]]);
    return result;
  });
}
