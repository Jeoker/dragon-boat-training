export const C1_CONTRACT_VERSION = "2026-09-20.c1";

export const C1_ACTIONS = {
  "/internal/c1/import-core": { method: "POST", authentication: "migration_key", writes: true },
  "/internal/c1/coach-login": { method: "POST", authentication: "coach_code", writes: true },
  "/internal/c1/coach-logout": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/coach-bootstrap": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/create-season": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/update-member": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/public-roster": { method: "GET", authentication: "public", writes: false }
} as const;

export type SeasonStatus = "DRAFT" | "OPEN" | "COMPLETED" | "ARCHIVED";
export type MemberStatus = "ACTIVE" | "INACTIVE";
export type Preference = "LEFT" | "AMBIENT" | "RIGHT";

export interface CoachSnapshot {
  coach_id: string;
  display_name: string;
  code_salt: string;
  code_digest: string;
  credential_version: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SeasonSnapshot {
  season_id: string;
  name: string;
  start_date: string;
  end_date: string;
  timezone: string;
  season_ends_at: string;
  status: SeasonStatus;
  binding_version: number;
  season_version: number;
  roster_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MemberSnapshot {
  season_id: string;
  member_id: string;
  source_key: string;
  source_display_name: string;
  display_name_override: string;
  status: MemberStatus;
  default_preference: Preference;
  member_version: number;
  created_at: string;
  updated_at: string;
}

export interface ImportCoreSnapshotRequest {
  request_id: string;
  source_snapshot_id: string;
  settings_version: number;
  default_season_id: string | null;
  coaches: CoachSnapshot[];
  seasons: SeasonSnapshot[];
  members: MemberSnapshot[];
}

export interface CoachLoginRequest {
  request_id: string;
  coach_code: string;
}

export interface SessionRequest {
  request_id: string;
  session_token: string;
}

export interface CreateSeasonRequest extends SessionRequest {
  name: string;
  start_date: string;
  end_date: string;
  timezone: string;
}

export interface UpdateMemberRequest extends SessionRequest {
  season_id: string;
  member_id: string;
  member_version: number;
  display_name_override?: string;
  default_preference?: Preference;
  status?: MemberStatus;
}

export class ContractValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

type Input = Record<string, unknown>;

function object(value: unknown, field = "request"): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError(`${field} must be an object.`, field);
  }
  return value as Input;
}

function string(input: Input, field: string, minimum: number, maximum: number): string {
  if (typeof input[field] !== "string") {
    throw new ContractValidationError(`${field} must be a string.`, field);
  }
  const value = input[field].trim();
  if (value.length < minimum || value.length > maximum) {
    throw new ContractValidationError(`${field} must contain ${minimum} to ${maximum} characters.`, field);
  }
  return value;
}

function integer(input: Input, field: string, minimum = 0): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ContractValidationError(`${field} must be an integer of at least ${minimum}.`, field);
  }
  return value;
}

function boolean(input: Input, field: string): boolean {
  if (typeof input[field] !== "boolean") throw new ContractValidationError(`${field} must be a boolean.`, field);
  return input[field];
}

function enumeration<T extends string>(input: Input, field: string, allowed: readonly T[]): T {
  const value = input[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ContractValidationError(`${field} must be one of ${allowed.join(", ")}.`, field);
  }
  return value as T;
}

function identifier(input: Input, field: string): string {
  const value = string(input, field, 8, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ContractValidationError(`${field} contains unsupported characters.`, field);
  }
  return value;
}

function nullableIdentifier(input: Input, field: string): string | null {
  if (input[field] === null) return null;
  return identifier(input, field);
}

function isoTimestamp(input: Input, field: string): string {
  const value = string(input, field, 20, 40);
  if (!Number.isFinite(Date.parse(value))) throw new ContractValidationError(`${field} must be an ISO timestamp.`, field);
  return value;
}

function date(input: Input, field: string): string {
  const value = string(input, field, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new ContractValidationError(`${field} must be a real YYYY-MM-DD date.`, field);
  }
  return value;
}

function array(input: Input, field: string, maximum: number): unknown[] {
  const value = input[field];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ContractValidationError(`${field} must be an array with at most ${maximum} entries.`, field);
  }
  return value;
}

function requestId(input: Input): string {
  const value = identifier(input, "request_id");
  if (value.length < 8) throw new ContractValidationError("request_id is invalid.", "request_id");
  return value;
}

function sessionRequest(value: unknown): SessionRequest {
  const input = object(value);
  return { request_id: requestId(input), session_token: string(input, "session_token", 32, 2048) };
}

export function parseImportCoreSnapshot(value: unknown): ImportCoreSnapshotRequest {
  const input = object(value);
  const coaches = array(input, "coaches", 100).map((entry, index): CoachSnapshot => {
    const row = object(entry, `coaches[${index}]`);
    return {
      coach_id: identifier(row, "coach_id"), display_name: string(row, "display_name", 1, 120),
      code_salt: string(row, "code_salt", 8, 256), code_digest: string(row, "code_digest", 32, 256),
      credential_version: integer(row, "credential_version", 1), active: boolean(row, "active"),
      created_at: isoTimestamp(row, "created_at"), updated_at: isoTimestamp(row, "updated_at")
    };
  });
  const seasons = array(input, "seasons", 500).map((entry, index): SeasonSnapshot => {
    const row = object(entry, `seasons[${index}]`);
    return {
      season_id: identifier(row, "season_id"), name: string(row, "name", 1, 120),
      start_date: date(row, "start_date"), end_date: date(row, "end_date"),
      timezone: string(row, "timezone", 1, 100), season_ends_at: isoTimestamp(row, "season_ends_at"),
      status: enumeration(row, "status", ["DRAFT", "OPEN", "COMPLETED", "ARCHIVED"]),
      binding_version: integer(row, "binding_version"), season_version: integer(row, "season_version"),
      roster_version: integer(row, "roster_version"), created_by: identifier(row, "created_by"),
      created_at: isoTimestamp(row, "created_at"), updated_at: isoTimestamp(row, "updated_at")
    };
  });
  const members = array(input, "members", 20_000).map((entry, index): MemberSnapshot => {
    const row = object(entry, `members[${index}]`);
    return {
      season_id: identifier(row, "season_id"), member_id: identifier(row, "member_id"),
      source_key: string(row, "source_key", 1, 256), source_display_name: string(row, "source_display_name", 1, 120),
      display_name_override: string(row, "display_name_override", 0, 120),
      status: enumeration(row, "status", ["ACTIVE", "INACTIVE"]),
      default_preference: enumeration(row, "default_preference", ["LEFT", "AMBIENT", "RIGHT"]),
      member_version: integer(row, "member_version", 1), created_at: isoTimestamp(row, "created_at"),
      updated_at: isoTimestamp(row, "updated_at")
    };
  });
  return {
    request_id: requestId(input), source_snapshot_id: identifier(input, "source_snapshot_id"),
    settings_version: integer(input, "settings_version"),
    default_season_id: nullableIdentifier(input, "default_season_id"), coaches, seasons, members
  };
}

export function parseCoachLogin(value: unknown): CoachLoginRequest {
  const input = object(value);
  return { request_id: requestId(input), coach_code: string(input, "coach_code", 6, 128) };
}

export function parseSessionRequest(value: unknown): SessionRequest {
  return sessionRequest(value);
}

export function parseCreateSeason(value: unknown): CreateSeasonRequest {
  const input = object(value);
  return {
    ...sessionRequest(input), name: string(input, "name", 1, 120), start_date: date(input, "start_date"),
    end_date: date(input, "end_date"), timezone: string(input, "timezone", 1, 100)
  };
}

export function parseUpdateMember(value: unknown): UpdateMemberRequest {
  const input = object(value);
  const result: UpdateMemberRequest = {
    ...sessionRequest(input), season_id: identifier(input, "season_id"), member_id: identifier(input, "member_id"),
    member_version: integer(input, "member_version", 1)
  };
  if (Object.hasOwn(input, "display_name_override")) {
    if (typeof input.display_name_override !== "string" || input.display_name_override.trim().length > 120) {
      throw new ContractValidationError("display_name_override must contain at most 120 characters.", "display_name_override");
    }
    result.display_name_override = input.display_name_override.trim();
  }
  if (Object.hasOwn(input, "default_preference")) {
    result.default_preference = enumeration<Preference>(input, "default_preference", ["LEFT", "AMBIENT", "RIGHT"]);
  }
  if (Object.hasOwn(input, "status")) result.status = enumeration<MemberStatus>(input, "status", ["ACTIVE", "INACTIVE"]);
  if (result.display_name_override === undefined && result.default_preference === undefined && result.status === undefined) {
    throw new ContractValidationError("At least one editable member field is required.");
  }
  return result;
}
