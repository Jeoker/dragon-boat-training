import { canonicalJson } from "../../shared/c1-rules";
import { identifier, object, requestId } from "../../shared/c1-contract";
import { SYNC_FIELD_DEFINITIONS, normalizeSyncValue } from "../../shared/c2-sync-rules";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";
import { C1Service } from "./c1-service";
import { firstRow, isRecord, parseContract, type SqlRow } from "./c1-support";
import { assertSentBatch, beginExportSend, confirmExportReceipt, recordExportFailure,
  recordExportPartial, verifyStoredPatch, type ExportBatch } from "./c2-export-batch";
import { assertBridgePatchBudget, patchGoogleScheduleRows, patchGoogleSeason,
  readGoogleSheet, schedulePatchPayload, SHEET_SCOPES,
  type ScheduleSheetScope, type SchedulePatchItem, type SchedulePatchReceipt,
  type SeasonPatchReceipt } from "./c2-sheet-bridge";
import { projectSchedulePatch, type ScheduleBaselineRow } from "./c2-schedule-projection";

interface ScheduleEvent extends SqlRow { outbox_id: string; payload_json: string;
  topic: string; due_at_ms: number; }
interface TargetRow { entity_type: ScheduleSheetScope; row_id: string;
  snapshot: Record<string, unknown>; }
interface ParsedEvent { season_version: number; rows: TargetRow[]; }
interface StoredScheduleTarget { entity_type: ScheduleSheetScope; row_id: string;
  expected: string[] | null; target: string[]; cloud_version: number;
  spreadsheet_id: string; tab_id: string; }
interface StoredSeasonTarget { season_id: string; expected: string[]; target: string[];
  season_version: number; spreadsheet_id: string; tab_id: string; }
interface SchedulePageRows { spreadsheet_id: string; tab_id: string;
  rows: Map<string, string[]>; }

const scheduleScopes = ["SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE"] as const;
const idField = { SCHEDULE_TEMPLATE: "template_id", TRAINING_WEEK: "week_id",
  PRACTICE: "practice_id" } as const;
const seasonHeaders = SHEET_SCOPES.SEASON.headers;
const seasonDefinitions = SYNC_FIELD_DEFINITIONS.SEASON;
const seasonGroups = [...new Set(seasonDefinitions.map((field) => field.dependency_group))];
const scheduleActions = new Set(["updateScheduleTemplates", "prepareTrainingWeek",
  "confirmTrainingWeek", "publishTrainingWeek", "createPractice",
  "publishAdditionalPractice", "updatePractice", "cancelPractice"]);

function parseEvent(event: ScheduleEvent, seasonId: string): ParsedEvent {
  let payload: unknown;
  try { payload = JSON.parse(event.payload_json); } catch { payload = null; }
  if (!isRecord(payload) || !scheduleActions.has(String(payload.action)) || !isRecord(payload.entity)) {
    throw new ApiError("SYNC_OUTBOX_INVALID", "The schedule event has an invalid payload.", 409);
  }
  const entity = payload.entity;
  if (entity.season_id !== seasonId || entity.snapshot_schema !== 1 ||
      !Number.isSafeInteger(entity.season_version) || Number(entity.season_version) < 1 ||
      !Array.isArray(entity.templates) || entity.templates.length > 100 ||
      !Array.isArray(entity.practices) || entity.practices.length > 100 ||
      entity.week !== null && !isRecord(entity.week)) {
    throw new ApiError("SYNC_OUTBOX_INVALID", "The schedule event lacks a complete captured snapshot.", 409);
  }
  const rows: TargetRow[] = [];
  const add = (scope: ScheduleSheetScope, value: unknown) => {
    if (!isRecord(value) || value.season_id !== seasonId ||
        typeof value[idField[scope]] !== "string" ||
        !/^[A-Za-z0-9_-]{8,128}$/u.test(value[idField[scope]] as string)) {
      throw new ApiError("SYNC_OUTBOX_INVALID", "A captured schedule row has an invalid identity.", 409);
    }
    rows.push({ entity_type: scope, row_id: value[idField[scope]] as string, snapshot: value });
  };
  entity.templates.forEach((value) => add("SCHEDULE_TEMPLATE", value));
  if (entity.week) add("TRAINING_WEEK", entity.week);
  entity.practices.forEach((value) => add("PRACTICE", value));
  if (!rows.length || entity.practices.length && !entity.week ||
      new Set(rows.map((row) => `${row.entity_type}:${row.row_id}`)).size !== rows.length ||
      rows.some((row) => row.entity_type === "PRACTICE" &&
        row.snapshot.week_id !== (entity.week as Record<string, unknown>).week_id)) {
    throw new ApiError("SYNC_OUTBOX_INVALID", "The schedule event has duplicate or disconnected rows.", 409);
  }
  return { season_version: Number(entity.season_version), rows: rows.sort((left, right) =>
    scheduleScopes.indexOf(left.entity_type) - scheduleScopes.indexOf(right.entity_type) ||
    left.row_id.localeCompare(right.row_id)) };
}

function verifiedRows(sql: SqlStorage, outboxId: string, bindingVersion: number): Set<string> {
  return new Set(sql.exec<{ entity_type: string; entity_id: string }>(
    `SELECT i.entity_type,i.entity_id FROM sync_batch_items i JOIN sync_batches b ON b.batch_id=i.batch_id
     WHERE b.first_outbox_id=? AND b.last_outbox_id=? AND b.binding_version=?
       AND b.status='CONFIRMED' AND i.status='VERIFIED'
       AND i.entity_type IN ('SCHEDULE_TEMPLATE','TRAINING_WEEK','PRACTICE')`,
    outboxId, outboxId, bindingVersion).toArray().map((row) => `${row.entity_type}:${row.entity_id}`));
}

function allRowsVerified(sql: SqlStorage, event: ScheduleEvent, seasonId: string,
  bindingVersion: number): boolean {
  const verified = verifiedRows(sql, event.outbox_id, bindingVersion);
  return parseEvent(event, seasonId).rows.every((row) => verified.has(`${row.entity_type}:${row.row_id}`));
}

function mappedGroup(scope: ScheduleSheetScope | "SEASON", record: Record<string, unknown>,
  group: string): Record<string, unknown> {
  try {
    return Object.fromEntries(SYNC_FIELD_DEFINITIONS[scope]
      .filter((field) => field.dependency_group === group)
      .map((field) => [field.field,
        normalizeSyncValue(record[field.field], field.kind, field.allowed_values)]));
  } catch {
    throw new ApiError("SYNC_MAPPING_INVALID", "A confirmed schedule value cannot be normalized.", 409);
  }
}

function cellsRecord(headers: readonly string[], cells: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
}

function assertCloudSeasonBusinessMatchesBaseline(sql: SqlStorage, seasonId: string,
  bindingVersion: number): void {
  const cloud = firstRow<SqlRow>(sql, "SELECT * FROM seasons WHERE season_id=?", seasonId);
  if (!cloud || Number(cloud.binding_version) !== bindingVersion) {
    throw new ApiError("SYNC_BINDING_STALE", "The Cloudflare season binding changed.", 409);
  }
  for (const group of seasonGroups.filter((name) => name !== "SYSTEM_VERSION")) {
    const saved = firstRow<SqlRow>(sql,
      `SELECT baseline_json FROM sync_baselines WHERE season_id=? AND binding_version=?
       AND entity_type='SEASON' AND entity_id=? AND dependency_group=?`,
      seasonId, bindingVersion, seasonId, group);
    if (!saved) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A season business baseline is missing.", 409);
    let baseline: Record<string, unknown>;
    try { baseline = JSON.parse(String(saved.baseline_json)) as Record<string, unknown>; }
    catch { throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A season business baseline is invalid.", 409); }
    const fields = seasonDefinitions.filter((field) => field.dependency_group === group)
      .map((field) => field.field).sort();
    if (!baseline || Array.isArray(baseline) ||
        canonicalJson(Object.keys(baseline).sort()) !== canonicalJson(fields) ||
        canonicalJson(mappedGroup("SEASON", cloud, group)) !==
          canonicalJson(mappedGroup("SEASON", baseline, group))) {
      throw new ApiError("SYNC_SEASON_NEEDS_REVIEW",
        "Cloudflare has an unexported season business change outside this schedule event.", 409);
    }
  }
}

export class C2ScheduleExportService {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  private remember(identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>,
    requestId: string, result: Record<string, unknown>): Record<string, unknown> {
    return this.ctx.storage.transactionSync(() => {
      const core = new C1Service(this.ctx, this.env);
      const prior = core.replayRequest(identity.requestKey, identity.payloadDigest);
      if (prior) return prior;
      core.recordRequest(identity, "C2:EXPORT", "exportNextSchedule", requestId, result,
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
    if (this.env.ENVIRONMENT === "production" || this.env.C2_SCHEDULE_EXPORT_ENABLED !== "true") {
      throw new ApiError("SCHEDULE_EXPORT_DISABLED", "The isolated schedule export is disabled.", 409);
    }
    const core = new C1Service(this.ctx, this.env);
    const identity = await core.createRequestIdentity("C2:EXPORT", "exportNextSchedule",
      input.request_id, { season_id: input.season_id });
    const replay = core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const batchId = `batch_${identity.requestKey.slice(7)}`;
    const sql = this.ctx.storage.sql;
    const ownBatch = firstRow<ExportBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batchId);
    if (ownBatch) {
      if (ownBatch.season_id !== input.season_id) throw new ApiError("IDEMPOTENCY_CONFLICT",
        "The request identifier belongs to another season.", 409);
      return this.send(ownBatch, input.request_id, identity);
    }
    const season = firstRow<SqlRow>(sql,
      "SELECT binding_version,season_version FROM seasons WHERE season_id=?", input.season_id);
    const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", input.season_id);
    if (!season || !binding || Number(season.binding_version) !== Number(binding.binding_version) ||
        Number(binding.export_paused) !== 0) {
      throw new ApiError("SYNC_EXPORT_PAUSED", "A current, unpaused season binding is required.", 409);
    }
    const unfinished = firstRow<ExportBatch>(sql,
      `SELECT * FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
       AND status IN ('PREPARED','SENT','PARTIAL','FAILED') ORDER BY created_at,batch_id LIMIT 1`,
      input.season_id);
    if (unfinished) return this.send(unfinished, input.request_id, identity);
    const event = firstRow<ScheduleEvent>(sql,
      `SELECT outbox_id,payload_json,topic,due_at_ms FROM sync_outbox
       WHERE status='PENDING' AND json_extract(payload_json,'$.entity.season_id')=?
       ORDER BY rowid LIMIT 1`, input.season_id);
    if (!event || Number(event.due_at_ms) > Date.now()) {
      return this.remember(identity, input.request_id, { season_id: input.season_id, status: "IDLE" });
    }
    if (event.topic !== "SCHEDULE_CHANGED") throw new ApiError("SYNC_OUTBOX_BLOCKED",
      "An earlier season event needs its own export handler first.", 409);
    const parsed = parseEvent(event, input.season_id);
    if (parsed.season_version > Number(season.season_version)) {
      throw new ApiError("SYNC_OUTBOX_INVALID", "The captured season version is ahead of Cloudflare.", 409);
    }
    const verified = verifiedRows(sql, event.outbox_id, Number(binding.binding_version));
    const next = parsed.rows.find((row) => !verified.has(`${row.entity_type}:${row.row_id}`));
    if (next) return this.prepareRow(event, next, binding, input.request_id, batchId, identity);
    return this.prepareSeason(event, parsed.season_version, binding, input.request_id, batchId, identity);
  }

  private async readScheduleRows(event: ScheduleEvent, binding: SqlRow, requestId: string,
    scope: ScheduleSheetScope, purpose: string): Promise<SchedulePageRows> {
    const page = await readGoogleSheet(this.env, { request_id: requestId,
      operation_id: `inspect_${(await sha256Base64Url(`${event.outbox_id}\n${purpose}\n${scope}`)).slice(0, 35)}`,
      season_id: String(binding.season_id), entity_type: scope,
      binding_version: Number(binding.binding_version),
      runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
    if (canonicalJson(page.headers) !== canonicalJson(SHEET_SCOPES[scope].headers)) {
      throw new ApiError("SHEET_STRUCTURE_INVALID", "The schedule tab columns changed.", 409);
    }
    const rows = new Map<string, string[]>();
    for (const source of page.rows) {
      const cells = source.cells;
      if (cells[0] !== binding.season_id || !/^[A-Za-z0-9_-]{8,128}$/u.test(cells[1]) ||
          rows.has(cells[1])) {
        throw new ApiError("SHEET_STRUCTURE_INVALID", "The schedule tab has an invalid row identity.", 409);
      }
      rows.set(cells[1], cells);
    }
    return { spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id, rows };
  }

  private async prepareRow(event: ScheduleEvent, row: TargetRow, binding: SqlRow,
    requestId: string, batchId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const scope = row.entity_type;
    const coachIds = scope === "TRAINING_WEEK" ? [row.snapshot.confirmed_by] :
      scope === "PRACTICE" ? [row.snapshot.cancelled_by, row.snapshot.schedule_published_by] : [];
    await this.assertCoachReferences(event, binding, requestId,
      coachIds.filter((id): id is string => typeof id === "string" && id.length > 0));
    if (scope === "PRACTICE") {
      await this.assertReference(event, binding, requestId, "TRAINING_WEEK",
        String(row.snapshot.week_id ?? ""));
      if (row.snapshot.template_id) await this.assertReference(event, binding, requestId,
        "SCHEDULE_TEMPLATE", String(row.snapshot.template_id));
    }
    const page = await this.readScheduleRows(event, binding, requestId, scope, row.row_id);
    const baselines = sql.exec<ScheduleBaselineRow>(
      `SELECT dependency_group,baseline_json,cloud_version FROM sync_baselines
       WHERE season_id=? AND binding_version=? AND entity_type=? AND entity_id=?`,
      binding.season_id, binding.binding_version, scope, row.row_id).toArray();
    const projected = projectSchedulePatch({ entity_type: scope, season_id: String(binding.season_id),
      row_id: row.row_id, snapshot: row.snapshot, google_cells: page.rows.get(row.row_id) ?? null, baselines });
    const stored: StoredScheduleTarget = { entity_type: scope, ...projected,
      spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id };
    const item: SchedulePatchItem = { row_id: stored.row_id, expected: stored.expected, target: stored.target };
    const payload = schedulePatchPayload({ season_id: String(binding.season_id), batch_id: batchId,
      entity_type: scope, spreadsheet_id: stored.spreadsheet_id, tab_id: stored.tab_id, items: [item] });
    assertBridgePatchBudget(payload);
    const payloadDigest = await sha256Base64Url(JSON.stringify(payload));
    const expectedDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(stored.expected))}`;
    const targetDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(stored.target))}`;
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const current = firstRow<SqlRow>(sql,
        "SELECT binding_version,export_paused,runtime_spreadsheet_id FROM sync_bindings WHERE season_id=?",
        binding.season_id);
      const currentSeason = firstRow<SqlRow>(sql,
        "SELECT binding_version FROM seasons WHERE season_id=?", binding.season_id);
      const currentEvent = firstRow<SqlRow>(sql,
        "SELECT status,payload_json FROM sync_outbox WHERE outbox_id=?", event.outbox_id);
      const competing = firstRow<SqlRow>(sql,
        `SELECT batch_id FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
         AND status IN ('PREPARED','SENT','PARTIAL','FAILED') LIMIT 1`, binding.season_id);
      if (!current || !currentSeason ||
          Number(current.binding_version) !== Number(binding.binding_version) ||
          Number(currentSeason.binding_version) !== Number(binding.binding_version) ||
          Number(current.export_paused) !== 0 ||
          current.runtime_spreadsheet_id !== page.spreadsheet_id ||
          currentEvent?.status !== "PENDING" || currentEvent.payload_json !== event.payload_json ||
          verifiedRows(sql, event.outbox_id, Number(binding.binding_version)).has(`${scope}:${row.row_id}`) ||
          competing || firstRow<SqlRow>(sql, "SELECT batch_id FROM sync_batches WHERE batch_id=?", batchId)) {
        throw new ApiError("SYNC_EXPORT_STALE", "The schedule export changed during inspection.", 409, true);
      }
      sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,direction,status,
        payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
        VALUES (?,?,?,?,'CLOUDFLARE_TO_GOOGLE','PREPARED',?,?,?,?,?)`,
      batchId, binding.season_id, binding.binding_version, Number(this.env.WRITER_EPOCH),
      payloadDigest, event.outbox_id, event.outbox_id, at, at).toArray();
      sql.exec(`INSERT INTO sync_batch_items(batch_id,item_index,entity_type,entity_id,dependency_group,
        expected_sheet_digest,target_json,target_digest,status,updated_at)
        VALUES (?,0,?,?,'ROW',?,?,?,'PENDING',?)`, batchId, scope, row.row_id,
      expectedDigest, JSON.stringify(stored), targetDigest, at).toArray();
    });
    return this.send(firstRow<ExportBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batchId)!,
      requestId, identity);
  }

  private async assertCoachReferences(event: ScheduleEvent, binding: SqlRow, requestId: string,
    coachIds: string[]): Promise<void> {
    if (!coachIds.length) return;
    const ids = [...new Set(coachIds)];
    if (ids.some((id) => !/^[A-Za-z0-9_-]{8,128}$/u.test(id) ||
        !firstRow<SqlRow>(this.ctx.storage.sql,
          "SELECT 1 AS present FROM coaches WHERE coach_id=?", id))) {
      throw new ApiError("SYNC_REFERENCE_MISSING", "A schedule references an unknown Coach.", 409);
    }
    const page = await readGoogleSheet(this.env, { request_id: requestId,
      operation_id: `inspect_${(await sha256Base64Url(`${event.outbox_id}\nCOACH\n${ids.join(",")}`)).slice(0, 35)}`,
      season_id: String(binding.season_id), entity_type: "COACH",
      binding_version: Number(binding.binding_version),
      runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
    if (canonicalJson(page.headers) !== canonicalJson(SHEET_SCOPES.COACH.headers)) {
      throw new ApiError("SHEET_STRUCTURE_INVALID", "The Coach tab columns changed.", 409);
    }
    for (const id of ids) {
      if (page.rows.filter((row) => row.cells[0] === id).length !== 1) {
        throw new ApiError("SYNC_REFERENCE_MISSING",
          "A referenced Coach is missing or duplicated in Google.", 409);
      }
    }
  }

  private async assertReference(event: ScheduleEvent, binding: SqlRow, requestId: string,
    scope: "TRAINING_WEEK" | "SCHEDULE_TEMPLATE", rowId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(rowId)) throw new ApiError("SYNC_REFERENCE_MISSING",
      "A training refers to an invalid schedule identity.", 409);
    const sql = this.ctx.storage.sql;
    const baselines = sql.exec<ScheduleBaselineRow>(
      `SELECT dependency_group,baseline_json,cloud_version FROM sync_baselines
       WHERE season_id=? AND binding_version=? AND entity_type=? AND entity_id=?`,
      binding.season_id, binding.binding_version, scope, rowId).toArray();
    const definitions = SYNC_FIELD_DEFINITIONS[scope];
    const groups = [...new Set(definitions.map((field) => field.dependency_group))];
    if (baselines.length !== groups.length) throw new ApiError("SYNC_REFERENCE_MISSING",
      "A training reference has no complete confirmed Google baseline.", 409);
    const page = await this.readScheduleRows(event, binding, requestId, scope, `REF\n${rowId}`);
    const cells = page.rows.get(rowId);
    if (!cells) throw new ApiError("SYNC_REFERENCE_MISSING",
      "A training reference is missing in Google.", 409);
    const observed = cellsRecord(SHEET_SCOPES[scope].headers, cells);
    for (const group of groups) {
      const saved = baselines.find((baseline) => baseline.dependency_group === group);
      if (!saved) throw new ApiError("SYNC_REFERENCE_MISSING", "A reference baseline group is missing.", 409);
      let baseline: Record<string, unknown>;
      try { baseline = JSON.parse(saved.baseline_json) as Record<string, unknown>; }
      catch { throw new ApiError("SYNC_REFERENCE_MISSING", "A reference baseline is invalid.", 409); }
      const fields = definitions.filter((field) => field.dependency_group === group)
        .map((field) => field.field).sort();
      if (!baseline || Array.isArray(baseline) ||
          canonicalJson(Object.keys(baseline).sort()) !== canonicalJson(fields) ||
          canonicalJson(mappedGroup(scope, observed, group)) !==
            canonicalJson(mappedGroup(scope, baseline, group))) {
        throw new ApiError("SYNC_REFERENCE_NEEDS_REVIEW",
          "A referenced schedule row changed in Google since confirmation.", 409);
      }
    }
  }

  private async prepareSeason(event: ScheduleEvent, eventVersion: number, binding: SqlRow,
    requestId: string, batchId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    if (!allRowsVerified(sql, event, String(binding.season_id), Number(binding.binding_version))) {
      throw new ApiError("SYNC_BATCH_INVALID", "Not all schedule rows are verified.", 409);
    }
    assertCloudSeasonBusinessMatchesBaseline(sql, String(binding.season_id),
      Number(binding.binding_version));
    await this.assertEventRowsStillVerified(event, binding, requestId);
    const page = await readGoogleSheet(this.env, { request_id: requestId,
      operation_id: `inspect_${(await sha256Base64Url(`${event.outbox_id}\nSEASON`)).slice(0, 35)}`,
      season_id: String(binding.season_id), entity_type: "SEASON",
      binding_version: Number(binding.binding_version),
      runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
    if (canonicalJson(page.headers) !== canonicalJson(seasonHeaders)) throw new ApiError("SHEET_STRUCTURE_INVALID",
      "The season tab columns changed.", 409);
    const matches = page.rows.filter((row) => row.cells[0] === binding.season_id);
    if (matches.length !== 1) throw new ApiError("SYNC_SEASON_NEEDS_REVIEW",
      "The bound season row is missing or duplicated.", 409);
    const expected = matches[0].cells;
    const observed = cellsRecord(seasonHeaders, expected);
    if (observed.form_id !== binding.form_id ||
        observed.runtime_spreadsheet_id !== binding.runtime_spreadsheet_id ||
        observed.response_sheet_id !== binding.response_sheet_id ||
        observed.binding_version !== String(binding.binding_version)) {
      throw new ApiError("SYNC_BINDING_STALE", "The Google season binding identity changed.", 409);
    }
    const baselines = sql.exec<ScheduleBaselineRow>(
      `SELECT dependency_group,baseline_json,cloud_version FROM sync_baselines
       WHERE season_id=? AND binding_version=? AND entity_type='SEASON' AND entity_id=?`,
      binding.season_id, binding.binding_version, binding.season_id).toArray();
    if (baselines.length !== seasonGroups.length) throw new ApiError("SYNC_BASELINE_INCOMPLETE",
      "The season needs every baseline group before schedule confirmation.", 409);
    for (const group of seasonGroups) {
      const saved = baselines.find((row) => row.dependency_group === group);
      if (!saved) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A season baseline is missing.", 409);
      let baseline: Record<string, unknown>;
      try { baseline = JSON.parse(saved.baseline_json) as Record<string, unknown>; }
      catch { throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A season baseline is invalid.", 409); }
      const fields = seasonDefinitions.filter((field) => field.dependency_group === group)
        .map((field) => field.field).sort();
      if (!baseline || Array.isArray(baseline) ||
          canonicalJson(Object.keys(baseline).sort()) !== canonicalJson(fields)) {
        throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A season baseline uses an older mapping.", 409);
      }
      if (canonicalJson(mappedGroup("SEASON", observed, group)) !==
          canonicalJson(mappedGroup("SEASON", baseline, group))) {
        throw new ApiError("SYNC_SEASON_NEEDS_REVIEW",
          "The Google season row changed since its baseline.", 409);
      }
    }
    if (Number(observed.season_version) > eventVersion) throw new ApiError("SYNC_VERSION_REGRESSION",
      "The Google season version is ahead of this schedule event.", 409);
    const target = [...expected];
    target[seasonHeaders.indexOf("season_version")] = String(eventVersion);
    const stored: StoredSeasonTarget = { season_id: String(binding.season_id), expected, target,
      season_version: eventVersion, spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id };
    const payload = { season_id: stored.season_id, batch_id: batchId,
      spreadsheet_id: stored.spreadsheet_id, tab_id: stored.tab_id,
      items: [{ season_id: stored.season_id, expected, target }] };
    assertBridgePatchBudget(payload);
    const payloadDigest = await sha256Base64Url(JSON.stringify(payload));
    const expectedDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(expected))}`;
    const targetDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(target))}`;
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const current = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", binding.season_id);
      const currentSeason = firstRow<SqlRow>(sql,
        "SELECT binding_version,season_version FROM seasons WHERE season_id=?", binding.season_id);
      const currentEvent = firstRow<SqlRow>(sql,
        "SELECT status,payload_json FROM sync_outbox WHERE outbox_id=?", event.outbox_id);
      const competing = firstRow<SqlRow>(sql,
        `SELECT batch_id FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
         AND status IN ('PREPARED','SENT','PARTIAL','FAILED') LIMIT 1`, binding.season_id);
      if (!current || !currentSeason || Number(current.binding_version) !== Number(binding.binding_version) ||
          Number(currentSeason.binding_version) !== Number(binding.binding_version) ||
          Number(currentSeason.season_version) < eventVersion || Number(current.export_paused) !== 0 ||
          current.runtime_spreadsheet_id !== binding.runtime_spreadsheet_id ||
          currentEvent?.status !== "PENDING" || currentEvent.payload_json !== event.payload_json ||
          !allRowsVerified(sql, event, String(binding.season_id), Number(binding.binding_version)) ||
          competing || firstRow<SqlRow>(sql, "SELECT batch_id FROM sync_batches WHERE batch_id=?", batchId)) {
        throw new ApiError("SYNC_EXPORT_STALE", "The season changed during schedule inspection.", 409, true);
      }
      sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,direction,status,
        payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
        VALUES (?,?,?,?,'CLOUDFLARE_TO_GOOGLE','PREPARED',?,?,?,?,?)`, batchId,
      binding.season_id, binding.binding_version, Number(this.env.WRITER_EPOCH), payloadDigest,
      event.outbox_id, event.outbox_id, at, at).toArray();
      sql.exec(`INSERT INTO sync_batch_items(batch_id,item_index,entity_type,entity_id,dependency_group,
        expected_sheet_digest,target_json,target_digest,status,updated_at)
        VALUES (?,0,'SEASON',?,'SYSTEM_VERSION',?,?,?,'PENDING',?)`,
      batchId, binding.season_id, expectedDigest, JSON.stringify(stored), targetDigest, at).toArray();
    });
    return this.send(firstRow<ExportBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batchId)!,
      requestId, identity);
  }

  private async assertEventRowsStillVerified(event: ScheduleEvent, binding: SqlRow,
    requestId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    const parsed = parseEvent(event, String(binding.season_id));
    for (const scope of scheduleScopes) {
      const targets = parsed.rows.filter((row) => row.entity_type === scope);
      if (!targets.length) continue;
      const page = await this.readScheduleRows(event, binding, requestId, scope, "FINAL");
      for (const target of targets) {
        const saved = firstRow<SqlRow>(sql,
          `SELECT i.target_json FROM sync_batch_items i JOIN sync_batches b ON b.batch_id=i.batch_id
           WHERE b.first_outbox_id=? AND b.last_outbox_id=? AND b.binding_version=?
             AND b.status='CONFIRMED' AND i.status='VERIFIED'
             AND i.entity_type=? AND i.entity_id=?`,
          event.outbox_id, event.outbox_id, binding.binding_version, scope, target.row_id);
        if (!saved) throw new ApiError("SYNC_BATCH_INVALID", "A confirmed schedule target is missing.", 409);
        let stored: StoredScheduleTarget;
        try { stored = JSON.parse(String(saved.target_json)) as StoredScheduleTarget; }
        catch { throw new ApiError("SYNC_BATCH_INVALID", "A confirmed schedule target is invalid.", 409); }
        if (stored.entity_type !== scope || stored.row_id !== target.row_id ||
            canonicalJson(page.rows.get(target.row_id) ?? null) !== canonicalJson(stored.target)) {
          throw new ApiError("SYNC_SCHEDULE_NEEDS_REVIEW",
            "A confirmed schedule row changed in Google before event completion.", 409);
        }
      }
    }
  }

  private async send(batch: ExportBatch, requestId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const saved = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM sync_batch_items WHERE batch_id=? AND item_index=0", batch.batch_id);
    if (!saved) throw new ApiError("SYNC_BATCH_INVALID", "The schedule batch has no target.", 409);
    if (scheduleScopes.includes(saved.entity_type as ScheduleSheetScope)) {
      return this.sendRow(batch, saved, requestId, identity);
    }
    if (saved.entity_type === "SEASON") return this.sendSeason(batch, saved, requestId, identity);
    throw new ApiError("SYNC_OUTBOX_BLOCKED", "Another export handler owns the unfinished batch.", 409);
  }

  private async sendRow(batch: ExportBatch, saved: SqlRow, requestId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    let target: StoredScheduleTarget;
    try { target = JSON.parse(String(saved.target_json)) as StoredScheduleTarget; }
    catch { throw new ApiError("SYNC_BATCH_INVALID", "The stored schedule target is invalid.", 409); }
    if (!scheduleScopes.includes(target.entity_type) || saved.entity_type !== target.entity_type ||
        saved.entity_id !== target.row_id) throw new ApiError("SYNC_BATCH_INVALID",
      "The stored schedule target identity changed.", 409);
    const result = { season_id: batch.season_id, status: "BATCH_CONFIRMED",
      batch_id: batch.batch_id, outbox_id: batch.first_outbox_id,
      entity_type: target.entity_type, row_id: target.row_id, cloud_version: target.cloud_version };
    if (batch.status === "CONFIRMED") return this.remember(identity, requestId, result);
    const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
    const season = firstRow<SqlRow>(sql, "SELECT binding_version FROM seasons WHERE season_id=?", batch.season_id);
    const event = firstRow<ScheduleEvent>(sql,
      "SELECT outbox_id,payload_json,topic FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
    if (!binding || !season || Number(binding.binding_version) !== Number(batch.binding_version) ||
        Number(season.binding_version) !== Number(batch.binding_version) ||
        String(binding.runtime_spreadsheet_id) !== target.spreadsheet_id ||
        event?.topic !== "SCHEDULE_CHANGED" ||
        firstRow<SqlRow>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id)
          ?.status !== "PENDING") {
      throw new ApiError("SYNC_BINDING_STALE", "The prepared schedule batch belongs to an old state.", 409);
    }
    const snapshot = parseEvent(event, String(batch.season_id)).rows.find((row) =>
      row.entity_type === target.entity_type && row.row_id === target.row_id);
    if (!snapshot || canonicalJson(projectSchedulePatch({ entity_type: target.entity_type,
      season_id: String(batch.season_id), row_id: target.row_id, snapshot: snapshot.snapshot,
      google_cells: null, baselines: [] }).target) !== canonicalJson(target.target)) {
      throw new ApiError("SYNC_BATCH_INVALID", "The prepared schedule target differs from its event snapshot.", 409);
    }
    const item: SchedulePatchItem = { row_id: target.row_id,
      expected: target.expected, target: target.target };
    const payload = schedulePatchPayload({ season_id: String(batch.season_id), batch_id: batch.batch_id,
      entity_type: target.entity_type, spreadsheet_id: target.spreadsheet_id,
      tab_id: target.tab_id, items: [item] });
    await verifyStoredPatch(batch, saved, payload, target.expected, target.target,
      Number(this.env.WRITER_EPOCH));
    if (beginExportSend(this.ctx, batch)) return this.remember(identity, requestId, result);
    let receipt: SchedulePatchReceipt;
    try {
      receipt = await patchGoogleScheduleRows(this.env, { request_id: requestId,
        batch_id: batch.batch_id, season_id: String(batch.season_id),
        binding_version: Number(batch.binding_version), entity_type: target.entity_type,
        spreadsheet_id: target.spreadsheet_id, tab_id: target.tab_id, items: [item] });
    } catch (error) {
      recordExportFailure(sql, batch.batch_id, error);
      throw error;
    }
    const record = cellsRecord(SHEET_SCOPES[target.entity_type].headers, target.target);
    const groups = [...new Set(SYNC_FIELD_DEFINITIONS[target.entity_type]
      .map((field) => field.dependency_group))];
    const preparedBaselines = await Promise.all(groups.map(async (group) => {
      const baseline = mappedGroup(target.entity_type, record, group);
      const digest = `sha256_v1:${await sha256Base64Url(canonicalJson(baseline))}`;
      return { group, baseline, digest };
    }));
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      const currentBinding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
      const currentSeason = firstRow<SqlRow>(sql,
        "SELECT binding_version FROM seasons WHERE season_id=?", batch.season_id);
      const currentBatch = firstRow<ExportBatch>(sql,
        "SELECT * FROM sync_batches WHERE batch_id=?", batch.batch_id);
      const currentEvent = firstRow<SqlRow>(sql,
        "SELECT status,payload_json FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
      if (currentBatch?.status === "CONFIRMED") return;
      assertSentBatch(currentBatch);
      if (!currentBinding || !currentSeason || !currentBatch ||
          Number(currentSeason.binding_version) !== Number(batch.binding_version) ||
          Number(currentBinding.binding_version) !==
          Number(batch.binding_version) || String(currentBinding.runtime_spreadsheet_id) !==
          target.spreadsheet_id || String(currentBatch.payload_digest) !== receipt.payload_digest ||
          currentEvent?.status !== "PENDING" || currentEvent.payload_json !== event.payload_json) {
        changed = true;
        recordExportPartial(sql, batch.batch_id,
          "Google verified a schedule row, but its binding or event changed before confirmation.");
        return;
      }
      const at = new Date().toISOString();
      for (const { group, baseline, digest } of preparedBaselines) {
        sql.exec(`INSERT INTO sync_baselines(season_id,binding_version,entity_type,entity_id,
          dependency_group,baseline_json,baseline_digest,cloud_version,sheet_digest,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(season_id,binding_version,entity_type,entity_id,dependency_group)
          DO UPDATE SET baseline_json=excluded.baseline_json,baseline_digest=excluded.baseline_digest,
            cloud_version=excluded.cloud_version,sheet_digest=excluded.sheet_digest,updated_at=excluded.updated_at`,
        batch.season_id, batch.binding_version, target.entity_type, target.row_id,
        group, canonicalJson(baseline), digest, target.cloud_version, digest, at).toArray();
      }
      confirmExportReceipt(sql, batch, receipt, at, "BATCH");
    });
    if (changed) throw new ApiError("SYNC_BINDING_CHANGED_AFTER_WRITE",
      "Google verified the schedule row, but its binding or event changed before confirmation.", 409);
    return this.remember(identity, requestId, result);
  }

  private async sendSeason(batch: ExportBatch, saved: SqlRow, requestId: string,
    identity: Awaited<ReturnType<C1Service["createRequestIdentity"]>>): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    let target: StoredSeasonTarget;
    try { target = JSON.parse(String(saved.target_json)) as StoredSeasonTarget; }
    catch { throw new ApiError("SYNC_BATCH_INVALID", "The stored season target is invalid.", 409); }
    if (saved.entity_id !== batch.season_id || target.season_id !== batch.season_id) {
      throw new ApiError("SYNC_BATCH_INVALID", "The stored season target identity changed.", 409);
    }
    const result = { season_id: batch.season_id, status: "EVENT_CONFIRMED",
      batch_id: batch.batch_id, outbox_id: batch.first_outbox_id,
      season_version: target.season_version };
    if (batch.status === "CONFIRMED") return this.remember(identity, requestId, result);
    const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
    const season = firstRow<SqlRow>(sql,
      "SELECT binding_version,season_version FROM seasons WHERE season_id=?", batch.season_id);
    const event = firstRow<ScheduleEvent>(sql,
      "SELECT outbox_id,payload_json,topic FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
    if (!binding || !season || Number(binding.binding_version) !== Number(batch.binding_version) ||
        Number(season.binding_version) !== Number(batch.binding_version) ||
        Number(season.season_version) < target.season_version ||
        String(binding.runtime_spreadsheet_id) !==
          target.expected[seasonHeaders.indexOf("runtime_spreadsheet_id")] ||
        event?.topic !== "SCHEDULE_CHANGED" ||
        firstRow<SqlRow>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id)
          ?.status !== "PENDING" ||
        parseEvent(event, String(batch.season_id)).season_version !== target.season_version ||
        !allRowsVerified(sql, event, String(batch.season_id), Number(batch.binding_version))) {
      throw new ApiError("SYNC_BINDING_STALE", "The prepared season batch belongs to an old event.", 409);
    }
    assertCloudSeasonBusinessMatchesBaseline(sql, String(batch.season_id), Number(batch.binding_version));
    const item = { season_id: target.season_id, expected: target.expected, target: target.target };
    const payload = { season_id: String(batch.season_id), batch_id: batch.batch_id,
      spreadsheet_id: target.spreadsheet_id, tab_id: target.tab_id, items: [item] };
    await verifyStoredPatch(batch, saved, payload, target.expected, target.target,
      Number(this.env.WRITER_EPOCH));
    await this.assertEventRowsStillVerified(event, binding, requestId);
    if (beginExportSend(this.ctx, batch)) return this.remember(identity, requestId, result);
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
    const baseline = mappedGroup("SEASON", cellsRecord(seasonHeaders, target.target), "SYSTEM_VERSION");
    const digest = `sha256_v1:${await sha256Base64Url(canonicalJson(baseline))}`;
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      const currentBinding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
      const currentSeason = firstRow<SqlRow>(sql,
        "SELECT binding_version,season_version FROM seasons WHERE season_id=?", batch.season_id);
      const currentBatch = firstRow<ExportBatch>(sql,
        "SELECT * FROM sync_batches WHERE batch_id=?", batch.batch_id);
      const currentEvent = firstRow<SqlRow>(sql,
        "SELECT status,payload_json FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
      if (currentBatch?.status === "CONFIRMED") return;
      assertSentBatch(currentBatch);
      if (!currentBinding || !currentSeason || !currentBatch ||
          Number(currentBinding.binding_version) !== Number(batch.binding_version) ||
          Number(currentSeason.binding_version) !== Number(batch.binding_version) ||
          Number(currentSeason.season_version) < target.season_version ||
          String(currentBinding.runtime_spreadsheet_id) !==
            target.expected[seasonHeaders.indexOf("runtime_spreadsheet_id")] ||
          String(currentBatch.payload_digest) !== receipt.payload_digest ||
          currentEvent?.status !== "PENDING" || currentEvent.payload_json !== event.payload_json ||
          !allRowsVerified(sql, event, String(batch.season_id), Number(batch.binding_version))) {
        changed = true;
        recordExportPartial(sql, batch.batch_id,
          "Google verified the season version, but its binding or event changed before confirmation.");
        return;
      }
      const currentBaseline = firstRow<SqlRow>(sql,
        `SELECT baseline_json FROM sync_baselines WHERE season_id=? AND binding_version=?
         AND entity_type='SEASON' AND entity_id=? AND dependency_group='SYSTEM_VERSION'`,
        batch.season_id, batch.binding_version, batch.season_id);
      if (!currentBaseline || Number((JSON.parse(String(currentBaseline.baseline_json)) as {
        season_version: number }).season_version) > target.season_version) {
        throw new ApiError("SYNC_BASELINE_INVALID", "A later season baseline cannot be replaced.", 409);
      }
      const at = new Date().toISOString();
      sql.exec(`INSERT INTO sync_baselines(season_id,binding_version,entity_type,entity_id,
        dependency_group,baseline_json,baseline_digest,cloud_version,sheet_digest,updated_at)
        VALUES (?,?,'SEASON',?,'SYSTEM_VERSION',?,?,?,?,?)
        ON CONFLICT(season_id,binding_version,entity_type,entity_id,dependency_group)
        DO UPDATE SET baseline_json=excluded.baseline_json,baseline_digest=excluded.baseline_digest,
          cloud_version=excluded.cloud_version,sheet_digest=excluded.sheet_digest,updated_at=excluded.updated_at`,
      batch.season_id, batch.binding_version, batch.season_id,
      canonicalJson(baseline), digest, target.season_version, digest, at).toArray();
      confirmExportReceipt(sql, batch, receipt, at, "EVENT");
    });
    if (changed) throw new ApiError("SYNC_BINDING_CHANGED_AFTER_WRITE",
      "Google verified the season row, but its binding or event changed before confirmation.", 409);
    return this.remember(identity, requestId, result);
  }
}
