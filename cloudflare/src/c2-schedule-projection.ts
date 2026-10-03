import { canonicalJson } from "../../shared/c1-rules";
import { SYNC_FIELD_DEFINITIONS, compareSyncGroup, normalizeSyncValue,
  type SyncFieldDefinition } from "../../shared/c2-sync-rules";
import { SHEET_SCOPES, type ScheduleSheetScope } from "./c2-sheet-bridge";
import { ApiError } from "./http";

export interface ScheduleBaselineRow {
  [key: string]: string | number;
  dependency_group: string;
  baseline_json: string;
  cloud_version: number;
}

export interface SchedulePatchProjection {
  row_id: string;
  expected: string[] | null;
  target: string[];
  cloud_version: number;
}

const identityField = { SCHEDULE_TEMPLATE: "template_id", TRAINING_WEEK: "week_id",
  PRACTICE: "practice_id" } as const;
const versionField = { SCHEDULE_TEMPLATE: "template_version", TRAINING_WEEK: "week_version",
  PRACTICE: "practice_version" } as const;

function mapping(scope: ScheduleSheetScope): { headers: readonly string[];
  definitions: readonly SyncFieldDefinition[]; groups: string[] } {
  const headers = SHEET_SCOPES[scope].headers;
  const definitions = SYNC_FIELD_DEFINITIONS[scope];
  const fields = definitions.map((definition) => definition.field);
  if (new Set(fields).size !== fields.length || canonicalJson([...fields].sort()) !==
      canonicalJson([...headers].sort())) {
    throw new ApiError("SYNC_MAPPING_INVALID", "The schedule mapping must cover every Sheet column exactly once.", 409);
  }
  return { headers, definitions, groups: [...new Set(definitions.map((field) => field.dependency_group))] };
}

function normalize(source: Record<string, unknown>, definitions: readonly SyncFieldDefinition[]):
  Record<string, unknown> {
  try {
    return Object.fromEntries(definitions.map((definition) => {
      if (!Object.hasOwn(source, definition.field)) throw new Error("A mapped field is missing.");
      return [definition.field, normalizeSyncValue(source[definition.field],
        definition.kind, definition.allowed_values)];
    }));
  } catch {
    throw new ApiError("SYNC_SCHEDULE_INVALID", "The captured schedule row has an invalid mapped field.", 409);
  }
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

export function projectSchedulePatch(input: {
  entity_type: ScheduleSheetScope; season_id: string; row_id: string;
  snapshot: Record<string, unknown>; google_cells: string[] | null;
  baselines: ScheduleBaselineRow[];
}): SchedulePatchProjection {
  const { headers, definitions, groups } = mapping(input.entity_type);
  const cloud = normalize(input.snapshot, definitions);
  const idField = identityField[input.entity_type];
  if (cloud.season_id !== input.season_id || cloud[idField] !== input.row_id ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(input.row_id)) {
    throw new ApiError("SYNC_SCHEDULE_INVALID", "The captured schedule identity is invalid.", 409);
  }
  const version = Number(cloud[versionField[input.entity_type]]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ApiError("SYNC_SCHEDULE_INVALID", "The captured schedule version is invalid.", 409);
  }
  const target = headers.map((header) => cell(cloud[header]));
  if (target.some((value) => value.length > 10_000 || value.startsWith("="))) {
    throw new ApiError("SYNC_SCHEDULE_INVALID", "A schedule cell exceeds the limit or starts a formula.", 409);
  }
  if (!input.google_cells) {
    if (input.baselines.length) throw new ApiError("SYNC_SCHEDULE_NEEDS_REVIEW",
      "A confirmed schedule row is missing in Google.", 409);
    return { row_id: input.row_id, expected: null, target, cloud_version: version };
  }
  const observed = input.google_cells;
  if (observed.length !== headers.length || observed[0] !== input.season_id ||
      observed[1] !== input.row_id) {
    throw new ApiError("SYNC_SCHEDULE_NEEDS_REVIEW", "The Google schedule row identity changed.", 409);
  }
  if (input.baselines.length !== groups.length ||
      new Set(input.baselines.map((row) => row.dependency_group)).size !== groups.length ||
      new Set(input.baselines.map((row) => Number(row.cloud_version))).size !== 1 ||
      input.baselines.some((row) => Number(row.cloud_version) > version)) {
    throw new ApiError("SYNC_BASELINE_INCOMPLETE", "An existing schedule row needs its complete current mapping.", 409);
  }
  const google = Object.fromEntries(headers.map((header, index) => [header, observed[index]]));
  for (const group of groups) {
    const saved = input.baselines.find((row) => row.dependency_group === group);
    if (!saved) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A schedule baseline is missing.", 409);
    let baseline: Record<string, unknown>;
    try { baseline = JSON.parse(saved.baseline_json) as Record<string, unknown>; }
    catch { throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A schedule baseline is invalid.", 409); }
    const fields = definitions.filter((field) => field.dependency_group === group).map((field) => field.field);
    if (!baseline || Array.isArray(baseline) || canonicalJson(Object.keys(baseline).sort()) !==
        canonicalJson(fields.sort())) {
      throw new ApiError("SYNC_BASELINE_MAPPING_STALE", "The schedule baseline uses an older field mapping.", 409);
    }
    const decision = compareSyncGroup({ entity_type: input.entity_type,
      baseline, cloudflare: cloud, google }, group);
    if (!["NO_CHANGE", "EXPORT", "ADVANCE_BASELINE"].includes(decision.outcome) ||
        group === "IDENTITY" && decision.outcome !== "NO_CHANGE") {
      throw new ApiError("SYNC_SCHEDULE_NEEDS_REVIEW",
        "Google and Cloudflare schedule values need review before export.", 409);
    }
  }
  return { row_id: input.row_id, expected: observed, target, cloud_version: version };
}
