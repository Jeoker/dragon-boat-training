import { identifier, object, requestId, string } from "../../shared/c1-contract";
import { SOURCE_LIMITS, sourceInstant, sourceKnownSources, sourcePinnedContext, type SourceObject } from "../../shared/c2-source-capture-contract";
import { readSourceAuthorityPin, sourceAuthorityText, type SourceAuthorityPin, type SourceAuthorityPinCore }
  from "../../shared/c2-source-authority-contract";
import { formResponseSourceId } from "../../shared/c2-sync-rules";
import { C1Service, type AuthenticatedCoach } from "./c1-service";
import { firstRow, parseContract, type SqlRow } from "./c1-support";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";

const MAX_PIN_BYTES = SOURCE_LIMITS.input_bytes;
function fail(code: string): never { throw new ApiError(code, "Source authority could not be confirmed.", 409); }
interface Command { request_id: string; session_token: string; season_id: string; }
interface Snapshot { source: SourceAuthorityPinCore["source"]; response_tab_title: string; known_sources: SourceObject[]; }

/** Authenticated internal server adapter. Only identifiers and authority metadata
 * are persisted here. No source raw content, OAuth token or Google call. */
export class C2SourceAuthority {
  private readonly core: C1Service;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env, private readonly clock = Date.now) {
    this.core = new C1Service(ctx, env);
  }
  protected async digest(text: string) { return sha256Base64Url(text); }
  private command(value: unknown): Command {
    return parseContract(() => {
      const row = object(JSON.parse(sourceAuthorityText(value)));
      if (Object.keys(row).length !== 3 || Object.keys(row).some(key => !["request_id", "session_token", "season_id"].includes(key)))
        fail("SOURCE_AUTHORITY_COMMAND_INVALID");
      return { request_id: requestId(row), session_token: string(row, "session_token", 1, 16_000), season_id: identifier(row, "season_id") };
    });
  }
  private at() {
    const now = this.clock();
    if (!Number.isSafeInteger(now)) fail("SOURCE_AUTHORITY_CLOCK_INVALID");
    return new Date(now).toISOString();
  }
  private snapshot(seasonId: string, operationId: string): Omit<Snapshot, "known_sources"> {
    const sql = this.ctx.storage.sql;
    const season = firstRow<SqlRow>(sql, "SELECT binding_version, season_ends_at, status FROM seasons WHERE season_id=?", seasonId);
    const binding = firstRow<SqlRow>(sql, `SELECT binding_version, form_id, runtime_spreadsheet_id,
      response_sheet_id, response_sheet_name FROM sync_bindings WHERE season_id=?`, seasonId);
    if (!season || !binding || season.binding_version !== binding.binding_version) fail("SOURCE_AUTHORITY_BINDING_UNPROVEN");
    if (!["COMPLETED", "ARCHIVED"].includes(String(season.status))) fail("SOURCE_AUTHORITY_NOT_DUE");
    const numericTab = String(binding.response_sheet_id);
    if (!/^(?:0|[1-9]\d*)$/u.test(numericTab) || !Number.isSafeInteger(Number(numericTab))) fail("SOURCE_AUTHORITY_BINDING_UNPROVEN");
    const source = sourcePinnedContext({ source_operation_id: operationId, team_id: this.env.TEAM_ID, season_id: seasonId,
      binding_version: season.binding_version, backend_generation: this.env.BACKEND_GENERATION, writer_epoch: Number(this.env.WRITER_EPOCH),
      form_id: binding.form_id, spreadsheet_id: binding.runtime_spreadsheet_id, sheet_id: Number(numericTab), season_ends_at: season.season_ends_at });
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(source.form_id) || !/^[A-Za-z0-9_-]{1,512}$/u.test(source.spreadsheet_id) ||
      typeof binding.response_sheet_name !== "string" || !binding.response_sheet_name.length || binding.response_sheet_name.length > 512)
      fail("SOURCE_AUTHORITY_BINDING_UNPROVEN");
    if (sourceInstant(this.at()) < sourceInstant(source.season_ends_at)) fail("SOURCE_AUTHORITY_NOT_DUE");
    return { source, response_tab_title: binding.response_sheet_name };
  }
  private census(snapshot: Omit<Snapshot, "known_sources">): SourceObject[] {
    const sql = this.ctx.storage.sql, sid = snapshot.source.season_id;
    // COUNT/bytes precede materialization; include all binding versions and
    // inactive members. No answer body, observation name or source display name.
    const sources = sql.exec<{ count: number; bytes: number }>(`SELECT COUNT(*) count, COALESCE(SUM(
      LENGTH(CAST(stable_source_id AS BLOB))+LENGTH(CAST(source_external_id AS BLOB))+
      COALESCE(LENGTH(CAST(member_id AS BLOB)),0)+LENGTH(CAST(status AS BLOB))),0) bytes
      FROM source_imports WHERE season_id=?`, sid).one();
    const members = sql.exec<{ count: number; bytes: number }>(`SELECT COUNT(*) count, COALESCE(SUM(LENGTH(CAST(member_id AS BLOB))),0) bytes
      FROM members WHERE season_id=?`, sid).one();
    const unmapped = sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM members m WHERE m.season_id=? AND NOT EXISTS
      (SELECT 1 FROM source_imports s WHERE s.season_id=m.season_id AND s.member_id=m.member_id AND s.status='IMPORTED')`, sid).one().count;
    if (![sources.count, sources.bytes, members.count, members.bytes, unmapped].every(value => Number.isSafeInteger(value) && value >= 0) ||
      sources.count + unmapped > SOURCE_LIMITS.records || members.count > SOURCE_LIMITS.records ||
      6 * (sources.bytes + members.bytes) + 256 * (sources.count + members.count) + 8192 > MAX_PIN_BYTES)
      fail("SOURCE_AUTHORITY_RESOURCE_EXCEEDED");
    const memberIds = new Set(sql.exec<{ member_id: string }>("SELECT member_id FROM members WHERE season_id=? ORDER BY member_id", sid)
      .toArray().map(row => row.member_id));
    const rows = sql.exec<SqlRow>(`/* source authority materialize census */ SELECT stable_source_id, binding_version,
      source_type, source_external_id, member_id, status FROM source_imports WHERE season_id=? ORDER BY stable_source_id`, sid).toArray();
    if (rows.length !== sources.count || memberIds.size !== members.count) fail("SOURCE_AUTHORITY_CENSUS_INVALID");
    const mapped = new Set<string>(), known: SourceObject[] = [];
    for (const row of rows) {
      const external = String(row.source_external_id), type = String(row.source_type), status = String(row.status);
      if (!Number.isSafeInteger(row.binding_version) || Number(row.binding_version) < 1 || Number(row.binding_version) > snapshot.source.binding_version ||
        !["FORM_RESPONSE", "LEGACY_ROW"].includes(type) || !["IMPORTED", "REVIEW_REQUIRED"].includes(status)) fail("SOURCE_AUTHORITY_CENSUS_INVALID");
      const expected = type === "FORM_RESPONSE" ? formResponseSourceId(sid, snapshot.source.form_id, external) : `LEGACY_ROW:${sid}:${external}`;
      if (row.stable_source_id !== expected) fail("SOURCE_AUTHORITY_CENSUS_INVALID");
      if (status === "IMPORTED") {
        if (typeof row.member_id !== "string" || !memberIds.has(row.member_id)) fail("SOURCE_AUTHORITY_CENSUS_INVALID");
        mapped.add(row.member_id);
      } else if (row.member_id !== null) fail("SOURCE_AUTHORITY_CENSUS_INVALID");
      known.push(type === "FORM_RESPONSE" ? { kind: "FORM_RESPONSE", form_id: snapshot.source.form_id, response_id: external, status } :
        { kind: "LEGACY_ROW", source_key: external, status });
    }
    for (const member_id of memberIds) if (!mapped.has(member_id)) known.push({ kind: "UNMAPPED_MEMBER", member_id });
    if (known.length !== sources.count + unmapped) fail("SOURCE_AUTHORITY_CENSUS_INVALID");
    known.sort((a, b) => {
      const left = sourceAuthorityText(a), right = sourceAuthorityText(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    sourceKnownSources(known, snapshot.source);
    return known;
  }
  private load(command: Command, coach: AuthenticatedCoach): { pin: SourceAuthorityPin; text: string } | null {
    const sql = this.ctx.storage.sql;
    const sameRequest = firstRow<SqlRow>(sql, "SELECT season_id FROM source_authority_pins WHERE actor_id=? AND request_id=?",
      coach.coach_id, command.request_id);
    if (sameRequest && sameRequest.season_id !== command.season_id) fail("SOURCE_AUTHORITY_IDEMPOTENCY_CONFLICT");
    const size = firstRow<SqlRow>(sql, `SELECT LENGTH(CAST(pin_text AS BLOB)) bytes FROM source_authority_pins WHERE season_id=?`, command.season_id);
    if (!size) return null;
    if (!Number.isSafeInteger(size.bytes) || Number(size.bytes) > MAX_PIN_BYTES) fail("SOURCE_AUTHORITY_RESOURCE_EXCEEDED");
    const row = firstRow<SqlRow>(sql, "SELECT * FROM source_authority_pins WHERE season_id=?", command.season_id)!;
    if (row.actor_id !== coach.coach_id || row.request_id !== command.request_id) fail("SOURCE_AUTHORITY_SCOPE_ALREADY_PINNED");
    const text = String(row.pin_text), pin = readSourceAuthorityPin(JSON.parse(text));
    if (text !== sourceAuthorityText(pin) || row.source_operation_id !== pin.source.source_operation_id || row.actor_id !== pin.actor_id ||
      row.season_id !== pin.source.season_id || row.authority_digest !== pin.authority_digest || row.pinned_at !== pin.pinned_at)
      fail("SOURCE_AUTHORITY_PIN_CHANGED");
    return { pin, text };
  }
  async pin(value: unknown): Promise<SourceAuthorityPin> {
    try {
      const command = this.command(value), coach = await this.core.authenticateSession(command.session_token);
      const operationId = `c2_source_${await this.digest("c2-source-authority-operation-v1\n" + sourceAuthorityText([
        this.env.TEAM_ID, coach.coach_id, command.request_id]))}`;
      const prior = this.ctx.storage.transactionSync(() => {
        this.core.assertSessionCurrent(coach);
        return this.load(command, coach);
      });
      if (prior) {
        const { authority_digest, ...core } = prior.pin;
        if (await this.digest("c2-source-authority-pin-v1\n" + sourceAuthorityText(core)) !== authority_digest ||
          prior.pin.source.source_operation_id !== operationId) fail("SOURCE_AUTHORITY_PIN_CHANGED");
        return this.ctx.storage.transactionSync(() => {
          this.core.assertSessionCurrent(coach);
          if (this.load(command, coach)?.text !== prior.text || sourceAuthorityText(this.snapshot(command.season_id, operationId)) !==
            sourceAuthorityText({ source: prior.pin.source, response_tab_title: prior.pin.response_tab_title })) fail("SOURCE_AUTHORITY_OWNERSHIP_CHANGED");
          // Original census stays fixed; never recapture it on replay.
          return prior.pin;
        });
      }
      const snapshot = this.ctx.storage.transactionSync(() => {
        this.core.assertSessionCurrent(coach);
        const scope = this.snapshot(command.season_id, operationId);
        return { ...scope, known_sources: this.census(scope) };
      });
      const core: SourceAuthorityPinCore = { format: "c2-source-authority-pin-v1", state: "SERVER_AUTHORITY_PIN_ONLY",
        actor_id: coach.coach_id, ...snapshot, census_scope: "DATABASE_KNOWN_IDENTITIES_ONLY", pinned_at: this.at(),
        source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
      const pin = readSourceAuthorityPin({ ...core, authority_digest: await this.digest("c2-source-authority-pin-v1\n" + sourceAuthorityText(core)) });
      const committed = this.ctx.storage.transactionSync(() => {
        this.core.assertSessionCurrent(coach);
        if (sourceAuthorityText(this.snapshot(command.season_id, operationId)) !== sourceAuthorityText({ source: snapshot.source,
          response_tab_title: snapshot.response_tab_title })) fail("SOURCE_AUTHORITY_OWNERSHIP_CHANGED");
        const winner = this.load(command, coach);
        if (winner) return null; // Verify/replay the exact winner, including its original pin time.
        if (sourceAuthorityText(this.census(snapshot)) !== sourceAuthorityText(snapshot.known_sources)) fail("SOURCE_AUTHORITY_CENSUS_CHANGED");
        this.ctx.storage.sql.exec(`INSERT INTO source_authority_pins(season_id, source_operation_id, actor_id, request_id,
          pin_text, authority_digest, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, command.season_id, operationId, coach.coach_id,
          command.request_id, sourceAuthorityText(pin), pin.authority_digest, pin.pinned_at).toArray();
        return pin;
      });
      return committed ?? this.pin(command);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return fail("SOURCE_AUTHORITY_UNCONFIRMED");
    }
  }
}
