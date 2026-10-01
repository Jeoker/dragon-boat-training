import {
  array, boolean, enumeration, identifier, integer, isoTimestamp, nullableIdentifier, object, requestId,
  sessionRequest, string, ContractValidationError, type Input, type SessionRequest
} from "./c1-contract";
import { C2_CONTRACT_VERSION, C2_SYNC_ACTIONS } from "./c2-actions";
import type { SyncEntityType } from "./c2-sync-rules";

export { C2_CONTRACT_VERSION, C2_SYNC_ACTIONS };

export interface SyncBindingSnapshot {
  season_id: string;
  binding_version: number;
  form_id: string;
  runtime_spreadsheet_id: string;
  response_sheet_id: string;
  response_sheet_name: string;
  field_mapping: Record<string, string>;
  schema_fingerprint: string;
  export_paused: boolean;
  last_pull_at: string | null;
  last_push_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncBaselineSnapshot {
  season_id: string;
  binding_version: number;
  entity_type: SyncEntityType;
  entity_id: string;
  dependency_group: string;
  baseline: Record<string, unknown>;
  cloud_version: number;
  sheet_digest: string;
  updated_at: string;
}

export interface SourceImportSnapshot {
  stable_source_id: string;
  season_id: string;
  binding_version: number;
  source_type: "FORM_RESPONSE" | "LEGACY_ROW";
  source_external_id: string;
  source_digest: string;
  source_version: number;
  member_id: string | null;
  status: "IMPORTED" | "REVIEW_REQUIRED";
  imported_at: string | null;
  updated_at: string;
}

export interface ImportSyncFoundationRequest {
  request_id: string;
  source_snapshot_id: string;
  bindings: SyncBindingSnapshot[];
  baselines: SyncBaselineSnapshot[];
  source_imports: SourceImportSnapshot[];
}

export interface SyncOverviewRequest extends SessionRequest { season_id: string; }
export interface RetryExportRequest extends SyncOverviewRequest { outbox_id: string | null; }
export interface ListExportBlocksRequest extends SyncOverviewRequest { limit: number; cursor: string | null; }
export interface SetExportPauseRequest extends SessionRequest { season_id: string; paused: boolean; }
export interface ListSyncConflictsRequest extends SessionRequest {
  season_id: string; limit: number; cursor: string | null; status: "OPEN" | "RESOLVED" | "SUPERSEDED";
}
export interface GetSyncConflictRequest extends SessionRequest { season_id: string; conflict_id: string; }
export interface CheckSheetDifferencesRequest extends SessionRequest {
  season_id: string;
  entity_type: SyncEntityType;
}
export type AssociatedPhysicalScope = "SIGNUP" | "SEAT_PLAN_DRAFT" |
  "SEAT_PLAN_CURRENT" | "SEAT_PLAN_REVISION";
// This diagnosis covers confirmed physical rows only. Empty Google/B tables without a confirmed
// physical baseline are INCOMPLETE, not evidence that all application events have been exported.
export interface CheckAssociatedPhysicalDifferencesRequest extends SessionRequest {
  season_id: string;
  scope: AssociatedPhysicalScope;
}
export interface ListFormReviewsRequest extends SessionRequest {
  season_id: string;
  limit: number;
  cursor: string | null;
}
export interface PullFormResponsesRequest {
  request_id: string;
  season_id: string;
  limit: number;
}
export interface ResolveFormSourceRequest extends SessionRequest {
  season_id: string;
  response_id: string;
  member_id: string;
  source_version: number;
}

const ENTITY_TYPES = ["SEASON", "MEMBER", "SCHEDULE_TEMPLATE", "TRAINING_WEEK",
  "SIGNUP", "PRACTICE", "SEAT_PLAN_DRAFT", "HISTORY"] as const;

function nullableTimestamp(input: Input, field: string): string | null {
  if (input[field] === null || input[field] === undefined || input[field] === "") return null;
  return isoTimestamp(input, field);
}

function jsonObject(input: Input, field: string, maximumCharacters = 50_000): Record<string, unknown> {
  const value = object(input[field], field);
  if (JSON.stringify(value).length > maximumCharacters) {
    throw new ContractValidationError(`${field} is too large.`, field);
  }
  return value;
}

function safeExternalId(input: Input, field: string, maximum = 512, minimum = 8): string {
  const value = string(input, field, minimum, maximum);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(value)) {
    throw new ContractValidationError(`${field} contains unsupported characters.`, field);
  }
  return value;
}

function googleFileId(input: Input, field: string): string {
  const value = string(input, field, 10, 256);
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ContractValidationError(`${field} must be a Google file identifier.`, field);
  }
  return value;
}

function formResponseId(input: Input, field: string): string {
  const value = string(input, field, 8, 256);
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ContractValidationError(`${field} is invalid.`, field);
  }
  return value;
}

function sheetTabId(input: Input, field: string): string {
  const value = string(input, field, 1, 16);
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(value)) {
    throw new ContractValidationError(`${field} must be a numeric Google Sheet tab identifier.`, field);
  }
  return value;
}

function fieldMapping(input: Input): Record<string, string> {
  const mapping = jsonObject(input, "field_mapping", 10_000);
  const entries = Object.entries(mapping);
  if (!entries.length || !("display_name_header" in mapping)) {
    throw new ContractValidationError("field_mapping requires display_name_header.", "field_mapping");
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key) || typeof rawValue !== "string" ||
        !rawValue.trim() || rawValue.trim().length > 200) {
      throw new ContractValidationError("field_mapping must use normalized keys and non-empty header names.", "field_mapping");
    }
    result[key] = rawValue.trim();
  }
  if (new Set(Object.values(result)).size !== Object.values(result).length) {
    throw new ContractValidationError("field_mapping cannot assign one header to multiple fields.", "field_mapping");
  }
  return result;
}

function digest(input: Input, field: string): string {
  const value = string(input, field, 16, 256);
  if (!/^[-A-Za-z0-9_:]+$/u.test(value)) throw new ContractValidationError(`${field} is invalid.`, field);
  return value;
}

function syncBinding(value: unknown, index: number): SyncBindingSnapshot {
  const input = object(value, `bindings[${index}]`);
  return {
    season_id: identifier(input, "season_id"), binding_version: integer(input, "binding_version", 1),
    form_id: googleFileId(input, "form_id"),
    runtime_spreadsheet_id: googleFileId(input, "runtime_spreadsheet_id"),
    response_sheet_id: sheetTabId(input, "response_sheet_id"),
    response_sheet_name: string(input, "response_sheet_name", 1, 200),
    field_mapping: fieldMapping(input),
    schema_fingerprint: digest(input, "schema_fingerprint"), export_paused: boolean(input, "export_paused"),
    last_pull_at: nullableTimestamp(input, "last_pull_at"), last_push_at: nullableTimestamp(input, "last_push_at"),
    created_at: isoTimestamp(input, "created_at"), updated_at: isoTimestamp(input, "updated_at")
  };
}

function syncBaseline(value: unknown, index: number): SyncBaselineSnapshot {
  const input = object(value, `baselines[${index}]`);
  return {
    season_id: identifier(input, "season_id"), binding_version: integer(input, "binding_version", 1),
    entity_type: enumeration(input, "entity_type", ENTITY_TYPES),
    entity_id: safeExternalId(input, "entity_id"),
    dependency_group: safeExternalId(input, "dependency_group", 128),
    baseline: jsonObject(input, "baseline"), cloud_version: integer(input, "cloud_version"),
    sheet_digest: digest(input, "sheet_digest"), updated_at: isoTimestamp(input, "updated_at")
  };
}

function sourceImport(value: unknown, index: number): SourceImportSnapshot {
  const input = object(value, `source_imports[${index}]`);
  const source = {
    stable_source_id: safeExternalId(input, "stable_source_id", 800),
    season_id: identifier(input, "season_id"), binding_version: integer(input, "binding_version", 1),
    source_type: enumeration(input, "source_type", ["FORM_RESPONSE", "LEGACY_ROW"] as const),
    source_external_id: safeExternalId(input, "source_external_id", 512, 1),
    source_digest: digest(input, "source_digest"), source_version: integer(input, "source_version", 1),
    member_id: nullableIdentifier(input, "member_id"),
    status: enumeration(input, "status", ["IMPORTED", "REVIEW_REQUIRED"] as const),
    imported_at: nullableTimestamp(input, "imported_at"), updated_at: isoTimestamp(input, "updated_at")
  };
  if (source.status === "IMPORTED" && (!source.member_id || !source.imported_at)) {
    throw new ContractValidationError("An imported source requires member_id and imported_at.", `source_imports[${index}]`);
  }
  if (source.status === "REVIEW_REQUIRED" && source.member_id) {
    throw new ContractValidationError("A source under review cannot already own a member mapping.", `source_imports[${index}]`);
  }
  if (source.status === "REVIEW_REQUIRED" && source.imported_at) {
    throw new ContractValidationError("A source under review cannot have imported_at.", `source_imports[${index}]`);
  }
  return source;
}

export function parseImportSyncFoundation(value: unknown): ImportSyncFoundationRequest {
  const input = object(value);
  return {
    request_id: requestId(input), source_snapshot_id: safeExternalId(input, "source_snapshot_id"),
    bindings: array(input, "bindings", 500).map(syncBinding),
    baselines: array(input, "baselines", 50_000).map(syncBaseline),
    source_imports: array(input, "source_imports", 50_000).map(sourceImport)
  };
}

export function parseSyncOverview(value: unknown): SyncOverviewRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id") };
}

export function parseRetryExport(value: unknown): RetryExportRequest {
  const input = object(value);
  return { ...parseSyncOverview(input), outbox_id: input.outbox_id === undefined ? null : identifier(input, "outbox_id") };
}

export function parseListExportBlocks(value: unknown): ListExportBlocksRequest {
  const input = object(value);
  const limit = input.limit === undefined ? 50 : integer(input, "limit", 1);
  if (limit > 100) throw new ContractValidationError("limit must not exceed 100.", "limit");
  const cursor = input.cursor == null ? null : string(input, "cursor", 1, 128);
  if (cursor && (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
    throw new ContractValidationError("cursor must be a positive event sequence.", "cursor");
  }
  return { ...parseSyncOverview(input), limit, cursor };
}

export function parseSetExportPause(value: unknown): SetExportPauseRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id"),
    paused: boolean(input, "paused") };
}

export function parseListSyncConflicts(value: unknown): ListSyncConflictsRequest {
  const input = object(value);
  const limit = input.limit === undefined ? 50 : integer(input, "limit", 1);
  if (limit > 100) throw new ContractValidationError("limit must not exceed 100.", "limit");
  return { ...sessionRequest(input), season_id: identifier(input, "season_id"), limit,
    cursor: input.cursor == null ? null : identifier(input, "cursor"),
    status: input.status === undefined ? "OPEN" :
      enumeration(input, "status", ["OPEN", "RESOLVED", "SUPERSEDED"] as const) };
}

export function parseGetSyncConflict(value: unknown): GetSyncConflictRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id"),
    conflict_id: identifier(input, "conflict_id") };
}

export function parseCheckSheetDifferences(value: unknown): CheckSheetDifferencesRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id"),
    entity_type: enumeration(input, "entity_type", ["SEASON", "MEMBER", "SCHEDULE_TEMPLATE",
      "TRAINING_WEEK", "SIGNUP", "PRACTICE",
      "SEAT_PLAN_DRAFT"] as const) };
}

export function parseCheckAssociatedPhysicalDifferences(value: unknown): CheckAssociatedPhysicalDifferencesRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id"),
    scope: enumeration(input, "scope", ["SIGNUP", "SEAT_PLAN_DRAFT",
      "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION"] as const) };
}

export function parseListFormReviews(value: unknown): ListFormReviewsRequest {
  const input = object(value);
  const limit = input.limit === undefined ? 50 : integer(input, "limit", 1);
  if (limit > 100) throw new ContractValidationError("limit must not exceed 100.", "limit");
  return { ...sessionRequest(input), season_id: identifier(input, "season_id"), limit,
    cursor: input.cursor == null ? null : formResponseId(input, "cursor") };
}

export function parsePullFormResponses(value: unknown): PullFormResponsesRequest {
  const input = object(value);
  const limit = input.limit === undefined ? 50 : integer(input, "limit", 1);
  if (limit > 100) throw new ContractValidationError("limit must not exceed 100.", "limit");
  return { request_id: requestId(input), season_id: identifier(input, "season_id"), limit };
}

export function parseResolveFormSource(value: unknown): ResolveFormSourceRequest {
  const input = object(value);
  return {
    ...sessionRequest(input), season_id: identifier(input, "season_id"),
    response_id: formResponseId(input, "response_id"), member_id: identifier(input, "member_id"),
    source_version: integer(input, "source_version", 1)
  };
}
