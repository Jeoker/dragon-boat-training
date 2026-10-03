import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PROTOCOL } from "../src/bridge";
import { patchGoogleAssociatedRows, SHEET_SCOPES,
  type AssociatedSheetScope } from "../src/c2-sheet-bridge";

const seasonId = "season_associated_bridge_001";
const batchId = "batch_associated_bridge_001";
const spreadsheetId = "spreadsheet_associated_bridge_001";
const tabId = "123";
const environment = {
  ...env, TEAM_ID: "pentasus", WRITER_EPOCH: "0",
  GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/local-test/exec",
  GOOGLE_BRIDGE_SECRET: "local-associated-bridge-secret"
} as Env;

afterEach(() => vi.restoreAllMocks());

describe("C2.4 associated patch transport", () => {
  const scopes: Array<{ scope: AssociatedSheetScope; action: string; rowId: string }> = [
    { scope: "SIGNUP", action: "cloudflarePatchSignupSheet",
      rowId: "practice_associated_001:member_associated_001" },
    { scope: "SEAT_PLAN_DRAFT", action: "cloudflarePatchSeatPlanStateSheet",
      rowId: "practice_associated_001" },
    { scope: "SEAT_PLAN_CURRENT", action: "cloudflarePatchSeatPlanCurrentSheet",
      rowId: "practice_associated_001:1:LEFT" },
    { scope: "SEAT_PLAN_REVISION", action: "cloudflarePatchSeatPlanRevisionSheet",
      rowId: "practice_associated_001:1" }
  ];

  it.each(scopes)("routes $scope and verifies identity-bound receipt", async ({ scope, action, rowId }) => {
    const target = SHEET_SCOPES[scope].headers.map((header) =>
      header === "season_id" ? seasonId : "");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      expect(envelope.action).toBe(action);
      expect(JSON.parse(envelope.payload_json)).toEqual({
        season_id: seasonId, batch_id: batchId, entity_type: scope,
        spreadsheet_id: spreadsheetId, tab_id: tabId,
        items: [{ row_id: rowId, expected: null, target }]
      });
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        status: "verified", protocol_version: BRIDGE_PROTOCOL, team_id: environment.TEAM_ID,
        season_id: seasonId, binding_version: 1, writer_epoch: 0,
        operation_id: batchId, payload_digest: envelope.payload_digest,
        spreadsheet_id: spreadsheetId, tab_id: tabId, entity_type: scope,
        verified_row_ids: [rowId], acknowledged_at: new Date().toISOString()
      } });
    });
    const receipt = await patchGoogleAssociatedRows(environment, {
      request_id: `request_associated_${scope.toLowerCase()}_001`, batch_id: batchId,
      season_id: seasonId, binding_version: 1, entity_type: scope,
      spreadsheet_id: spreadsheetId, tab_id: tabId,
      items: [{ row_id: rowId, expected: null, target }]
    });
    expect(receipt.verified_row_ids).toEqual([rowId]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a forged verified ID or oversized payload", async () => {
    const target = SHEET_SCOPES.SIGNUP.headers.map(() => "");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        status: "verified", protocol_version: BRIDGE_PROTOCOL, team_id: environment.TEAM_ID,
        season_id: seasonId, binding_version: 1, writer_epoch: 0,
        operation_id: batchId, payload_digest: envelope.payload_digest,
        spreadsheet_id: spreadsheetId, tab_id: tabId, entity_type: "SIGNUP",
        verified_row_ids: ["practice_other:member_other"], acknowledged_at: new Date().toISOString()
      } });
    });
    const base = { request_id: "request_associated_forged_001", batch_id: batchId,
      season_id: seasonId, binding_version: 1, entity_type: "SIGNUP" as const,
      spreadsheet_id: spreadsheetId, tab_id: tabId };
    await expect(patchGoogleAssociatedRows(environment, {
      ...base, items: [{ row_id: "practice_associated_001:member_associated_001",
        expected: null, target }]
    })).rejects.toMatchObject({ code: "BRIDGE_INVALID_RESPONSE" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(patchGoogleAssociatedRows(environment, {
      ...base, items: [{ row_id: "practice_associated_001:member_associated_001",
        expected: null, target: [...target, "x".repeat(9_500)] }]
    })).rejects.toMatchObject({ code: "SYNC_BATCH_TOO_LARGE" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
