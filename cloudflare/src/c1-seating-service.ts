import {
  parseImportSeatingSnapshot, parsePublishSeatPlan, parseSaveSeatPlanDraft, parseSeatingWorkspace,
  type ImportSeatingSnapshotRequest, type PublishSeatPlanRequest, type SaveSeatPlanDraftRequest,
  type SeatSnapshot, type SeatSide, type SeatingRevisionSnapshot
} from "../../shared/c1-seating-contract";
import { canonicalJson } from "../../shared/c1-rules";
import { ApiError } from "./http";
import { C1Service } from "./c1-service";
import {
  firstRow, operationReceipt, parseContract, queueOrder, signupProjection, type SqlRow
} from "./c1-support";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeatPlanSeat {
  row_number: number;
  side: SeatSide;
  member_id: string;
}

interface SeatPlanState extends SqlRow {
  seat_plan_version: number;
  published_revision: number;
  coach_member_id: string;
  steerer_member_id: string;
}

interface SeatClaim {
  side: SeatSide;
  row_number: number;
  claimed: boolean;
  claimed_preference?: string;
  released_by_target: boolean;
}

export interface SignupSeatingTransition {
  seat_plan_version: number;
  published_revision: number;
  draft_changed: boolean;
  published_changed: boolean;
}

function seatKey(side: unknown, rowNumber: unknown): string {
  return `${String(side)}:${Number(rowNumber)}`;
}

function practiceKey(row: { season_id: string; practice_id: string }): string {
  return `${row.season_id}\n${row.practice_id}`;
}

function groupByPractice<T extends { season_id: string; practice_id: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = practiceKey(row);
    const values = grouped.get(key);
    if (values) values.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function roleValue(value: unknown): string {
  return value ? String(value) : "";
}

function practiceProjection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    practice_id: String(row.practice_id), week_id: String(row.week_id), start_at: String(row.start_at),
    end_at: String(row.end_at), timezone: String(row.timezone), location: String(row.location),
    address: String(row.address), map_url: String(row.map_url || ""), left_capacity: Number(row.left_capacity),
    right_capacity: Number(row.right_capacity), signup_cutoff_at: String(row.signup_cutoff_at),
    practice_version: Number(row.practice_version), schedule_published_at: row.schedule_published_at
      ? String(row.schedule_published_at) : null, cancelled: Boolean(row.cancelled_at), updated_at: String(row.updated_at)
  };
}

function archiveDueAt(practice: Record<string, unknown>): string {
  const end = Date.parse(String(practice.end_at));
  if (!Number.isFinite(end)) throw new ApiError("CONFIGURATION_ERROR", "The training end time is invalid.", 500);
  return new Date(end + DAY_MS).toISOString();
}

export function seatingMode(practice: Record<string, unknown>, now = Date.now()): "UPCOMING" | "FINAL_CORRECTION" | "FROZEN" | "CANCELLED" {
  if (practice.cancelled_at) return "CANCELLED";
  const end = Date.parse(String(practice.end_at));
  if (now >= end + DAY_MS) return "FROZEN";
  if (now >= end) return "FINAL_CORRECTION";
  return "UPCOMING";
}

function normalizeSeats(practice: Record<string, unknown>, input: SeatSnapshot[] | SeatPlanSeat[]): SeatPlanSeat[] {
  const capacities = { LEFT: Number(practice.left_capacity), RIGHT: Number(practice.right_capacity) };
  if (!Number.isSafeInteger(capacities.LEFT) || capacities.LEFT < 1 ||
      !Number.isSafeInteger(capacities.RIGHT) || capacities.RIGHT < 1) {
    throw new ApiError("CONFIGURATION_ERROR", "The training capacity is invalid.", 500);
  }
  const supplied = new Map<string, string>();
  for (const seat of input) {
    if (!seat || !["LEFT", "RIGHT"].includes(seat.side) || !Number.isSafeInteger(seat.row_number) ||
        seat.row_number < 1 || seat.row_number > capacities[seat.side]) {
      throw new ApiError("INVALID_SEAT_PLAN", "A seat is outside the training capacity.", 400);
    }
    const key = seatKey(seat.side, seat.row_number);
    if (supplied.has(key)) throw new ApiError("INVALID_SEAT_PLAN", "The same seat was included more than once.", 400);
    supplied.set(key, String(seat.member_id || ""));
  }
  const result: SeatPlanSeat[] = [];
  for (const side of ["LEFT", "RIGHT"] as const) {
    for (let rowNumber = 1; rowNumber <= capacities[side]; rowNumber += 1) {
      result.push({ side, row_number: rowNumber, member_id: supplied.get(seatKey(side, rowNumber)) || "" });
    }
  }
  return result;
}

function occupiedSeats(seats: SeatPlanSeat[]): SeatPlanSeat[] {
  return seats.filter((seat) => Boolean(seat.member_id));
}

function seatsEqual(left: SeatPlanSeat[], right: SeatPlanSeat[]): boolean {
  return canonicalJson(left.map((seat) => [seat.row_number, seat.side, seat.member_id])) ===
    canonicalJson(right.map((seat) => [seat.row_number, seat.side, seat.member_id]));
}

function matchesPreference(side: SeatSide, preference: unknown): boolean {
  return preference === "AMBIENT" || side === preference;
}

function claimSeat(slots: SeatClaim[] | null, preference: unknown): boolean {
  if (!slots) return true;
  const direct = slots.find((slot) => !slot.claimed && matchesPreference(slot.side, preference));
  if (direct) {
    direct.claimed = true;
    direct.claimed_preference = String(preference);
    return true;
  }
  if (preference !== "AMBIENT") {
    const flexible = slots.find((slot) => slot.side === preference && slot.claimed_preference === "AMBIENT");
    const spare = slots.find((slot) => !slot.claimed);
    if (flexible && spare) {
      flexible.claimed_preference = String(preference);
      spare.claimed = true;
      spare.claimed_preference = "AMBIENT";
      return true;
    }
  }
  return false;
}

function stateRow(sql: SqlStorage, seasonId: string, practiceId: string): SeatPlanState {
  const row = firstRow<SqlRow>(sql,
    `SELECT pv.seat_plan_version, pv.published_revision,
            COALESCE(s.coach_member_id, '') AS coach_member_id,
            COALESCE(s.steerer_member_id, '') AS steerer_member_id,
            COALESCE(s.updated_by, '') AS updated_by, COALESCE(s.updated_at, '') AS state_updated_at
       FROM practice_versions pv
       LEFT JOIN seat_plan_states s ON s.season_id=pv.season_id AND s.practice_id=pv.practice_id
      WHERE pv.season_id=? AND pv.practice_id=?`, seasonId, practiceId);
  if (!row) throw new ApiError("PRACTICE_NOT_FOUND", "The training does not exist.", 404);
  return { ...row, seat_plan_version: Number(row.seat_plan_version),
    published_revision: Number(row.published_revision), coach_member_id: roleValue(row.coach_member_id),
    steerer_member_id: roleValue(row.steerer_member_id) } as SeatPlanState;
}

function revisionRow(sql: SqlStorage, seasonId: string, practiceId: string, revisionNumber: number): SqlRow | null {
  if (!revisionNumber) return null;
  return firstRow<SqlRow>(sql,
    "SELECT * FROM seat_plan_revisions WHERE season_id=? AND practice_id=? AND revision_number=?",
    seasonId, practiceId, revisionNumber);
}

function storedDraftSeats(sql: SqlStorage, practice: Record<string, unknown>): SeatPlanSeat[] {
  const rows = sql.exec<SqlRow>(
    "SELECT side, row_number, COALESCE(member_id, '') AS member_id FROM seat_plan_draft_seats WHERE season_id=? AND practice_id=?",
    String(practice.season_id), String(practice.practice_id)).toArray();
  return normalizeSeats(practice, rows.map((row) => ({ side: String(row.side) as SeatSide,
    row_number: Number(row.row_number), member_id: roleValue(row.member_id) })));
}

function storedRevisionSeats(sql: SqlStorage, practice: Record<string, unknown>, revisionNumber: number): SeatPlanSeat[] {
  const rows = sql.exec<SqlRow>(
    `SELECT side, row_number, member_id FROM seat_plan_revision_seats
      WHERE season_id=? AND practice_id=? AND revision_number=?`,
    String(practice.season_id), String(practice.practice_id), revisionNumber).toArray();
  return normalizeSeats(practice, rows.map((row) => ({ side: String(row.side) as SeatSide,
    row_number: Number(row.row_number), member_id: String(row.member_id) })));
}

function currentNames(sql: SqlStorage, seasonId: string): Map<string, string> {
  return new Map(sql.exec<SqlRow>(
    "SELECT member_id, source_display_name, display_name_override FROM members WHERE season_id=?", seasonId
  ).toArray().map((row) => [String(row.member_id), String(row.display_name_override || row.source_display_name)]));
}

function participantNames(names: Map<string, string>, coachId: string, steererId: string,
  seats: SeatPlanSeat[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const memberId of [coachId, steererId, ...occupiedSeats(seats).map((seat) => seat.member_id)]) {
    if (memberId && names.has(memberId)) result.set(memberId, names.get(memberId)!);
  }
  return result;
}

function publicRows(practice: Record<string, unknown>, seats: SeatPlanSeat[], names: Map<string, string>): Record<string, unknown>[] {
  const bySlot = new Map(occupiedSeats(seats).map((seat) => [seatKey(seat.side, seat.row_number), {
    member_id: seat.member_id, display_name: names.get(seat.member_id) || "已停用队员"
  }]));
  const rows = [];
  const maximum = Math.max(Number(practice.left_capacity), Number(practice.right_capacity));
  for (let rowNumber = 1; rowNumber <= maximum; rowNumber += 1) {
    rows.push({ row_number: rowNumber, left: bySlot.get(seatKey("LEFT", rowNumber)) || null,
      right: bySlot.get(seatKey("RIGHT", rowNumber)) || null });
  }
  return rows;
}

export function publicSeatPlanProjection(sql: SqlStorage, practice: Record<string, unknown>, management = false): Record<string, unknown> {
  const seasonId = String(practice.season_id);
  const practiceId = String(practice.practice_id);
  const state = stateRow(sql, seasonId, practiceId);
  const revision = revisionRow(sql, seasonId, practiceId, state.published_revision);
  const seats = revision ? storedRevisionSeats(sql, practice, state.published_revision) : normalizeSeats(practice, []);
  const names = currentNames(sql, seasonId);
  const coachId = revision ? roleValue(revision.coach_member_id) : "";
  const steererId = revision ? roleValue(revision.steerer_member_id) : "";
  const role = (memberId: string) => memberId ? { display_name: names.get(memberId) || "已停用队员",
    ...(management ? { member_id: memberId } : {}) } : null;
  const mode = seatingMode(practice);
  return {
    status: mode === "FROZEN" ? "FROZEN" : revision ? "PUBLISHED" : "UNPUBLISHED",
    mode, seat_plan_version: revision ? Number(revision.seat_plan_version) : 0,
    published_revision: state.published_revision, archive_due_at: archiveDueAt(practice),
    published_at: revision ? String(revision.published_at) : "", source: revision ? String(revision.source) : "",
    coach: role(coachId), steerer: role(steererId),
    seats: occupiedSeats(seats).map((seat) => ({ ...seat,
      display_name: names.get(seat.member_id) || "已停用队员" })),
    rows: publicRows(practice, seats, names)
  };
}

function writeDraft(sql: SqlStorage, practice: Record<string, unknown>, seats: SeatPlanSeat[],
  version: number, actorId: string, at: string): void {
  const seasonId = String(practice.season_id);
  const practiceId = String(practice.practice_id);
  sql.exec("DELETE FROM seat_plan_draft_seats WHERE season_id=? AND practice_id=?", seasonId, practiceId).toArray();
  for (const seat of seats) {
    sql.exec(
      `INSERT INTO seat_plan_draft_seats(season_id, practice_id, side, row_number, member_id,
         seat_plan_version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      seasonId, practiceId, seat.side, seat.row_number, seat.member_id || null, version, actorId, at).toArray();
  }
}

function upsertState(sql: SqlStorage, seasonId: string, practiceId: string, coachId: string,
  steererId: string, actorId: string, at: string): void {
  sql.exec(
    `INSERT INTO seat_plan_states(season_id, practice_id, coach_member_id, steerer_member_id, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(season_id, practice_id) DO UPDATE SET
       coach_member_id=excluded.coach_member_id, steerer_member_id=excluded.steerer_member_id,
       updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    seasonId, practiceId, coachId || null, steererId || null, actorId, at).toArray();
}

function writeRevision(sql: SqlStorage, practice: Record<string, unknown>, revision: {
  revision_number: number; revision_id: string; source: string; seat_plan_version: number;
  coach_member_id: string; steerer_member_id: string; seats: SeatPlanSeat[]; names: Map<string, string>;
  published_by: string; published_at: string; request_id: string;
}): void {
  const seasonId = String(practice.season_id);
  const practiceId = String(practice.practice_id);
  sql.exec(
    `INSERT INTO seat_plan_revisions(season_id, practice_id, revision_number, revision_id, source,
       seat_plan_version, coach_member_id, steerer_member_id, published_by, published_at, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    seasonId, practiceId, revision.revision_number, revision.revision_id, revision.source,
    revision.seat_plan_version, revision.coach_member_id || null, revision.steerer_member_id || null,
    revision.published_by, revision.published_at, revision.request_id).toArray();
  for (const seat of occupiedSeats(revision.seats)) {
    sql.exec(
      `INSERT INTO seat_plan_revision_seats(season_id, practice_id, revision_number, side, row_number, member_id)
       VALUES (?, ?, ?, ?, ?, ?)`, seasonId, practiceId, revision.revision_number,
      seat.side, seat.row_number, seat.member_id).toArray();
  }
  for (const [memberId, displayName] of revision.names) {
    sql.exec(
      `INSERT INTO seat_plan_revision_names(season_id, practice_id, revision_number, member_id, display_name)
       VALUES (?, ?, ?, ?, ?)`, seasonId, practiceId, revision.revision_number, memberId, displayName).toArray();
  }
}

export class C1SeatingService {
  private readonly core: C1Service;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.core = new C1Service(ctx, env);
  }

  async handle(path: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (path) {
      case "/internal/c1/import-seating": return this.importSeating(raw);
      case "/internal/c1/get-seating-workspace": return this.getWorkspace(raw);
      case "/internal/c1/save-seat-plan-draft": return this.saveDraft(raw);
      case "/internal/c1/publish-seat-plan": return this.publish(raw);
      default: throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    }
  }

  private requireStoredPractice(seasonId: string, practiceId: string): SqlRow {
    const row = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT p.*, w.status AS week_status, s.status AS season_status,
              pv.signup_version, pv.signup_sequence, pv.seat_plan_version, pv.published_revision
         FROM practices p
         JOIN training_weeks w ON w.season_id=p.season_id AND w.week_id=p.week_id
         JOIN seasons s ON s.season_id=p.season_id
         JOIN practice_versions pv ON pv.season_id=p.season_id AND pv.practice_id=p.practice_id
        WHERE p.season_id=? AND p.practice_id=?`, seasonId, practiceId);
    if (!row) throw new ApiError("PRACTICE_NOT_FOUND", "The training does not exist.", 404);
    return row;
  }

  private requirePractice(seasonId: string, practiceId: string): SqlRow {
    const row = this.requireStoredPractice(seasonId, practiceId);
    if (!["OPEN", "COMPLETED"].includes(String(row.season_status)) || row.week_status !== "OPENED" ||
        !row.schedule_published_at || row.cancelled_at) {
      throw new ApiError("PRACTICE_NOT_PUBLIC", "The training is not publicly available.", 404);
    }
    return row;
  }

  roleMemberIds(seasonId: string, practiceId: string): Set<string> {
    const state = stateRow(this.ctx.storage.sql, seasonId, practiceId);
    const revision = revisionRow(this.ctx.storage.sql, seasonId, practiceId, state.published_revision);
    return new Set([state.coach_member_id, state.steerer_member_id,
      roleValue(revision?.coach_member_id), roleValue(revision?.steerer_member_id)].filter(Boolean));
  }

  signupSeatAvailability(practice: Record<string, unknown>, signupRows: SqlRow[], targetMemberId: string): SeatClaim[] | null {
    const seasonId = String(practice.season_id);
    const practiceId = String(practice.practice_id);
    const state = stateRow(this.ctx.storage.sql, seasonId, practiceId);
    const revision = revisionRow(this.ctx.storage.sql, seasonId, practiceId, state.published_revision);
    const hasDraft = state.seat_plan_version > 0 || Boolean(firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT 1 AS present FROM seat_plan_draft_seats WHERE season_id=? AND practice_id=? LIMIT 1",
      seasonId, practiceId));
    if (!revision && !hasDraft) return null;
    const seats = revision ? storedRevisionSeats(this.ctx.storage.sql, practice, state.published_revision)
      : storedDraftSeats(this.ctx.storage.sql, practice);
    const signupByMember = new Map(signupRows.map((row) => [String(row.member_id), row]));
    const occupied = new Set<string>();
    const slots: SeatClaim[] = [];
    for (const seat of seats) {
      const signup = seat.member_id ? signupByMember.get(seat.member_id) : null;
      const released = seat.member_id === targetMemberId &&
        (!signup || signup.status !== "CONFIRMED" || !matchesPreference(seat.side, signup.preference));
      if (seat.member_id && !released) occupied.add(seat.member_id);
      else slots.push({ side: seat.side, row_number: seat.row_number, claimed: false, released_by_target: released });
    }
    slots.sort((left, right) => Number(right.released_by_target) - Number(left.released_by_target) ||
      left.row_number - right.row_number || left.side.localeCompare(right.side));
    signupRows.filter((row) => row.status === "CONFIRMED" && !occupied.has(String(row.member_id)))
      .sort(queueOrder).forEach((row) => { claimSeat(slots, row.preference); });
    return slots;
  }

  claimSignupSeat(slots: SeatClaim[] | null, preference: unknown): boolean {
    return claimSeat(slots, preference);
  }

  applySignupTransition(practice: SqlRow, signupRows: SqlRow[], target: SqlRow,
    promotedMemberIds: string[], action: string, requestId: string, requestKey: string,
    actorId: string, at: string): SignupSeatingTransition | null {
    const sql = this.ctx.storage.sql;
    const seasonId = String(practice.season_id);
    const practiceId = String(practice.practice_id);
    const state = stateRow(sql, seasonId, practiceId);
    const published = revisionRow(sql, seasonId, practiceId, state.published_revision);
    const hasDraft = state.seat_plan_version > 0 || Boolean(firstRow<SqlRow>(sql,
      "SELECT 1 AS present FROM seat_plan_draft_seats WHERE season_id=? AND practice_id=? LIMIT 1",
      seasonId, practiceId));
    if (!published && !hasDraft) return null;

    const targetId = String(target.member_id);
    const shouldRemove = target.status !== "CONFIRMED";
    const preference = String(target.preference || "AMBIENT");
    const signupByMember = new Map(signupRows.map((row) => [String(row.member_id), row]));
    const publishedBefore = published ? storedRevisionSeats(sql, practice, state.published_revision) : null;
    const publishedAfter = publishedBefore?.map((seat) => ({ ...seat })) ?? null;
    const releasedKeys: string[] = [];
    if (publishedAfter) {
      for (const seat of publishedAfter) {
        if (seat.member_id === targetId && (shouldRemove || !matchesPreference(seat.side, preference))) {
          releasedKeys.push(seatKey(seat.side, seat.row_number));
          seat.member_id = "";
        }
      }
    }
    let promotedId = "";
    if (publishedAfter && releasedKeys.length) {
      const releasedSide = releasedKeys[0].split(":")[0] as SeatSide;
      promotedId = promotedMemberIds.find((memberId) => {
        const signup = signupByMember.get(memberId);
        return signup && matchesPreference(releasedSide, signup.preference);
      }) || "";
      if (promotedId) {
        const replacement = publishedAfter.find((seat) => seatKey(seat.side, seat.row_number) === releasedKeys[0]);
        if (replacement && !replacement.member_id) replacement.member_id = promotedId;
      }
    }

    const draftBefore = hasDraft ? storedDraftSeats(sql, practice) : null;
    const draftAfter = draftBefore?.map((seat) => ({ ...seat })) ?? null;
    if (!publishedBefore && promotedMemberIds.length) promotedId = promotedMemberIds[0];
    if (draftAfter) {
      for (const seat of draftAfter) {
        if (seat.member_id === targetId && (shouldRemove || !matchesPreference(seat.side, preference))) {
          seat.member_id = "";
        }
      }
      if (promotedId) {
        let replacementKey = "";
        if (publishedBefore && releasedKeys.length) {
          if (draftBefore!.some((seat) => seatKey(seat.side, seat.row_number) === releasedKeys[0] && seat.member_id === targetId)) {
            replacementKey = releasedKeys[0];
          }
        } else if (!publishedBefore) {
          const releasedDraftSeat = draftBefore!.find((seat) => seat.member_id === targetId &&
            (shouldRemove || !matchesPreference(seat.side, preference)));
          if (releasedDraftSeat) replacementKey = seatKey(releasedDraftSeat.side, releasedDraftSeat.row_number);
        }
        const replacement = draftAfter.find((seat) => seatKey(seat.side, seat.row_number) === replacementKey);
        if (replacement && !replacement.member_id) replacement.member_id = promotedId;
      }
    }

    const draftChanged = Boolean(draftBefore && draftAfter && !seatsEqual(draftBefore, draftAfter));
    const publishedChanged = Boolean(publishedBefore && publishedAfter && !seatsEqual(publishedBefore, publishedAfter));
    if (!draftChanged && !publishedChanged) return null;
    const nextSeatVersion = state.seat_plan_version + (draftChanged ? 1 : 0);
    const nextRevision = state.published_revision + (publishedChanged ? 1 : 0);
    if (draftChanged) writeDraft(sql, practice, draftAfter!, nextSeatVersion, actorId, at);
    if (publishedChanged) {
      const coachId = roleValue(published!.coach_member_id);
      const steererId = roleValue(published!.steerer_member_id);
      writeRevision(sql, practice, {
        revision_number: nextRevision, revision_id: `seat_revision_${requestKey.slice(-32)}_system`,
        source: `SYSTEM_${action.toUpperCase()}`, seat_plan_version: nextSeatVersion,
        coach_member_id: coachId, steerer_member_id: steererId, seats: publishedAfter!,
        names: participantNames(currentNames(sql, seasonId), coachId, steererId, publishedAfter!),
        published_by: actorId, published_at: at, request_id: requestId
      });
    }
    sql.exec(
      "UPDATE practice_versions SET seat_plan_version=?, published_revision=? WHERE season_id=? AND practice_id=?",
      nextSeatVersion, nextRevision, seasonId, practiceId).toArray();
    upsertState(sql, seasonId, practiceId, state.coach_member_id, state.steerer_member_id, actorId, at);
    return { seat_plan_version: nextSeatVersion, published_revision: nextRevision,
      draft_changed: draftChanged, published_changed: publishedChanged };
  }

  private preferenceMismatches(practice: Record<string, unknown>, seats: SeatPlanSeat[]): Record<string, unknown>[] {
    const preferences = new Map(this.ctx.storage.sql.exec<SqlRow>(
      "SELECT member_id, preference FROM signups WHERE season_id=? AND practice_id=? AND status='CONFIRMED'",
      String(practice.season_id), String(practice.practice_id)).toArray()
      .map((row) => [String(row.member_id), String(row.preference)]));
    return occupiedSeats(seats).filter((seat) => preferences.has(seat.member_id) &&
      preferences.get(seat.member_id) !== "AMBIENT" && preferences.get(seat.member_id) !== seat.side)
      .map((seat) => ({ member_id: seat.member_id, preference: preferences.get(seat.member_id), side: seat.side }));
  }

  private validateSnapshot(practice: SqlRow, snapshot: { coach_member_id: string; steerer_member_id: string;
    seats: SeatPlanSeat[] }, mode: ReturnType<typeof seatingMode>, publishing: boolean): Record<string, unknown>[] {
    const members = new Map(this.ctx.storage.sql.exec<SqlRow>(
      "SELECT * FROM members WHERE season_id=?", String(practice.season_id)).toArray()
      .map((row) => [String(row.member_id), row]));
    const signups = this.ctx.storage.sql.exec<SqlRow>(
      "SELECT * FROM signups WHERE season_id=? AND practice_id=?", practice.season_id, practice.practice_id).toArray();
    const activeSignups = new Set(signups.filter((row) => row.status !== "CANCELLED").map((row) => String(row.member_id)));
    const confirmed = new Set(signups.filter((row) => row.status === "CONFIRMED").map((row) => String(row.member_id)));
    for (const memberId of [snapshot.coach_member_id, snapshot.steerer_member_id]) {
      if (!memberId) continue;
      const member = members.get(memberId);
      if (!member || (mode === "UPCOMING" && member.status !== "ACTIVE")) {
        throw new ApiError("INVALID_SEAT_PLAN", "A training role contains an unavailable member.", 400);
      }
      if (mode === "UPCOMING" && activeSignups.has(memberId)) {
        throw new ApiError("ROLE_SIGNUP_CONFLICT", "Remove this member's signup before assigning a training role.", 409);
      }
    }
    const seated = new Set<string>();
    for (const seat of occupiedSeats(snapshot.seats)) {
      const member = members.get(seat.member_id);
      if (!member || (mode === "UPCOMING" && member.status !== "ACTIVE")) {
        throw new ApiError("INVALID_SEAT_PLAN", "A seat contains an unavailable member.", 400);
      }
      if (seated.has(seat.member_id)) {
        throw new ApiError("INVALID_SEAT_PLAN", "A member cannot occupy more than one seat.", 400);
      }
      if (seat.member_id === snapshot.coach_member_id || seat.member_id === snapshot.steerer_member_id) {
        throw new ApiError("INVALID_SEAT_PLAN", "A Coach or Steerer cannot also occupy a paddling seat.", 400);
      }
      if (mode === "UPCOMING" && !confirmed.has(seat.member_id)) {
        throw new ApiError("SEAT_MEMBER_NOT_CONFIRMED", "Only confirmed signups can be seated before training ends.", 409);
      }
      seated.add(seat.member_id);
    }
    if (publishing && mode === "UPCOMING" && [...confirmed].some((memberId) => !seated.has(memberId))) {
      throw new ApiError("SEAT_PLAN_INCOMPLETE", "Seat every confirmed signup before publishing.", 409);
    }
    return this.preferenceMismatches(practice, snapshot.seats);
  }

  workspace(seasonId: string, practiceId: string): Record<string, unknown> {
    const practice = this.requirePractice(seasonId, practiceId);
    const state = stateRow(this.ctx.storage.sql, seasonId, practiceId);
    const mode = seatingMode(practice);
    const seats = storedDraftSeats(this.ctx.storage.sql, practice);
    const names = currentNames(this.ctx.storage.sql, seasonId);
    const signups = this.ctx.storage.sql.exec<SqlRow>(
      "SELECT * FROM signups WHERE season_id=? AND practice_id=? AND status<>'CANCELLED'",
      seasonId, practiceId).toArray().sort(queueOrder);
    const seated = new Set(occupiedSeats(seats).map((seat) => seat.member_id));
    return {
      season_id: seasonId, practice_id: practiceId, practice: practiceProjection(practice), mode,
      editable: mode === "UPCOMING" || mode === "FINAL_CORRECTION", archive_due_at: archiveDueAt(practice),
      generated_at: new Date().toISOString(), signup_version: Number(practice.signup_version),
      seat_plan_version: state.seat_plan_version, published_revision: state.published_revision,
      draft: { coach_member_id: state.coach_member_id, steerer_member_id: state.steerer_member_id,
        seats: occupiedSeats(seats) },
      published: state.published_revision ? publicSeatPlanProjection(this.ctx.storage.sql, practice, true) : null,
      members: this.ctx.storage.sql.exec<SqlRow>(
        "SELECT * FROM members WHERE season_id=? ORDER BY lower(CASE WHEN display_name_override='' THEN source_display_name ELSE display_name_override END), member_id",
        seasonId).toArray().map((row) => ({ member_id: String(row.member_id),
        display_name: String(row.display_name_override || row.source_display_name), status: String(row.status),
        default_preference: String(row.default_preference) })),
      signups: signups.map((row) => ({ ...signupProjection(row),
        display_name: names.get(String(row.member_id)) || "已停用队员" })),
      unseated_member_ids: signups.filter((row) => row.status === "CONFIRMED" && !seated.has(String(row.member_id)))
        .map((row) => String(row.member_id)),
      preference_mismatches: this.preferenceMismatches(practice, seats)
    };
  }

  private currentView(response: Record<string, unknown>, seasonId: string, practiceId: string): Record<string, unknown> {
    try { return { ...response, view_status: "ready", current_view: this.workspace(seasonId, practiceId) }; }
    catch { return { ...response, view_status: "reload_required" }; }
  }

  private async getWorkspace(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseSeatingWorkspace(raw));
    await this.core.authenticateSession(input.session_token);
    return this.workspace(input.season_id, input.practice_id);
  }

  private digestSeats(seats: SeatSnapshot[]): SeatSnapshot[] {
    return [...seats].sort((left, right) => left.side.localeCompare(right.side) ||
      left.row_number - right.row_number || left.member_id.localeCompare(right.member_id));
  }

  private assertVersions(practice: SqlRow, input: { practice_version: number; signup_version: number;
    seat_plan_version: number; published_revision?: number }): SeatPlanState {
    const state = stateRow(this.ctx.storage.sql, String(practice.season_id), String(practice.practice_id));
    if (Number(practice.practice_version) !== input.practice_version || Number(practice.signup_version) !== input.signup_version ||
        state.seat_plan_version !== input.seat_plan_version ||
        (input.published_revision !== undefined && state.published_revision !== input.published_revision)) {
      throw new ApiError("VERSION_CONFLICT", "The training, signup list or seating plan changed. Refresh and try again.", 409);
    }
    return state;
  }

  private async saveDraft(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseSaveSeatPlanDraft(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, practice_id: input.practice_id,
      practice_version: input.practice_version, signup_version: input.signup_version,
      seat_plan_version: input.seat_plan_version, coach_member_id: input.coach_member_id,
      steerer_member_id: input.steerer_member_id, seats: this.digestSeats(input.seats), change_kind: input.change_kind };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "saveSeatPlanDraft", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id, input.practice_id);
    const practice = this.requirePractice(input.season_id, input.practice_id);
    const state = this.assertVersions(practice, input);
    if (seatingMode(practice) === "FROZEN") throw new ApiError("SEAT_PLAN_FROZEN", "The final correction window has closed.", 409);
    let coachId = input.coach_member_id;
    let steererId = input.steerer_member_id;
    let seats = normalizeSeats(practice, input.seats);
    if (input.change_kind === "RESET_TO_PUBLISHED") {
      const revision = revisionRow(this.ctx.storage.sql, input.season_id, input.practice_id, state.published_revision);
      coachId = roleValue(revision?.coach_member_id);
      steererId = roleValue(revision?.steerer_member_id);
      seats = revision ? storedRevisionSeats(this.ctx.storage.sql, practice, state.published_revision) : normalizeSeats(practice, []);
    }
    this.validateSnapshot(practice, { coach_member_id: coachId, steerer_member_id: steererId, seats },
      seatingMode(practice), false);
    const at = new Date().toISOString();
    const nextVersion = state.seat_plan_version + 1;
    const response = { operation: operationReceipt("saveSeatPlanDraft", input.request_id, at), result: {
      season_id: input.season_id, practice_id: input.practice_id, seat_plan_version: nextVersion
    } };
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth);
      const current = this.requirePractice(input.season_id, input.practice_id);
      this.assertVersions(current, input);
      if (seatingMode(current) === "FROZEN") throw new ApiError("SEAT_PLAN_FROZEN", "The final correction window has closed.", 409);
      this.validateSnapshot(current, { coach_member_id: coachId, steerer_member_id: steererId, seats },
        seatingMode(current), false);
      writeDraft(this.ctx.storage.sql, current, seats, nextVersion, auth.coach_id, at);
      upsertState(this.ctx.storage.sql, input.season_id, input.practice_id, coachId, steererId, auth.coach_id, at);
      this.ctx.storage.sql.exec(
        "UPDATE practice_versions SET seat_plan_version=? WHERE season_id=? AND practice_id=?",
        nextVersion, input.season_id, input.practice_id).toArray();
      this.core.recordRequest(identity, auth.coach_id, "saveSeatPlanDraft", input.request_id, response,
        { season_id: input.season_id, practice_id: input.practice_id, change_kind: input.change_kind,
          seat_plan_version: nextVersion }, at);
      this.core.enqueueChange(identity, "SEATING_CHANGED", "saveSeatPlanDraft",
        { season_id: input.season_id, practice_id: input.practice_id, seat_plan_version: nextVersion }, at);
    });
    return this.currentView(response, input.season_id, input.practice_id);
  }

  private async publish(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parsePublishSeatPlan(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, practice_id: input.practice_id,
      practice_version: input.practice_version, signup_version: input.signup_version,
      seat_plan_version: input.seat_plan_version, published_revision: input.published_revision,
      acknowledge_preference_mismatch: input.acknowledge_preference_mismatch };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "publishSeatPlan", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id, input.practice_id);
    const practice = this.requirePractice(input.season_id, input.practice_id);
    const state = this.assertVersions(practice, input);
    const mode = seatingMode(practice);
    if (mode === "FROZEN") throw new ApiError("SEAT_PLAN_FROZEN", "The final correction window has closed.", 409);
    const seats = storedDraftSeats(this.ctx.storage.sql, practice);
    const mismatches = this.validateSnapshot(practice, { coach_member_id: state.coach_member_id,
      steerer_member_id: state.steerer_member_id, seats }, mode, true);
    if (mode === "UPCOMING" && mismatches.length && !input.acknowledge_preference_mismatch) {
      throw new ApiError("PREFERENCE_ACK_REQUIRED", "Confirm the side-preference differences before publishing.", 409);
    }
    const at = new Date().toISOString();
    const revisionNumber = state.published_revision + 1;
    const response = { operation: operationReceipt("publishSeatPlan", input.request_id, at), result: {
      season_id: input.season_id, practice_id: input.practice_id,
      seat_plan_version: state.seat_plan_version, published_revision: revisionNumber
    } };
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth);
      const current = this.requirePractice(input.season_id, input.practice_id);
      const currentState = this.assertVersions(current, input);
      const currentMode = seatingMode(current);
      if (currentMode === "FROZEN") throw new ApiError("SEAT_PLAN_FROZEN", "The final correction window has closed.", 409);
      const currentSeats = storedDraftSeats(this.ctx.storage.sql, current);
      const currentMismatches = this.validateSnapshot(current, { coach_member_id: currentState.coach_member_id,
        steerer_member_id: currentState.steerer_member_id, seats: currentSeats }, currentMode, true);
      if (currentMode === "UPCOMING" && currentMismatches.length && !input.acknowledge_preference_mismatch) {
        throw new ApiError("PREFERENCE_ACK_REQUIRED", "Confirm the side-preference differences before publishing.", 409);
      }
      writeRevision(this.ctx.storage.sql, current, {
        revision_number: revisionNumber, revision_id: `seat_revision_${identity.requestKey.slice(-32)}_manual`,
        source: "MANUAL", seat_plan_version: currentState.seat_plan_version,
        coach_member_id: currentState.coach_member_id, steerer_member_id: currentState.steerer_member_id,
        seats: currentSeats, names: participantNames(currentNames(this.ctx.storage.sql, input.season_id),
          currentState.coach_member_id, currentState.steerer_member_id, currentSeats),
        published_by: auth.coach_id, published_at: at, request_id: input.request_id
      });
      this.ctx.storage.sql.exec(
        "UPDATE practice_versions SET published_revision=? WHERE season_id=? AND practice_id=?",
        revisionNumber, input.season_id, input.practice_id).toArray();
      upsertState(this.ctx.storage.sql, input.season_id, input.practice_id, currentState.coach_member_id,
        currentState.steerer_member_id, auth.coach_id, at);
      this.core.recordRequest(identity, auth.coach_id, "publishSeatPlan", input.request_id, response,
        { season_id: input.season_id, practice_id: input.practice_id, published_revision: revisionNumber,
          seat_plan_version: currentState.seat_plan_version, preference_mismatches: currentMismatches }, at);
      this.core.enqueueChange(identity, "SEATING_CHANGED", "publishSeatPlan",
        { season_id: input.season_id, practice_id: input.practice_id,
          seat_plan_version: currentState.seat_plan_version, published_revision: revisionNumber }, at);
    });
    return this.currentView(response, input.season_id, input.practice_id);
  }

  private revisionComparable(revision: SeatingRevisionSnapshot | SqlRow, seats: SeatPlanSeat[],
    names: Array<{ member_id: string; display_name: string }>): Record<string, unknown> {
    return { season_id: String(revision.season_id), practice_id: String(revision.practice_id),
      revision_number: Number(revision.revision_number), revision_id: String(revision.revision_id),
      source: String(revision.source), seat_plan_version: Number(revision.seat_plan_version),
      coach_member_id: roleValue(revision.coach_member_id), steerer_member_id: roleValue(revision.steerer_member_id),
      seats: occupiedSeats(seats), names: [...names].sort((a, b) => a.member_id.localeCompare(b.member_id)),
      published_by: String(revision.published_by), published_at: String(revision.published_at),
      request_id: String(revision.request_id) };
  }

  private validateImport(input: ImportSeatingSnapshotRequest): void {
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) throw new ApiError("IMPORT_CONFLICT", `${label} contains duplicates.`, 409);
    };
    unique(input.states.map((row) => `${row.season_id}\n${row.practice_id}`), "seating states");
    unique(input.draft_seats.map((row) => `${row.season_id}\n${row.practice_id}\n${row.side}\n${row.row_number}`), "draft seats");
    unique(input.revisions.map((row) => `${row.season_id}\n${row.practice_id}\n${row.revision_number}`), "seating revisions");
    unique(input.revisions.map((row) => row.revision_id), "revision identifiers");
    const draftsByPractice = groupByPractice(input.draft_seats);
    const revisionsByPractice = groupByPractice(input.revisions);
    const revisionsByNumber = new Map(input.revisions.map((row) =>
      [`${practiceKey(row)}\n${row.revision_number}`, row]));
    const practices = new Map(this.ctx.storage.sql.exec<SqlRow>(
      `SELECT p.*, pv.seat_plan_version, pv.published_revision FROM practices p
       JOIN practice_versions pv ON pv.season_id=p.season_id AND pv.practice_id=p.practice_id`
    ).toArray().map((row) => [`${row.season_id}\n${row.practice_id}`, row]));
    const members = new Set(this.ctx.storage.sql.exec<SqlRow>("SELECT season_id, member_id FROM members").toArray()
      .map((row) => `${row.season_id}\n${row.member_id}`));
    const states = new Map(input.states.map((row) => [`${row.season_id}\n${row.practice_id}`, row]));
    for (const state of input.states) {
      const key = `${state.season_id}\n${state.practice_id}`;
      const practice = practices.get(key);
      if (!practice) throw new ApiError("IMPORT_REFERENCE_MISSING", "A seating state has an unknown training.", 409);
      if (state.seat_plan_version < Number(practice.seat_plan_version) ||
          state.published_revision < Number(practice.published_revision)) {
        throw new ApiError("IMPORT_VERSION_REGRESSION", "The snapshot contains an older seating state.", 409);
      }
      for (const memberId of [state.coach_member_id, state.steerer_member_id]) {
        if (memberId && !members.has(`${state.season_id}\n${memberId}`)) {
          throw new ApiError("IMPORT_REFERENCE_MISSING", "A seating role has an unknown member.", 409);
        }
      }
      const draft = draftsByPractice.get(key) || [];
      if (state.seat_plan_version > 0 && draft.length !== Number(practice.left_capacity) + Number(practice.right_capacity)) {
        throw new ApiError("IMPORT_CONFLICT", "A seating state requires a complete draft snapshot.", 409);
      }
      if (draft.some((row) => row.seat_plan_version !== state.seat_plan_version)) {
        throw new ApiError("IMPORT_CONFLICT", "A draft seat has the wrong seating version.", 409);
      }
      const normalized = normalizeSeats(practice, draft);
      const occupied = occupiedSeats(normalized);
      if (new Set(occupied.map((row) => row.member_id)).size !== occupied.length ||
          occupied.some((row) => !members.has(`${state.season_id}\n${row.member_id}`))) {
        throw new ApiError("IMPORT_CONFLICT", "A draft contains duplicate or unknown members.", 409);
      }
      const currentState = stateRow(this.ctx.storage.sql, state.season_id, state.practice_id);
      const storedState = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT updated_by, updated_at FROM seat_plan_states WHERE season_id=? AND practice_id=?",
        state.season_id, state.practice_id);
      if (state.seat_plan_version === currentState.seat_plan_version) {
        if (state.coach_member_id !== currentState.coach_member_id ||
            state.steerer_member_id !== currentState.steerer_member_id ||
            (state.seat_plan_version > 0 && !seatsEqual(normalized,
              storedDraftSeats(this.ctx.storage.sql, practice)))) {
          throw new ApiError("IMPORT_CONFLICT", "The same seating version contains different draft data.", 409);
        }
      }
      if (storedState && state.seat_plan_version === currentState.seat_plan_version &&
          state.published_revision === currentState.published_revision &&
          (state.updated_by !== String(storedState.updated_by) || state.updated_at !== String(storedState.updated_at))) {
        throw new ApiError("IMPORT_CONFLICT", "The same seating state versions contain different metadata.", 409);
      }
      this.validateSnapshot(practice, { coach_member_id: state.coach_member_id,
        steerer_member_id: state.steerer_member_id, seats: normalized }, seatingMode(practice), false);
      const mergedRevisions = new Set(this.ctx.storage.sql.exec<SqlRow>(
        "SELECT revision_number FROM seat_plan_revisions WHERE season_id=? AND practice_id=?",
        state.season_id, state.practice_id).toArray().map((row) => Number(row.revision_number)));
      (revisionsByPractice.get(key) || [])
        .forEach((row) => mergedRevisions.add(row.revision_number));
      const continuousRevisionCount = [...mergedRevisions]
        .filter((revisionNumber) => revisionNumber >= 1 && revisionNumber <= state.published_revision).length;
      if (continuousRevisionCount !== state.published_revision) {
        throw new ApiError("IMPORT_CONFLICT", "A published seating revision is missing.", 409);
      }
      if (state.published_revision > 0) {
        const importedLatest = revisionsByNumber.get(`${key}\n${state.published_revision}`);
        const storedLatest = importedLatest ? null : revisionRow(this.ctx.storage.sql, state.season_id,
          state.practice_id, state.published_revision);
        const latest = importedLatest || storedLatest!;
        const latestSeats = importedLatest ? normalizeSeats(practice, importedLatest.seats) :
          storedRevisionSeats(this.ctx.storage.sql, practice, state.published_revision);
        this.validateSnapshot(practice, { coach_member_id: roleValue(latest.coach_member_id),
          steerer_member_id: roleValue(latest.steerer_member_id), seats: latestSeats }, seatingMode(practice), true);
      }
    }
    for (const row of input.draft_seats) {
      if (!states.has(`${row.season_id}\n${row.practice_id}`)) {
        throw new ApiError("IMPORT_REFERENCE_MISSING", "A draft seat has no state in this snapshot.", 409);
      }
    }
    for (const revision of input.revisions) {
      const key = `${revision.season_id}\n${revision.practice_id}`;
      const state = states.get(key);
      const practice = practices.get(key);
      if (!state || !practice) throw new ApiError("IMPORT_REFERENCE_MISSING", "A revision has no seating state.", 409);
      if (revision.revision_number > state.published_revision || revision.seat_plan_version > state.seat_plan_version) {
        throw new ApiError("IMPORT_CONFLICT", "A revision exceeds its seating state.", 409);
      }
      const seats = normalizeSeats(practice, revision.seats);
      const participants = [revision.coach_member_id, revision.steerer_member_id,
        ...occupiedSeats(seats).map((seat) => seat.member_id)].filter(Boolean);
      const occupiedMemberIds = occupiedSeats(seats).map((seat) => seat.member_id);
      if (new Set(occupiedMemberIds).size !== occupiedMemberIds.length ||
          occupiedMemberIds.includes(revision.coach_member_id) || occupiedMemberIds.includes(revision.steerer_member_id) ||
          participants.some((memberId) => !members.has(`${revision.season_id}\n${memberId}`))) {
        throw new ApiError("IMPORT_CONFLICT", "A revision contains duplicate or unknown members.", 409);
      }
      unique(revision.names.map((name) => name.member_id), `revision ${revision.revision_id} names`);
      const names = new Map(revision.names.map((name) => [name.member_id, name.display_name]));
      const participantIds = new Set(participants);
      if (revision.names.length !== participantIds.size ||
          revision.names.some((name) => !participantIds.has(name.member_id)) ||
          participants.some((memberId) => !names.has(memberId)) ||
          revision.names.some((name) => !members.has(`${revision.season_id}\n${name.member_id}`))) {
        throw new ApiError("IMPORT_CONFLICT", "A revision name snapshot must exactly match its participants.", 409);
      }
      const existing = revisionRow(this.ctx.storage.sql, revision.season_id, revision.practice_id, revision.revision_number);
      const revisionOwner = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT season_id, practice_id, revision_number FROM seat_plan_revisions WHERE revision_id=?",
        revision.revision_id);
      if (revisionOwner && (revisionOwner.season_id !== revision.season_id ||
          revisionOwner.practice_id !== revision.practice_id ||
          Number(revisionOwner.revision_number) !== revision.revision_number)) {
        throw new ApiError("IMPORT_CONFLICT", "A revision identifier belongs to another revision.", 409);
      }
      if (existing) {
        const existingSeats = storedRevisionSeats(this.ctx.storage.sql, practice, revision.revision_number);
        const existingNames = this.ctx.storage.sql.exec<SqlRow>(
          `SELECT member_id, display_name FROM seat_plan_revision_names
            WHERE season_id=? AND practice_id=? AND revision_number=?`,
          revision.season_id, revision.practice_id, revision.revision_number).toArray()
          .map((name) => ({ member_id: String(name.member_id), display_name: String(name.display_name) }));
        if (canonicalJson(this.revisionComparable(existing, existingSeats, existingNames)) !==
            canonicalJson(this.revisionComparable(revision, seats, revision.names))) {
          throw new ApiError("IMPORT_CONFLICT", "An immutable seating revision has different data.", 409);
        }
      }
    }
  }

  private async importSeating(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseImportSeatingSnapshot(raw));
    const { request_id: _requestId, ...snapshot } = input;
    const identity = await this.core.createRequestIdentity("C1:MIGRATION", "importSeatingSnapshot", input.request_id, snapshot);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    this.validateImport(input);
    const prior = firstRow<{ payload_digest: string }>(this.ctx.storage.sql,
      "SELECT payload_digest FROM seating_migration_snapshots WHERE source_snapshot_id=?", input.source_snapshot_id);
    if (prior && prior.payload_digest !== identity.payloadDigest) {
      throw new ApiError("IMPORT_SNAPSHOT_CONFLICT", "This seating snapshot identifier has different content.", 409);
    }
    const at = new Date().toISOString();
    const draftsByPractice = groupByPractice(input.draft_seats);
    const response = { operation: operationReceipt("importSeatingSnapshot", input.request_id, at), result: {
      source_snapshot_id: input.source_snapshot_id, states: input.states.length,
      draft_seats: input.draft_seats.length, revisions: input.revisions.length
    } };
    this.ctx.storage.transactionSync(() => {
      for (const revision of input.revisions) {
        if (revisionRow(this.ctx.storage.sql, revision.season_id, revision.practice_id, revision.revision_number)) continue;
        const practice = this.requireStoredPractice(revision.season_id, revision.practice_id);
        writeRevision(this.ctx.storage.sql, practice, { ...revision,
          seats: normalizeSeats(practice, revision.seats), names: new Map(revision.names.map((name) => [name.member_id, name.display_name])) });
      }
      for (const state of input.states) {
        const practice = this.requireStoredPractice(state.season_id, state.practice_id);
        const draft = draftsByPractice.get(practiceKey(state)) || [];
        if (state.seat_plan_version > 0) {
          writeDraft(this.ctx.storage.sql, practice, normalizeSeats(practice, draft), state.seat_plan_version,
            state.updated_by, state.updated_at);
        }
        upsertState(this.ctx.storage.sql, state.season_id, state.practice_id, state.coach_member_id,
          state.steerer_member_id, state.updated_by, state.updated_at);
        this.ctx.storage.sql.exec(
          "UPDATE practice_versions SET seat_plan_version=?, published_revision=? WHERE season_id=? AND practice_id=?",
          state.seat_plan_version, state.published_revision, state.season_id, state.practice_id).toArray();
      }
      this.core.recordRequest(identity, "C1:MIGRATION", "importSeatingSnapshot", input.request_id, response,
        { source_snapshot_id: input.source_snapshot_id, counts: response.result }, at);
      this.ctx.storage.sql.exec(
        `INSERT INTO seating_migration_snapshots(source_snapshot_id, payload_digest, imported_at, request_key)
         VALUES (?, ?, ?, ?) ON CONFLICT(source_snapshot_id) DO NOTHING`,
        input.source_snapshot_id, identity.payloadDigest, at, identity.requestKey).toArray();
    });
    return response;
  }
}
