import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PROTOCOL } from "../src/bridge";
import { patchGoogleScheduleRows, SHEET_SCOPES, type ScheduleSheetScope } from "../src/c2-sheet-bridge";

const seasonId = "season_bridge_test_001";
const batchId = "batch_schedule_bridge_test_001";
const spreadsheetId = "spreadsheet_schedule_bridge_001";
const tabId = "123";
const environment = {
  ...env, TEAM_ID: "pentasus", WRITER_EPOCH: "0",
  GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/local-test/exec",
  GOOGLE_BRIDGE_SECRET: "local-schedule-bridge-secret"
} as Env;

afterEach(() => vi.restoreAllMocks());

describe("C2.4 schedule bridge receipt validation", () => {
  const scopes: Array<{ scope: ScheduleSheetScope; action: string; idKey: string }> = [
    { scope: "SCHEDULE_TEMPLATE", action: "cloudflarePatchScheduleTemplateSheet", idKey: "template_id" },
    { scope: "TRAINING_WEEK", action: "cloudflarePatchTrainingWeekSheet", idKey: "week_id" },
    { scope: "PRACTICE", action: "cloudflarePatchPracticeSheet", idKey: "practice_id" }
  ];

  it.each(scopes)("routes $scope to its bound action and checks the verified receipt", async ({ scope, action, idKey }) => {
    const rowId = `row_${scope.toLowerCase()}_001`;
    const target = SHEET_SCOPES[scope].headers.map((header) =>
      header === "season_id" ? seasonId : header === idKey ? rowId : "");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      const payload = JSON.parse(envelope.payload_json);
      expect(envelope.action).toBe(action);
      expect(envelope.binding_version).toBe(`${seasonId}:1`);
      expect(payload).toEqual({ season_id: seasonId, batch_id: batchId, entity_type: scope,
        spreadsheet_id: spreadsheetId, tab_id: tabId,
        items: [{ [idKey]: rowId, expected: null, target }] });
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        status: "verified", protocol_version: BRIDGE_PROTOCOL, team_id: environment.TEAM_ID,
        season_id: seasonId, binding_version: 1, writer_epoch: 0,
        operation_id: batchId, payload_digest: envelope.payload_digest,
        spreadsheet_id: spreadsheetId, tab_id: tabId, entity_type: scope,
        verified_row_ids: [rowId], acknowledged_at: new Date().toISOString()
      } });
    });
    const receipt = await patchGoogleScheduleRows(environment, {
      request_id: `request_schedule_${scope.toLowerCase()}_001`, batch_id: batchId,
      season_id: seasonId, binding_version: 1, entity_type: scope,
      spreadsheet_id: spreadsheetId, tab_id: tabId,
      items: [{ row_id: rowId, expected: null, target }]
    });
    expect(receipt.verified_row_ids).toEqual([rowId]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["entity_type", "verified_row_ids", "tab_id", "payload_digest"])(
    "rejects a mismatched %s even when the response claims verification", async (field) => {
      const rowId = "practice_bridge_reject_001";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const envelope = JSON.parse(String(init?.body));
        const receipt: Record<string, unknown> = {
          status: "verified", protocol_version: BRIDGE_PROTOCOL, team_id: environment.TEAM_ID,
          season_id: seasonId, binding_version: 1, writer_epoch: 0,
          operation_id: batchId, payload_digest: envelope.payload_digest,
          spreadsheet_id: spreadsheetId, tab_id: tabId, entity_type: "PRACTICE",
          verified_row_ids: [rowId], acknowledged_at: new Date().toISOString()
        };
        receipt[field] = field === "verified_row_ids" ? ["practice_wrong_id_001"] : "wrong";
        return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: receipt });
      });
      await expect(patchGoogleScheduleRows(environment, {
        request_id: `request_schedule_reject_${field}_001`, batch_id: batchId,
        season_id: seasonId, binding_version: 1, entity_type: "PRACTICE",
        spreadsheet_id: spreadsheetId, tab_id: tabId,
        items: [{ row_id: rowId, expected: null,
          target: SHEET_SCOPES.PRACTICE.headers.map(() => "") }]
      })).rejects.toMatchObject({ code: "BRIDGE_INVALID_RESPONSE" });
    }
  );
});
