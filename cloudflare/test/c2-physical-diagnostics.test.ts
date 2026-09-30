import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../shared/c1-rules";
import { sha256Base64Url } from "../src/crypto";
import { SHEET_SCOPES, type AssociatedSheetScope, type SheetPage } from "../src/c2-sheet-bridge";
import { analyzePhysicalPage, scanLimitIntegrity, type PhysicalBaseline } from "../src/c2-physical-diagnostics";

const season = "season_physical_001";
const practice = "practice_physical_001";
const member = "member_physical_001";
const at = "2026-09-30T12:00:00.000Z";

function cells(scope: AssociatedSheetScope, extras: Record<string, string> = {}): string[] {
  const row = { season_id: season, practice_id: practice, member_id: member,
    row_number: "1", side: "LEFT", revision_number: "1", revision_id: "revision_physical_001",
    preference: "LEFT", status: "CONFIRMED", queue_at: at, queue_sequence: "1",
    updated_at: at, last_request_id: "request_physical_001", seat_plan_version: "1", ...extras };
  return SHEET_SCOPES[scope].headers.map((header) => row[header as keyof typeof row] ?? "");
}

function page(scope: AssociatedSheetScope, rows: string[][]): SheetPage {
  return { entity_type: scope, spreadsheet_id: "spreadsheet_physical_001",
    tab_name: SHEET_SCOPES[scope].tab, tab_id: "100", read_at_ms: Date.parse(at),
    headers: [...SHEET_SCOPES[scope].headers],
    rows: rows.map((value, index) => ({ row_number: index + 2, cells: value })) };
}

function id(scope: AssociatedSheetScope, row: string[]): string {
  if (scope === "SIGNUP") return `${row[1]}:${row[2]}`;
  if (scope === "SEAT_PLAN_CURRENT") return `${row[1]}:${row[2]}:${row[3]}`;
  if (scope === "SEAT_PLAN_REVISION") return `${row[1]}:${row[2]}`;
  return row[1];
}

async function baseline(scope: AssociatedSheetScope, row: string[]): Promise<PhysicalBaseline> {
  const cells_json = canonicalJson(row);
  return { scope, row_id: id(scope, row), cells_json,
    cells_digest: `sha256_v1:${await sha256Base64Url(cells_json)}` };
}

async function inspect(scope: AssociatedSheetScope, rows: string[][], baselines: PhysicalBaseline[]) {
  return analyzePhysicalPage({ season_id: season, scope, page: page(scope, rows), baselines });
}

describe("C2 associated physical diagnostics", () => {
  it("checks all four full-row scopes without exposing row contents", async () => {
    for (const scope of ["SIGNUP", "SEAT_PLAN_DRAFT", "SEAT_PLAN_CURRENT",
      "SEAT_PLAN_REVISION"] as AssociatedSheetScope[]) {
      const row = cells(scope);
      const source = page(scope, [row]);
      const baselines = [await baseline(scope, row)];
      if (scope === "SEAT_PLAN_DRAFT") {
        const seat = cells("SEAT_PLAN_CURRENT");
        source.secondary = { tab_name: "SeatPlanCurrent", tab_id: "101",
          headers: [...SHEET_SCOPES.SEAT_PLAN_CURRENT.headers],
          rows: [{ row_number: 2, cells: seat }] };
        baselines.push(await baseline("SEAT_PLAN_CURRENT", seat));
      }
      const result = await analyzePhysicalPage({ season_id: season, scope, page: source, baselines });
      expect(result).toMatchObject({ status: "OK", coverage: "complete", rows_read: baselines.length,
        baselines_checked: baselines.length, findings_count: 0 });
      expect(JSON.stringify(result)).not.toContain(member);
    }
  });

  it("finds audit-only changes in signup and seat state while leaving the semantic check independent", async () => {
    const signup = cells("SIGNUP");
    const signupB = await baseline("SIGNUP", signup);
    const modified = [...signup];
    modified[SHEET_SCOPES.SIGNUP.headers.indexOf("last_request_id")] = "request_physical_edited";
    expect(await inspect("SIGNUP", [modified], [signupB])).toMatchObject({ status: "DRIFT",
      findings: [{ scope: "SIGNUP", tab_name: "SignupsCurrent", type: "CELL_CHANGED",
        changed_columns: ["last_request_id"], google_row_number: 2 }] });
    const state = cells("SEAT_PLAN_DRAFT");
    const seat = cells("SEAT_PLAN_CURRENT");
    const source = page("SEAT_PLAN_DRAFT", [state]);
    source.secondary = { tab_name: "SeatPlanCurrent", tab_id: "101",
      headers: [...SHEET_SCOPES.SEAT_PLAN_CURRENT.headers],
      rows: [{ row_number: 2, cells: [...seat] }] };
    source.secondary.rows[0].cells[SHEET_SCOPES.SEAT_PLAN_CURRENT.headers.indexOf("updated_by")] =
      "coach_physical_edited";
    const result = await analyzePhysicalPage({ season_id: season, scope: "SEAT_PLAN_DRAFT",
      page: source, baselines: [await baseline("SEAT_PLAN_DRAFT", state),
        await baseline("SEAT_PLAN_CURRENT", seat)] });
    expect(result).toMatchObject({ status: "DRIFT", findings: [
      { scope: "SEAT_PLAN_CURRENT", tab_name: "SeatPlanCurrent", type: "CELL_CHANGED",
        changed_columns: ["updated_by"] }] });
  });

  it("reports revision edits, deletion, extra row, changed identity and duplicate identity", async () => {
    const original = cells("SEAT_PLAN_REVISION");
    const B = await baseline("SEAT_PLAN_REVISION", original);
    const altered = [...original];
    altered[SHEET_SCOPES.SEAT_PLAN_REVISION.headers.indexOf("revision_id")] = "revision_physical_002";
    expect(await inspect("SEAT_PLAN_REVISION", [altered], [B])).toMatchObject({ status: "DRIFT",
      findings: [{ type: "CELL_CHANGED", changed_columns: ["revision_id"] }] });
    expect(await inspect("SEAT_PLAN_REVISION", [], [B])).toMatchObject({ status: "DRIFT",
      findings: [{ type: "GOOGLE_ROW_MISSING" }] });
    const extra = cells("SEAT_PLAN_REVISION", { revision_number: "2" });
    expect(await inspect("SEAT_PLAN_REVISION", [original, extra], [B])).toMatchObject({
      status: "INCOMPLETE", findings: [{ type: "BASELINE_MISSING", google_row_number: 3 }] });
    expect(await inspect("SEAT_PLAN_REVISION", [extra], [B])).toMatchObject({ status: "INCOMPLETE",
      findings: [{ type: "GOOGLE_ROW_MISSING" }, { type: "BASELINE_MISSING" }] });
    expect(await inspect("SEAT_PLAN_REVISION", [original, original], [B])).toMatchObject({
      status: "STRUCTURE_INVALID", findings: [{ type: "ROW_ID_DUPLICATE" }] });
  });

  it("never calls missing or malformed B, invalid structure, or bounded scans clean", async () => {
    const row = cells("SIGNUP");
    const B = await baseline("SIGNUP", row);
    expect(await inspect("SIGNUP", [row], [])).toMatchObject({ status: "INCOMPLETE",
      findings: [{ type: "BASELINE_MISSING" }] });
    expect(await inspect("SIGNUP", [], [])).toMatchObject({ status: "INCOMPLETE",
      findings: [{ type: "BASELINE_NOT_ESTABLISHED" }] });
    expect(await inspect("SIGNUP", [row], [{ ...B, cells_json: "broken" }])).toMatchObject({
      status: "INCOMPLETE", findings: [{ type: "BASELINE_INVALID" }] });
    expect(await inspect("SIGNUP", [row], [{ ...B, cells_digest: "wrong" }])).toMatchObject({
      status: "INCOMPLETE", findings: [{ type: "BASELINE_INVALID" }] });
    const foreign = [...row]; foreign[0] = "season_foreign_001";
    expect(await inspect("SIGNUP", [foreign], [B])).toMatchObject({ status: "STRUCTURE_INVALID",
      findings: expect.arrayContaining([expect.objectContaining({ type: "SEASON_MISMATCH" })]) });
    const badHeader = page("SIGNUP", [row]); badHeader.headers[0] = "wrong";
    expect(await analyzePhysicalPage({ season_id: season, scope: "SIGNUP",
      page: badHeader, baselines: [B] })).toMatchObject({ status: "STRUCTURE_INVALID",
      coverage: "failed", findings: [{ type: "HEADER_CHANGED" }] });
    expect(scanLimitIntegrity("SIGNUP")).toMatchObject({ status: "INCOMPLETE",
      coverage: "bounded_limit" });
    expect(await analyzePhysicalPage({ season_id: season, scope: "SIGNUP",
      page: page("SIGNUP", [row]), baselines: [B], baseline_limited: true }))
      .toMatchObject({ status: "INCOMPLETE", coverage: "bounded_limit" });
  });

  it("caps detailed findings at 100 while preserving the total", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => cells("SIGNUP", {
      member_id: `member_physical_${String(index).padStart(3, "0")}` }));
    const result = await inspect("SIGNUP", rows, []);
    expect(result).toMatchObject({ status: "INCOMPLETE", rows_read: 120,
      findings_count: 120, truncated: true });
    expect(result.findings).toHaveLength(100);
  });
});
