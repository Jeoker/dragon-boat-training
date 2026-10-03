import { ApiError } from "./http";
import { SEAT_CELL_HEADERS, SHEET_SCOPES, type AssociatedSheetScope } from "./c2-sheet-bridge";

export interface AssociatedStage {
  entity_type: AssociatedSheetScope;
  row_id: string;
  values: Record<string, unknown>;
  version: number;
}

export interface AssociatedEvent {
  topic: "SIGNUPS_CHANGED" | "SEATING_CHANGED";
  season_id: string;
  practice_id: string;
  practice_version: number;
  signup_version: number;
  seat_plan_version: number | null;
  published_revision: number | null;
  stages: AssociatedStage[];
  seating: Record<string, unknown> | null;
}

const stable = (value: unknown): value is string => typeof value === "string" &&
  /^[A-Za-z0-9_-]{8,128}$/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const bad = (reason: string): never => { throw new ApiError("SYNC_OUTBOX_INVALID", reason, 409); };

function optionalId(value: unknown): boolean { return value === "" || stable(value); }

export function parseAssociatedEvent(topic: string, payloadJson: string, seasonId: string): AssociatedEvent {
  let payload: unknown;
  try { payload = JSON.parse(payloadJson); } catch { return bad("The associated event JSON is invalid."); }
  if (!record(payload) || !record(payload.entity)) return bad("The associated event has no entity snapshot.");
  const entity = payload.entity;
  if (entity.season_id !== seasonId || !stable(entity.practice_id) ||
      !positive(entity.practice_version) || Number(entity.practice_version) < 1 ||
      !positive(entity.signup_version)) return bad("The associated event identity or versions are invalid.");
  if (topic !== "SIGNUPS_CHANGED" && topic !== "SEATING_CHANGED") return bad("An unrelated event reached the associated exporter.");
  const signupActions = new Set(["signup", "updateSignup", "cancelSignup",
    "signupByCoach", "updateSignupByCoach", "cancelSignupByCoach"]);
  const seatingActions = new Set(["saveSeatPlanDraft", "publishSeatPlan"]);
  if (!(topic === "SIGNUPS_CHANGED" ? signupActions : seatingActions).has(String(payload.action))) {
    return bad("The associated event has an invalid action.");
  }
  if (entity.snapshot_schema !== (topic === "SIGNUPS_CHANGED" ? 2 : 1)) {
    return bad("A legacy associated event has no complete captured snapshot.");
  }
  const stages: AssociatedStage[] = [];
  if (topic === "SIGNUPS_CHANGED") {
    if (!Array.isArray(entity.signup_rows) || !entity.signup_rows.length || entity.signup_rows.length > 100 ||
        Number(entity.signup_version) < 1) return bad("A signup event has no bounded signup snapshot.");
    for (const item of entity.signup_rows) {
      if (!record(item) || item.season_id !== seasonId || item.practice_id !== entity.practice_id ||
          !stable(item.member_id) || !["LEFT", "RIGHT", "AMBIENT"].includes(String(item.preference)) ||
          !["CONFIRMED", "WAITLISTED", "CANCELLED"].includes(String(item.status)) ||
          typeof item.queue_at !== "string" || !positive(item.queue_sequence) ||
          typeof item.updated_at !== "string" || typeof item.last_request_id !== "string") {
        return bad("A captured signup row is invalid.");
      }
      stages.push({ entity_type: "SIGNUP", row_id: `${entity.practice_id}:${item.member_id}`,
        values: item, version: Number(entity.signup_version) });
    }
  } else if (entity.signup_rows !== undefined) return bad("A seating event contains signup rows.");
  const seating = entity.seating_snapshot;
  let seatVersion: number | null = null;
  let revisionNumber: number | null = null;
  if (seating !== undefined) {
    if (!record(seating) || !record(seating.state)) return bad("The seating snapshot has no state.");
    const state = seating.state;
    // Draft events emitted before published_revision was added still carry the
    // complete, captured state. Accept only that one legacy shape so an
    // already-pending outbox can be exported without rewriting its snapshot.
    const legacyDraftRevision = topic === "SEATING_CHANGED" &&
      payload.action === "saveSeatPlanDraft" && entity.published_revision === undefined &&
      Array.isArray(seating.draft_seats) && seating.revision === null;
    if (state.season_id !== seasonId || state.practice_id !== entity.practice_id ||
        !positive(state.seat_plan_version) || !positive(state.published_revision) ||
        !optionalId(state.coach_member_id) || !optionalId(state.steerer_member_id) ||
        !stable(state.updated_by) || typeof state.updated_at !== "string" ||
        entity.seat_plan_version !== state.seat_plan_version ||
        !(entity.published_revision === state.published_revision || legacyDraftRevision)) {
      return bad("The captured seating state is inconsistent.");
    }
    seatVersion = Number(state.seat_plan_version);
    revisionNumber = Number(state.published_revision);
    if (seating.draft_seats !== null) {
      if (!Array.isArray(seating.draft_seats) || !seating.draft_seats.length || seating.draft_seats.length > 100) {
        return bad("The captured draft seat list is invalid.");
      }
      for (const item of seating.draft_seats) {
        if (!record(item) || !["LEFT", "RIGHT"].includes(String(item.side)) ||
            !positive(item.row_number) || Number(item.row_number) < 1 || !optionalId(item.member_id)) {
          return bad("A captured draft seat is invalid.");
        }
        stages.push({ entity_type: "SEAT_PLAN_CURRENT",
          row_id: `${entity.practice_id}:${item.row_number}:${item.side}`,
          values: { season_id: seasonId, practice_id: entity.practice_id,
            row_number: item.row_number, side: item.side, member_id: item.member_id,
            seat_plan_version: seatVersion, updated_by: state.updated_by,
            updated_at: state.updated_at }, version: seatVersion });
      }
    }
    if (seating.revision !== null) {
      const revision = seating.revision;
      if (!record(revision) || revision.season_id !== seasonId || revision.practice_id !== entity.practice_id ||
          !positive(revision.revision_number) || revision.revision_number !== revisionNumber ||
          !stable(revision.revision_id) || !/^(?:MANUAL|SYSTEM_[A-Z_]+)$/u.test(String(revision.source)) ||
          !positive(revision.seat_plan_version) || revision.seat_plan_version !== seatVersion ||
          revisionNumber === 0 || revision.coach_member_id !== state.coach_member_id ||
          revision.steerer_member_id !== state.steerer_member_id ||
          !Array.isArray(revision.seats) ||
          !Array.isArray(revision.names) || !stable(revision.published_by) ||
          typeof revision.published_at !== "string" || typeof revision.request_id !== "string") {
        return bad("The captured published revision is invalid.");
      }
      stages.push({ entity_type: "SEAT_PLAN_REVISION",
        row_id: `${entity.practice_id}:${revisionNumber}`, values: {
          ...revision, seats_json: JSON.stringify(revision.seats),
          names_json: JSON.stringify(revision.names) }, version: revisionNumber });
    }
    stages.push({ entity_type: "SEAT_PLAN_DRAFT", row_id: String(entity.practice_id),
      values: { ...state, frozen_revision: 0, frozen_at: "" }, version: seatVersion });
  } else if (topic === "SEATING_CHANGED") return bad("A seating event has no captured seating snapshot.");
  const ids = stages.map((stage) => `${stage.entity_type}:${stage.row_id}`);
  if (new Set(ids).size !== ids.length || !stages.length) return bad("The associated event has duplicate or empty stages.");
  return { topic, season_id: seasonId, practice_id: String(entity.practice_id),
    practice_version: Number(entity.practice_version), signup_version: Number(entity.signup_version),
    seat_plan_version: seatVersion, published_revision: revisionNumber,
    stages, seating: record(seating) ? seating : null };
}

export function associatedHeaders(scope: AssociatedSheetScope): readonly string[] {
  return scope === "SEAT_PLAN_CURRENT" ? SEAT_CELL_HEADERS : SHEET_SCOPES[scope].headers;
}

export function assertAssociatedCapacity(event: AssociatedEvent, practice: Record<string, unknown>): void {
  const left = Number(practice.left_capacity);
  const right = Number(practice.right_capacity);
  if (practice.season_id !== event.season_id || practice.practice_id !== event.practice_id ||
      Number(practice.practice_version) < event.practice_version ||
      !Number.isSafeInteger(left) || left < 1 || left > 50 ||
      !Number.isSafeInteger(right) || right < 1 || right > 50) {
    throw new ApiError("SYNC_ASSOCIATED_INVALID", "The associated event has an invalid practice capacity.", 409);
  }
  const seats = event.stages.filter((stage) => stage.entity_type === "SEAT_PLAN_CURRENT");
  if (seats.length) {
    const expected = left + right;
    const identities = new Set(seats.map((stage) => stage.row_id));
    if (seats.length !== expected || identities.size !== expected ||
        seats.some((stage) => {
          const side = String(stage.values.side);
          const row = Number(stage.values.row_number);
          return row < 1 || row > (side === "LEFT" ? left : right);
        })) {
      throw new ApiError("SYNC_ASSOCIATED_INVALID", "The captured draft must cover every seat exactly once.", 409);
    }
    const members = seats.map((stage) => String(stage.values.member_id)).filter(Boolean);
    const state = event.seating?.state as Record<string, unknown>;
    if (new Set(members).size !== members.length ||
        members.includes(String(state.coach_member_id)) || members.includes(String(state.steerer_member_id))) {
      throw new ApiError("SYNC_ASSOCIATED_INVALID", "The captured draft assigns a member twice.", 409);
    }
  }
  const revision = event.seating?.revision as Record<string, unknown> | null | undefined;
  if (revision) {
    const occupied = revision.seats as Array<Record<string, unknown>>;
    const names = revision.names as Array<Record<string, unknown>>;
    const keys = new Set<string>();
    const members = new Set<string>();
    if (occupied.length > left + right || names.length > left + right + 2) {
      throw new ApiError("SYNC_ASSOCIATED_INVALID", "The captured revision exceeds practice capacity.", 409);
    }
    for (const seat of occupied) {
      if (!record(seat) || !["LEFT", "RIGHT"].includes(String(seat.side)) ||
          !positive(seat.row_number) || Number(seat.row_number) < 1 ||
          Number(seat.row_number) > (seat.side === "LEFT" ? left : right) ||
          !stable(seat.member_id)) throw new ApiError("SYNC_ASSOCIATED_INVALID", "A published seat is invalid.", 409);
      const key = `${seat.side}:${seat.row_number}`;
      if (keys.has(key) || members.has(String(seat.member_id))) {
        throw new ApiError("SYNC_ASSOCIATED_INVALID", "A published seat is duplicated.", 409);
      }
      keys.add(key);
      members.add(String(seat.member_id));
    }
    if (members.has(String(revision.coach_member_id)) || members.has(String(revision.steerer_member_id)) ||
        names.some((name) => !record(name) || !stable(name.member_id) ||
          typeof name.display_name !== "string" || !name.display_name.trim()) ||
        new Set(names.map((name) => String(name.member_id))).size !== names.length) {
      throw new ApiError("SYNC_ASSOCIATED_INVALID", "The published roles or names are invalid.", 409);
    }
  }
}

export function associatedCells(stage: AssociatedStage, previous: string[] | null): string[] {
  const headers = associatedHeaders(stage.entity_type);
  const target = headers.map((header, index) => {
    // The event snapshot does not touch history-freeze metadata.
    const raw = stage.entity_type === "SEAT_PLAN_DRAFT" &&
      (header === "frozen_revision" || header === "frozen_at") && previous
      ? previous[index] : stage.values[header];
    if (raw === undefined || raw === null) return "";
    return String(raw);
  });
  if (target.some((cell) => cell.length > 10_000 || cell.startsWith("="))) {
    throw new ApiError("SYNC_ASSOCIATED_INVALID", "An associated target contains an unsafe Sheet cell.", 409);
  }
  return target;
}
