import {
  parseCoachSignupMutation, parseImportSignupSnapshot, parseSignupMutation,
  type ImportSignupSnapshotRequest, type SignupMutationRequest, type SignupSnapshot,
  type SignupStateSnapshot
} from "../../shared/c1-signup-contract";
import { canonicalJson } from "../../shared/c1-rules";
import { ApiError } from "./http";
import { C1Service } from "./c1-service";
import { C1SeatingService, publicSeatPlanProjection } from "./c1-seating-service";
import { firstRow, operationReceipt, parseContract, queueOrder, signupProjection, type SqlRow } from "./c1-support";

type MutationKind = "CREATE" | "UPDATE" | "CANCEL";

interface SignupCounts extends Record<string, number> {
  confirmed: number;
  waitlisted: number;
  left: number;
  ambient: number;
  right: number;
  left_capacity: number;
  right_capacity: number;
  total_capacity: number;
}

function practiceProjection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    practice_id: String(row.practice_id), week_id: String(row.week_id),
    start_at: String(row.start_at), end_at: String(row.end_at), timezone: String(row.timezone),
    location: String(row.location), address: String(row.address), map_url: String(row.map_url || ""),
    signup_cutoff_at: String(row.signup_cutoff_at), left_capacity: Number(row.left_capacity),
    right_capacity: Number(row.right_capacity), practice_version: Number(row.practice_version),
    schedule_published_at: row.schedule_published_at ? String(row.schedule_published_at) : null,
    cancelled: Boolean(row.cancelled_at), updated_at: String(row.updated_at),
    schedule_changed_at: row.schedule_published_at && String(row.updated_at) > String(row.schedule_published_at)
      ? String(row.updated_at) : null
  };
}

function signupComparable(row: Record<string, unknown> | SignupSnapshot): Record<string, unknown> {
  return {
    season_id: String(row.season_id), practice_id: String(row.practice_id), member_id: String(row.member_id),
    preference: String(row.preference), status: String(row.status), queue_at: String(row.queue_at),
    queue_sequence: Number(row.queue_sequence), updated_at: String(row.updated_at),
    last_request_id: String(row.last_request_id || "")
  };
}

function signupCounts(rows: Record<string, unknown>[], practice: Record<string, unknown>): SignupCounts {
  const counts: SignupCounts = {
    confirmed: 0, waitlisted: 0, left: 0, ambient: 0, right: 0,
    left_capacity: Number(practice.left_capacity), right_capacity: Number(practice.right_capacity),
    total_capacity: Number(practice.left_capacity) + Number(practice.right_capacity)
  };
  for (const row of rows) {
    if (row.status === "CONFIRMED") {
      counts.confirmed += 1;
      counts[String(row.preference).toLowerCase()] += 1;
    } else if (row.status === "WAITLISTED") counts.waitlisted += 1;
  }
  return counts;
}

function canConfirm(preference: unknown, counts: SignupCounts): boolean {
  return counts.confirmed < counts.total_capacity &&
    (preference !== "LEFT" || counts.left < counts.left_capacity) &&
    (preference !== "RIGHT" || counts.right < counts.right_capacity);
}

function validateIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new ApiError("INVALID_REQUEST", `${field} is invalid.`);
  return value;
}

export class C1SignupService {
  private readonly core: C1Service;
  private readonly seating: C1SeatingService;

  constructor(private readonly ctx: DurableObjectState, env: Env) {
    this.core = new C1Service(ctx, env);
    this.seating = new C1SeatingService(ctx, env);
  }

  async handle(path: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (path) {
      case "/internal/c1/import-signups": return this.importSignups(raw);
      case "/internal/c1/signup": return this.mutate(raw, "CREATE", false);
      case "/internal/c1/update-signup": return this.mutate(raw, "UPDATE", false);
      case "/internal/c1/cancel-signup": return this.mutate(raw, "CANCEL", false);
      case "/internal/c1/signup-by-coach": return this.mutate(raw, "CREATE", true);
      case "/internal/c1/update-signup-by-coach": return this.mutate(raw, "UPDATE", true);
      case "/internal/c1/cancel-signup-by-coach": return this.mutate(raw, "CANCEL", true);
      default: throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    }
  }

  publicPractice(seasonId: string, practiceId: string): Record<string, unknown> {
    validateIdentifier(seasonId, "season_id");
    validateIdentifier(practiceId, "practice_id");
    const practice = this.requirePublicPractice(seasonId, practiceId);
    const rows = this.signupRows(seasonId, practiceId).filter((row) => row.status !== "CANCELLED");
    const names = new Map(this.ctx.storage.sql.exec<SqlRow>(
      `SELECT member_id, source_display_name, display_name_override FROM members WHERE season_id=?`, seasonId
    ).toArray().map((row) => [String(row.member_id), String(row.display_name_override || row.source_display_name)]));
    const now = Date.now();
    const publicClosedReason = this.closedReason(practice, false, now);
    let waitlistPosition = 0;
    return {
      season_id: seasonId, season_status: String(practice.season_status),
      roster_version: Number(practice.roster_version), binding_version: Number(practice.binding_version),
      practice: practiceProjection(practice), signup_version: Number(practice.signup_version),
      signup_open: !publicClosedReason,
      management_signup_open: !this.closedReason(practice, true, now),
      closed_reason: publicClosedReason, counts: signupCounts(rows, practice),
      signups: rows.map((row) => ({ ...signupProjection(row),
        display_name: names.get(String(row.member_id)) || "已停用队员",
        waitlist_position: row.status === "WAITLISTED" ? ++waitlistPosition : null })),
      seat_plan: publicSeatPlanProjection(this.ctx.storage.sql, practice), generated_at: new Date().toISOString()
    };
  }

  private requirePublicPractice(seasonId: string, practiceId: string): SqlRow {
    const row = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT p.*, w.status AS week_status, s.status AS season_status,
              s.roster_version, s.binding_version, pv.signup_version, pv.signup_sequence
         FROM practices p
         JOIN training_weeks w ON w.season_id=p.season_id AND w.week_id=p.week_id
         JOIN seasons s ON s.season_id=p.season_id
         JOIN practice_versions pv ON pv.season_id=p.season_id AND pv.practice_id=p.practice_id
        WHERE p.season_id=? AND p.practice_id=?`, seasonId, practiceId);
    if (!row || !["OPEN", "COMPLETED"].includes(String(row.season_status)) || row.week_status !== "OPENED" ||
        !row.schedule_published_at || row.cancelled_at) {
      throw new ApiError("PRACTICE_NOT_PUBLIC", "The training is not publicly available.", 404);
    }
    return row;
  }

  private requireMutationContext(input: SignupMutationRequest, management: boolean): { practice: SqlRow; member: SqlRow } {
    const practice = this.requirePublicPractice(input.season_id, input.practice_id);
    const reason = this.closedReason(practice, management);
    if (reason) throw new ApiError(reason, "Signups cannot be changed at this time.", 409);
    if (Number(practice.practice_version) !== input.practice_version ||
        Number(practice.signup_version) !== input.signup_version) {
      throw new ApiError("VERSION_CONFLICT", "The training or signup list changed. Refresh and try again.", 409);
    }
    const member = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM members WHERE season_id=? AND member_id=?", input.season_id, input.member_id);
    if (!member) throw new ApiError("MEMBER_NOT_FOUND", "The member does not exist.", 404);
    return { practice, member };
  }

  private closedReason(practice: Record<string, unknown>, management: boolean, now = Date.now()): string {
    if (practice.season_status !== "OPEN") return "SEASON_NOT_OPEN";
    if (now >= Date.parse(String(practice.end_at))) return "PRACTICE_ENDED";
    if (!management && now >= Date.parse(String(practice.signup_cutoff_at))) return "SIGNUP_CLOSED";
    return "";
  }

  private signupRows(seasonId: string, practiceId: string): SqlRow[] {
    return this.ctx.storage.sql.exec<SqlRow>(
      `SELECT * FROM signups WHERE season_id=? AND practice_id=?`,
      seasonId, practiceId).toArray().sort(queueOrder);
  }

  private consumePublicAttempt(seasonId: string, memberId: string, at: string): void {
    const bucket = Math.floor(Date.parse(at) / 60_000);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM signup_rate_limits WHERE minute_bucket < ?", bucket - 5).toArray();
      const current = firstRow<{ attempt_count: number }>(this.ctx.storage.sql,
        "SELECT attempt_count FROM signup_rate_limits WHERE season_id=? AND member_id=? AND minute_bucket=?",
        seasonId, memberId, bucket);
      if (Number(current?.attempt_count ?? 0) >= 12) {
        throw new ApiError("SIGNUP_RATE_LIMITED", "Too many changes. Wait briefly and retry.", 429, true);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO signup_rate_limits(season_id, member_id, minute_bucket, attempt_count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(season_id, member_id, minute_bucket)
         DO UPDATE SET attempt_count=attempt_count+1, updated_at=excluded.updated_at`,
        seasonId, memberId, bucket, at).toArray();
    });
  }

  private currentView(response: Record<string, unknown>, seasonId: string, practiceId: string): Record<string, unknown> {
    try { return { ...response, view_status: "ready", current_view: this.publicPractice(seasonId, practiceId) }; }
    catch { return { ...response, view_status: "reload_required" }; }
  }

  private async mutate(raw: Record<string, unknown>, kind: MutationKind,
    management: boolean): Promise<Record<string, unknown>> {
    const input = parseContract(() => management
      ? parseCoachSignupMutation(raw, kind !== "CANCEL")
      : parseSignupMutation(raw, kind !== "CANCEL"));
    const auth = management
      ? await this.core.authenticateSession((input as SignupMutationRequest & { session_token: string }).session_token)
      : null;
    const action = kind === "CREATE" ? (management ? "signupByCoach" : "signup") :
      kind === "UPDATE" ? (management ? "updateSignupByCoach" : "updateSignup") :
        management ? "cancelSignupByCoach" : "cancelSignup";
    const actorScope = auth?.coach_id || `PUBLIC:${input.season_id}:${input.member_id}`;
    const payload = {
      season_id: input.season_id, practice_id: input.practice_id, member_id: input.member_id,
      practice_version: input.practice_version, signup_version: input.signup_version,
      ...(kind === "CANCEL" ? {} : { preference: input.preference })
    };
    const identity = await this.core.createRequestIdentity(actorScope, action, input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id, input.practice_id);
    const preflight = this.requireMutationContext(input, management);
    if (kind !== "CANCEL" && preflight.member.status !== "ACTIVE") {
      throw new ApiError("MEMBER_INACTIVE", "This member is inactive.", 409);
    }
    if (kind !== "CANCEL" && this.seating.roleMemberIds(input.season_id, input.practice_id).has(input.member_id)) {
      throw new ApiError("ROLE_SIGNUP_CONFLICT", "A Coach or Steerer cannot also hold a training signup.", 409);
    }
    const at = new Date().toISOString();
    if (!management) this.consumePublicAttempt(input.season_id, input.member_id, at);
    let response: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      if (auth) this.core.assertSessionCurrent(auth);
      const { practice, member } = this.requireMutationContext(input, management);
      if (kind !== "CANCEL" && member.status !== "ACTIVE") {
        throw new ApiError("MEMBER_INACTIVE", "This member is inactive.", 409);
      }
      if (kind !== "CANCEL" && this.seating.roleMemberIds(input.season_id, input.practice_id).has(input.member_id)) {
        throw new ApiError("ROLE_SIGNUP_CONFLICT", "A Coach or Steerer cannot also hold a training signup.", 409);
      }
      const rows = this.signupRows(input.season_id, input.practice_id);
      const before = new Map(rows.map((row) => [String(row.member_id), signupComparable(row)]));
      let target = rows.find((row) => row.member_id === input.member_id);
      const active = Boolean(target && target.status !== "CANCELLED");
      if (kind === "CREATE" && active) throw new ApiError("SIGNUP_EXISTS", "This member is already signed up.", 409);
      if (kind !== "CREATE" && !active) throw new ApiError("SIGNUP_NOT_ACTIVE", "This member has no active signup.", 409);
      const noChange = kind === "UPDATE" && target?.preference === input.preference;
      let sequence = Number(practice.signup_sequence);
      if (!noChange) {
        if (kind === "CREATE") {
          sequence += 1;
          if (!target) {
            target = { season_id: input.season_id, practice_id: input.practice_id,
              member_id: input.member_id } as SqlRow;
            rows.push(target);
          }
          target.queue_at = at;
          target.queue_sequence = sequence;
        }
        target!.status = kind === "CANCEL" ? "CANCELLED" : "WAITLISTED";
        if (kind !== "CANCEL") target!.preference = input.preference!;
        target!.updated_at = at;
        target!.last_request_id = input.request_id;
        const activeMembers = new Set(this.ctx.storage.sql.exec<SqlRow>(
          "SELECT member_id FROM members WHERE season_id=? AND status='ACTIVE'", input.season_id
        ).toArray().map((row) => String(row.member_id)));
        const counts = signupCounts(rows, practice);
        const seatAvailability = this.seating.signupSeatAvailability(practice, rows, input.member_id);
        for (const row of rows.filter((candidate) => candidate.status === "WAITLISTED").sort(queueOrder)) {
          if (!activeMembers.has(String(row.member_id)) || !canConfirm(row.preference, counts) ||
              !this.seating.claimSignupSeat(seatAvailability, row.preference)) continue;
          row.status = "CONFIRMED";
          row.updated_at = at;
          row.last_request_id = input.request_id;
          counts.confirmed += 1;
          counts[String(row.preference).toLowerCase()] += 1;
        }
      }
      const changed = rows.filter((row) => canonicalJson(signupComparable(row)) !==
        canonicalJson(before.get(String(row.member_id)) ?? null));
      for (const row of changed) {
        this.ctx.storage.sql.exec(
          `INSERT INTO signups(season_id, practice_id, member_id, preference, status, queue_at,
             queue_sequence, updated_at, last_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(season_id, practice_id, member_id) DO UPDATE SET preference=excluded.preference,
             status=excluded.status, queue_at=excluded.queue_at, queue_sequence=excluded.queue_sequence,
             updated_at=excluded.updated_at, last_request_id=excluded.last_request_id`,
          row.season_id, row.practice_id, row.member_id, row.preference, row.status, row.queue_at,
          row.queue_sequence, row.updated_at, row.last_request_id).toArray();
      }
      const nextVersion = Number(practice.signup_version) + (noChange ? 0 : 1);
      if (!noChange) this.ctx.storage.sql.exec(
        "UPDATE practice_versions SET signup_version=?, signup_sequence=? WHERE season_id=? AND practice_id=?",
        nextVersion, sequence, input.season_id, input.practice_id).toArray();
      const promoted = changed.filter((row) => row.member_id !== input.member_id && row.status === "CONFIRMED" &&
        before.get(String(row.member_id))?.status === "WAITLISTED").map((row) => String(row.member_id));
      const seating = noChange ? null : this.seating.applySignupTransition(practice, rows, target!, promoted,
        action, input.request_id, identity.requestKey, auth?.coach_id || input.member_id, at);
      response = { operation: operationReceipt(action, input.request_id, at), result: {
        season_id: input.season_id, practice_id: input.practice_id, signup_version: nextVersion,
        signup: signupProjection(target!), promoted_member_ids: promoted,
        ...(seating ? { seat_plan_version: seating.seat_plan_version,
          published_revision: seating.published_revision } : {})
      } };
      this.core.recordRequest(identity, actorScope, action, input.request_id, response,
        { season_id: input.season_id, practice_id: input.practice_id, member_id: input.member_id,
          status: target!.status, promoted_member_ids: promoted, seating }, at);
      if (!noChange) this.core.enqueueChange(identity, "SIGNUPS_CHANGED", action,
        { season_id: input.season_id, practice_id: input.practice_id,
          member_id: input.member_id, promoted_member_ids: promoted,
          ...(seating ? { seat_plan_version: seating.seat_plan_version,
            published_revision: seating.published_revision } : {}) }, at);
    });
    return this.currentView(response, input.season_id, input.practice_id);
  }

  private validateImportGraph(input: ImportSignupSnapshotRequest): void {
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) throw new ApiError("IMPORT_CONFLICT", `${label} contains duplicates.`, 409);
    };
    unique(input.states.map((row) => `${row.season_id}\n${row.practice_id}`), "signup states");
    unique(input.signups.map((row) => `${row.season_id}\n${row.practice_id}\n${row.member_id}`), "signups");
    const states = new Map(input.states.map((row) => [`${row.season_id}\n${row.practice_id}`, row]));
    const practices = new Map(this.ctx.storage.sql.exec<SqlRow>(
      `SELECT p.*, pv.signup_version, pv.signup_sequence FROM practices p
       JOIN practice_versions pv ON pv.season_id=p.season_id AND pv.practice_id=p.practice_id`
    ).toArray().map((row) => [`${row.season_id}\n${row.practice_id}`, row]));
    const members = new Map(this.ctx.storage.sql.exec<SqlRow>("SELECT * FROM members").toArray()
      .map((row) => [`${row.season_id}\n${row.member_id}`, row]));
    const existing = new Map(this.ctx.storage.sql.exec<SqlRow>("SELECT * FROM signups").toArray()
      .map((row) => [`${row.season_id}\n${row.practice_id}\n${row.member_id}`, row]));
    for (const state of input.states) {
      const key = `${state.season_id}\n${state.practice_id}`;
      const practice = practices.get(key);
      if (!practice) throw new ApiError("IMPORT_REFERENCE_MISSING", "A signup state has an unknown training.", 409);
      if (state.signup_version < Number(practice.signup_version) || state.signup_sequence < Number(practice.signup_sequence)) {
        throw new ApiError("IMPORT_VERSION_REGRESSION", "The snapshot contains an older signup state.", 409);
      }
      if (state.signup_version === Number(practice.signup_version) &&
          state.signup_sequence !== Number(practice.signup_sequence)) {
        throw new ApiError("IMPORT_CONFLICT", "The same signup version contains a different queue sequence.", 409);
      }
    }
    for (const row of input.signups) {
      const stateKey = `${row.season_id}\n${row.practice_id}`;
      const state = states.get(stateKey);
      if (!state) throw new ApiError("IMPORT_REFERENCE_MISSING", "A signup has no state in this snapshot.", 409);
      const member = members.get(`${row.season_id}\n${row.member_id}`);
      if (!member) throw new ApiError("IMPORT_REFERENCE_MISSING", "A signup has an unknown member.", 409);
      if (row.status !== "CANCELLED" && member.status !== "ACTIVE") {
        throw new ApiError("IMPORT_CONFLICT", "An active signup belongs to an inactive member.", 409);
      }
      if (row.queue_sequence > state.signup_sequence) {
        throw new ApiError("IMPORT_CONFLICT", "A signup queue sequence exceeds its state.", 409);
      }
      if (Date.parse(row.updated_at) < Date.parse(row.queue_at)) {
        throw new ApiError("IMPORT_CONFLICT", "A signup was updated before it entered the queue.", 409);
      }
      const currentState = practices.get(stateKey)!;
      const current = existing.get(`${stateKey}\n${row.member_id}`);
      if (state.signup_version === Number(currentState.signup_version) &&
          (!current || canonicalJson(signupComparable(current)) !== canonicalJson(row))) {
        throw new ApiError("IMPORT_CONFLICT", "The same signup version contains different data.", 409);
      }
    }
    for (const state of input.states) {
      const stateKey = `${state.season_id}\n${state.practice_id}`;
      const practice = practices.get(stateKey)!;
      const merged = new Map<string, Record<string, unknown>>();
      for (const [key, row] of existing) if (key.startsWith(`${stateKey}\n`)) merged.set(String(row.member_id), row);
      for (const row of input.signups) {
        if (`${row.season_id}\n${row.practice_id}` === stateKey) merged.set(row.member_id, signupComparable(row));
      }
      const rows = [...merged.values()];
      const sequences = rows.map((row) => Number(row.queue_sequence));
      if (new Set(sequences).size !== sequences.length || sequences.some((sequence) => sequence > state.signup_sequence)) {
        throw new ApiError("IMPORT_CONFLICT", "A signup snapshot contains invalid queue sequences.", 409);
      }
      const counts = signupCounts(rows, practice);
      if (counts.confirmed > counts.total_capacity || counts.left > counts.left_capacity || counts.right > counts.right_capacity) {
        throw new ApiError("IMPORT_CONFLICT", "A signup snapshot exceeds training capacity.", 409);
      }
      for (const row of rows.filter((candidate) => candidate.status === "WAITLISTED").sort(queueOrder)) {
        if (canConfirm(row.preference, counts)) {
          throw new ApiError("IMPORT_CONFLICT", "A signup snapshot leaves an eligible member on the waitlist.", 409);
        }
      }
    }
  }

  private upsertSignup(row: SignupSnapshot): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO signups(season_id, practice_id, member_id, preference, status, queue_at,
         queue_sequence, updated_at, last_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id, practice_id, member_id) DO UPDATE SET preference=excluded.preference,
         status=excluded.status, queue_at=excluded.queue_at, queue_sequence=excluded.queue_sequence,
         updated_at=excluded.updated_at, last_request_id=excluded.last_request_id`,
      row.season_id, row.practice_id, row.member_id, row.preference, row.status, row.queue_at,
      row.queue_sequence, row.updated_at, row.last_request_id).toArray();
  }

  private updateSignupState(row: SignupStateSnapshot): void {
    this.ctx.storage.sql.exec(
      "UPDATE practice_versions SET signup_version=?, signup_sequence=? WHERE season_id=? AND practice_id=?",
      row.signup_version, row.signup_sequence, row.season_id, row.practice_id).toArray();
  }

  private async importSignups(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseImportSignupSnapshot(raw));
    const { request_id: _requestId, ...snapshot } = input;
    const identity = await this.core.createRequestIdentity("C1:MIGRATION", "importSignupSnapshot", input.request_id, snapshot);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    this.validateImportGraph(input);
    const prior = firstRow<{ payload_digest: string }>(this.ctx.storage.sql,
      "SELECT payload_digest FROM signup_migration_snapshots WHERE source_snapshot_id=?", input.source_snapshot_id);
    if (prior && prior.payload_digest !== identity.payloadDigest) {
      throw new ApiError("IMPORT_SNAPSHOT_CONFLICT", "This signup snapshot identifier has different content.", 409);
    }
    const at = new Date().toISOString();
    const response = { operation: operationReceipt("importSignupSnapshot", input.request_id, at), result: {
      source_snapshot_id: input.source_snapshot_id, states: input.states.length, signups: input.signups.length
    } };
    this.ctx.storage.transactionSync(() => {
      input.signups.forEach((row) => this.upsertSignup(row));
      input.states.forEach((row) => this.updateSignupState(row));
      this.core.recordRequest(identity, "C1:MIGRATION", "importSignupSnapshot", input.request_id, response,
        { source_snapshot_id: input.source_snapshot_id, counts: response.result }, at);
      this.ctx.storage.sql.exec(
        `INSERT INTO signup_migration_snapshots(source_snapshot_id, payload_digest, imported_at, request_key)
         VALUES (?, ?, ?, ?) ON CONFLICT(source_snapshot_id) DO NOTHING`,
        input.source_snapshot_id, identity.payloadDigest, at, identity.requestKey).toArray();
    });
    return response;
  }
}
