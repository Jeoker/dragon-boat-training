import { canonicalJson } from "../../shared/c1-rules";
import { SYNC_FIELD_DEFINITIONS, compareSyncGroup, normalizeSyncValue } from "../../shared/c2-sync-rules";
import { identifier, object, requestId } from "../../shared/c1-contract";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";
import { firstRow, parseContract, type SqlRow } from "./c1-support";
import { C1Service } from "./c1-service";
import { assertExportMayPrepare } from "./c2-export-control";
import { assertSentBatch, beginExportSend, confirmExportReceipt, recordExportFailure,
  recordExportPartial, verifyStoredPatch, type ExportBatch } from "./c2-export-batch";
import { assertBridgePatchBudget, patchGoogleMembers, patchGoogleSeason, readGoogleSheet, SHEET_SCOPES,
  type MemberPatchItem, type MemberPatchReceipt, type SeasonPatchItem,
  type SeasonPatchReceipt } from "./c2-sheet-bridge";

interface ExportEvent extends SqlRow { outbox_id: string; payload_json: string; sequence: number; }
type StoredBatch = ExportBatch;
interface StoredTarget { member_id: string; expected: string[] | null; target: string[];
  spreadsheet_id: string; tab_id: string; cloud_version: number; }
interface StoredSeasonTarget { season_id: string; expected: string[]; target: string[];
  spreadsheet_id: string; tab_id: string; roster_version: number; season_version: number; }

const definitions = SYNC_FIELD_DEFINITIONS.MEMBER;
const groups = [...new Set(definitions.map((field) => field.dependency_group))];
const headers = SHEET_SCOPES.MEMBER.headers;
const seasonHeaders = SHEET_SCOPES.SEASON.headers;
const seasonDefinitions = SYNC_FIELD_DEFINITIONS.SEASON;
const seasonGroups = [...new Set(seasonDefinitions.map((field) => field.dependency_group))];

function memberIds(event: ExportEvent): string[] {
  let payload: unknown;
  try { payload = JSON.parse(event.payload_json); } catch { payload = null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("SYNC_OUTBOX_INVALID", "The member outbox has an invalid payload.", 409);
  }
  const data = payload as Record<string, unknown>;
  const entity = data.entity;
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    throw new ApiError("SYNC_OUTBOX_INVALID", "The member outbox has an invalid entity.", 409);
  }
  const ids = (entity as Record<string, unknown>).member_ids ??
    ((entity as Record<string, unknown>).member_id ? [(entity as Record<string, unknown>).member_id] : []);
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
      !ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new ApiError("SYNC_OUTBOX_INVALID", "The member outbox has invalid target IDs.", 409);
  }
  return ids as string[];
}

function eventRosterVersion(sql: SqlStorage, event: ExportEvent, current: number): number {
  const payload = JSON.parse(event.payload_json) as { entity?: { roster_version?: unknown } };
  const captured = payload.entity?.roster_version;
  if (captured !== undefined) {
    if (!Number.isSafeInteger(captured) || Number(captured) < 0 || Number(captured) > current) {
      throw new ApiError("SYNC_OUTBOX_INVALID", "The captured roster version is invalid.", 409);
    }
    return Number(captured);
  }
  // Pre-capture events can only use the live version when no later roster event exists.
  // Otherwise the version at this event cannot be reconstructed without guessing.
  const later = firstRow<SqlRow>(sql,
    `SELECT outbox_id FROM sync_outbox WHERE rowid>? AND status='PENDING'
     AND json_extract(payload_json,'$.entity.season_id')=? AND
       (topic='MEMBERS_IMPORTED' OR (topic='CORE_CHANGED' AND
        json_extract(payload_json,'$.action')='updateMember')) LIMIT 1`,
    event.sequence, (payload.entity as { season_id?: string } | undefined)?.season_id ?? "");
  if (later) throw new ApiError("SYNC_ROSTER_VERSION_UNCAPTURED",
    "An older member event has no captured roster version and newer member events exist.", 409);
  return current;
}

function verifiedMemberIds(sql: SqlStorage, outboxId: string, bindingVersion: number): Set<string> {
  return new Set(sql.exec<{ entity_id: string }>(
    `SELECT i.entity_id FROM sync_batch_items i JOIN sync_batches b ON b.batch_id=i.batch_id
     WHERE b.first_outbox_id=? AND b.last_outbox_id=? AND b.binding_version=?
       AND b.status='CONFIRMED' AND i.entity_type='MEMBER' AND i.status='VERIFIED'`,
    outboxId, outboxId, bindingVersion)
    .toArray().map((row) => row.entity_id));
}

function memberTargetsVerified(sql: SqlStorage, outboxId: string, bindingVersion: number): boolean {
  const event = firstRow<SqlRow>(sql,
    "SELECT payload_json,status FROM sync_outbox WHERE outbox_id=?", outboxId);
  if (event?.status !== "PENDING") return false;
  const ids = memberIds({ outbox_id: outboxId, payload_json: String(event.payload_json), sequence: 0 });
  const done = verifiedMemberIds(sql, outboxId, bindingVersion);
  return ids.every((id) => done.has(id));
}

function seasonGroup(row: Record<string, unknown>, group: string): Record<string, unknown> {
  try {
    return Object.fromEntries(seasonDefinitions.filter((field) => field.dependency_group === group)
      .map((field) => [field.field,
        normalizeSyncValue(row[field.field], field.kind, field.allowed_values)]));
  } catch {
    throw new ApiError("SYNC_SEASON_INVALID", "The season has an invalid mapped value.", 409);
  }
}

function normalizedGroup(row: Record<string, unknown>, group: string): Record<string, unknown> {
  try {
    return Object.fromEntries(definitions.filter((field) => field.dependency_group === group)
      .map((field) => [field.field,
        normalizeSyncValue(row[field.field], field.kind, field.allowed_values)]));
  } catch {
    throw new ApiError("SYNC_MEMBER_INVALID", "The member has an invalid mapped value.", 409);
  }
}

function sheetRecord(cells: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
}

function targetRows(seasonId: string, memberId: string, member: SqlRow,
  google: string[] | null, baselines: SqlRow[]): { expected: string[] | null; target: string[] } {
  const cloud = Object.fromEntries(Object.entries(member));
  const sourceKey = String(cloud.source_key);
  if (google) {
    if (baselines.length !== groups.length ||
        new Set(baselines.map((row) => String(row.dependency_group))).size !== groups.length ||
        new Set(baselines.map((row) => Number(row.cloud_version))).size !== 1) {
      throw new ApiError("SYNC_BASELINE_INCOMPLETE", "An existing member row needs every baseline group.", 409);
    }
    const observed = sheetRecord(google);
    for (const group of groups) {
      const saved = baselines.find((row) => row.dependency_group === group);
      if (!saved) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A member baseline is missing.", 409);
      const baseline = JSON.parse(String(saved.baseline_json)) as Record<string, unknown>;
      const decision = compareSyncGroup({ entity_type: "MEMBER", baseline,
        cloudflare: cloud, google: observed }, group);
      if (!["NO_CHANGE", "EXPORT", "ADVANCE_BASELINE"].includes(decision.outcome) ||
          group === "IDENTITY" && decision.outcome !== "NO_CHANGE") {
        throw new ApiError("SYNC_MEMBER_NEEDS_REVIEW", "Google and Cloudflare member values need review before export.", 409);
      }
      if (group === "SYSTEM_VERSION" && Number(saved.cloud_version) > Number(cloud.member_version)) {
        throw new ApiError("SYNC_BASELINE_INVALID", "The stored member version is ahead of Cloudflare.", 409);
      }
    }
    if (observed.season_id !== seasonId || observed.member_id !== memberId || observed.source_key !== sourceKey) {
      throw new ApiError("SYNC_MEMBER_NEEDS_REVIEW", "The Google member identity changed.", 409);
    }
    const target = [...google];
    for (const field of definitions) {
      const index = headers.indexOf(field.field as typeof headers[number]);
      if (index >= 0) target[index] = String(cloud[field.field] ?? "");
    }
    target[headers.indexOf("updated_at")] = String(cloud.updated_at);
    return { expected: google, target };
  }
  if (baselines.length) throw new ApiError("SYNC_MEMBER_NEEDS_REVIEW", "A confirmed member row is missing in Google.", 409);
  const target = headers.map((header) => header === "source_row_number" ? "" : String(cloud[header] ?? ""));
  if (target[0] !== seasonId || target[1] !== memberId || target[2] !== sourceKey) {
    throw new ApiError("SYNC_MEMBER_INVALID", "The member identity cannot be exported.", 409);
  }
  for (const group of groups) normalizedGroup(cloud, group);
  if (target.some((cell) => cell.startsWith("="))) {
    throw new ApiError("SYNC_MEMBER_INVALID", "A member cell cannot start with a Sheet formula.", 409);
  }
  return { expected: null, target };
}

export class C2MemberExportService {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  private remember(identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>,
    requestId: string, result: Record<string, unknown>): Record<string, unknown> {
    return this.ctx.storage.transactionSync(() => {
      const core = new C1Service(this.ctx, this.env);
      const prior = core.replayRequest(identity.requestKey, identity.payloadDigest);
      if (prior) return prior;
      core.recordRequest(identity, "C2:EXPORT", "exportNextMember", requestId, result,
        { season_id: result.season_id, status: result.status, batch_id: result.batch_id ?? null },
        new Date().toISOString());
      return result;
    });
  }

  async process(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => {
      const value = object(raw);
      return { request_id: requestId(value), season_id: identifier(value, "season_id") };
    });
    if (this.env.ENVIRONMENT === "production" || this.env.C2_MEMBER_EXPORT_ENABLED !== "true") {
      throw new ApiError("MEMBER_EXPORT_DISABLED", "The isolated member export is disabled.", 409);
    }
    const core = new C1Service(this.ctx, this.env);
    const identity = await core.createRequestIdentity("C2:EXPORT", "exportNextMember",
      input.request_id, { season_id: input.season_id });
    const replay = core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const requestBatchId = `batch_${identity.requestKey.slice(7)}`;
    const sql = this.ctx.storage.sql;
    const ownBatch = firstRow<StoredBatch>(sql,
      "SELECT * FROM sync_batches WHERE batch_id=?", requestBatchId);
    if (ownBatch) {
      if (String(ownBatch.season_id) !== input.season_id) {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "The request identifier belongs to another season.", 409);
      }
      return this.send(ownBatch, input.request_id, identity);
    }
    const season = firstRow<SqlRow>(sql, "SELECT binding_version,roster_version FROM seasons WHERE season_id=?", input.season_id);
    const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", input.season_id);
    if (!season || !binding || Number(season.binding_version) !== Number(binding.binding_version) ||
        Number(binding.export_paused) !== 0) {
      throw new ApiError("SYNC_EXPORT_PAUSED", "A current, unpaused season binding is required.", 409);
    }
    const batch = firstRow<StoredBatch>(sql,
      `SELECT * FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
       AND status IN ('PREPARED','SENT','PARTIAL','FAILED') ORDER BY created_at,batch_id LIMIT 1`, input.season_id);
    if (batch) return this.send(batch, input.request_id, identity);
    assertExportMayPrepare(sql, input.season_id);
    const event = firstRow<ExportEvent>(sql,
      `SELECT rowid AS sequence,outbox_id,payload_json FROM sync_outbox
       WHERE status='PENDING' AND due_at_ms<=? AND
         json_extract(payload_json,'$.entity.season_id')=? AND
         ((topic='MEMBERS_IMPORTED' AND json_extract(payload_json,'$.action') IN
           ('pullFormResponses','resolveFormSource')) OR
          (topic='CORE_CHANGED' AND json_extract(payload_json,'$.action')='updateMember'))
       ORDER BY rowid LIMIT 1`, Date.now(), input.season_id);
    if (!event) return this.remember(identity, input.request_id,
      { season_id: input.season_id, status: "IDLE" });
    const earlier = firstRow<SqlRow>(sql,
      `SELECT outbox_id FROM sync_outbox WHERE status='PENDING' AND rowid<?
       AND json_extract(payload_json,'$.entity.season_id')=? LIMIT 1`, event.sequence, input.season_id);
    if (earlier) throw new ApiError("SYNC_OUTBOX_BLOCKED",
      "An earlier season event needs its own export handler first.", 409);
    const capturedRosterVersion = eventRosterVersion(sql, event, Number(season.roster_version));
    const seasonBaselines = sql.exec<SqlRow>(
      `SELECT dependency_group,baseline_json FROM sync_baselines
       WHERE season_id=? AND binding_version=? AND entity_type='SEASON' AND entity_id=?`,
      input.season_id, binding.binding_version, input.season_id).toArray();
    if (seasonBaselines.length !== seasonGroups.length ||
        new Set(seasonBaselines.map((row) => String(row.dependency_group))).size !== seasonGroups.length) {
      throw new ApiError("SYNC_BASELINE_INCOMPLETE", "The season needs every baseline group before member export.", 409);
    }
    const versionBaseline = seasonBaselines.find((row) => row.dependency_group === "SYSTEM_VERSION");
    if (!versionBaseline || Number((JSON.parse(String(versionBaseline.baseline_json)) as {
      roster_version: unknown }).roster_version) > capturedRosterVersion) {
      throw new ApiError("SYNC_ROSTER_VERSION_REGRESSION", "The confirmed roster version is ahead of this event.", 409);
    }
    const ids = memberIds(event);
    const verified = verifiedMemberIds(sql, event.outbox_id, Number(binding.binding_version));
    const nextId = ids.find((id) => !verified.has(id));
    if (!nextId) {
      return this.prepareSeason(event, binding, input.request_id, requestBatchId, identity);
    }
    const member = firstRow<SqlRow>(sql, "SELECT * FROM members WHERE season_id=? AND member_id=?",
      input.season_id, nextId);
    if (!member) throw new ApiError("SYNC_MEMBER_MISSING", "The outbox member no longer exists.", 409);
    const version = Number(binding.binding_version);
    const page = await readGoogleSheet(this.env, { request_id: input.request_id,
      operation_id: `inspect_${(await sha256Base64Url(`${event.outbox_id}\n${nextId}`)).slice(0, 35)}`,
      season_id: input.season_id, entity_type: "MEMBER", binding_version: version,
      runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
    if (canonicalJson(page.headers) !== canonicalJson(headers)) {
      throw new ApiError("SHEET_STRUCTURE_INVALID", "The member tab columns changed.", 409);
    }
    const rows = new Map<string, string[]>();
    for (const source of page.rows) {
      const cells = source.cells;
      if (cells[0] !== input.season_id || !/^[A-Za-z0-9_-]{8,128}$/u.test(cells[1]) || rows.has(cells[1])) {
        throw new ApiError("SHEET_STRUCTURE_INVALID", "The member tab contains an invalid or duplicate identity.", 409);
      }
      rows.set(cells[1], cells);
    }
    const baselines = sql.exec<SqlRow>(
      `SELECT dependency_group,baseline_json,cloud_version FROM sync_baselines
       WHERE season_id=? AND binding_version=? AND entity_type='MEMBER' AND entity_id=?`,
      input.season_id, version, nextId).toArray();
    const row = targetRows(input.season_id, nextId, member, rows.get(nextId) ?? null, baselines);
    if (row.target.some((cell) => cell.startsWith("="))) {
      throw new ApiError("SYNC_MEMBER_INVALID", "A member cell cannot start with a Sheet formula.", 409);
    }
    const batchId = requestBatchId;
    const target: StoredTarget = { member_id: nextId, ...row,
      spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id,
      cloud_version: Number(member.member_version) };
    const item: MemberPatchItem = { member_id: nextId, expected: row.expected, target: row.target };
    const payload = { season_id: input.season_id, batch_id: batchId,
      spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id, items: [item] };
    const payloadDigest = await sha256Base64Url(JSON.stringify(payload));
    const expectedDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(row.expected))}`;
    const targetDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(row.target))}`;
    assertBridgePatchBudget(payload);
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      assertExportMayPrepare(sql, input.season_id);
      const current = firstRow<SqlRow>(sql, "SELECT binding_version,export_paused,runtime_spreadsheet_id FROM sync_bindings WHERE season_id=?",
        input.season_id);
      const currentMember = firstRow<SqlRow>(sql, "SELECT member_version FROM members WHERE season_id=? AND member_id=?",
        input.season_id, nextId);
      const currentEvent = firstRow<SqlRow>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", event.outbox_id);
      const alreadyVerified = verifiedMemberIds(sql, event.outbox_id, version).has(nextId);
      const competing = firstRow<SqlRow>(sql,
        `SELECT batch_id FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
         AND status IN ('PREPARED','SENT','PARTIAL','FAILED') LIMIT 1`, input.season_id);
      const alreadyPrepared = firstRow<SqlRow>(sql,
        "SELECT batch_id FROM sync_batches WHERE batch_id=?", batchId);
      if (!current || Number(current.binding_version) !== version || Number(current.export_paused) !== 0 ||
          current.runtime_spreadsheet_id !== page.spreadsheet_id ||
          Number(currentMember?.member_version) !== target.cloud_version ||
          currentEvent?.status !== "PENDING" || alreadyVerified || competing || alreadyPrepared) {
        throw new ApiError("SYNC_EXPORT_STALE", "The member export changed during inspection.", 409, true);
      }
      sql.exec(
        `INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,direction,status,
          payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
         VALUES (?,?,?,?,'CLOUDFLARE_TO_GOOGLE','PREPARED',?,?,?,?,?)`,
        batchId, input.season_id, version, Number(this.env.WRITER_EPOCH), payloadDigest,
        event.outbox_id, event.outbox_id, at, at).toArray();
      sql.exec(
        `INSERT INTO sync_batch_items(batch_id,item_index,entity_type,entity_id,dependency_group,
          expected_sheet_digest,target_json,target_digest,status,updated_at)
         VALUES (?,0,'MEMBER',?,'ROW',?,?,?,'PENDING',?)`,
        batchId, nextId, expectedDigest, JSON.stringify(target), targetDigest, at).toArray();
    });
    return this.send(firstRow<StoredBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batchId)!,
      input.request_id, identity);
  }

  private async prepareSeason(event: ExportEvent, binding: SqlRow, requestId: string, batchId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const season = firstRow<SqlRow>(sql, "SELECT * FROM seasons WHERE season_id=?", binding.season_id);
    if (!season) throw new ApiError("SEASON_NOT_FOUND", "The season does not exist.", 404);
    const rosterVersion = eventRosterVersion(sql, event, Number(season.roster_version));
    const page = await readGoogleSheet(this.env, { request_id: requestId,
      operation_id: `inspect_${(await sha256Base64Url(`${event.outbox_id}\nSEASON`)).slice(0, 35)}`,
      season_id: String(season.season_id), entity_type: "SEASON",
      binding_version: Number(binding.binding_version),
      runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
    if (canonicalJson(page.headers) !== canonicalJson(seasonHeaders)) {
      throw new ApiError("SHEET_STRUCTURE_INVALID", "The season tab columns changed.", 409);
    }
    const matches = page.rows.filter((row) => row.cells[0] === season.season_id);
    if (matches.length !== 1) {
      throw new ApiError("SYNC_SEASON_NEEDS_REVIEW", "The bound season row is missing or duplicated.", 409);
    }
    const expected = matches[0].cells;
    const observed = Object.fromEntries(seasonHeaders.map((header, index) => [header, expected[index]]));
    if (observed.form_id !== binding.form_id ||
        observed.runtime_spreadsheet_id !== binding.runtime_spreadsheet_id ||
        observed.response_sheet_id !== binding.response_sheet_id ||
        observed.binding_version !== String(binding.binding_version)) {
      throw new ApiError("SYNC_BINDING_STALE", "The Google season binding identity changed.", 409);
    }
    const baselines = sql.exec<SqlRow>(
      `SELECT dependency_group,baseline_json,cloud_version FROM sync_baselines
       WHERE season_id=? AND binding_version=? AND entity_type='SEASON' AND entity_id=?`,
      season.season_id, binding.binding_version, season.season_id).toArray();
    if (baselines.length !== seasonGroups.length ||
        new Set(baselines.map((row) => String(row.dependency_group))).size !== seasonGroups.length) {
      throw new ApiError("SYNC_BASELINE_INCOMPLETE", "The season needs every baseline group before export.", 409);
    }
    for (const group of seasonGroups) {
      const saved = baselines.find((row) => row.dependency_group === group);
      if (!saved) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A season baseline is missing.", 409);
      let baseline: Record<string, unknown>;
      try { baseline = JSON.parse(String(saved.baseline_json)) as Record<string, unknown>; }
      catch { throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A season baseline is invalid.", 409); }
      if (canonicalJson(seasonGroup(observed, group)) !== canonicalJson(seasonGroup(baseline, group))) {
        throw new ApiError("SYNC_SEASON_NEEDS_REVIEW", "The Google season row changed since its baseline.", 409);
      }
    }
    if (rosterVersion < Number(observed.roster_version)) {
      throw new ApiError("SYNC_ROSTER_VERSION_REGRESSION", "The Google roster version is ahead of this event.", 409);
    }
    const target = [...expected];
    target[seasonHeaders.indexOf("roster_version")] = String(rosterVersion);
    const stored: StoredSeasonTarget = { season_id: String(season.season_id), expected, target,
      spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id,
      roster_version: rosterVersion, season_version: Number(observed.season_version) };
    const payload = { season_id: stored.season_id, batch_id: batchId,
      spreadsheet_id: stored.spreadsheet_id, tab_id: stored.tab_id,
      items: [{ season_id: stored.season_id, expected, target }] };
    assertBridgePatchBudget(payload);
    const payloadDigest = await sha256Base64Url(JSON.stringify(payload));
    const expectedDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(expected))}`;
    const targetDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(target))}`;
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      assertExportMayPrepare(sql, String(season.season_id));
      const current = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", season.season_id);
      const currentSeason = firstRow<SqlRow>(sql, "SELECT binding_version,roster_version FROM seasons WHERE season_id=?", season.season_id);
      const competing = firstRow<SqlRow>(sql,
        `SELECT batch_id FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
         AND status IN ('PREPARED','SENT','PARTIAL','FAILED') LIMIT 1`, season.season_id);
      const currentEvent = firstRow<SqlRow>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", event.outbox_id);
      if (!current || !currentSeason || Number(current.binding_version) !== Number(binding.binding_version) ||
          Number(currentSeason.binding_version) !== Number(binding.binding_version) ||
          Number(current.export_paused) !== 0 ||
          current.runtime_spreadsheet_id !== binding.runtime_spreadsheet_id ||
          Number(currentSeason.roster_version) < rosterVersion ||
          currentEvent?.status !== "PENDING" || competing ||
          firstRow<SqlRow>(sql, "SELECT batch_id FROM sync_batches WHERE batch_id=?", batchId)) {
        throw new ApiError("SYNC_EXPORT_STALE", "The season export changed during inspection.", 409, true);
      }
      sql.exec(
        `INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,direction,status,
          payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
         VALUES (?,?,?,?,'CLOUDFLARE_TO_GOOGLE','PREPARED',?,?,?,?,?)`,
        batchId, season.season_id, binding.binding_version, Number(this.env.WRITER_EPOCH),
        payloadDigest, event.outbox_id, event.outbox_id, at, at).toArray();
      sql.exec(
        `INSERT INTO sync_batch_items(batch_id,item_index,entity_type,entity_id,dependency_group,
          expected_sheet_digest,target_json,target_digest,status,updated_at)
         VALUES (?,0,'SEASON',?,'SYSTEM_VERSION',?,?,?,'PENDING',?)`,
        batchId, season.season_id, expectedDigest, JSON.stringify(stored), targetDigest, at).toArray();
    });
    return this.send(firstRow<StoredBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batchId)!,
      requestId, identity);
  }

  private async send(batch: StoredBatch, requestId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const item = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT entity_type FROM sync_batch_items WHERE batch_id=? AND item_index=0", batch.batch_id);
    if (item?.entity_type === "MEMBER") return this.sendMember(batch, requestId, identity);
    if (item?.entity_type === "SEASON") return this.sendSeason(batch, requestId, identity);
    throw new ApiError("SYNC_BATCH_INVALID", "The export batch has an invalid target.", 409);
  }

  private async sendMember(batch: StoredBatch, requestId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const saved = firstRow<SqlRow>(sql, "SELECT * FROM sync_batch_items WHERE batch_id=? AND item_index=0", batch.batch_id);
    if (!saved || String(saved.entity_type) !== "MEMBER") {
      throw new ApiError("SYNC_BATCH_INVALID", "The member batch is incomplete.", 409);
    }
    const target = JSON.parse(String(saved.target_json)) as StoredTarget;
    const result = () => ({ season_id: batch.season_id, status: "BATCH_CONFIRMED",
      batch_id: batch.batch_id, outbox_id: batch.first_outbox_id,
      member_id: target.member_id, cloud_version: target.cloud_version });
    if (batch.status === "CONFIRMED") return this.remember(identity, requestId, result());
    const currentBinding = firstRow<SqlRow>(sql,
      "SELECT binding_version,runtime_spreadsheet_id FROM sync_bindings WHERE season_id=?", batch.season_id);
    const currentSeason = firstRow<SqlRow>(sql,
      "SELECT binding_version FROM seasons WHERE season_id=?", batch.season_id);
    if (!currentBinding || !currentSeason ||
        Number(currentBinding.binding_version) !== Number(batch.binding_version) ||
        Number(currentSeason.binding_version) !== Number(batch.binding_version)) {
      throw new ApiError("SYNC_BINDING_STALE", "A prepared batch belongs to an old season binding.", 409);
    }
    if (currentBinding.runtime_spreadsheet_id !== target.spreadsheet_id) {
      throw new ApiError("SYNC_BINDING_STALE", "A prepared batch belongs to another Spreadsheet.", 409);
    }
    if (firstRow<SqlRow>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id)
      ?.status !== "PENDING") {
      throw new ApiError("SYNC_EXPORT_STALE", "The prepared batch no longer has a pending event.", 409);
    }
    const item: MemberPatchItem = { member_id: target.member_id,
      expected: target.expected, target: target.target };
    const payload = { season_id: String(batch.season_id), batch_id: batch.batch_id,
      spreadsheet_id: target.spreadsheet_id, tab_id: target.tab_id, items: [item] };
    await verifyStoredPatch(batch, saved, payload, target.expected, target.target,
      Number(this.env.WRITER_EPOCH));
    const alreadyConfirmed = beginExportSend(this.ctx, batch);
    if (alreadyConfirmed) return this.remember(identity, requestId, result());
    let receipt: MemberPatchReceipt;
    try {
      receipt = await patchGoogleMembers(this.env, { request_id: requestId,
        batch_id: batch.batch_id, season_id: String(batch.season_id),
        binding_version: Number(batch.binding_version), spreadsheet_id: target.spreadsheet_id,
        tab_id: target.tab_id, items: [item] });
    } catch (error) {
      recordExportFailure(sql, batch.batch_id, error);
      throw error;
    }
    const capturedBaselines = await Promise.all(groups.map(async (group) => {
      const baseline = normalizedGroup(sheetRecord(target.target), group);
      const digest = `sha256_v1:${await sha256Base64Url(canonicalJson(baseline))}`;
      return { group, baseline, digest };
    }));
    let exportStateChanged = false;
    this.ctx.storage.transactionSync(() => {
      const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
      const currentSeason = firstRow<SqlRow>(sql, "SELECT binding_version FROM seasons WHERE season_id=?", batch.season_id);
      const currentBatch = firstRow<StoredBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batch.batch_id);
      const currentEvent = firstRow<SqlRow>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
      if (currentBatch?.status === "CONFIRMED") return;
      assertSentBatch(currentBatch);
      if (!binding || !currentSeason || !currentBatch ||
          Number(binding.binding_version) !== Number(batch.binding_version) ||
          Number(currentSeason.binding_version) !== Number(batch.binding_version) ||
          String(binding.runtime_spreadsheet_id) !== target.spreadsheet_id ||
          String(currentBatch.payload_digest) !== receipt.payload_digest ||
          currentEvent?.status !== "PENDING") {
        exportStateChanged = true;
        recordExportPartial(sql, batch.batch_id,
          "Google verified the batch, but its binding or event changed; review before confirming.");
        return;
      }
      const at = new Date().toISOString();
      for (const { group, baseline, digest } of capturedBaselines) {
        sql.exec(
          `INSERT INTO sync_baselines(season_id,binding_version,entity_type,entity_id,dependency_group,
            baseline_json,baseline_digest,cloud_version,sheet_digest,updated_at)
           VALUES (?,?,'MEMBER',?,?,?,?,?,?,?)
           ON CONFLICT(season_id,binding_version,entity_type,entity_id,dependency_group)
           DO UPDATE SET baseline_json=excluded.baseline_json,baseline_digest=excluded.baseline_digest,
             cloud_version=excluded.cloud_version,sheet_digest=excluded.sheet_digest,updated_at=excluded.updated_at`,
          batch.season_id, batch.binding_version, target.member_id, group,
          canonicalJson(baseline), digest, target.cloud_version, digest, at).toArray();
      }
      confirmExportReceipt(sql, batch, receipt, at, "BATCH");
      new C1Service(this.ctx, this.env).recordRequest(identity, "C2:EXPORT", "exportNextMember",
        requestId, result(), { season_id: batch.season_id, status: "BATCH_CONFIRMED",
          batch_id: batch.batch_id }, at);
    });
    if (exportStateChanged) throw new ApiError("SYNC_BINDING_CHANGED_AFTER_WRITE",
      "Google verified the batch, but its binding or event changed before confirmation.", 409);
    return this.remember(identity, requestId, result());
  }

  private async sendSeason(batch: StoredBatch, requestId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const saved = firstRow<SqlRow>(sql,
      "SELECT * FROM sync_batch_items WHERE batch_id=? AND item_index=0", batch.batch_id);
    if (!saved || saved.entity_type !== "SEASON" || saved.entity_id !== batch.season_id) {
      throw new ApiError("SYNC_BATCH_INVALID", "The season batch is incomplete.", 409);
    }
    const target = JSON.parse(String(saved.target_json)) as StoredSeasonTarget;
    const result = () => ({ season_id: batch.season_id, status: "EVENT_CONFIRMED",
      batch_id: batch.batch_id, outbox_id: batch.first_outbox_id,
      roster_version: target.roster_version });
    if (batch.status === "CONFIRMED") return this.remember(identity, requestId, result());
    const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
    const season = firstRow<SqlRow>(sql, "SELECT binding_version,roster_version FROM seasons WHERE season_id=?", batch.season_id);
    if (!binding || !season || Number(binding.binding_version) !== Number(batch.binding_version) ||
        Number(season.binding_version) !== Number(batch.binding_version) ||
        Number(season.roster_version) < target.roster_version ||
        String(target.season_id) !== String(batch.season_id) ||
        String(binding.runtime_spreadsheet_id) !==
          target.expected[seasonHeaders.indexOf("runtime_spreadsheet_id")]) {
      throw new ApiError("SYNC_BINDING_STALE", "The prepared season batch belongs to an old state.", 409);
    }
    if (!memberTargetsVerified(sql, String(batch.first_outbox_id), Number(batch.binding_version))) {
      throw new ApiError("SYNC_BATCH_INVALID", "The event members are not all verified.", 409);
    }
    const item: SeasonPatchItem = { season_id: target.season_id,
      expected: target.expected, target: target.target };
    const payload = { season_id: String(batch.season_id), batch_id: batch.batch_id,
      spreadsheet_id: target.spreadsheet_id, tab_id: target.tab_id, items: [item] };
    await verifyStoredPatch(batch, saved, payload, target.expected, target.target,
      Number(this.env.WRITER_EPOCH));
    const alreadyConfirmed = beginExportSend(this.ctx, batch);
    if (alreadyConfirmed) return this.remember(identity, requestId, result());
    let receipt: SeasonPatchReceipt;
    try {
      receipt = await patchGoogleSeason(this.env, { request_id: requestId,
        batch_id: batch.batch_id, season_id: String(batch.season_id),
        binding_version: Number(batch.binding_version), spreadsheet_id: target.spreadsheet_id,
        tab_id: target.tab_id, items: [item] });
    } catch (error) {
      recordExportFailure(sql, batch.batch_id, error);
      throw error;
    }
    const baseline = seasonGroup(Object.fromEntries(seasonHeaders.map((header, index) =>
      [header, target.target[index]])), "SYSTEM_VERSION");
    const digest = `sha256_v1:${await sha256Base64Url(canonicalJson(baseline))}`;
    let exportStateChanged = false;
    this.ctx.storage.transactionSync(() => {
      const currentBinding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
      const currentSeason = firstRow<SqlRow>(sql,
        "SELECT binding_version,roster_version FROM seasons WHERE season_id=?", batch.season_id);
      const currentBatch = firstRow<StoredBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batch.batch_id);
      const currentEvent = firstRow<SqlRow>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
      if (currentBatch?.status === "CONFIRMED") return;
      assertSentBatch(currentBatch);
      if (!currentBinding || !currentSeason || !currentBatch ||
          Number(currentBinding.binding_version) !== Number(batch.binding_version) ||
          Number(currentSeason.binding_version) !== Number(batch.binding_version) ||
          Number(currentSeason.roster_version) < target.roster_version ||
          String(currentBinding.runtime_spreadsheet_id) !==
            target.expected[seasonHeaders.indexOf("runtime_spreadsheet_id")] ||
          String(currentBatch.payload_digest) !== receipt.payload_digest ||
          String(currentBatch.first_outbox_id) !== String(batch.first_outbox_id) ||
          currentEvent?.status !== "PENDING" ||
          !memberTargetsVerified(sql, String(batch.first_outbox_id), Number(batch.binding_version))) {
        exportStateChanged = true;
        recordExportPartial(sql, batch.batch_id,
          "Google verified the season row, but its binding or event changed; review before confirming.");
        return;
      }
      const currentBaseline = firstRow<SqlRow>(sql,
        `SELECT baseline_json FROM sync_baselines WHERE season_id=? AND binding_version=?
         AND entity_type='SEASON' AND entity_id=? AND dependency_group='SYSTEM_VERSION'`,
        batch.season_id, batch.binding_version, batch.season_id);
      if (!currentBaseline || Number((JSON.parse(String(currentBaseline.baseline_json)) as { roster_version: number }).roster_version) >
          target.roster_version) {
        throw new ApiError("SYNC_BASELINE_INVALID", "A later season baseline cannot be replaced.", 409);
      }
      const at = new Date().toISOString();
      sql.exec(
        `INSERT INTO sync_baselines(season_id,binding_version,entity_type,entity_id,dependency_group,
          baseline_json,baseline_digest,cloud_version,sheet_digest,updated_at)
         VALUES (?,?,'SEASON',?,'SYSTEM_VERSION',?,?,?,?,?)
         ON CONFLICT(season_id,binding_version,entity_type,entity_id,dependency_group)
         DO UPDATE SET baseline_json=excluded.baseline_json,baseline_digest=excluded.baseline_digest,
           cloud_version=excluded.cloud_version,sheet_digest=excluded.sheet_digest,updated_at=excluded.updated_at`,
        batch.season_id, batch.binding_version, batch.season_id,
        canonicalJson(baseline), digest, target.season_version, digest, at).toArray();
      confirmExportReceipt(sql, batch, receipt, at, "EVENT");
      new C1Service(this.ctx, this.env).recordRequest(identity, "C2:EXPORT", "exportNextMember",
        requestId, result(), { season_id: batch.season_id, status: "EVENT_CONFIRMED",
          batch_id: batch.batch_id }, at);
    });
    if (exportStateChanged) throw new ApiError("SYNC_BINDING_CHANGED_AFTER_WRITE",
      "Google verified the season row, but its binding or event changed before confirmation.", 409);
    return this.remember(identity, requestId, result());
  }
}
