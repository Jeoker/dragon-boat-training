import { canonicalJson } from "./c1-rules";

export type SyncEntityType = "SEASON" | "MEMBER" | "SIGNUP" | "PRACTICE" | "SEAT_PLAN_DRAFT" | "HISTORY";
export type GoogleChangePolicy = "AUTO" | "VALIDATE" | "REVIEW" | "REJECT";
export type SyncValueKind = "TEXT" | "OPTIONAL_TEXT" | "INTEGER" | "BOOLEAN" | "DATE" | "TIME" |
  "INSTANT" | "PREFERENCE" | "STATUS" | "JSON";

export interface SyncFieldDefinition {
  field: string;
  dependency_group: string;
  kind: SyncValueKind;
  google_policy: GoogleChangePolicy;
}

export interface SyncRecord {
  [field: string]: unknown;
}

export interface SyncComparisonInput {
  entity_type: SyncEntityType;
  baseline: SyncRecord | null;
  cloudflare: SyncRecord | null;
  google: SyncRecord | null;
}

export type SyncGroupOutcome = "NO_CHANGE" | "EXPORT" | "IMPORT" | "IMPORT_WITH_VALIDATION" |
  "ADVANCE_BASELINE" | "CONFLICT" | "REVIEW_REQUIRED" | "REJECTED";

export interface SyncGroupDecision {
  dependency_group: string;
  outcome: SyncGroupOutcome;
  fields: string[];
  baseline: SyncRecord;
  cloudflare: SyncRecord;
  google: SyncRecord;
  reason: string;
}

export interface SyncComparison {
  outcome: "NO_CHANGE" | "READY" | "NEEDS_ATTENTION";
  groups: SyncGroupDecision[];
}

const identity = (fields: string[]): SyncFieldDefinition[] => fields.map((field) => ({
  field, dependency_group: "IDENTITY", kind: "TEXT", google_policy: "REJECT"
}));

const version = (fields: string[]): SyncFieldDefinition[] => fields.map((field) => ({
  field, dependency_group: "SYSTEM_VERSION", kind: "INTEGER", google_policy: "REJECT"
}));

export const SYNC_FIELD_DEFINITIONS: Record<SyncEntityType, readonly SyncFieldDefinition[]> = {
  SEASON: [
    ...identity(["season_id"]),
    { field: "name", dependency_group: "SEASON_IDENTITY", kind: "TEXT", google_policy: "REVIEW" },
    { field: "start_date", dependency_group: "SEASON_BOUNDARY", kind: "DATE", google_policy: "REVIEW" },
    { field: "end_date", dependency_group: "SEASON_BOUNDARY", kind: "DATE", google_policy: "REVIEW" },
    { field: "timezone", dependency_group: "SEASON_BOUNDARY", kind: "TEXT", google_policy: "REVIEW" },
    { field: "status", dependency_group: "SEASON_LIFECYCLE", kind: "STATUS", google_policy: "REVIEW" },
    ...version(["binding_version", "season_version", "roster_version"])
  ],
  MEMBER: [
    ...identity(["season_id", "member_id", "source_key"]),
    { field: "source_display_name", dependency_group: "FORM_SOURCE", kind: "TEXT", google_policy: "REJECT" },
    { field: "display_name_override", dependency_group: "MEMBER_NAME", kind: "OPTIONAL_TEXT", google_policy: "AUTO" },
    { field: "default_preference", dependency_group: "MEMBER_DEFAULT_PREFERENCE", kind: "PREFERENCE", google_policy: "AUTO" },
    { field: "status", dependency_group: "MEMBER_STATUS", kind: "STATUS", google_policy: "REVIEW" },
    ...version(["member_version"])
  ],
  SIGNUP: [
    ...identity(["season_id", "practice_id", "member_id"]),
    { field: "preference", dependency_group: "SIGNUP_STATE", kind: "PREFERENCE", google_policy: "VALIDATE" },
    { field: "status", dependency_group: "SIGNUP_STATE", kind: "STATUS", google_policy: "REVIEW" },
    { field: "queue_at", dependency_group: "SIGNUP_QUEUE", kind: "INSTANT", google_policy: "REJECT" },
    { field: "queue_sequence", dependency_group: "SIGNUP_QUEUE", kind: "INTEGER", google_policy: "REJECT" },
    ...version(["signup_version"])
  ],
  PRACTICE: [
    ...identity(["season_id", "week_id", "practice_id"]),
    { field: "start_at", dependency_group: "PRACTICE_SCHEDULE", kind: "INSTANT", google_policy: "REVIEW" },
    { field: "end_at", dependency_group: "PRACTICE_SCHEDULE", kind: "INSTANT", google_policy: "REVIEW" },
    { field: "timezone", dependency_group: "PRACTICE_SCHEDULE", kind: "TEXT", google_policy: "REVIEW" },
    { field: "location", dependency_group: "PRACTICE_SCHEDULE", kind: "TEXT", google_policy: "REVIEW" },
    { field: "address", dependency_group: "PRACTICE_SCHEDULE", kind: "TEXT", google_policy: "REVIEW" },
    { field: "map_url", dependency_group: "PRACTICE_SCHEDULE", kind: "OPTIONAL_TEXT", google_policy: "REVIEW" },
    { field: "cancelled", dependency_group: "PRACTICE_LIFECYCLE", kind: "BOOLEAN", google_policy: "REVIEW" },
    { field: "left_capacity", dependency_group: "CAPACITY_RESULT", kind: "INTEGER", google_policy: "REJECT" },
    { field: "right_capacity", dependency_group: "CAPACITY_RESULT", kind: "INTEGER", google_policy: "REJECT" },
    ...version(["practice_version", "signup_version"])
  ],
  SEAT_PLAN_DRAFT: [
    ...identity(["season_id", "practice_id"]),
    { field: "coach_member_id", dependency_group: "SEATING_DRAFT", kind: "OPTIONAL_TEXT", google_policy: "VALIDATE" },
    { field: "steerer_member_id", dependency_group: "SEATING_DRAFT", kind: "OPTIONAL_TEXT", google_policy: "VALIDATE" },
    { field: "seats", dependency_group: "SEATING_DRAFT", kind: "JSON", google_policy: "VALIDATE" },
    ...version(["seat_plan_version", "published_revision"])
  ],
  HISTORY: [
    ...identity(["season_id", "practice_id"]),
    { field: "correction_note", dependency_group: "HISTORY_CORRECTION", kind: "OPTIONAL_TEXT", google_policy: "REVIEW" },
    { field: "snapshot", dependency_group: "FROZEN_HISTORY", kind: "JSON", google_policy: "REJECT" },
    ...version(["history_version", "frozen_revision"])
  ]
};

export function normalizeSyncValue(value: unknown, kind: SyncValueKind): unknown {
  if (kind === "TEXT" || kind === "OPTIONAL_TEXT") {
    if ((value === null || value === undefined || value === "") && kind === "OPTIONAL_TEXT") return "";
    if (typeof value !== "string") throw new Error("Expected text.");
    const text = value.trim();
    if (!text && kind === "TEXT") throw new Error("Expected non-empty text.");
    return text;
  }
  if (kind === "INTEGER") {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)) return Number(value);
    throw new Error("Expected a non-negative integer.");
  }
  if (kind === "BOOLEAN") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/iu.test(value.trim())) return value.trim().toLowerCase() === "true";
    throw new Error("Expected a boolean.");
  }
  if (kind === "DATE") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.trim()) ||
        !Number.isFinite(Date.parse(`${value.trim()}T00:00:00.000Z`)) ||
        new Date(`${value.trim()}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.trim()) {
      throw new Error("Expected a real ISO date.");
    }
    return value.trim();
  }
  if (kind === "TIME") {
    if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.trim())) {
      throw new Error("Expected a local time.");
    }
    return value.trim();
  }
  if (kind === "INSTANT") {
    if (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value.trim()) ||
        !Number.isFinite(Date.parse(value.trim()))) throw new Error("Expected an ISO instant with a time zone.");
    const parsed = new Date(value.trim());
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u)!;
    const offsetMinutes = match[7] === "Z" ? 0 : (match[8] === "+" ? 1 : -1) *
      (Number(match[9]) * 60 + Number(match[10]));
    const local = new Date(parsed.getTime() + offsetMinutes * 60_000);
    if (local.getUTCFullYear() !== Number(match[1]) || local.getUTCMonth() + 1 !== Number(match[2]) ||
        local.getUTCDate() !== Number(match[3]) || local.getUTCHours() !== Number(match[4]) ||
        local.getUTCMinutes() !== Number(match[5]) || local.getUTCSeconds() !== Number(match[6])) {
      throw new Error("Expected a real ISO instant with a time zone.");
    }
    return parsed.toISOString();
  }
  if (kind === "PREFERENCE") {
    if (typeof value !== "string" || !["LEFT", "AMBIENT", "RIGHT"].includes(value.trim().toUpperCase())) {
      throw new Error("Expected a valid side preference.");
    }
    return value.trim().toUpperCase();
  }
  if (kind === "STATUS") {
    if (typeof value !== "string" || !/^[A-Z][A-Z_]{1,39}$/u.test(value.trim().toUpperCase())) {
      throw new Error("Expected a normalized status.");
    }
    return value.trim().toUpperCase();
  }
  if (typeof value === "string") {
    try { return JSON.parse(value); }
    catch { throw new Error("Expected valid JSON."); }
  }
  if (value === null || typeof value !== "object") throw new Error("Expected a JSON object or array.");
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizedGroup(record: SyncRecord, definitions: SyncFieldDefinition[]): SyncRecord {
  return Object.fromEntries(definitions.map((definition) => [definition.field,
    normalizeSyncValue(record[definition.field], definition.kind)]));
}

function groupOutcome(definitions: SyncFieldDefinition[], baseline: SyncRecord,
  cloudflare: SyncRecord, google: SyncRecord): Pick<SyncGroupDecision, "outcome" | "reason"> {
  const cloudChanged = !same(cloudflare, baseline);
  const googleChanged = !same(google, baseline);
  if (!cloudChanged && !googleChanged) return { outcome: "NO_CHANGE", reason: "Both sides still match the baseline." };
  if (cloudChanged && googleChanged) {
    if (same(cloudflare, google)) {
      return { outcome: "ADVANCE_BASELINE", reason: "Both sides independently reached the same value." };
    }
    return { outcome: "CONFLICT", reason: "Both sides changed one business dependency group differently." };
  }
  if (cloudChanged) return { outcome: "EXPORT", reason: "Only Cloudflare changed this dependency group." };
  const changedDefinitions = definitions.filter((definition) =>
    !same(google[definition.field], baseline[definition.field]));
  const policies = new Set(changedDefinitions.map((definition) => definition.google_policy));
  if (policies.has("REJECT")) return { outcome: "REJECTED", reason: "Google changed a protected identity, version or result field." };
  if (policies.has("REVIEW")) return { outcome: "REVIEW_REQUIRED", reason: "This Google change requires an impact preview and Coach confirmation." };
  if (policies.has("VALIDATE")) return { outcome: "IMPORT_WITH_VALIDATION", reason: "Only Google changed; run the normal business validator before importing." };
  return { outcome: "IMPORT", reason: "Only Google changed an automatically importable field." };
}

function rowDecision(input: SyncComparisonInput): SyncComparison | null {
  if (input.baseline === null && input.cloudflare === null && input.google === null) {
    return { outcome: "NO_CHANGE", groups: [] };
  }
  if (input.baseline === null) {
    const outcome: SyncGroupOutcome = input.cloudflare && !input.google ? "EXPORT" : "REVIEW_REQUIRED";
    return { outcome: outcome === "EXPORT" ? "READY" : "NEEDS_ATTENTION", groups: [{
      dependency_group: "ROW_IDENTITY", outcome, fields: [], baseline: {},
      cloudflare: input.cloudflare ?? {}, google: input.google ?? {},
      reason: outcome === "EXPORT" ? "A new Cloudflare record can be exported after bridge validation." :
        "A row without a baseline cannot be treated as a new business entity; Form import or Coach review must establish its identity."
    }] };
  }
  if (input.cloudflare === null || input.google === null) {
    return { outcome: "NEEDS_ATTENTION", groups: [{
      dependency_group: "ROW_IDENTITY", outcome: "REVIEW_REQUIRED", fields: [], baseline: input.baseline,
      cloudflare: input.cloudflare ?? {}, google: input.google ?? {},
      reason: input.cloudflare === null ? "The authoritative Cloudflare record is missing." :
        "The Google row was deleted; deletion is never interpreted as cancellation."
    }] };
  }
  return null;
}

export function compareSyncRecord(input: SyncComparisonInput): SyncComparison {
  const row = rowDecision(input);
  if (row) return row;
  const definitions = SYNC_FIELD_DEFINITIONS[input.entity_type];
  const byGroup = new Map<string, SyncFieldDefinition[]>();
  for (const definition of definitions) {
    const values = byGroup.get(definition.dependency_group) ?? [];
    values.push(definition);
    byGroup.set(definition.dependency_group, values);
  }
  const groups: SyncGroupDecision[] = [];
  for (const [dependencyGroup, groupDefinitions] of byGroup) {
    const fields = groupDefinitions.map((definition) => definition.field);
    try {
      const baseline = normalizedGroup(input.baseline!, groupDefinitions);
      const cloudflare = normalizedGroup(input.cloudflare!, groupDefinitions);
      const google = normalizedGroup(input.google!, groupDefinitions);
      const decision = groupOutcome(groupDefinitions, baseline, cloudflare, google);
      if (decision.outcome !== "NO_CHANGE") groups.push({ dependency_group: dependencyGroup,
        fields, baseline, cloudflare, google, ...decision });
    } catch (error) {
      groups.push({ dependency_group: dependencyGroup, outcome: "REVIEW_REQUIRED", fields,
        baseline: {}, cloudflare: {}, google: {},
        reason: error instanceof Error ? `A mapped value is invalid: ${error.message}` : "A mapped value is invalid." });
    }
  }
  const known = new Set(definitions.map((definition) => definition.field));
  const unknownFields = new Set([...Object.keys(input.baseline!), ...Object.keys(input.cloudflare!),
    ...Object.keys(input.google!)]);
  const unknownChanged = [...unknownFields].filter((field) => !known.has(field) &&
    (!same(input.cloudflare![field], input.baseline![field]) || !same(input.google![field], input.baseline![field])));
  if (unknownChanged.length) groups.push({ dependency_group: "UNMAPPED_FIELDS", outcome: "REVIEW_REQUIRED",
    fields: unknownChanged.sort(), baseline: {}, cloudflare: {}, google: {},
    reason: "A side changed fields that are not present in the explicit sync mapping." });
  const attention = new Set<SyncGroupOutcome>(["CONFLICT", "REVIEW_REQUIRED", "REJECTED"]);
  return { outcome: groups.some((group) => attention.has(group.outcome)) ? "NEEDS_ATTENTION" :
    groups.length ? "READY" : "NO_CHANGE", groups };
}

function stableSourceComponent(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{8,256}$/u.test(trimmed)) throw new Error(`${label} is not a stable identifier.`);
  return trimmed;
}

export function formResponseSourceId(seasonId: string, formId: string, responseId: string): string {
  return `FORM_RESPONSE:${stableSourceComponent(seasonId, "season_id")}:` +
    `${stableSourceComponent(formId, "form_id")}:${stableSourceComponent(responseId, "response_id")}`;
}
