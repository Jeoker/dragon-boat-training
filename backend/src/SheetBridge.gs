// C2 inspection is read-only. Never use getSeasonSheet_ here: it can create a missing tab.
function cloudflareReadSheetRecords_(request) {
  var verified = verifyBridgeEnvelope_(request, null);
  var input = verified.payload;
  var seasonId = requireRequestString_(input, "season_id", 8, 128);
  var entityType = requireRequestString_(input, "entity_type", 1, 40);
  var tabNames = {
    COACH: "Coaches", SEASON: "Seasons", MEMBER: "Members",
    SIGNUP: "SignupsCurrent", PRACTICE: "Practices",
    SCHEDULE_TEMPLATE: "ScheduleTemplates", TRAINING_WEEK: "TrainingWeeks",
    SEAT_PLAN_DRAFT: "SeatPlanState"
  };
  if (!Object.prototype.hasOwnProperty.call(tabNames, entityType)) {
    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "The Sheet inspection scope is invalid.");
  }
  var season = requireSeason_(seasonId);
  var bindingVersion = Number(season.binding_version);
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 1 ||
      verified.binding_version !== seasonId + ":" + bindingVersion) {
    throw dragonBoatRequestError_("BRIDGE_OWNERSHIP_INVALID", "The Sheet read has the wrong season binding.");
  }
  var spreadsheet = entityType === "SEASON" || entityType === "COACH" ?
    getSystemSpreadsheet_() : getSeasonSpreadsheet_(season);
  var inspectedCells = 0;
  var inspectedCharacters = 0;
  function readTab(name) {
    var tab = spreadsheet.getSheetByName(name);
    if (!tab) throw dragonBoatRequestError_("BINDING_SHEET_MISSING", "A registered Sheet tab is missing.");
    var rowCount = tab.getLastRow();
    var columnCount = tab.getLastColumn();
    if (rowCount > 5001 || columnCount > 50 || inspectedCells + rowCount * columnCount > 100000) {
      throw dragonBoatRequestError_("SHEET_SCAN_LIMIT", "The Sheet tab exceeds the bounded inspection size.");
    }
    inspectedCells += rowCount * columnCount;
    var values = rowCount && columnCount ? tab.getRange(1, 1, rowCount, columnCount).getDisplayValues() : [];
    values.forEach(function (cells) {
      cells.forEach(function (cell) {
        inspectedCharacters += cell.length;
        if (cell.length > 10000 || inspectedCharacters > 2000000) {
          throw dragonBoatRequestError_("SHEET_SCAN_LIMIT", "The Sheet inspection payload is too large.");
        }
      });
    });
    return { tab_name: name, tab_id: String(tab.getSheetId()), headers: values.length ? values[0] : [],
      rows: values.slice(1).map(function (cells, index) { return { row_number: index + 2, cells: cells }; }) };
  }
  var primary = readTab(tabNames[entityType]);
  if (entityType === "COACH") {
    if (JSON.stringify(primary.headers) !== JSON.stringify(DRAGON_BOAT_SHEET_HEADERS_.Coaches)) {
      throw dragonBoatRequestError_("SHEET_STRUCTURE_INVALID", "The Coach tab header changed.");
    }
    // Reference checks need stable IDs only; never send credential digests to the Worker.
    primary.headers = ["coach_id"];
    primary.rows = primary.rows.map(function (row) {
      return { row_number: row.row_number, cells: [row.cells[0]] };
    });
  }
  var secondary = entityType === "SEAT_PLAN_DRAFT" ? readTab("SeatPlanCurrent") : null;
  return {
    protocol_version: verified.protocol,
    team_id: verified.team_id,
    season_id: seasonId,
    entity_type: entityType,
    binding_version: bindingVersion,
    writer_epoch: verified.writer_epoch,
    operation_id: verified.operation_id,
    payload_digest: verified.payload_digest,
    spreadsheet_id: spreadsheet.getId(),
    tab_name: primary.tab_name,
    tab_id: primary.tab_id,
    read_at_ms: new Date().getTime(),
    headers: primary.headers,
    rows: primary.rows,
    secondary: secondary
  };
}
