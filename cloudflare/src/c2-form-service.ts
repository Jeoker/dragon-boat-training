import { parsePullFormResponses, parseResolveFormSource } from "../../shared/c2-sync-contract";
import { formResponseSourceId } from "../../shared/c2-sync-rules";
import { canonicalJson } from "../../shared/c1-rules";
import { sha256Base64Url } from "./crypto";
import { readGoogleFormPage, type FormCursorRequest, type FormResponsePage } from "./c2-form-bridge";
import { ApiError } from "./http";
import { C1Service } from "./c1-service";
import { firstRow, operationReceipt, parseContract, type SqlRow } from "./c1-support";

const OVERLAP_MS = 24 * 60 * 60 * 1000;

interface PreparedResponse {
  response_id: string;
  submitted_at: string;
  display_name: string;
  stable_source_id: string;
  source_digest: string;
  member_id: string;
}

function cursorRequest(row: SqlRow | null): FormCursorRequest {
  const windowStart = row?.window_start_ms == null
    ? Math.max(0, Number(row?.watermark_ms ?? 0) - OVERLAP_MS)
    : Number(row.window_start_ms);
  return {
    window_start_ms: windowStart,
    after_at_ms: row?.window_start_ms == null ? windowStart : Number(row.after_at_ms),
    after_id: row?.window_start_ms == null ? "" : String(row.after_id)
  };
}

export class C2FormService {
  private readonly core: C1Service;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.core = new C1Service(ctx, env);
  }

  async pull(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parsePullFormResponses(raw));
    const identity = await this.core.createRequestIdentity("C2:FORM", "pullFormResponses", input.request_id,
      { season_id: input.season_id, limit: input.limit });
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const season = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM seasons WHERE season_id=?", input.season_id);
    const binding = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM sync_bindings WHERE season_id=?", input.season_id);
    if (!season || !binding || Number(season.binding_version) !== Number(binding.binding_version)) {
      throw new ApiError("SYNC_BINDING_NOT_FOUND", "A current Form binding is required.", 409);
    }
    if (!["OPEN", "COMPLETED"].includes(String(season.status))) {
      throw new ApiError("FORM_IMPORT_CLOSED", "The season is not eligible for Form import.", 409);
    }
    const cursor = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM form_import_cursors WHERE season_id=?", input.season_id);
    const requestCursor = cursorRequest(cursor && Number(cursor.binding_version) === Number(binding.binding_version)
      ? cursor : cursor ? { ...cursor, window_start_ms: null } : null);
    const page = await readGoogleFormPage(this.env, {
      request_id: input.request_id, operation_id: `c2_form_${identity.requestKey.slice(-32)}`,
      season_id: input.season_id, form_id: String(binding.form_id),
      binding_version: Number(binding.binding_version), cursor: requestCursor, limit: input.limit
    });
    const prepared = await Promise.all(page.responses.map(async (row): Promise<PreparedResponse> => {
      const stableId = formResponseSourceId(input.season_id, String(binding.form_id), row.response_id);
      return {
        ...row, stable_source_id: stableId,
        source_digest: `sha256_v1:${await sha256Base64Url(canonicalJson({
          response_id: row.response_id, submitted_at: row.submitted_at, display_name: row.display_name.trim()
        }))}`,
        member_id: `member_${(await sha256Base64Url(stableId)).slice(0, 32)}`
      };
    }));
    const at = new Date().toISOString();
    const responseDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(page))}`;
    return this.ctx.storage.transactionSync(() => this.commit(input.season_id, input.request_id,
      Number(binding.binding_version), String(binding.form_id), String(season.season_ends_at),
      cursor, requestCursor, page, prepared, identity, responseDigest, at));
  }

  async resolve(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseResolveFormSource(raw));
    const coach = await this.core.authenticateSession(input.session_token);
    const identity = await this.core.createRequestIdentity(coach.coach_id, "resolveFormSource", input.request_id,
      { season_id: input.season_id, response_id: input.response_id,
        member_id: input.member_id, source_version: input.source_version });
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const at = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(coach);
      const sql = this.ctx.storage.sql;
      const season = firstRow<SqlRow>(sql,
        "SELECT binding_version, season_ends_at FROM seasons WHERE season_id=?", input.season_id);
      const binding = firstRow<SqlRow>(sql, "SELECT binding_version, form_id FROM sync_bindings WHERE season_id=?", input.season_id);
      if (!season || !binding || Number(season.binding_version) !== Number(binding.binding_version)) {
        throw new ApiError("SYNC_BINDING_NOT_FOUND", "A current Form binding is required.", 409);
      }
      const stableId = formResponseSourceId(input.season_id, String(binding.form_id), input.response_id);
      const source = firstRow<SqlRow>(sql, "SELECT * FROM source_imports WHERE stable_source_id=?", stableId);
      const observation = firstRow<SqlRow>(sql,
        "SELECT * FROM form_source_observations WHERE stable_source_id=?", stableId);
      const member = firstRow<SqlRow>(sql,
        "SELECT * FROM members WHERE season_id=? AND member_id=?", input.season_id, input.member_id);
      if (!source || source.status !== "REVIEW_REQUIRED" || !observation || !member) {
        throw new ApiError("FORM_SOURCE_REVIEW_REQUIRED", "The source or member is not available for resolution.", 409);
      }
      if (Number(source.source_version) !== input.source_version) {
        throw new ApiError("IMPORT_VERSION_REGRESSION", "The source review changed before resolution.", 409);
      }
      const owner = firstRow<SqlRow>(sql,
        `SELECT stable_source_id FROM source_imports WHERE season_id=? AND source_type='FORM_RESPONSE'
         AND member_id=? AND status='IMPORTED' LIMIT 1`, input.season_id, input.member_id);
      if (owner) throw new ApiError("SOURCE_IDENTITY_CONFLICT", "The member already has a Form response mapping.", 409);
      if (!String(observation.display_name).trim() || String(observation.display_name).length > 120 ||
          Date.parse(String(observation.submitted_at)) >= Date.parse(String(season.season_ends_at))) {
        throw new ApiError("FORM_SOURCE_REVIEW_REQUIRED", "An invalid or late answer cannot be linked as a member.", 409);
      }
      sql.exec(
        `UPDATE source_imports SET member_id=?, status='IMPORTED', imported_at=?,
         source_version=source_version+1, binding_version=?, updated_at=? WHERE stable_source_id=?`,
        input.member_id, at, Number(binding.binding_version), at, stableId).toArray();
      sql.exec("UPDATE form_source_observations SET review_reason='', observed_at=? WHERE stable_source_id=?",
        at, stableId).toArray();
      if (String(member.source_display_name) !== String(observation.display_name)) {
        sql.exec(
          `UPDATE members SET source_display_name=?, member_version=member_version+1, updated_at=?
           WHERE season_id=? AND member_id=?`,
          observation.display_name, at, input.season_id, input.member_id).toArray();
        sql.exec("UPDATE seasons SET roster_version=roster_version+1, updated_at=? WHERE season_id=?",
          at, input.season_id).toArray();
      }
      const result = { operation: operationReceipt("resolveFormSource", input.request_id, at), result: {
        season_id: input.season_id, response_id: input.response_id,
        member_id: input.member_id, source_version: input.source_version + 1
      } };
      this.core.recordRequest(identity, coach.coach_id, "resolveFormSource", input.request_id, result,
        { season_id: input.season_id, member_id: input.member_id, stable_source_id: stableId }, at);
      this.core.enqueueChange(identity, "MEMBERS_IMPORTED", "resolveFormSource",
        { season_id: input.season_id, member_ids: [input.member_id] }, at);
      return result;
    });
  }

  private commit(seasonId: string, requestId: string, bindingVersion: number, formId: string,
    seasonEndsAt: string, originalCursor: SqlRow | null, requestCursor: FormCursorRequest,
    page: FormResponsePage, prepared: PreparedResponse[],
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>, responseDigest: string,
    at: string): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    const currentSeason = firstRow<SqlRow>(sql, "SELECT binding_version, status, season_ends_at FROM seasons WHERE season_id=?", seasonId);
    const currentBinding = firstRow<SqlRow>(sql, "SELECT binding_version, form_id FROM sync_bindings WHERE season_id=?", seasonId);
    const currentCursor = firstRow<SqlRow>(sql, "SELECT * FROM form_import_cursors WHERE season_id=?", seasonId);
    if (!currentSeason || !currentBinding || Number(currentSeason.binding_version) !== bindingVersion ||
        Number(currentBinding.binding_version) !== bindingVersion || String(currentBinding.form_id) !== formId ||
        !["OPEN", "COMPLETED"].includes(String(currentSeason.status)) ||
        String(currentSeason.season_ends_at) !== seasonEndsAt ||
        canonicalJson(currentCursor) !== canonicalJson(originalCursor)) {
      throw new ApiError("FORM_IMPORT_STALE", "The Form import state changed while reading Google.", 409, true);
    }
    const counts = { created: 0, updated: 0, reviewed: 0, unchanged: 0 };
    const changedMembers: string[] = [];
    const scanBaseline = originalCursor?.window_start_ms != null
      ? Number(originalCursor.scan_baseline_ms) : Number(originalCursor?.watermark_ms ?? page.read_at_ms);
    for (const row of prepared) {
      const source = firstRow<SqlRow>(sql, "SELECT * FROM source_imports WHERE stable_source_id=?", row.stable_source_id);
      if (source && (String(source.season_id) !== seasonId || String(source.source_type) !== "FORM_RESPONSE" ||
          String(source.source_external_id) !== row.response_id || Number(source.binding_version) > bindingVersion)) {
        throw new ApiError("SOURCE_IDENTITY_CONFLICT", "The Form response identity changed.", 409);
      }
      const changed = !source || String(source.source_digest) !== row.source_digest;
      if (source && !changed) {
        if (Number(source.binding_version) < bindingVersion) sql.exec(
          "UPDATE source_imports SET binding_version=? WHERE stable_source_id=?",
          bindingVersion, row.stable_source_id).toArray();
        counts.unchanged += 1;
        continue;
      }
      const eligible = !!row.display_name.trim() && row.display_name.length <= 120 &&
        Date.parse(row.submitted_at) < Date.parse(seasonEndsAt);
      const legacyName = !source && eligible && firstRow<SqlRow>(sql,
        `SELECT 1 AS present FROM members m WHERE m.season_id=? AND
         lower(trim(m.source_display_name))=lower(?) AND
         NOT EXISTS (SELECT 1 FROM source_imports f WHERE f.season_id=m.season_id AND
           f.source_type='FORM_RESPONSE' AND f.member_id=m.member_id AND f.status='IMPORTED')
         LIMIT 1`, seasonId, row.display_name.trim());
      // Until a complete scan establishes a watermark, any unmapped answer may belong to
      // an old member, even when that member's name no longer matches the Form answer.
      const historicalUnmapped = !source && Date.parse(row.submitted_at) <= scanBaseline &&
        firstRow<SqlRow>(sql,
          `SELECT 1 AS present FROM members m WHERE m.season_id=? AND
           NOT EXISTS (SELECT 1 FROM source_imports f WHERE f.season_id=m.season_id AND
             f.source_type='FORM_RESPONSE' AND f.member_id=m.member_id AND f.status='IMPORTED')
           LIMIT 1`, seasonId);
      const memberId = source?.member_id ? String(source.member_id) : row.member_id;
      const needsReview = !eligible || !!legacyName || !!historicalUnmapped || source?.status === "REVIEW_REQUIRED";
      const reviewReason = !row.display_name.trim() ? "MISSING_NAME" :
        row.display_name.length > 120 ? "NAME_TOO_LONG" :
        Date.parse(row.submitted_at) >= Date.parse(seasonEndsAt) ? "AFTER_SEASON" :
        legacyName ? "LEGACY_NAME_MATCH" : historicalUnmapped ? "HISTORICAL_UNMAPPED" :
        source?.status === "REVIEW_REQUIRED" ? "PRIOR_REVIEW" : "";
      if (source?.status === "IMPORTED" && !eligible) {
        throw new ApiError("FORM_SOURCE_REVIEW_REQUIRED", "An imported Form response changed to an invalid value.", 409);
      }
      if (needsReview) {
        sql.exec(
          `INSERT INTO source_imports(stable_source_id, season_id, binding_version, source_type,
             source_external_id, source_digest, source_version, member_id, status, imported_at, updated_at)
           VALUES (?, ?, ?, 'FORM_RESPONSE', ?, ?, ?, NULL, 'REVIEW_REQUIRED', NULL, ?)
           ON CONFLICT(stable_source_id) DO UPDATE SET binding_version=excluded.binding_version,
             source_digest=excluded.source_digest, source_version=excluded.source_version, updated_at=excluded.updated_at`,
          row.stable_source_id, seasonId, bindingVersion, row.response_id, row.source_digest,
          source ? Number(source.source_version) + 1 : 1, at).toArray();
        counts.reviewed += 1;
      } else if (!source) {
        sql.exec(
          `INSERT INTO members(season_id, member_id, source_key, source_display_name,
             display_name_override, status, default_preference, member_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', 'ACTIVE', 'AMBIENT', 1, ?, ?)`,
          seasonId, memberId, row.stable_source_id, row.display_name.trim(), at, at).toArray();
        sql.exec(
          `INSERT INTO source_imports VALUES (?, ?, ?, 'FORM_RESPONSE', ?, ?, 1, ?, 'IMPORTED', ?, ?)`,
          row.stable_source_id, seasonId, bindingVersion, row.response_id, row.source_digest,
          memberId, at, at).toArray();
        sql.exec("UPDATE seasons SET roster_version=roster_version+1, updated_at=? WHERE season_id=?",
          at, seasonId).toArray();
        counts.created += 1;
        changedMembers.push(memberId);
      } else {
        const member = firstRow<SqlRow>(sql,
          "SELECT source_display_name FROM members WHERE season_id=? AND member_id=?", seasonId, memberId);
        if (!member) throw new ApiError("IMPORT_REFERENCE_MISSING", "A Form source references a missing member.", 409);
        if (String(member.source_display_name) !== row.display_name.trim()) {
          sql.exec(
            `UPDATE members SET source_display_name=?, member_version=member_version+1, updated_at=?
             WHERE season_id=? AND member_id=?`, row.display_name.trim(), at, seasonId, memberId).toArray();
          sql.exec("UPDATE seasons SET roster_version=roster_version+1, updated_at=? WHERE season_id=?",
            at, seasonId).toArray();
          changedMembers.push(memberId);
        }
        sql.exec(
          `UPDATE source_imports SET binding_version=?, source_digest=?, source_version=source_version+1,
           updated_at=? WHERE stable_source_id=?`, bindingVersion, row.source_digest, at, row.stable_source_id).toArray();
        counts.updated += 1;
      }
      sql.exec(
        `INSERT INTO form_source_observations VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stable_source_id) DO UPDATE SET submitted_at=excluded.submitted_at,
           display_name=excluded.display_name, source_digest=excluded.source_digest,
           review_reason=excluded.review_reason, observed_at=excluded.observed_at`,
        row.stable_source_id, seasonId, row.submitted_at, row.display_name.trim(),
        row.source_digest, reviewReason, at).toArray();
    }
    const watermark = page.has_more ? Number(originalCursor?.watermark_ms ?? 0) :
      Math.max(Number(originalCursor?.watermark_ms ?? 0), page.read_at_ms);
    sql.exec(
      `INSERT INTO form_import_cursors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id) DO UPDATE SET binding_version=excluded.binding_version,
         watermark_ms=excluded.watermark_ms, window_start_ms=excluded.window_start_ms,
         scan_baseline_ms=excluded.scan_baseline_ms,
         after_at_ms=excluded.after_at_ms, after_id=excluded.after_id,
         last_read_at_ms=excluded.last_read_at_ms, updated_at=excluded.updated_at`,
      seasonId, bindingVersion, watermark, page.has_more ? requestCursor.window_start_ms : null,
      page.has_more ? scanBaseline : null,
      page.has_more ? page.next_after_at_ms : 0, page.has_more ? page.next_after_id : "",
      page.read_at_ms, at).toArray();
    sql.exec("UPDATE sync_bindings SET last_pull_at=?, updated_at=? WHERE season_id=?",
      new Date(page.read_at_ms).toISOString(), at, seasonId).toArray();
    const result = {
      operation: operationReceipt("pullFormResponses", requestId, at),
      result: { season_id: seasonId, binding_version: bindingVersion, ...counts,
        has_more: page.has_more, watermark_ms: watermark,
        next_after_at_ms: page.has_more ? page.next_after_at_ms : null,
        next_after_id: page.has_more ? page.next_after_id : null }
    };
    this.core.recordRequest(identity, "C2:FORM", "pullFormResponses", requestId, result,
      { season_id: seasonId, counts, has_more: page.has_more }, at);
    if (changedMembers.length) this.core.enqueueChange(identity, "MEMBERS_IMPORTED", "pullFormResponses",
      { season_id: seasonId, member_ids: changedMembers }, at);
    sql.exec("INSERT INTO form_import_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      `c2_form_${identity.requestKey.slice(-32)}`, identity.requestKey, seasonId,
      bindingVersion, identity.payloadDigest, responseDigest, JSON.stringify(result), at).toArray();
    return result;
  }
}
