import {
  array, boolean, enumeration, identifier, integer, isoTimestamp, object, requestId, sessionRequest, string,
  ContractValidationError, type Input, type SessionRequest
} from "./c1-contract";

export type SeatSide = "LEFT" | "RIGHT";
export type SeatPlanChangeKind = "EDIT" | "UNDO" | "RESET_TO_PUBLISHED";

export interface SeatSnapshot {
  row_number: number;
  side: SeatSide;
  member_id: string;
}

export interface SeatingStateSnapshot {
  season_id: string;
  practice_id: string;
  seat_plan_version: number;
  published_revision: number;
  coach_member_id: string;
  steerer_member_id: string;
  updated_by: string;
  updated_at: string;
}

export interface SeatingRevisionNameSnapshot {
  member_id: string;
  display_name: string;
}

export interface SeatingRevisionSnapshot {
  season_id: string;
  practice_id: string;
  revision_number: number;
  revision_id: string;
  source: string;
  seat_plan_version: number;
  coach_member_id: string;
  steerer_member_id: string;
  seats: SeatSnapshot[];
  names: SeatingRevisionNameSnapshot[];
  published_by: string;
  published_at: string;
  request_id: string;
}

export interface ImportSeatingSnapshotRequest {
  request_id: string;
  source_snapshot_id: string;
  states: SeatingStateSnapshot[];
  draft_seats: Array<SeatSnapshot & { season_id: string; practice_id: string; seat_plan_version: number }>;
  revisions: SeatingRevisionSnapshot[];
}

export interface SeatingWorkspaceRequest extends SessionRequest {
  season_id: string;
  practice_id: string;
}

export interface SaveSeatPlanDraftRequest extends SeatingWorkspaceRequest {
  practice_version: number;
  signup_version: number;
  seat_plan_version: number;
  coach_member_id: string;
  steerer_member_id: string;
  seats: SeatSnapshot[];
  change_kind: SeatPlanChangeKind;
}

export interface PublishSeatPlanRequest extends SeatingWorkspaceRequest {
  practice_version: number;
  signup_version: number;
  seat_plan_version: number;
  published_revision: number;
  acknowledge_preference_mismatch: boolean;
}

function optionalMemberId(input: Input, field: string): string {
  if (input[field] === undefined || input[field] === null || input[field] === "") return "";
  return identifier(input, field);
}

function actorId(input: Input, field: string): string {
  const value = string(input, field, 1, 128);
  if (!/^[A-Za-z0-9_:-]+$/u.test(value)) {
    throw new ContractValidationError(`${field} contains unsupported characters.`, field);
  }
  return value;
}

function source(input: Input): string {
  const value = string(input, "source", 1, 64);
  if (!/^[A-Z0-9_]+$/u.test(value)) {
    throw new ContractValidationError("source contains unsupported characters.", "source");
  }
  return value;
}

function seat(value: unknown, field: string): SeatSnapshot {
  const input = object(value, field);
  return {
    row_number: integer(input, "row_number", 1),
    side: enumeration(input, "side", ["LEFT", "RIGHT"] as const),
    member_id: optionalMemberId(input, "member_id")
  };
}

function state(value: unknown, index: number): SeatingStateSnapshot {
  const input = object(value, `states[${index}]`);
  return {
    season_id: identifier(input, "season_id"), practice_id: identifier(input, "practice_id"),
    seat_plan_version: integer(input, "seat_plan_version"),
    published_revision: integer(input, "published_revision"),
    coach_member_id: optionalMemberId(input, "coach_member_id"),
    steerer_member_id: optionalMemberId(input, "steerer_member_id"),
    updated_by: actorId(input, "updated_by"), updated_at: isoTimestamp(input, "updated_at")
  };
}

function revision(value: unknown, index: number): SeatingRevisionSnapshot {
  const input = object(value, `revisions[${index}]`);
  return {
    season_id: identifier(input, "season_id"), practice_id: identifier(input, "practice_id"),
    revision_number: integer(input, "revision_number", 1), revision_id: identifier(input, "revision_id"),
    source: source(input), seat_plan_version: integer(input, "seat_plan_version"),
    coach_member_id: optionalMemberId(input, "coach_member_id"),
    steerer_member_id: optionalMemberId(input, "steerer_member_id"),
    seats: array(input, "seats", 100).map((entry, seatIndex) => seat(entry, `revisions[${index}].seats[${seatIndex}]`)),
    names: array(input, "names", 102).map((entry, nameIndex) => {
      const name = object(entry, `revisions[${index}].names[${nameIndex}]`);
      return { member_id: identifier(name, "member_id"), display_name: string(name, "display_name", 1, 120) };
    }),
    published_by: actorId(input, "published_by"), published_at: isoTimestamp(input, "published_at"),
    request_id: requestId(input)
  };
}

export function parseImportSeatingSnapshot(value: unknown): ImportSeatingSnapshotRequest {
  const input = object(value);
  return {
    request_id: requestId(input), source_snapshot_id: identifier(input, "source_snapshot_id"),
    states: array(input, "states", 20_000).map(state),
    draft_seats: array(input, "draft_seats", 100_000).map((entry, index) => {
      const row = object(entry, `draft_seats[${index}]`);
      return { season_id: identifier(row, "season_id"), practice_id: identifier(row, "practice_id"),
        seat_plan_version: integer(row, "seat_plan_version"), ...seat(row, `draft_seats[${index}]`) };
    }),
    revisions: array(input, "revisions", 100_000).map(revision)
  };
}

export function parseSeatingWorkspace(value: unknown): SeatingWorkspaceRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id"),
    practice_id: identifier(input, "practice_id") };
}

export function parseSaveSeatPlanDraft(value: unknown): SaveSeatPlanDraftRequest {
  const input = object(value);
  return {
    ...parseSeatingWorkspace(input), practice_version: integer(input, "practice_version", 1),
    signup_version: integer(input, "signup_version"), seat_plan_version: integer(input, "seat_plan_version"),
    coach_member_id: optionalMemberId(input, "coach_member_id"),
    steerer_member_id: optionalMemberId(input, "steerer_member_id"),
    seats: array(input, "seats", 100).map((entry, index) => seat(entry, `seats[${index}]`)),
    change_kind: enumeration(input, "change_kind", ["EDIT", "UNDO", "RESET_TO_PUBLISHED"] as const)
  };
}

export function parsePublishSeatPlan(value: unknown): PublishSeatPlanRequest {
  const input = object(value);
  return {
    ...parseSeatingWorkspace(input), practice_version: integer(input, "practice_version", 1),
    signup_version: integer(input, "signup_version"), seat_plan_version: integer(input, "seat_plan_version"),
    published_revision: integer(input, "published_revision"),
    acknowledge_preference_mismatch: boolean(input, "acknowledge_preference_mismatch")
  };
}
