import { describe, expect, it } from "vitest";
import { SYNC_FIELD_DEFINITIONS, normalizeSyncValue } from "../../shared/c2-sync-rules";
import { projectSchedulePatch, type ScheduleBaselineRow } from "../src/c2-schedule-projection";
import { SHEET_SCOPES, type ScheduleSheetScope } from "../src/c2-sheet-bridge";

const seasonId = "season_projection_2026";
const at = "2026-07-01T12:00:00.000Z";
const template = { season_id: seasonId, template_id: "template_projection_001",
  day_of_week: 3, start_time: "18:00", end_time: "20:00", timezone: "America/New_York",
  location: "River", address: "Dock 1", map_url: "", active: true,
  template_version: 1, created_at: at, updated_at: at };
const week = { season_id: seasonId, week_id: "week_projection_001",
  week_start_date: "2026-07-06", scheduled_open_at: null, status: "DRAFT",
  week_version: 1, confirmed_version: null, confirmed_by: null, confirmed_at: null,
  published_at: null, created_at: at, updated_at: at };
const practice = { season_id: seasonId, practice_id: "practice_projection_001",
  week_id: week.week_id, template_id: template.template_id, generation_key: "generated_projection_001",
  start_at: "2026-07-08T22:00:00.000Z", end_at: "2026-07-09T00:00:00.000Z",
  timezone: "America/New_York", location: "River", address: "Dock 1", map_url: "",
  left_capacity: 10, right_capacity: 10, signup_cutoff_at: "2026-07-08T20:00:00.000Z",
  practice_version: 1, cancelled_at: null, cancelled_by: null,
  schedule_published_at: null, schedule_published_by: null, created_at: at, updated_at: at };

function baseline(scope: ScheduleSheetScope, source: Record<string, unknown>): ScheduleBaselineRow[] {
  return [...new Set(SYNC_FIELD_DEFINITIONS[scope].map((field) => field.dependency_group))].map((group) => ({
    dependency_group: group, cloud_version: Number(source[scope === "PRACTICE" ? "practice_version" :
      scope === "TRAINING_WEEK" ? "week_version" : "template_version"]),
    baseline_json: JSON.stringify(Object.fromEntries(SYNC_FIELD_DEFINITIONS[scope]
      .filter((field) => field.dependency_group === group)
      .map((field) => [field.field,
        normalizeSyncValue(source[field.field], field.kind, field.allowed_values)])))
  }));
}

describe("C2 schedule target projection", () => {
  it("covers every schedule Sheet column exactly once", () => {
    for (const scope of ["SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE"] as const) {
      expect(SYNC_FIELD_DEFINITIONS[scope].map((field) => field.field).sort())
        .toEqual([...SHEET_SCOPES[scope].headers].sort());
    }
  });

  it("projects new rows with stable boolean, nullable and timestamp cells", () => {
    const projectedTemplate = projectSchedulePatch({ entity_type: "SCHEDULE_TEMPLATE",
      season_id: seasonId, row_id: template.template_id, snapshot: template,
      google_cells: null, baselines: [] });
    expect(projectedTemplate.expected).toBeNull();
    expect(projectedTemplate.target[SHEET_SCOPES.SCHEDULE_TEMPLATE.headers.indexOf("active")]).toBe("TRUE");
    const projectedWeek = projectSchedulePatch({ entity_type: "TRAINING_WEEK",
      season_id: seasonId, row_id: week.week_id, snapshot: week,
      google_cells: null, baselines: [] });
    expect(projectedWeek.target[SHEET_SCOPES.TRAINING_WEEK.headers.indexOf("scheduled_open_at")]).toBe("");
    expect(projectedWeek.target[SHEET_SCOPES.TRAINING_WEEK.headers.indexOf("confirmed_version")]).toBe("");
    const projectedPractice = projectSchedulePatch({ entity_type: "PRACTICE",
      season_id: seasonId, row_id: practice.practice_id, snapshot: practice,
      google_cells: null, baselines: [] });
    expect(projectedPractice.target[SHEET_SCOPES.PRACTICE.headers.indexOf("cancelled_at")]).toBe("");
    expect(projectedPractice.target[SHEET_SCOPES.PRACTICE.headers.indexOf("template_id")])
      .toBe(template.template_id);
  });

  it("requires a full mapped baseline and refuses a human-edited Google field", () => {
    const original = projectSchedulePatch({ entity_type: "PRACTICE", season_id: seasonId,
      row_id: practice.practice_id, snapshot: practice, google_cells: null, baselines: [] });
    const revised = { ...practice, location: "New dock", practice_version: 2, updated_at:
      "2026-07-02T12:00:00.000Z" };
    const safe = projectSchedulePatch({ entity_type: "PRACTICE", season_id: seasonId,
      row_id: practice.practice_id, snapshot: revised,
      google_cells: original.target, baselines: baseline("PRACTICE", practice) });
    expect(safe.expected).toEqual(original.target);
    expect(safe.target[SHEET_SCOPES.PRACTICE.headers.indexOf("location")]).toBe("New dock");
    const edited = [...original.target];
    edited[SHEET_SCOPES.PRACTICE.headers.indexOf("location")] = "Human edit";
    expect(() => projectSchedulePatch({ entity_type: "PRACTICE", season_id: seasonId,
      row_id: practice.practice_id, snapshot: revised, google_cells: edited,
      baselines: baseline("PRACTICE", practice) })).toThrow("need review");
    const legacy = baseline("PRACTICE", practice).map((row) => row.dependency_group === "PRACTICE_LIFECYCLE"
      ? { ...row, baseline_json: JSON.stringify({ cancelled: false }) } : row);
    expect(() => projectSchedulePatch({ entity_type: "PRACTICE", season_id: seasonId,
      row_id: practice.practice_id, snapshot: revised, google_cells: original.target,
      baselines: legacy })).toThrow("older field mapping");
    expect(() => projectSchedulePatch({ entity_type: "PRACTICE", season_id: seasonId,
      row_id: practice.practice_id, snapshot: revised, google_cells: null,
      baselines: baseline("PRACTICE", practice) })).toThrow("missing in Google");
  });

  it("rejects a forged identity and formula-like cell before a batch is prepared", () => {
    expect(() => projectSchedulePatch({ entity_type: "SCHEDULE_TEMPLATE",
      season_id: seasonId, row_id: template.template_id,
      snapshot: { ...template, season_id: "season_other_2026" },
      google_cells: null, baselines: [] })).toThrow("identity");
    expect(() => projectSchedulePatch({ entity_type: "SCHEDULE_TEMPLATE",
      season_id: seasonId, row_id: template.template_id,
      snapshot: { ...template, location: "=IMPORTXML(A1)" },
      google_cells: null, baselines: [] })).toThrow("formula");
  });
});
