import { canonicalJson } from "../../shared/c1-rules";
import { SYNC_FIELD_DEFINITIONS, compareSyncGroup, normalizeSyncValue } from "../../shared/c2-sync-rules";
import { identifier, object, requestId } from "../../shared/c1-contract";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";
import { firstRow, parseContract, type SqlRow } from "./c1-support";
import { patchGoogleMembers, readGoogleSheet, SHEET_SCOPES,
  type MemberPatchItem, type MemberPatchReceipt } from "./c2-sheet-bridge";

interface ExportEvent extends SqlRow { outbox_id: string; payload_json: string; sequence: number; }
interface StoredBatch extends SqlRow { batch_id: string; season_id: string; binding_version: number;
  writer_epoch: number; status: string; payload_digest: string; first_outbox_id: string; }
interface StoredTarget { member_id: string; expected: string[] | null; target: string[];
  spreadsheet_id: string; tab_id: string; cloud_version: number; }

const definitions = SYNC_FIELD_DEFINITIONS.MEMBER;
const groups = [...new Set(definitions.map((field) => field.dependency_group))];
const headers = SHEET_SCOPES.MEMBER.headers;

function memberIds(event: ExportEvent): string[] {
  let payload: unknown;
  try { payload = JSON.parse(event.payload_json); } catch { payload = null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const data = payload as Record<string, unknown>;
  const entity = data.entity;
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) return [];
  const ids = (entity as Record<string, unknown>).member_ids ??
    ((entity as Record<string, unknown>).member_id ? [(entity as Record<string, unknown>).member_id] : []);
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
      !ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new ApiError("SYNC_OUTBOX_INVALID", "The member outbox has invalid target IDs.", 409);
  }
  return ids as string[];
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

  async process(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => {
      const value = object(raw);
      return { request_id: requestId(value), season_id: identifier(value, "season_id") };
    });
    if (this.env.ENVIRONMENT === "production" || this.env.C2_MEMBER_EXPORT_ENABLED !== "true") {
      throw new ApiError("MEMBER_EXPORT_DISABLED", "The isolated member export is disabled.", 409);
    }
    const sql = this.ctx.storage.sql;
    const season = firstRow<SqlRow>(sql, "SELECT binding_version FROM seasons WHERE season_id=?", input.season_id);
    const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", input.season_id);
    if (!season || !binding || Number(season.binding_version) !== Number(binding.binding_version) ||
        Number(binding.export_paused) !== 0) {
      throw new ApiError("SYNC_EXPORT_PAUSED", "A current, unpaused season binding is required.", 409);
    }
    const batch = firstRow<StoredBatch>(sql,
      `SELECT * FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
       AND status IN ('PREPARED','SENT','PARTIAL','FAILED') ORDER BY created_at,batch_id LIMIT 1`, input.season_id);
    if (batch) return this.send(batch, input.request_id);
    const event = firstRow<ExportEvent>(sql,
      `SELECT rowid AS sequence,outbox_id,payload_json FROM sync_outbox
       WHERE status='PENDING' AND due_at_ms<=? AND
         json_extract(payload_json,'$.entity.season_id')=? AND
         ((topic='MEMBERS_IMPORTED' AND json_extract(payload_json,'$.action') IN
           ('pullFormResponses','resolveFormSource')) OR
          (topic='CORE_CHANGED' AND json_extract(payload_json,'$.action')='updateMember'))
       ORDER BY rowid LIMIT 1`, Date.now(), input.season_id);
    if (!event) return { season_id: input.season_id, status: "IDLE" };
    const earlier = firstRow<SqlRow>(sql,
      `SELECT outbox_id FROM sync_outbox WHERE status='PENDING' AND rowid<?
       AND json_extract(payload_json,'$.entity.season_id')=? LIMIT 1`, event.sequence, input.season_id);
    if (earlier) throw new ApiError("SYNC_OUTBOX_BLOCKED",
      "An earlier season event needs its own export handler first.", 409);
    const ids = memberIds(event);
    const verified = new Set(sql.exec<{ entity_id: string }>(
      `SELECT i.entity_id FROM sync_batch_items i JOIN sync_batches b ON b.batch_id=i.batch_id
       WHERE b.first_outbox_id=? AND b.last_outbox_id=? AND b.status='CONFIRMED'
         AND i.entity_type='MEMBER' AND i.status='VERIFIED'`, event.outbox_id, event.outbox_id)
      .toArray().map((row) => row.entity_id));
    const nextId = ids.find((id) => !verified.has(id));
    if (!nextId) {
      sql.exec("UPDATE sync_outbox SET status='CONFIRMED',completed_at=?,last_error='' WHERE outbox_id=? AND status='PENDING'",
        new Date().toISOString(), event.outbox_id).toArray();
      return { season_id: input.season_id, status: "EVENT_CONFIRMED", outbox_id: event.outbox_id };
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
    const batchId = `batch_${(await sha256Base64Url(`${event.outbox_id}\n${nextId}`)).slice(0, 42)}`;
    const target: StoredTarget = { member_id: nextId, ...row,
      spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id,
      cloud_version: Number(member.member_version) };
    const item: MemberPatchItem = { member_id: nextId, expected: row.expected, target: row.target };
    const payload = { season_id: input.season_id, batch_id: batchId,
      spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id, items: [item] };
    const payloadDigest = await sha256Base64Url(JSON.stringify(payload));
    const expectedDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(row.expected))}`;
    const targetDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(row.target))}`;
    if (JSON.stringify(payload).length > 9500) {
      throw new ApiError("SYNC_BATCH_TOO_LARGE", "The member row exceeds the bridge batch limit.", 409);
    }
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const current = firstRow<SqlRow>(sql, "SELECT binding_version,export_paused,runtime_spreadsheet_id FROM sync_bindings WHERE season_id=?",
        input.season_id);
      const currentMember = firstRow<SqlRow>(sql, "SELECT member_version FROM members WHERE season_id=? AND member_id=?",
        input.season_id, nextId);
      const competing = firstRow<SqlRow>(sql,
        `SELECT batch_id FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
         AND status IN ('PREPARED','SENT','PARTIAL','FAILED') LIMIT 1`, input.season_id);
      const alreadyPrepared = firstRow<SqlRow>(sql,
        "SELECT batch_id FROM sync_batches WHERE batch_id=?", batchId);
      if (!current || Number(current.binding_version) !== version || Number(current.export_paused) !== 0 ||
          current.runtime_spreadsheet_id !== page.spreadsheet_id ||
          Number(currentMember?.member_version) !== target.cloud_version || competing || alreadyPrepared) {
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
    return this.send(firstRow<StoredBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batchId)!, input.request_id);
  }

  private async send(batch: StoredBatch, requestId: string): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const currentBinding = firstRow<SqlRow>(sql,
      "SELECT binding_version,runtime_spreadsheet_id FROM sync_bindings WHERE season_id=?", batch.season_id);
    const currentSeason = firstRow<SqlRow>(sql,
      "SELECT binding_version FROM seasons WHERE season_id=?", batch.season_id);
    if (!currentBinding || !currentSeason ||
        Number(currentBinding.binding_version) !== Number(batch.binding_version) ||
        Number(currentSeason.binding_version) !== Number(batch.binding_version)) {
      throw new ApiError("SYNC_BINDING_STALE", "A prepared batch belongs to an old season binding.", 409);
    }
    const saved = firstRow<SqlRow>(sql, "SELECT * FROM sync_batch_items WHERE batch_id=? AND item_index=0", batch.batch_id);
    if (!saved || String(saved.entity_type) !== "MEMBER") {
      throw new ApiError("SYNC_BATCH_INVALID", "The member batch is incomplete.", 409);
    }
    const target = JSON.parse(String(saved.target_json)) as StoredTarget;
    if (currentBinding.runtime_spreadsheet_id !== target.spreadsheet_id) {
      throw new ApiError("SYNC_BINDING_STALE", "A prepared batch belongs to another Spreadsheet.", 409);
    }
    const item: MemberPatchItem = { member_id: target.member_id,
      expected: target.expected, target: target.target };
    const payload = { season_id: String(batch.season_id), batch_id: batch.batch_id,
      spreadsheet_id: target.spreadsheet_id, tab_id: target.tab_id, items: [item] };
    if (await sha256Base64Url(JSON.stringify(payload)) !== String(batch.payload_digest) ||
        `sha256_v1:${await sha256Base64Url(canonicalJson(target.expected))}` !== String(saved.expected_sheet_digest) ||
        `sha256_v1:${await sha256Base64Url(canonicalJson(target.target))}` !== String(saved.target_digest) ||
        Number(batch.writer_epoch) !== Number(this.env.WRITER_EPOCH)) {
      throw new ApiError("SYNC_BATCH_INVALID", "The prepared member batch or writer epoch changed.", 409);
    }
    const result = () => ({ season_id: batch.season_id, status: "BATCH_CONFIRMED",
      batch_id: batch.batch_id, outbox_id: batch.first_outbox_id,
      member_id: target.member_id, cloud_version: target.cloud_version });
    const alreadyConfirmed = this.ctx.storage.transactionSync(() => {
      const current = firstRow<StoredBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batch.batch_id);
      if (!current || current.payload_digest !== batch.payload_digest) {
        throw new ApiError("SYNC_BATCH_INVALID", "The prepared batch changed before sending.", 409);
      }
      if (current.status === "CONFIRMED") return true;
      sql.exec(
        `UPDATE sync_batches SET status='SENT',attempt_count=attempt_count+1,updated_at=?
         WHERE batch_id=? AND status IN ('PREPARED','SENT','PARTIAL','FAILED')`,
        new Date().toISOString(), batch.batch_id).toArray();
      return false;
    });
    if (alreadyConfirmed) return result();
    let receipt: MemberPatchReceipt;
    try {
      receipt = await patchGoogleMembers(this.env, { request_id: requestId,
        batch_id: batch.batch_id, season_id: String(batch.season_id),
        binding_version: Number(batch.binding_version), spreadsheet_id: target.spreadsheet_id,
        tab_id: target.tab_id, items: [item] });
    } catch (error) {
      sql.exec("UPDATE sync_batches SET status='FAILED',last_error=?,updated_at=? WHERE batch_id=? AND status='SENT'",
        error instanceof Error ? error.message.slice(0, 400) : "Unknown bridge error.",
        new Date().toISOString(), batch.batch_id).toArray();
      throw error;
    }
    const capturedBaselines = await Promise.all(groups.map(async (group) => {
      const baseline = normalizedGroup(sheetRecord(target.target), group);
      const digest = `sha256_v1:${await sha256Base64Url(canonicalJson(baseline))}`;
      return { group, baseline, digest };
    }));
    let bindingChanged = false;
    this.ctx.storage.transactionSync(() => {
      const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
      const currentSeason = firstRow<SqlRow>(sql, "SELECT binding_version FROM seasons WHERE season_id=?", batch.season_id);
      const currentBatch = firstRow<StoredBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batch.batch_id);
      if (currentBatch?.status === "CONFIRMED") return;
      if (!binding || !currentSeason || !currentBatch ||
          Number(binding.binding_version) !== Number(batch.binding_version) ||
          Number(currentSeason.binding_version) !== Number(batch.binding_version) ||
          String(binding.runtime_spreadsheet_id) !== target.spreadsheet_id ||
          String(currentBatch.payload_digest) !== receipt.payload_digest) {
        bindingChanged = true;
        sql.exec("UPDATE sync_batches SET status='PARTIAL',last_error=?,updated_at=? WHERE batch_id=?",
          "Google verified the batch, but its current binding changed; review before confirming.",
          new Date().toISOString(), batch.batch_id).toArray();
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
      sql.exec("UPDATE sync_batch_items SET status='VERIFIED',receipt_json=?,updated_at=? WHERE batch_id=? AND item_index=0",
        JSON.stringify(receipt), at, batch.batch_id).toArray();
      sql.exec("UPDATE sync_batches SET status='CONFIRMED',last_error='',updated_at=?,completed_at=? WHERE batch_id=?",
        at, at, batch.batch_id).toArray();
      const event = firstRow<SqlRow>(sql,
        "SELECT outbox_id,payload_json,status FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
      if (event?.status === "PENDING") {
        const ids = memberIds({ outbox_id: String(event.outbox_id),
          payload_json: String(event.payload_json), sequence: 0 });
        const done = new Set(sql.exec<{ entity_id: string }>(
          `SELECT i.entity_id FROM sync_batch_items i JOIN sync_batches b ON b.batch_id=i.batch_id
           WHERE b.first_outbox_id=? AND b.last_outbox_id=? AND b.status='CONFIRMED'
             AND i.entity_type='MEMBER' AND i.status='VERIFIED'`,
          batch.first_outbox_id, batch.first_outbox_id).toArray().map((row) => row.entity_id));
        if (ids.every((id) => done.has(id))) sql.exec(
          "UPDATE sync_outbox SET status='CONFIRMED',completed_at=?,last_error='' WHERE outbox_id=? AND status='PENDING'",
          at, batch.first_outbox_id).toArray();
      }
      sql.exec("UPDATE sync_bindings SET last_push_at=?,updated_at=? WHERE season_id=? AND binding_version=?",
        at, at, batch.season_id, batch.binding_version).toArray();
    });
    if (bindingChanged) throw new ApiError("SYNC_BINDING_CHANGED_AFTER_WRITE",
      "Google verified the batch, but the binding changed before Cloudflare confirmed it.", 409);
    return result();
  }
}
