import {
  array, enumeration, identifier, integer, isoTimestamp, object, requestId, sessionRequest, string,
  type Input, type Preference, type SessionRequest
} from "./c1-contract";

export type SignupStatus = "CONFIRMED" | "WAITLISTED" | "CANCELLED";

export interface SignupStateSnapshot {
  season_id: string;
  practice_id: string;
  signup_version: number;
  signup_sequence: number;
}

export interface SignupSnapshot {
  season_id: string;
  practice_id: string;
  member_id: string;
  preference: Preference;
  status: SignupStatus;
  queue_at: string;
  queue_sequence: number;
  updated_at: string;
  last_request_id: string;
}

export interface ImportSignupSnapshotRequest {
  request_id: string;
  source_snapshot_id: string;
  states: SignupStateSnapshot[];
  signups: SignupSnapshot[];
}

export interface SignupMutationRequest {
  request_id: string;
  season_id: string;
  practice_id: string;
  member_id: string;
  practice_version: number;
  signup_version: number;
  preference?: Preference;
}

export interface CoachSignupMutationRequest extends SignupMutationRequest, SessionRequest {}

function signupState(value: unknown, index: number): SignupStateSnapshot {
  const row = object(value, `states[${index}]`);
  return {
    season_id: identifier(row, "season_id"), practice_id: identifier(row, "practice_id"),
    signup_version: integer(row, "signup_version"), signup_sequence: integer(row, "signup_sequence")
  };
}

function signupSnapshot(value: unknown, index: number): SignupSnapshot {
  const row = object(value, `signups[${index}]`);
  return {
    season_id: identifier(row, "season_id"), practice_id: identifier(row, "practice_id"),
    member_id: identifier(row, "member_id"),
    preference: enumeration(row, "preference", ["LEFT", "AMBIENT", "RIGHT"]),
    status: enumeration(row, "status", ["CONFIRMED", "WAITLISTED", "CANCELLED"]),
    queue_at: isoTimestamp(row, "queue_at"), queue_sequence: integer(row, "queue_sequence", 1),
    updated_at: isoTimestamp(row, "updated_at"), last_request_id: string(row, "last_request_id", 0, 128)
  };
}

export function parseImportSignupSnapshot(value: unknown): ImportSignupSnapshotRequest {
  const input = object(value);
  return {
    request_id: requestId(input), source_snapshot_id: identifier(input, "source_snapshot_id"),
    states: array(input, "states", 20_000).map(signupState),
    signups: array(input, "signups", 100_000).map(signupSnapshot)
  };
}

function mutation(input: Input, requirePreference: boolean): SignupMutationRequest {
  const result: SignupMutationRequest = {
    request_id: requestId(input), season_id: identifier(input, "season_id"),
    practice_id: identifier(input, "practice_id"), member_id: identifier(input, "member_id"),
    practice_version: integer(input, "practice_version", 1), signup_version: integer(input, "signup_version")
  };
  if (requirePreference) {
    result.preference = enumeration(input, "preference", ["LEFT", "AMBIENT", "RIGHT"] as const);
  }
  return result;
}

export function parseSignupMutation(value: unknown, requirePreference: boolean): SignupMutationRequest {
  return mutation(object(value), requirePreference);
}

export function parseCoachSignupMutation(value: unknown, requirePreference: boolean): CoachSignupMutationRequest {
  const input = object(value);
  return { ...sessionRequest(input), ...mutation(input, requirePreference) };
}
