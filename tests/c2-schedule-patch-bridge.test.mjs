import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createBackend, post } from "./backend-test-runtime.mjs";

const secret = "schedule-patch-test-secret";
const properties = {
  DRAGON_BOAT_BRIDGE_SECRET: secret,
  DRAGON_BOAT_BRIDGE_TEAM_ID: "pentasus",
  DRAGON_BOAT_BRIDGE_BINDING_VERSION: "c0",
  DRAGON_BOAT_BRIDGE_WRITER_EPOCH: "0"
};

function signed(action, seasonId, payload, operationId, bindingVersion = 1) {
  const payload_json = JSON.stringify(payload);
  const request = {
    action, request_id: `request_${operationId}`,
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: "pentasus", binding_version: `${seasonId}:${bindingVersion}`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: `nonce_${crypto.randomUUID().replaceAll("-", "_")}`,
    operation_id: operationId, payload_json,
    payload_digest: crypto.createHash("sha256").update(payload_json).digest("base64url")
  };
  request.signature = crypto.createHmac("sha256", secret).update([
    request.protocol_version, request.direction, request.team_id, request.binding_version,
    request.writer_epoch, request.timestamp_ms, request.nonce, request.operation_id,
    request.payload_digest
  ].join("\n")).digest("base64url");
  return request;
}

test("schedule bridge reads and patches three bound tabs with verified resumable receipts", async () => {
  const backend = await createBackend({ properties });
  const login = post(backend.context, {
    action: "coachLogin", request_id: "schedule_patch_login", coach_code: "coach-code-123"
  });
  const season = post(backend.context, {
    action: "createSeason", request_id: "schedule_patch_season", session_token: login.data.session_token,
    name: "Schedule Patch 2026", start_date: "2026-09-01", end_date: "2026-12-31",
    timezone: "America/New_York"
  }).data.season;
  const fixture = backend.createFormBinding();
  assert.equal(post(backend.context, {
    action: "initializeSeason", request_id: "schedule_patch_initialize",
    session_token: login.data.session_token, season_id: season.season_id,
    season_version: season.season_version, form: fixture.formId,
    spreadsheet: fixture.spreadsheetId, response_sheet: fixture.responseSheet.getName(),
    display_name_header: "Display Name"
  }).ok, true);

  const cases = [
    { scope: "SCHEDULE_TEMPLATE", action: "cloudflarePatchScheduleTemplateSheet",
      tab: "ScheduleTemplates", idKey: "template_id", id: "template_bridge_001",
      row: { day_of_week: "3", start_time: "18:00", end_time: "20:00", timezone: "America/New_York",
        location: "Dock A", address: "1 River Road", map_url: "", active: "TRUE", template_version: "1" } },
    { scope: "TRAINING_WEEK", action: "cloudflarePatchTrainingWeekSheet",
      tab: "TrainingWeeks", idKey: "week_id", id: "week_bridge_001",
      row: { week_start_date: "2026-09-07", scheduled_open_at: "", status: "DRAFT",
        week_version: "1", confirmed_version: "", confirmed_by: "", confirmed_at: "", published_at: "" } },
    { scope: "PRACTICE", action: "cloudflarePatchPracticeSheet",
      tab: "Practices", idKey: "practice_id", id: "practice_bridge_001",
      row: { week_id: "week_bridge_001", template_id: "template_bridge_001", generation_key: "generation_bridge_001",
        start_at: "2026-09-09T22:00:00.000Z", end_at: "2026-09-10T00:00:00.000Z",
        timezone: "America/New_York", location: "Dock A", address: "1 River Road", map_url: "",
        left_capacity: "10", right_capacity: "10", signup_cutoff_at: "2026-09-09T20:00:00.000Z",
        practice_version: "1", cancelled_at: "", cancelled_by: "", schedule_published_at: "",
        schedule_published_by: "" } }
  ];

  for (const [index, entry] of cases.entries()) {
    const sheet = fixture.runtimeSpreadsheet.getSheetByName(entry.tab);
    assert.ok(sheet, entry.tab);
    const headers = sheet.rows[0];
    const values = { season_id: season.season_id, [entry.idKey]: entry.id, ...entry.row,
      created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" };
    const row = headers.map((header) => values[header] ?? "");
    const batchId = `batch_schedule_${index}_001`;
    const payload = { season_id: season.season_id, batch_id: batchId, entity_type: entry.scope,
      spreadsheet_id: fixture.spreadsheetId, tab_id: String(sheet.getSheetId()),
      items: [{ [entry.idKey]: entry.id, expected: null, target: row }] };
    const first = post(backend.context, signed(entry.action, season.season_id, payload, batchId));
    assert.equal(first.ok, true, JSON.stringify(first.error));
    assert.equal(first.data.entity_type, entry.scope);
    assert.deepEqual(first.data.verified_row_ids, [entry.id]);
    assert.deepEqual([...sheet.rows[1]], row);
    assert.equal(post(backend.context, signed(entry.action, season.season_id, payload, batchId)).ok, true);
    assert.equal(sheet.rows.length, 2);
    const read = post(backend.context, signed("cloudflareReadSheetRecords", season.season_id,
      { season_id: season.season_id, entity_type: entry.scope }, `read_schedule_${index}`));
    assert.equal(read.ok, true);
    assert.equal(read.data.tab_name, entry.tab);
    assert.deepEqual(read.data.rows[0].cells, row);

    const changed = [...row];
    changed[headers.indexOf("updated_at")] = "2026-09-02T00:00:00.000Z";
    const updateId = `batch_schedule_${index}_002`;
    const updatePayload = { ...payload, batch_id: updateId,
      items: [{ [entry.idKey]: entry.id, expected: row, target: changed }] };
    assert.equal(post(backend.context, signed(entry.action, season.season_id, updatePayload, updateId)).ok, true);
    const staleId = `batch_schedule_${index}_003`;
    const staleTarget = [...changed];
    staleTarget[headers.indexOf("updated_at")] = "2026-09-03T00:00:00.000Z";
    const stalePayload = { ...payload, batch_id: staleId,
      items: [{ [entry.idKey]: entry.id, expected: row, target: staleTarget }] };
    assert.equal(post(backend.context, signed(entry.action, season.season_id, stalePayload, staleId))
      .error.code, "SHEET_PATCH_CONFLICT");
    assert.deepEqual([...sheet.rows[1]], changed);
  }

  const template = cases[0];
  const sheet = fixture.runtimeSpreadsheet.getSheetByName(template.tab);
  const firstRow = [...sheet.rows[1]];
  const nextId = "template_bridge_002";
  const thirdId = "template_bridge_003";
  const nextRow = [...firstRow]; nextRow[1] = nextId;
  const thirdRow = [...firstRow]; thirdRow[1] = thirdId;
  const conflicting = [...thirdRow]; conflicting[6] = "Manual edit";
  sheet.rows.push(conflicting);
  const batchId = "batch_schedule_partial_001";
  const partialPayload = { season_id: season.season_id, batch_id: batchId, entity_type: template.scope,
    spreadsheet_id: fixture.spreadsheetId, tab_id: String(sheet.getSheetId()),
    items: [{ template_id: nextId, expected: null, target: nextRow },
      { template_id: thirdId, expected: null, target: thirdRow }] };
  assert.equal(post(backend.context, signed(template.action, season.season_id, partialPayload, batchId))
    .error.code, "SHEET_PATCH_CONFLICT");
  const receipts = backend.spreadsheet.getSheetByName("BridgeExportReceipts");
  assert.equal(receipts.rows.at(-1)[5], "PARTIAL");
  assert.equal(sheet.rows.filter((row) => row[1] === nextId).length, 1);
  sheet.rows = sheet.rows.filter((row) => row[1] !== thirdId);
  assert.equal(post(backend.context, signed(template.action, season.season_id, partialPayload, batchId)).ok, true);
  assert.equal(sheet.rows.filter((row) => row[1] === nextId).length, 1);
  assert.equal(sheet.rows.filter((row) => row[1] === thirdId).length, 1);
  assert.equal(receipts.rows.at(-1)[5], "VERIFIED");

  const editId = "batch_schedule_manual_edit";
  const targetAfterEdit = [...firstRow];
  targetAfterEdit[6] = "Proposed Dock";
  sheet.rows[1][6] = "Manual Dock";
  assert.equal(post(backend.context, signed(template.action, season.season_id,
    { ...partialPayload, batch_id: editId,
      items: [{ template_id: template.id, expected: firstRow, target: targetAfterEdit }] }, editId))
    .error.code, "SHEET_PATCH_CONFLICT");
  assert.equal(sheet.rows[1][6], "Manual Dock");
  sheet.rows[1][6] = firstRow[6];
  const deleted = sheet.rows.splice(1, 1)[0];
  const deletedId = "batch_schedule_deleted_row";
  assert.equal(post(backend.context, signed(template.action, season.season_id,
    { ...partialPayload, batch_id: deletedId,
      items: [{ template_id: template.id, expected: firstRow, target: targetAfterEdit }] }, deletedId))
    .error.code, "SHEET_PATCH_CONFLICT");
  sheet.rows.splice(1, 0, deleted);
  sheet.rows.push([...deleted]);
  const duplicateId = "batch_schedule_duplicate_row";
  assert.equal(post(backend.context, signed(template.action, season.season_id,
    { ...partialPayload, batch_id: duplicateId,
      items: [{ template_id: template.id, expected: firstRow, target: targetAfterEdit }] }, duplicateId))
    .error.code, "SHEET_PATCH_STRUCTURE");
  sheet.rows.pop();
  const staleBindingId = "batch_schedule_stale_binding";
  assert.equal(post(backend.context, signed(template.action, season.season_id,
    { ...partialPayload, batch_id: staleBindingId,
      items: [{ template_id: template.id, expected: firstRow, target: targetAfterEdit }] },
    staleBindingId, 2)).error.code, "BRIDGE_OWNERSHIP_INVALID");
  const formulaId = "batch_schedule_formula";
  const formulaTarget = [...targetAfterEdit]; formulaTarget[6] = "=1+1";
  assert.equal(post(backend.context, signed(template.action, season.season_id,
    { ...partialPayload, batch_id: formulaId,
      items: [{ template_id: template.id, expected: firstRow, target: formulaTarget }] }, formulaId))
    .error.code, "BRIDGE_PAYLOAD_INVALID");

  const wrongScopeId = "batch_schedule_wrong_scope";
  assert.equal(post(backend.context, signed("cloudflarePatchPracticeSheet", season.season_id,
    { ...partialPayload, batch_id: wrongScopeId }, wrongScopeId)).error.code, "BRIDGE_PAYLOAD_INVALID");
  const wrongSeasonId = "batch_schedule_wrong_season";
  const foreignRow = [...firstRow]; foreignRow[0] = "season_other_2026";
  assert.equal(post(backend.context, signed(template.action, season.season_id,
    { ...partialPayload, batch_id: wrongSeasonId,
      items: [{ template_id: "template_bridge_001", expected: firstRow, target: foreignRow }] },
    wrongSeasonId)).error.code, "BRIDGE_PAYLOAD_INVALID");
  const wrongTabId = "batch_schedule_wrong_tab";
  assert.equal(post(backend.context, signed(template.action, season.season_id,
    { ...partialPayload, batch_id: wrongTabId, tab_id: "999999" }, wrongTabId))
    .error.code, "SHEET_PATCH_STRUCTURE");
  const practiceSheet = fixture.runtimeSpreadsheet.getSheetByName("Practices");
  practiceSheet.rows.push(...Array.from({ length: 4798 }, () => [...practiceSheet.rows[1]]));
  const oversizedId = "batch_schedule_oversized";
  assert.equal(post(backend.context, signed(cases[2].action, season.season_id,
    { ...partialPayload, batch_id: oversizedId, entity_type: "PRACTICE",
      tab_id: String(practiceSheet.getSheetId()), items: [] }, oversizedId))
    .error.code, "BRIDGE_PAYLOAD_INVALID");
  const oversizedValidId = "batch_schedule_oversized_valid";
  assert.equal(post(backend.context, signed(cases[2].action, season.season_id,
    { ...partialPayload, batch_id: oversizedValidId, entity_type: "PRACTICE",
      tab_id: String(practiceSheet.getSheetId()),
      items: [{ practice_id: cases[2].id, expected: null, target: [...practiceSheet.rows[1]] }] },
    oversizedValidId)).error.code, "SHEET_SCAN_LIMIT");
  practiceSheet.rows.length = 2;
  const weekSheet = fixture.runtimeSpreadsheet.getSheetByName("TrainingWeeks");
  const weekRow = [...weekSheet.rows[1]];
  fixture.runtimeSpreadsheet.sheets.delete("TrainingWeeks");
  const missingId = "batch_schedule_missing_tab";
  assert.equal(post(backend.context, signed(cases[1].action, season.season_id,
    { ...partialPayload, batch_id: missingId, entity_type: "TRAINING_WEEK",
      tab_id: String(weekSheet.getSheetId()),
      items: [{ week_id: cases[1].id, expected: weekRow, target: weekRow }] }, missingId))
    .error.code, "SHEET_PATCH_STRUCTURE");
  assert.equal(fixture.runtimeSpreadsheet.getSheetByName("TrainingWeeks"), null);
});
