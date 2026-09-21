import {
  parseCoachLogin, parseCreateSeason, parseImportCoreSnapshot,
  parseSessionRequest, parseUpdateMember, type CoachSnapshot, type ImportCoreSnapshotRequest,
  type MemberSnapshot, type SeasonSnapshot
} from "../../shared/c1-contract";
import { canonicalJson, seasonEndsAt, validateSeasonSnapshot } from "../../shared/c1-rules";
import { ApiError } from "./http";
import {
  base64UrlText, constantTimeEqual, decodeBase64UrlText, hmacSha256Base64Url,
  legacyCredentialDigest, sha256Base64Url
} from "./crypto";
import { firstRow, isRecord, operationReceipt, parseContract, type SqlRow } from "./c1-support";

export interface AuthenticatedCoach {
  coach_id: string;
  display_name: string;
  credential_version: number;
  session_id: string;
}

export interface C1RequestIdentity {
  requestKey: string;
  payloadDigest: string;
  eventId: string;
}

interface SessionTokenPayload {
  sid: string;
  cid: string;
  cv: number;
  iat: string;
  exp: string;
  bg: string;
  we: number;
}

function invalidSession(): ApiError {
  return new ApiError("SESSION_INVALID", "The Coach session is invalid.", 401);
}

function parseSessionTokenPayload(value: unknown): SessionTokenPayload {
  if (!isRecord(value) || typeof value.sid !== "string" || !value.sid ||
      typeof value.cid !== "string" || !value.cid ||
      typeof value.cv !== "number" || !Number.isSafeInteger(value.cv) || value.cv < 1 ||
      typeof value.iat !== "string" || !Number.isFinite(Date.parse(value.iat)) ||
      typeof value.exp !== "string" || !Number.isFinite(Date.parse(value.exp)) ||
      typeof value.bg !== "string" || !value.bg ||
      typeof value.we !== "number" || !Number.isSafeInteger(value.we) || value.we < 0) {
    throw invalidSession();
  }
  return value as unknown as SessionTokenPayload;
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value || value.length < 16) throw new ApiError("CONFIGURATION_ERROR", `${name} is not configured.`, 500, true);
  return value;
}

function memberProjection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    member_id: String(row.member_id),
    display_name: String(row.display_name_override || row.source_display_name),
    source_display_name: String(row.source_display_name),
    display_name_override: String(row.display_name_override || ""),
    status: String(row.status),
    default_preference: String(row.default_preference),
    member_version: Number(row.member_version)
  };
}

function seasonProjection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    season_id: String(row.season_id), name: String(row.name), start_date: String(row.start_date),
    end_date: String(row.end_date), timezone: String(row.timezone), season_ends_at: String(row.season_ends_at),
    status: String(row.status), binding_version: Number(row.binding_version),
    season_version: Number(row.season_version), roster_version: Number(row.roster_version)
  };
}

export class C1Service {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async handle(path: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (path) {
      case "/internal/c1/import-core": return this.importCore(raw);
      case "/internal/c1/coach-login": return this.login(raw);
      case "/internal/c1/coach-logout": return this.logout(raw);
      case "/internal/c1/coach-bootstrap": return this.bootstrap(raw);
      case "/internal/c1/create-season": return this.createSeason(raw);
      case "/internal/c1/update-member": return this.updateMember(raw);
      default: throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    }
  }

  publicRoster(seasonId: string): Record<string, unknown> {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(seasonId)) throw new ApiError("INVALID_REQUEST", "season_id is invalid.");
    const sql = this.ctx.storage.sql;
    const season = firstRow<SqlRow>(sql, "SELECT * FROM seasons WHERE season_id = ?", seasonId);
    if (!season || !["OPEN", "COMPLETED"].includes(String(season.status))) {
      throw new ApiError("SEASON_NOT_PUBLIC", "The season is not publicly available.", 404);
    }
    const members = sql.exec<SqlRow>(
      `SELECT member_id, source_display_name, display_name_override, default_preference, member_version, status
         FROM members WHERE season_id = ? AND status = 'ACTIVE'
         ORDER BY lower(CASE WHEN display_name_override = '' THEN source_display_name ELSE display_name_override END), member_id`,
      seasonId
    ).toArray().map((row) => {
      const projected = memberProjection(row);
      delete projected.source_display_name;
      delete projected.display_name_override;
      delete projected.status;
      return projected;
    });
    return { season: seasonProjection(season), members, generated_at: new Date().toISOString() };
  }

  async createRequestIdentity(actorScope: string, action: string, requestId: string,
    payload: unknown): Promise<C1RequestIdentity> {
    const requestKey = `req_v2_${await sha256Base64Url(`${this.env.TEAM_ID}\n${actorScope}\n${action}\n${requestId}`)}`;
    const payloadDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(payload))}`;
    return { requestKey, payloadDigest, eventId: `event_${await sha256Base64Url(`${requestKey}\nsucceeded`)}` };
  }

  replayRequest(requestKey: string, payloadDigest: string): Record<string, unknown> | null {
    const existing = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT payload_digest, result_json FROM system_requests WHERE request_key = ?", requestKey);
    if (!existing) return null;
    if (String(existing.payload_digest) !== payloadDigest) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "This request identifier was already used with different input.", 409);
    }
    return JSON.parse(String(existing.result_json)) as Record<string, unknown>;
  }

  recordRequest(identity: C1RequestIdentity, actorScope: string,
    action: string, requestId: string, result: Record<string, unknown>, details: Record<string, unknown>, at: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO system_requests(request_key, actor_scope, action, request_id, payload_digest, status,
         result_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)`,
      identity.requestKey, actorScope, action, requestId, identity.payloadDigest, JSON.stringify(result), at, at
    ).toArray();
    sql.exec(
      `INSERT INTO audit_events(event_id, request_key, actor_scope, action, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`, identity.eventId, identity.requestKey, actorScope, action, JSON.stringify(details), at
    ).toArray();
  }

  enqueueChange(identity: Pick<C1RequestIdentity, "requestKey">, topic: string, action: string,
    entity: Record<string, unknown>, at: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id, request_key, topic, payload_json, status, due_at_ms, created_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
      `out_${identity.requestKey.slice(7)}`, identity.requestKey, topic,
      JSON.stringify({ action, entity }), Date.parse(at) + 600_000, at
    ).toArray();
  }

  private validateImportGraph(input: ImportCoreSnapshotRequest): void {
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) throw new ApiError("IMPORT_CONFLICT", `${label} contains duplicate identifiers.`, 409);
    };
    unique(input.coaches.map((row) => row.coach_id), "coaches");
    unique(input.seasons.map((row) => row.season_id), "seasons");
    unique(input.members.map((row) => `${row.season_id}\n${row.member_id}`), "members");
    unique(input.members.map((row) => `${row.season_id}\n${row.source_key}`), "member source keys");
    input.seasons.forEach((season) => parseContract(() => validateSeasonSnapshot(season)));
    const seasonIds = new Set(input.seasons.map((row) => row.season_id));
    const coachIds = new Set(input.coaches.map((row) => row.coach_id));
    for (const season of input.seasons) if (!coachIds.has(season.created_by)) {
      throw new ApiError("IMPORT_REFERENCE_MISSING", `Season ${season.season_id} has an unknown creator.`, 409);
    }
    for (const member of input.members) if (!seasonIds.has(member.season_id)) {
      throw new ApiError("IMPORT_REFERENCE_MISSING", `Member ${member.member_id} has an unknown season.`, 409);
    }
    if (input.default_season_id) {
      const season = input.seasons.find((row) => row.season_id === input.default_season_id);
      if (!season || season.status !== "OPEN") throw new ApiError("IMPORT_REFERENCE_MISSING", "The default season must be OPEN in this snapshot.", 409);
    }
  }

  private assertImportVersion(table: "coaches" | "seasons" | "members", keys: SqlStorageValue[], versionColumn: string,
    incomingVersion: number, comparable: unknown): void {
    const keyWhere = table === "members" ? "season_id = ? AND member_id = ?" :
      table === "coaches" ? "coach_id = ?" : "season_id = ?";
    const current = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT *, ${versionColumn} AS imported_version FROM ${table} WHERE ${keyWhere}`, ...keys);
    if (!current) return;
    const currentVersion = Number(current.imported_version);
    if (incomingVersion < currentVersion) throw new ApiError("IMPORT_VERSION_REGRESSION", "The snapshot contains an older entity version.", 409);
    if (incomingVersion === currentVersion && canonicalJson(comparable) !== canonicalJson(this.importComparable(table, current))) {
      throw new ApiError("IMPORT_CONFLICT", "The same entity version contains different data.", 409);
    }
  }

  private importComparable(table: "coaches" | "seasons" | "members", row: Record<string, unknown>): unknown {
    if (table === "coaches") return {
      coach_id: row.coach_id, display_name: row.display_name, code_salt: row.code_salt, code_digest: row.code_digest,
      credential_version: Number(row.credential_version), active: Number(row.active) === 1,
      created_at: row.created_at, updated_at: row.updated_at
    };
    if (table === "seasons") return {
      season_id: row.season_id, name: row.name, start_date: row.start_date, end_date: row.end_date,
      timezone: row.timezone, season_ends_at: row.season_ends_at, status: row.status,
      binding_version: Number(row.binding_version), season_version: Number(row.season_version),
      roster_version: Number(row.roster_version), created_by: row.created_by,
      created_at: row.created_at, updated_at: row.updated_at
    };
    return {
      season_id: row.season_id, member_id: row.member_id, source_key: row.source_key,
      source_display_name: row.source_display_name, display_name_override: row.display_name_override,
      status: row.status, default_preference: row.default_preference, member_version: Number(row.member_version),
      created_at: row.created_at, updated_at: row.updated_at
    };
  }

  private async importCore(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseImportCoreSnapshot(raw));
    const { request_id: _requestId, ...snapshotPayload } = input;
    const identity = await this.createRequestIdentity("C1:MIGRATION", "importCoreSnapshot", input.request_id, snapshotPayload);
    const replay = this.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    this.validateImportGraph(input);
    const priorSnapshot = firstRow<{ payload_digest: string }>(this.ctx.storage.sql,
      "SELECT payload_digest FROM migration_snapshots WHERE source_snapshot_id = ?", input.source_snapshot_id);
    if (priorSnapshot && priorSnapshot.payload_digest !== identity.payloadDigest) {
      throw new ApiError("IMPORT_SNAPSHOT_CONFLICT", "This source snapshot identifier was already imported with different content.", 409);
    }
    const importedAt = new Date().toISOString();
    const result = {
      operation: operationReceipt("importCoreSnapshot", input.request_id, importedAt),
      result: { source_snapshot_id: input.source_snapshot_id, coaches: input.coaches.length,
        seasons: input.seasons.length, members: input.members.length, settings_version: input.settings_version }
    };
    this.ctx.storage.transactionSync(() => {
      input.coaches.forEach((row) => this.upsertCoach(row));
      input.seasons.forEach((row) => this.upsertSeason(row));
      input.members.forEach((row) => this.upsertMember(row));
      const currentSetting = firstRow<{ settings_version: number; value_json: string }>(this.ctx.storage.sql,
        "SELECT settings_version, value_json FROM settings WHERE setting_key = 'default_season_id'");
      if (currentSetting && input.settings_version < Number(currentSetting.settings_version)) {
        throw new ApiError("IMPORT_VERSION_REGRESSION", "The snapshot contains an older settings version.", 409);
      }
      if (currentSetting && input.settings_version === Number(currentSetting.settings_version) &&
          currentSetting.value_json !== JSON.stringify(input.default_season_id)) {
        throw new ApiError("IMPORT_CONFLICT", "The same settings version contains a different default season.", 409);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO settings(setting_key, value_json, settings_version, updated_at) VALUES ('default_season_id', ?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,
           settings_version=excluded.settings_version, updated_at=excluded.updated_at`,
        JSON.stringify(input.default_season_id), input.settings_version, importedAt
      ).toArray();
      this.recordRequest(identity, "C1:MIGRATION", "importCoreSnapshot", input.request_id, result,
        { source_snapshot_id: input.source_snapshot_id, counts: result.result }, importedAt);
      this.ctx.storage.sql.exec(
        `INSERT INTO migration_snapshots(source_snapshot_id, payload_digest, imported_at, request_key)
         VALUES (?, ?, ?, ?) ON CONFLICT(source_snapshot_id) DO NOTHING`,
        input.source_snapshot_id, identity.payloadDigest, importedAt, identity.requestKey
      ).toArray();
    });
    return result;
  }

  private upsertCoach(row: CoachSnapshot): void {
    this.assertImportVersion("coaches", [row.coach_id], "credential_version", row.credential_version, row);
    this.ctx.storage.sql.exec(
      `INSERT INTO coaches VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(coach_id) DO UPDATE SET display_name=excluded.display_name, code_salt=excluded.code_salt,
         code_digest=excluded.code_digest, credential_version=excluded.credential_version,
         active=excluded.active, created_at=excluded.created_at, updated_at=excluded.updated_at`,
      row.coach_id, row.display_name, row.code_salt, row.code_digest, row.credential_version,
      row.active ? 1 : 0, row.created_at, row.updated_at
    ).toArray();
  }

  private upsertSeason(row: SeasonSnapshot): void {
    this.assertImportVersion("seasons", [row.season_id], "season_version", row.season_version, row);
    this.ctx.storage.sql.exec(
      `INSERT INTO seasons VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id) DO UPDATE SET name=excluded.name, start_date=excluded.start_date,
         end_date=excluded.end_date, timezone=excluded.timezone, season_ends_at=excluded.season_ends_at,
         status=excluded.status, binding_version=excluded.binding_version, season_version=excluded.season_version,
         roster_version=excluded.roster_version, created_by=excluded.created_by,
         created_at=excluded.created_at, updated_at=excluded.updated_at`,
      row.season_id, row.name, row.start_date, row.end_date, row.timezone, row.season_ends_at, row.status,
      row.binding_version, row.season_version, row.roster_version, row.created_by, row.created_at, row.updated_at
    ).toArray();
  }

  private upsertMember(row: MemberSnapshot): void {
    this.assertImportVersion("members", [row.season_id, row.member_id], "member_version", row.member_version, row);
    const currentMember = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT source_key FROM members WHERE season_id = ? AND member_id = ?", row.season_id, row.member_id);
    if (currentMember && String(currentMember.source_key) !== row.source_key) {
      throw new ApiError("IMPORT_CONFLICT", "A member source key cannot be reassigned.", 409);
    }
    const sourceOwner = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT member_id FROM members WHERE season_id = ? AND source_key = ?", row.season_id, row.source_key);
    if (sourceOwner && String(sourceOwner.member_id) !== row.member_id) {
      throw new ApiError("IMPORT_CONFLICT", "A member source key already belongs to another member.", 409);
    }
    if (row.status === "INACTIVE") {
      const activeLink = firstRow<{ count: number }>(this.ctx.storage.sql,
        `SELECT COUNT(*) AS count FROM signups sg
         JOIN practices p ON p.season_id=sg.season_id AND p.practice_id=sg.practice_id
         WHERE sg.season_id=? AND sg.member_id=? AND sg.status<>'CANCELLED'
           AND p.cancelled_at IS NULL AND p.end_at>?`, row.season_id, row.member_id, new Date().toISOString());
      if (Number(activeLink?.count ?? 0) > 0) {
        throw new ApiError("IMPORT_CONFLICT", "An inactive member still has active training links.", 409);
      }
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id, member_id) DO UPDATE SET source_key=excluded.source_key,
         source_display_name=excluded.source_display_name, display_name_override=excluded.display_name_override,
         status=excluded.status, default_preference=excluded.default_preference,
         member_version=excluded.member_version, created_at=excluded.created_at, updated_at=excluded.updated_at`,
      row.season_id, row.member_id, row.source_key, row.source_display_name, row.display_name_override,
      row.status, row.default_preference, row.member_version, row.created_at, row.updated_at
    ).toArray();
  }

  private async login(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseCoachLogin(raw));
    const secret = requiredSecret(this.env.COACH_CODE_SECRET, "COACH_CODE_SECRET");
    const coaches = this.ctx.storage.sql.exec<SqlRow>("SELECT * FROM coaches WHERE active = 1 ORDER BY coach_id").toArray();
    let coach: SqlRow | null = null;
    let matches = 0;
    for (const candidate of coaches) {
      const digest = await legacyCredentialDigest(String(candidate.code_salt), input.coach_code, secret);
      if (constantTimeEqual(digest, String(candidate.code_digest))) { coach = candidate; matches += 1; }
    }
    if (!coach || matches !== 1) throw new ApiError("COACH_CODE_INVALID", "The Coach Code is not valid.", 401);
    const actor = String(coach.coach_id);
    const credentialDigest = await legacyCredentialDigest(String(coach.code_salt), input.coach_code, secret);
    const identity = await this.createRequestIdentity(actor, "coachLogin", input.request_id, { coach_code_digest: credentialDigest });
    const replay = this.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.loginResponse(replay);
    const now = new Date();
    const ttl = Number(this.env.COACH_SESSION_TTL_SECONDS || 28_800);
    if (!Number.isInteger(ttl) || ttl < 900 || ttl > 86_400) {
      throw new ApiError("CONFIGURATION_ERROR", "COACH_SESSION_TTL_SECONDS is invalid.", 500, true);
    }
    const metadata = {
      operation: operationReceipt("coachLogin", input.request_id, now.toISOString()),
      result: {
        session_id: `session_${identity.requestKey.slice(-32)}`, coach_id: actor,
        display_name: String(coach.display_name), credential_version: Number(coach.credential_version),
        issued_at: now.toISOString(), expires_at: new Date(now.getTime() + ttl * 1000).toISOString()
      }
    };
    this.ctx.storage.transactionSync(() => {
      const currentCoach = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM coaches WHERE coach_id = ?", actor);
      if (!currentCoach || Number(currentCoach.active) !== 1 ||
          Number(currentCoach.credential_version) !== Number(coach.credential_version) ||
          String(currentCoach.code_digest) !== String(coach.code_digest)) {
        throw new ApiError("SESSION_REVOKED", "The Coach credential changed during login.", 401);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO coach_sessions(session_id, coach_id, credential_version, issued_at, expires_at,
           revoked_at, backend_generation, writer_epoch) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        metadata.result.session_id, actor, metadata.result.credential_version, metadata.result.issued_at,
        metadata.result.expires_at, this.env.BACKEND_GENERATION, Number(this.env.WRITER_EPOCH)
      ).toArray();
      this.recordRequest(identity, actor, "coachLogin", input.request_id, metadata,
        { session_id: metadata.result.session_id, expires_at: metadata.result.expires_at }, now.toISOString());
    });
    return this.loginResponse(metadata);
  }

  private async loginResponse(metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isRecord(metadata.result)) throw new Error("Stored login result is invalid.");
    const result = metadata.result;
    const row = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM coach_sessions WHERE session_id = ?", String(result.session_id));
    const coach = row && firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM coaches WHERE coach_id = ?", row.coach_id);
    if (!row || !coach || Number(coach.active) !== 1 || Number(coach.credential_version) !== Number(row.credential_version) ||
        row.backend_generation !== this.env.BACKEND_GENERATION || Number(row.writer_epoch) !== Number(this.env.WRITER_EPOCH)) {
      throw new ApiError("SESSION_REVOKED", "The Coach session is no longer active.", 401);
    }
    if (row.revoked_at) throw new ApiError("SESSION_REVOKED", "The Coach session was revoked.", 401);
    if (Date.parse(String(row.expires_at)) <= Date.now()) throw new ApiError("SESSION_EXPIRED", "The Coach session expired.", 401);
    const token = await this.signSession(row);
    this.assertSessionCurrent({ coach_id: String(coach.coach_id), display_name: String(coach.display_name),
      credential_version: Number(coach.credential_version), session_id: String(row.session_id) });
    return {
      ...metadata,
      result: { session_token: token, coach_id: result.coach_id,
        display_name: result.display_name, issued_at: result.issued_at, expires_at: result.expires_at }
    };
  }

  private async signSession(row: Record<string, unknown>): Promise<string> {
    const payload = base64UrlText(JSON.stringify({
      sid: row.session_id, cid: row.coach_id, cv: Number(row.credential_version),
      iat: row.issued_at, exp: row.expires_at, bg: row.backend_generation, we: Number(row.writer_epoch)
    }));
    return `${payload}.${await hmacSha256Base64Url(payload, requiredSecret(this.env.SESSION_SECRET, "SESSION_SECRET"))}`;
  }

  async authenticateSession(token: string, allowRevoked = false): Promise<AuthenticatedCoach> {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidSession();
    const expected = await hmacSha256Base64Url(parts[0], requiredSecret(this.env.SESSION_SECRET, "SESSION_SECRET"));
    if (!constantTimeEqual(expected, parts[1])) throw invalidSession();
    let payload: SessionTokenPayload;
    try { payload = parseSessionTokenPayload(JSON.parse(decodeBase64UrlText(parts[0]))); }
    catch { throw invalidSession(); }
    if (payload.bg !== this.env.BACKEND_GENERATION || payload.we !== Number(this.env.WRITER_EPOCH)) {
      throw new ApiError("SESSION_INVALID", "The Coach session belongs to another backend generation.", 401);
    }
    const session = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM coach_sessions WHERE session_id = ?", payload.sid);
    const coach = session && firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM coaches WHERE coach_id = ?", session.coach_id);
    if (!session || !coach || Number(coach.active) !== 1 || String(session.coach_id) !== payload.cid ||
        Number(session.credential_version) !== payload.cv || Number(coach.credential_version) !== payload.cv ||
        String(session.issued_at) !== payload.iat || String(session.expires_at) !== payload.exp) {
      throw invalidSession();
    }
    if (session.revoked_at && !allowRevoked) throw new ApiError("SESSION_REVOKED", "The Coach session was revoked.", 401);
    if (Date.parse(String(session.expires_at)) <= Date.now()) throw new ApiError("SESSION_EXPIRED", "The Coach session expired.", 401);
    return { coach_id: String(coach.coach_id), display_name: String(coach.display_name),
      credential_version: Number(coach.credential_version), session_id: String(session.session_id) };
  }

  assertSessionCurrent(auth: AuthenticatedCoach): void {
    const session = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM coach_sessions WHERE session_id = ?", auth.session_id);
    const coach = session && firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM coaches WHERE coach_id = ?", auth.coach_id);
    if (!session || !coach || String(session.coach_id) !== auth.coach_id ||
        session.revoked_at || Number(coach.active) !== 1 ||
        Number(session.credential_version) !== auth.credential_version ||
        Number(coach.credential_version) !== auth.credential_version ||
        String(session.backend_generation) !== this.env.BACKEND_GENERATION ||
        Number(session.writer_epoch) !== Number(this.env.WRITER_EPOCH)) {
      throw new ApiError("SESSION_REVOKED", "The Coach session is no longer active.", 401);
    }
    if (Date.parse(String(session.expires_at)) <= Date.now()) {
      throw new ApiError("SESSION_EXPIRED", "The Coach session expired.", 401);
    }
  }

  private async logout(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseSessionRequest(raw));
    const auth = await this.authenticateSession(input.session_token, true);
    const identity = await this.createRequestIdentity(auth.coach_id, "coachLogout", input.request_id, { session_id: auth.session_id });
    const replay = this.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const at = new Date().toISOString();
    const result = { operation: operationReceipt("coachLogout", input.request_id, at), result: { logged_out: true } };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE coach_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE session_id = ?", at, auth.session_id).toArray();
      this.recordRequest(identity, auth.coach_id, "coachLogout", input.request_id, result,
        { session_id: auth.session_id }, at);
    });
    return result;
  }

  private async bootstrap(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseSessionRequest(raw));
    const auth = await this.authenticateSession(input.session_token);
    const sql = this.ctx.storage.sql;
    const setting = firstRow<{ value_json: string; settings_version: number }>(sql,
      "SELECT value_json, settings_version FROM settings WHERE setting_key = 'default_season_id'");
    return {
      coach: { coach_id: auth.coach_id, display_name: auth.display_name },
      default_season_id: setting ? JSON.parse(setting.value_json) : null,
      settings_version: Number(setting?.settings_version ?? 0),
      seasons: sql.exec<SqlRow>("SELECT * FROM seasons ORDER BY start_date DESC, season_id").toArray().map(seasonProjection),
      generated_at: new Date().toISOString()
    };
  }

  private async createSeason(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseCreateSeason(raw));
    const auth = await this.authenticateSession(input.session_token);
    const payload = { name: input.name, start_date: input.start_date, end_date: input.end_date, timezone: input.timezone };
    const identity = await this.createRequestIdentity(auth.coach_id, "createSeason", input.request_id, payload);
    const replay = this.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    if (input.start_date > input.end_date) throw new ApiError("INVALID_REQUEST", "A season cannot end before it starts.");
    const boundary = parseContract(() => seasonEndsAt(input.end_date, input.timezone));
    const at = new Date().toISOString();
    const season = {
      season_id: `season_${identity.requestKey.slice(-32)}`, ...payload, season_ends_at: boundary,
      status: "DRAFT", binding_version: 0, season_version: 1, roster_version: 0,
      created_at: at, updated_at: at
    };
    const result = { operation: operationReceipt("createSeason", input.request_id, at), result: { season } };
    this.ctx.storage.transactionSync(() => {
      this.assertSessionCurrent(auth);
      this.ctx.storage.sql.exec(
        `INSERT INTO seasons VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 0, 1, 0, ?, ?, ?)`,
        season.season_id, season.name, season.start_date, season.end_date, season.timezone,
        season.season_ends_at, auth.coach_id, at, at
      ).toArray();
      this.recordRequest(identity, auth.coach_id, "createSeason", input.request_id, result,
        { season_id: season.season_id }, at);
      this.enqueueChange(identity, "CORE_CHANGED", "createSeason", { season_id: season.season_id }, at);
    });
    return result;
  }

  private async updateMember(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseUpdateMember(raw));
    const auth = await this.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, member_id: input.member_id, member_version: input.member_version,
      ...(input.display_name_override !== undefined ? { display_name_override: input.display_name_override } : {}),
      ...(input.default_preference !== undefined ? { default_preference: input.default_preference } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}) };
    const identity = await this.createRequestIdentity(auth.coach_id, "updateMember", input.request_id, payload);
    const replay = this.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const at = new Date().toISOString();
    let result: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      this.assertSessionCurrent(auth);
      const season = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM seasons WHERE season_id = ?", input.season_id);
      const member = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT * FROM members WHERE season_id = ? AND member_id = ?", input.season_id, input.member_id);
      if (!season) throw new ApiError("SEASON_NOT_FOUND", "The season does not exist.", 404);
      if (season.status !== "OPEN") throw new ApiError("SEASON_NOT_OPEN", "The season is not open.", 409);
      if (!member) throw new ApiError("MEMBER_NOT_FOUND", "The member does not exist.", 404);
      if (Number(member.member_version) !== input.member_version) {
        throw new ApiError("VERSION_CONFLICT", "The member changed. Refresh and try again.", 409);
      }
      if (input.status === "INACTIVE") {
        const activeLink = firstRow<{ count: number }>(this.ctx.storage.sql,
          `SELECT COUNT(*) AS count FROM signups sg
           JOIN practices p ON p.season_id=sg.season_id AND p.practice_id=sg.practice_id
           WHERE sg.season_id=? AND sg.member_id=? AND sg.status<>'CANCELLED'
             AND p.cancelled_at IS NULL AND p.end_at>?`, input.season_id, input.member_id, at);
        if (Number(activeLink?.count ?? 0) > 0) {
          throw new ApiError("MEMBER_HAS_ACTIVE_LINKS", "Cancel active signups before deactivating this member.", 409);
        }
      }
      const next = {
        ...member,
        display_name_override: input.display_name_override ?? member.display_name_override,
        default_preference: input.default_preference ?? member.default_preference,
        status: input.status ?? member.status,
        member_version: Number(member.member_version) + 1,
        updated_at: at
      };
      this.ctx.storage.sql.exec(
        `UPDATE members SET display_name_override=?, default_preference=?, status=?, member_version=?, updated_at=?
         WHERE season_id=? AND member_id=?`, next.display_name_override, next.default_preference, next.status,
        next.member_version, at, input.season_id, input.member_id
      ).toArray();
      const nextRoster = Number(season.roster_version) + 1;
      this.ctx.storage.sql.exec("UPDATE seasons SET roster_version=?, updated_at=? WHERE season_id=?",
        nextRoster, at, input.season_id).toArray();
      result = { operation: operationReceipt("updateMember", input.request_id, at),
        result: { season_id: input.season_id, roster_version: nextRoster, member: memberProjection(next) } };
      this.recordRequest(identity, auth.coach_id, "updateMember", input.request_id, result,
        { season_id: input.season_id, member_id: input.member_id, member_version: next.member_version }, at);
      this.enqueueChange(identity, "CORE_CHANGED", "updateMember",
        { season_id: input.season_id, member_id: input.member_id }, at);
    });
    return result;
  }
}
