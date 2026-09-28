import { describe, expect, it } from "vitest";
import { SYNC_FIELD_DEFINITIONS } from "../../shared/c2-sync-rules";
import { analyzeSheetPage, type SheetBaseline } from "../src/c2-sheet-diff";
import { prepareSheetFindings } from "../src/c2-sheet-findings";
import { SHEET_SCOPES, type SheetPage, type ComparedSheetScope } from "../src/c2-sheet-bridge";

const seasonId = "season_sheet_test_2026";
const memberId = "member_sheet_alice_01";
const member = {
  season_id: seasonId, member_id: memberId, source_key: "FORM_RESPONSE:test:alice",
  source_display_name: "Alice", display_name_override: "", status: "ACTIVE",
  default_preference: "LEFT", member_version: 1
};

function baselines(scope: ComparedSheetScope, entityId: string, values: Record<string, unknown>): SheetBaseline[] {
  const groups = new Map<string, Record<string, unknown>>();
  for (const definition of SYNC_FIELD_DEFINITIONS[scope]) {
    const group = groups.get(definition.dependency_group) ?? {};
    group[definition.field] = values[definition.field];
    groups.set(definition.dependency_group, group);
  }
  return [...groups].map(([dependency_group, baseline]) => ({ entity_id: entityId, dependency_group, baseline }));
}

function page(scope: ComparedSheetScope, records: Record<string, unknown>[],
  headers: string[] = [...SHEET_SCOPES[scope].headers]): SheetPage<ComparedSheetScope> {
  return { entity_type: scope, spreadsheet_id: "spreadsheet_sheet_test_01",
    tab_name: SHEET_SCOPES[scope].tab, tab_id: "123", read_at_ms: Date.now(), headers,
    rows: records.map((record, index) => ({ row_number: index + 2,
      cells: headers.map((header) => String(record[header] ?? "")) })) };
}

describe("C2.3 Sheet inspection", () => {
  it("classifies independent member changes without making a business mutation", () => {
    const result = analyzeSheetPage({ season_id: seasonId,
      page: page("MEMBER", [{ ...member, default_preference: "RIGHT" }]),
      baselines: baselines("MEMBER", memberId, member),
      cloud_rows: [{ ...member, display_name_override: "A. Smith", member_version: 2 }] });
    expect(result.status).toBe("OK");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ dependency_group: "MEMBER_NAME", outcome: "EXPORT" }),
      expect.objectContaining({ dependency_group: "MEMBER_DEFAULT_PREFERENCE", outcome: "IMPORT" })
    ]));
    expect(result.findings.some((entry) => entry.dependency_group === "SYSTEM_VERSION")).toBe(false);
  });

  it("keeps signup preference and status in one dependency group", () => {
    const signup = { season_id: seasonId, practice_id: "practice_sheet_test_01", member_id: memberId,
      preference: "LEFT", status: "CONFIRMED", queue_at: "2026-07-01T12:00:00.000Z",
      queue_sequence: 1, signup_version: 1 };
    const entityId = `${signup.practice_id}:${memberId}`;
    const result = analyzeSheetPage({ season_id: seasonId,
      page: page("SIGNUP", [{ ...signup, status: "CANCELLED" }]),
      baselines: baselines("SIGNUP", entityId, signup),
      cloud_rows: [{ ...signup, preference: "RIGHT" }] });
    expect(result.findings).toContainEqual(expect.objectContaining({
      dependency_group: "SIGNUP_STATE", outcome: "CONFLICT" }));
  });

  it("ignores row order while preserving changed IDs and deleted rows as reviews", () => {
    const bob = { ...member, member_id: "member_sheet_bob_002", source_key: "FORM_RESPONSE:test:bob",
      source_display_name: "Bob" };
    const baseline = [...baselines("MEMBER", memberId, member),
      ...baselines("MEMBER", bob.member_id, bob)];
    const sorted = analyzeSheetPage({ season_id: seasonId, page: page("MEMBER", [bob, member]),
      baselines: baseline, cloud_rows: [member, bob] });
    expect(sorted.findings_count).toBe(0);
    const changedId = analyzeSheetPage({ season_id: seasonId,
      page: page("MEMBER", [{ ...member, member_id: "member_sheet_changed_01" }, bob]),
      baselines: baseline, cloud_rows: [member, bob] });
    expect(changedId.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_id: memberId, dependency_group: "ROW_IDENTITY", outcome: "REVIEW_REQUIRED" }),
      expect.objectContaining({ entity_id: "member_sheet_changed_01", dependency_group: "ROW_IDENTITY",
        outcome: "REVIEW_REQUIRED" })
    ]));
    const deleted = analyzeSheetPage({ season_id: seasonId, page: page("MEMBER", [bob]),
      baselines: baseline, cloud_rows: [member, bob] });
    expect(deleted.findings).toContainEqual(expect.objectContaining({ entity_id: memberId,
      dependency_group: "ROW_IDENTITY", outcome: "REVIEW_REQUIRED" }));
  });

  it("stops comparison on duplicate IDs, alien season rows, and unknown columns", () => {
    const baseline = baselines("MEMBER", memberId, member);
    const duplicate = analyzeSheetPage({ season_id: seasonId, page: page("MEMBER", [member, member]),
      baselines: baseline, cloud_rows: [member] });
    expect(duplicate.status).toBe("STRUCTURE_INVALID");
    expect(duplicate.compared).toBe(0);
    const alien = analyzeSheetPage({ season_id: seasonId,
      page: page("MEMBER", [{ ...member, season_id: "season_other_2026" }]),
      baselines: baseline, cloud_rows: [member] });
    expect(alien.status).toBe("STRUCTURE_INVALID");
    const unknownColumn = analyzeSheetPage({ season_id: seasonId,
      page: page("MEMBER", [member], [...SHEET_SCOPES.MEMBER.headers, "unregistered_note"]),
      baselines: baseline, cloud_rows: [member] });
    expect(unknownColumn.status).toBe("STRUCTURE_INVALID");
    expect(unknownColumn.findings[0].google.headers).toContain("unregistered_note");
  });

  it("rejects invalid ID components before aligning Google rows to baselines", () => {
    const signup = { season_id: seasonId, practice_id: "practice_sheet_test_01",
      member_id: memberId, preference: "LEFT", status: "CONFIRMED",
      queue_at: "2026-07-01T12:00:00.000Z", queue_sequence: 1, signup_version: 1 };
    for (const edited of [
      { ...signup, practice_id: "practice.sheet.test.01" },
      { ...signup, member_id: "member:sheet:alice:01" },
      { ...signup, member_id: "short" }
    ]) {
      const result = analyzeSheetPage({ season_id: seasonId, page: page("SIGNUP", [edited]),
        baselines: baselines("SIGNUP", `${signup.practice_id}:${memberId}`, signup),
        cloud_rows: [signup] });
      expect(result).toMatchObject({ status: "STRUCTURE_INVALID", compared: 0 });
      expect(result.findings).toContainEqual(expect.objectContaining({
        dependency_group: "ROW_IDENTITY", outcome: "REVIEW_REQUIRED" }));
    }
  });

  it("keeps repeated identical corrupt rows visible but records one diagnostic fingerprint", async () => {
    const result = analyzeSheetPage({ season_id: seasonId,
      page: page("MEMBER", [member, member, member]),
      baselines: baselines("MEMBER", memberId, member), cloud_rows: [member] });
    expect(result.status).toBe("STRUCTURE_INVALID");
    expect(result.findings_count).toBe(2);
    const prepared = await prepareSheetFindings({ season_id: seasonId, binding_version: 1,
      entity_type: "MEMBER", findings: result.findings, cloud_rows: [member] });
    expect(prepared).toHaveLength(1);
  });

  it("retains a late conflict when export candidates fill the bounded result", async () => {
    const exports = Array.from({ length: 101 }, (_, index) => ({ ...member,
      member_id: `member_bulk_${String(index).padStart(3, "0")}` }));
    const result = analyzeSheetPage({ season_id: seasonId,
      page: page("MEMBER", [{ ...member, display_name_override: "Google" }]),
      baselines: baselines("MEMBER", memberId, member),
      cloud_rows: [...exports, { ...member, display_name_override: "Cloud" }],
      max_findings: 100 });
    expect(result).toMatchObject({ status: "OK", findings_count: 102, truncated: true });
    expect(result.findings).toHaveLength(100);
    expect(result.findings).toContainEqual(expect.objectContaining({
      entity_id: memberId, dependency_group: "MEMBER_NAME", outcome: "CONFLICT" }));
    const persisted = await prepareSheetFindings({ season_id: seasonId, binding_version: 1,
      entity_type: "MEMBER", findings: result.findings, cloud_rows: [...exports, member] });
    expect(persisted).toContainEqual(expect.objectContaining({
      entity_id: memberId, dependency_group: "MEMBER_NAME", outcome: "CONFLICT" }));
    const reviews = analyzeSheetPage({ season_id: seasonId,
      page: page("MEMBER", [...exports, { ...member, display_name_override: "Google" }]),
      baselines: baselines("MEMBER", memberId, member),
      cloud_rows: [...exports, { ...member, display_name_override: "Cloud" }],
      max_findings: 100 });
    expect(reviews.findings).toContainEqual(expect.objectContaining({
      entity_id: memberId, dependency_group: "MEMBER_NAME", outcome: "CONFLICT" }));
  });

  it("rejects hand edits to protected source and version cells", () => {
    const baseline = baselines("MEMBER", memberId, member);
    const result = analyzeSheetPage({ season_id: seasonId,
      page: page("MEMBER", [{ ...member, source_display_name: "Forged", member_version: 9 }]),
      baselines: baseline, cloud_rows: [member] });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ dependency_group: "FORM_SOURCE", outcome: "REJECTED" }),
      expect.objectContaining({ dependency_group: "SYSTEM_VERSION", outcome: "REJECTED" })
    ]));
  });

  it("compares Coach, Steerer and seats as one draft dependency group", () => {
    const practiceId = "practice_sheet_seating_01";
    const draft = { season_id: seasonId, practice_id: practiceId, coach_member_id: "",
      steerer_member_id: "", seats: [{ side: "LEFT", row_number: 1, member_id: memberId }],
      seat_plan_version: 1, published_revision: 0 };
    const statePage = page("SEAT_PLAN_DRAFT", [{ ...draft, seat_plan_version: 1 }]);
    statePage.secondary = { tab_name: "SeatPlanCurrent", tab_id: "124",
      headers: ["season_id", "practice_id", "row_number", "side", "member_id",
        "seat_plan_version", "updated_by", "updated_at"],
      rows: [{ row_number: 2, cells: [seasonId, practiceId, "1", "LEFT", "member_sheet_bob_002",
        "1", "coach_sheet_test_01", "2026-09-01T12:00:00.000Z"] }] };
    const result = analyzeSheetPage({ season_id: seasonId, page: statePage,
      baselines: baselines("SEAT_PLAN_DRAFT", practiceId, draft),
      cloud_rows: [{ ...draft, coach_member_id: "member_sheet_coach_01" }] });
    expect(result.findings).toContainEqual(expect.objectContaining({
      dependency_group: "SEATING_DRAFT", outcome: "CONFLICT" }));
    statePage.secondary.rows.push({ row_number: 3, cells: [...statePage.secondary.rows[0].cells] });
    const duplicate = analyzeSheetPage({ season_id: seasonId, page: statePage,
      baselines: baselines("SEAT_PLAN_DRAFT", practiceId, draft), cloud_rows: [draft] });
    expect(duplicate.status).toBe("STRUCTURE_INVALID");
    statePage.secondary.rows = [{ row_number: 2,
      cells: [seasonId, practiceId, "1", "LEFT", "invalid.member.id",
        "1", "coach_sheet_test_01", "2026-09-01T12:00:00.000Z"] }];
    const invalidSeatMember = analyzeSheetPage({ season_id: seasonId, page: statePage,
      baselines: baselines("SEAT_PLAN_DRAFT", practiceId, draft), cloud_rows: [draft] });
    expect(invalidSeatMember.status).toBe("STRUCTURE_INVALID");
  });
});
