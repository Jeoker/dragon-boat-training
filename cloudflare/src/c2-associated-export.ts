import { canonicalJson } from "../../shared/c1-rules";
import { identifier, object, requestId } from "../../shared/c1-contract";
import { SYNC_FIELD_DEFINITIONS, normalizeSyncValue } from "../../shared/c2-sync-rules";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";
import { firstRow, parseContract, type SqlRow } from "./c1-support";
import { C1Service } from "./c1-service";
import { assertExportMayPrepare } from "./c2-export-control";
import { assertSentBatch, beginExportSend, confirmExportReceipt, recordExportFailure,
  recordExportPartial, verifyStoredPatch, type ExportBatch } from "./c2-export-batch";
import { associatedPatchPayload, assertBridgePatchBudget, patchGoogleAssociatedRows,
  readGoogleSheet, SHEET_SCOPES, type AssociatedSheetScope, type AssociatedPatchReceipt } from "./c2-sheet-bridge";
import { assertAssociatedCapacity, associatedCells, associatedHeaders, parseAssociatedEvent,
  type AssociatedEvent, type AssociatedStage } from "./c2-associated-projection";

interface OutboxEvent extends SqlRow { outbox_id: string; payload_json: string; topic: string; due_at_ms: number; }
interface StoredTarget { scope: AssociatedSheetScope; row_id: string; expected: string[] | null;
  target: string[]; spreadsheet_id: string; tab_id: string; event_version: number; }
interface PageRows { spreadsheet_id: string; tab_id: string; rows: Map<string, string[]>; }
type Identity = Awaited<ReturnType<C1Service["createRequestIdentity"]>>;
const idPattern = /^[A-Za-z0-9_-]{8,128}$/u;

function physicalId(scope: AssociatedSheetScope, cells: string[]): string {
  if (scope === "SIGNUP") return `${cells[1]}:${cells[2]}`;
  if (scope === "SEAT_PLAN_CURRENT") return `${cells[1]}:${cells[2]}:${cells[3]}`;
  if (scope === "SEAT_PLAN_REVISION") return `${cells[1]}:${cells[2]}`;
  return cells[1];
}

function validPhysicalId(scope: AssociatedSheetScope, cells: string[]): boolean {
  if (!idPattern.test(cells[1])) return false;
  if (scope === "SIGNUP") return idPattern.test(cells[2]);
  if (scope === "SEAT_PLAN_CURRENT") return /^[1-9]\d*$/u.test(cells[2]) &&
    ["LEFT", "RIGHT"].includes(cells[3]);
  if (scope === "SEAT_PLAN_REVISION") return /^[1-9]\d*$/u.test(cells[2]);
  return true;
}

function groups(scope: "SIGNUP" | "SEAT_PLAN_DRAFT"): string[] {
  return [...new Set(SYNC_FIELD_DEFINITIONS[scope].map((field) => field.dependency_group))];
}

function mapped(scope: "SIGNUP" | "SEAT_PLAN_DRAFT", source: Record<string, unknown>, group: string): Record<string, unknown> {
  try {
    return Object.fromEntries(SYNC_FIELD_DEFINITIONS[scope]
      .filter((field) => field.dependency_group === group)
      .map((field) => [field.field,
        normalizeSyncValue(source[field.field], field.kind, field.allowed_values)]));
  } catch {
    throw new ApiError("SYNC_MAPPING_INVALID", "An associated snapshot cannot be normalized.", 409);
  }
}

function mappedReference(scope: "PRACTICE" | "MEMBER", source: Record<string, unknown>, group: string): Record<string, unknown> {
  try {
    return Object.fromEntries(SYNC_FIELD_DEFINITIONS[scope]
      .filter((field) => field.dependency_group === group)
      .map((field) => [field.field,
        normalizeSyncValue(source[field.field], field.kind, field.allowed_values)]));
  } catch {
    throw new ApiError("SYNC_REFERENCE_INVALID", "A referenced row cannot be normalized.", 409);
  }
}

function record(headers: readonly string[], cells: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
}

function confirmedStages(sql: SqlStorage, outboxId: string, bindingVersion: number): Map<string, StoredTarget> {
  const result = new Map<string, StoredTarget>();
  for (const item of sql.exec<SqlRow>(
    `SELECT i.entity_type,i.entity_id,i.dependency_group,i.target_json FROM sync_batch_items i
     JOIN sync_batches b ON b.batch_id=i.batch_id WHERE b.first_outbox_id=? AND b.last_outbox_id=?
     AND b.binding_version=? AND b.status='CONFIRMED' AND i.status='VERIFIED'`,
    outboxId, outboxId, bindingVersion).toArray()) {
    const scope = String(item.dependency_group) === "ROW" ? "SIGNUP" :
      String(item.dependency_group) as AssociatedSheetScope;
    if (!(["SIGNUP", "SEAT_PLAN_DRAFT", "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION"] as string[]).includes(scope)) continue;
    let target: StoredTarget;
    try { target = JSON.parse(String(item.target_json)) as StoredTarget; }
    catch { throw new ApiError("SYNC_BATCH_INVALID", "A confirmed associated target is invalid.", 409); }
    if (target.scope !== scope || target.row_id !== item.entity_id) {
      throw new ApiError("SYNC_BATCH_INVALID", "A confirmed associated target changed identity.", 409);
    }
    const key = `${scope}:${target.row_id}`;
    if (result.has(key)) throw new ApiError("SYNC_BATCH_INVALID", "An associated stage was confirmed twice.", 409);
    result.set(key, target);
  }
  return result;
}

function cursor(sql: SqlStorage, seasonId: string, bindingVersion: number, practiceId: string):
    { signup_version: number; seat_plan_version: number; published_revision: number } {
  return firstRow<{ signup_version: number; seat_plan_version: number; published_revision: number }>(sql,
    `SELECT signup_version,seat_plan_version,published_revision FROM sync_associated_cursors
     WHERE season_id=? AND binding_version=? AND practice_id=?`, seasonId, bindingVersion, practiceId) ??
    { signup_version: 0, seat_plan_version: 0, published_revision: 0 };
}

function assertCursorNext(current: ReturnType<typeof cursor>, event: AssociatedEvent): void {
  const signupDelta = event.signup_version - Number(current.signup_version);
  const seatTarget = event.seat_plan_version ?? Number(current.seat_plan_version);
  const revisionTarget = event.published_revision ?? Number(current.published_revision);
  const seatDelta = seatTarget - Number(current.seat_plan_version);
  const revisionDelta = revisionTarget - Number(current.published_revision);
  if (signupDelta !== (event.topic === "SIGNUPS_CHANGED" ? 1 : 0) ||
      seatDelta < 0 || seatDelta > 1 || revisionDelta < 0 || revisionDelta > 1 ||
      event.topic === "SEATING_CHANGED" && seatDelta + revisionDelta !== 1 ||
      event.topic === "SIGNUPS_CHANGED" && event.seating && seatDelta + revisionDelta < 1 ||
      event.topic === "SIGNUPS_CHANGED" && !event.seating && seatDelta + revisionDelta !== 0) {
    throw new ApiError("SYNC_ASSOCIATED_VERSION_GAP",
      "The associated event does not follow the last fully verified practice version.", 409);
  }
}

export class C2AssociatedExportService {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  private remember(identity: Identity, requestId: string, result: Record<string, unknown>): Record<string, unknown> {
    return this.ctx.storage.transactionSync(() => {
      const core = new C1Service(this.ctx, this.env);
      const previous = core.replayRequest(identity.requestKey, identity.payloadDigest);
      if (previous) return previous;
      core.recordRequest(identity, "C2:EXPORT", "exportNextAssociated", requestId, result,
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
    if (this.env.ENVIRONMENT === "production" || this.env.C2_ASSOCIATED_EXPORT_ENABLED !== "true") {
      throw new ApiError("ASSOCIATED_EXPORT_DISABLED", "The isolated associated export is disabled.", 409);
    }
    const core = new C1Service(this.ctx, this.env);
    const identity = await core.createRequestIdentity("C2:EXPORT", "exportNextAssociated", input.request_id,
      { season_id: input.season_id });
    const previous = core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (previous) return previous;
    const batchId = `batch_${identity.requestKey.slice(7)}`;
    const sql = this.ctx.storage.sql;
    const ownBatch = firstRow<ExportBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batchId);
    if (ownBatch) {
      if (ownBatch.season_id !== input.season_id) throw new ApiError("IDEMPOTENCY_CONFLICT",
        "This request belongs to another season.", 409);
      return this.send(ownBatch, input.request_id, identity);
    }
    const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", input.season_id);
    const season = firstRow<SqlRow>(sql, "SELECT binding_version FROM seasons WHERE season_id=?", input.season_id);
    if (!binding || !season || Number(binding.binding_version) !== Number(season.binding_version) ||
        Number(binding.export_paused) !== 0) throw new ApiError("SYNC_EXPORT_PAUSED",
      "A current, unpaused season binding is required.", 409);
    const unfinished = firstRow<ExportBatch>(sql,
      `SELECT * FROM sync_batches WHERE season_id=? AND direction='CLOUDFLARE_TO_GOOGLE'
       AND status IN ('PREPARED','SENT','PARTIAL','FAILED') ORDER BY created_at,batch_id LIMIT 1`, input.season_id);
    if (unfinished) return this.send(unfinished, input.request_id, identity);
    assertExportMayPrepare(sql, input.season_id);
    const outbox = firstRow<OutboxEvent>(sql,
      `SELECT outbox_id,payload_json,topic,due_at_ms FROM sync_outbox WHERE status='PENDING'
       AND json_extract(payload_json,'$.entity.season_id')=? ORDER BY rowid LIMIT 1`, input.season_id);
    if (!outbox || Number(outbox.due_at_ms) > Date.now()) return this.remember(identity,
      input.request_id, { season_id: input.season_id, status: "IDLE" });
    if (outbox.topic !== "SIGNUPS_CHANGED" && outbox.topic !== "SEATING_CHANGED") {
      throw new ApiError("SYNC_OUTBOX_BLOCKED", "An earlier season event needs its own export handler.", 409);
    }
    const event = parseAssociatedEvent(outbox.topic, outbox.payload_json, input.season_id);
    this.assertPractice(sql, event);
    assertCursorNext(cursor(sql, input.season_id, Number(binding.binding_version), event.practice_id), event);
    const confirmed = confirmedStages(sql, outbox.outbox_id, Number(binding.binding_version));
    const nextIndex = event.stages.findIndex((stage) => !confirmed.has(`${stage.entity_type}:${stage.row_id}`));
    if (nextIndex < 0) return this.finalize(outbox, event, binding, input.request_id, identity);
    const scope = event.stages[nextIndex].entity_type;
    const stages: AssociatedStage[] = [];
    for (const stage of event.stages.slice(nextIndex)) {
      if (stage.entity_type !== scope || confirmed.has(`${scope}:${stage.row_id}`) || stages.length === 4) break;
      stages.push(stage);
    }
    return this.prepare(outbox, event, stages, binding, input.request_id, batchId, identity);
  }

  private assertPractice(sql: SqlStorage, event: AssociatedEvent): void {
    const practice = firstRow<SqlRow>(sql,
      `SELECT p.season_id,p.practice_id,p.practice_version,p.left_capacity,p.right_capacity,
       v.signup_version,v.seat_plan_version,v.published_revision
       FROM practices p JOIN practice_versions v ON v.season_id=p.season_id AND v.practice_id=p.practice_id
       WHERE p.season_id=? AND p.practice_id=?`, event.season_id, event.practice_id);
    if (!practice || Number(practice.practice_version) < event.practice_version ||
        Number(practice.signup_version) < event.signup_version ||
        event.seat_plan_version !== null && Number(practice.seat_plan_version) < event.seat_plan_version ||
        event.published_revision !== null && Number(practice.published_revision) < event.published_revision) {
      throw new ApiError("SYNC_ASSOCIATED_STALE", "The captured practice is missing or ahead of Cloudflare.", 409);
    }
    assertAssociatedCapacity(event, practice);
    for (const stage of event.stages.filter((item) => item.entity_type === "SIGNUP")) {
      for (const group of groups("SIGNUP")) mapped("SIGNUP", stage.values, group);
      if (!Number.isFinite(Date.parse(String(stage.values.updated_at)))) {
        throw new ApiError("SYNC_ASSOCIATED_INVALID", "A signup snapshot has an invalid update time.", 409);
      }
      if (!firstRow<SqlRow>(sql,
        "SELECT 1 AS present FROM signups WHERE season_id=? AND practice_id=? AND member_id=?",
        event.season_id, event.practice_id, String(stage.values.member_id))) {
        throw new ApiError("SYNC_ASSOCIATED_STALE", "A captured signup lost its local identity.", 409);
      }
    }
    if (event.seating && !firstRow<SqlRow>(sql,
      "SELECT 1 AS present FROM seat_plan_states WHERE season_id=? AND practice_id=?",
      event.season_id, event.practice_id)) {
      throw new ApiError("SYNC_ASSOCIATED_STALE", "The captured seating state lost its local identity.", 409);
    }
    const revision = event.seating?.revision as Record<string, unknown> | null | undefined;
    if (event.seating) {
      const state = event.seating.state as Record<string, unknown>;
      if (!Number.isFinite(Date.parse(String(state.updated_at)))) {
        throw new ApiError("SYNC_ASSOCIATED_INVALID", "A seating snapshot has an invalid update time.", 409);
      }
      const source = { ...state, seats: event.seating.draft_seats ?? [] };
      for (const group of groups("SEAT_PLAN_DRAFT").filter((item) => item !== "SEATING_DRAFT")) {
        mapped("SEAT_PLAN_DRAFT", source, group);
      }
    }
    if (revision) {
      if (!Number.isFinite(Date.parse(String(revision.published_at)))) {
        throw new ApiError("SYNC_ASSOCIATED_INVALID", "A revision snapshot has an invalid publish time.", 409);
      }
      const captured = firstRow<SqlRow>(sql,
        `SELECT revision_id,source,seat_plan_version FROM seat_plan_revisions
         WHERE season_id=? AND practice_id=? AND revision_number=?`,
        event.season_id, event.practice_id, Number(revision.revision_number));
      if (!captured || captured.revision_id !== revision.revision_id ||
          captured.source !== revision.source ||
          Number(captured.seat_plan_version) !== Number(revision.seat_plan_version)) {
        throw new ApiError("SYNC_ASSOCIATED_STALE", "The captured revision lost its immutable local identity.", 409);
      }
    }
    const reference = firstRow<SqlRow>(sql,
      `SELECT 1 AS present FROM sync_baselines WHERE season_id=? AND entity_type='PRACTICE'
       AND entity_id=? AND dependency_group='IDENTITY'`, event.season_id, event.practice_id);
    if (!reference) throw new ApiError("SYNC_REFERENCE_MISSING",
      "The practice needs a confirmed Google baseline before associated export.", 409);
  }

  private async readRows(outbox: OutboxEvent, binding: SqlRow, requestId: string,
    scope: AssociatedSheetScope, purpose: string): Promise<PageRows> {
    const page = await readGoogleSheet(this.env, { request_id: requestId,
      operation_id: `inspect_${(await sha256Base64Url(`${outbox.outbox_id}\n${scope}\n${purpose}`)).slice(0, 35)}`,
      season_id: String(binding.season_id), entity_type: scope,
      binding_version: Number(binding.binding_version),
      runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
    if (canonicalJson(page.headers) !== canonicalJson(associatedHeaders(scope))) {
      throw new ApiError("SHEET_STRUCTURE_INVALID", "An associated tab's columns changed.", 409);
    }
    const rows = new Map<string, string[]>();
    for (const source of page.rows) {
      const cells = source.cells;
      if (cells[0] !== binding.season_id || !validPhysicalId(scope, cells)) {
        throw new ApiError("SHEET_STRUCTURE_INVALID", "An associated tab has an invalid row identity.", 409);
      }
      const id = physicalId(scope, cells);
      if (rows.has(id)) throw new ApiError("SHEET_STRUCTURE_INVALID",
        "An associated tab has duplicate row identities.", 409);
      rows.set(id, cells);
    }
    return { spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id, rows };
  }

  private assertRowBeforePatch(sql: SqlStorage, stage: AssociatedStage, expected: string[] | null,
    bindingVersion: number, seasonId: string): void {
    const scope = stage.entity_type;
    const physical = firstRow<SqlRow>(sql,
      `SELECT cells_json FROM sync_associated_physical_baselines WHERE season_id=?
       AND binding_version=? AND scope=? AND row_id=?`,
      seasonId, bindingVersion, scope, stage.row_id);
    if (physical) {
      let cells: unknown;
      try { cells = JSON.parse(String(physical.cells_json)); }
      catch { throw new ApiError("SYNC_BASELINE_INCOMPLETE", "A physical row baseline is invalid.", 409); }
      if (canonicalJson(expected) !== canonicalJson(cells)) {
        throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
          "A Google associated row differs from its full confirmed row baseline.", 409);
      }
    } else if (expected && scope !== "SEAT_PLAN_REVISION") {
      throw new ApiError("SYNC_BASELINE_INCOMPLETE",
        "An existing Google row has no full physical baseline; controlled bootstrap is required.", 409);
    }
    if (scope === "SEAT_PLAN_REVISION") {
      if (expected) throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
        "A published revision already exists outside a confirmed batch.", 409);
      return;
    }
    if (scope === "SEAT_PLAN_CURRENT") {
      const baseline = firstRow<SqlRow>(sql,
        `SELECT baseline_json FROM sync_baselines WHERE season_id=? AND binding_version=?
         AND entity_type='SEAT_PLAN_DRAFT' AND entity_id=? AND dependency_group='SEATING_DRAFT'`,
        seasonId, bindingVersion, String(stage.values.practice_id));
      if (!baseline) {
        if (expected) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "An existing seat has no draft baseline.", 409);
        return;
      }
      const seats = (JSON.parse(String(baseline.baseline_json)) as { seats?: unknown }).seats;
      const version = firstRow<SqlRow>(sql,
        `SELECT baseline_json FROM sync_baselines WHERE season_id=? AND binding_version=?
         AND entity_type='SEAT_PLAN_DRAFT' AND entity_id=? AND dependency_group='SYSTEM_VERSION'`,
        seasonId, bindingVersion, String(stage.values.practice_id));
      if (!Array.isArray(seats)) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "The seat baseline is incomplete.", 409);
      if (!version) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "The seat version baseline is missing.", 409);
      const baselineVersion = Number((JSON.parse(String(version.baseline_json)) as {
        seat_plan_version?: unknown }).seat_plan_version);
      if (!Number.isSafeInteger(baselineVersion)) throw new ApiError("SYNC_BASELINE_INCOMPLETE",
        "The seat version baseline is invalid.", 409);
      const prior = seats.find((seat) => seat && typeof seat === "object" &&
        (seat as Record<string, unknown>).side === stage.values.side &&
        Number((seat as Record<string, unknown>).row_number) === Number(stage.values.row_number)) as
        Record<string, unknown> | undefined;
      if (prior && (!expected || expected[4] !== String(prior.member_id ?? "") ||
          Number(expected[5]) !== baselineVersion) ||
          !prior && expected) throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
        "The Google seat differs from the last confirmed draft.", 409);
      return;
    }
    const logical = scope === "SIGNUP" ? "SIGNUP" : "SEAT_PLAN_DRAFT";
    const baselines = sql.exec<SqlRow>(
      `SELECT dependency_group,baseline_json,cloud_version FROM sync_baselines WHERE season_id=?
       AND binding_version=? AND entity_type=? AND entity_id=?`,
      seasonId, bindingVersion, logical, stage.row_id).toArray();
    if (!expected) {
      if (baselines.length) throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
        "A previously confirmed associated row is missing in Google.", 409);
      return;
    }
    if (baselines.length !== groups(logical).length) throw new ApiError("SYNC_BASELINE_INCOMPLETE",
      "An existing associated row needs every baseline group.", 409);
    const observed = record(associatedHeaders(scope), expected);
    for (const group of groups(logical)) {
      const saved = baselines.find((row) => row.dependency_group === group);
      if (!saved) throw new ApiError("SYNC_BASELINE_INCOMPLETE", "An associated baseline group is missing.", 409);
      const baseline = JSON.parse(String(saved.baseline_json)) as Record<string, unknown>;
      if (group === "SEATING_DRAFT") {
        // Seat cells were already checked against the same composite B, one row at a time.
        if (observed.coach_member_id !== String(baseline.coach_member_id ?? "") ||
            observed.steerer_member_id !== String(baseline.steerer_member_id ?? "")) {
          throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW", "Google changed the seat-plan roles.", 409);
        }
      } else if (canonicalJson(mapped(logical, observed, group)) !== canonicalJson(baseline)) {
        throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW", "Google changed an associated baseline field.", 409);
      }
      if (Number(saved.cloud_version) > stage.version) throw new ApiError("SYNC_VERSION_REGRESSION",
        "A confirmed associated baseline is ahead of this event.", 409);
    }
  }

  private async prepare(outbox: OutboxEvent, event: AssociatedEvent, stages: AssociatedStage[],
    binding: SqlRow, requestId: string, batchId: string, identity: Identity): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const scope = stages[0].entity_type;
    const page = await this.readRows(outbox, binding, requestId, scope, stages[0].row_id);
    const stored: StoredTarget[] = [];
    for (const stage of stages) {
      const expected = page.rows.get(stage.row_id) ?? null;
      this.assertRowBeforePatch(sql, stage, expected, Number(binding.binding_version), event.season_id);
      const target = associatedCells(stage, expected);
      if (physicalId(scope, target) !== stage.row_id || target[0] !== event.season_id) {
        throw new ApiError("SYNC_ASSOCIATED_INVALID", "The captured associated row changed identity.", 409);
      }
      const candidate: StoredTarget = { scope, row_id: stage.row_id, expected, target,
        spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id, event_version: stage.version };
      const attempt = [...stored, candidate];
      const attemptPayload = associatedPatchPayload({ season_id: event.season_id, batch_id: batchId,
        entity_type: scope, spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id,
        items: attempt.map((item) => ({ row_id: item.row_id, expected: item.expected, target: item.target })) });
      try { assertBridgePatchBudget(attemptPayload); }
      catch (error) { if (!stored.length) throw error; break; }
      stored.push(candidate);
    }
    const payload = associatedPatchPayload({ season_id: event.season_id, batch_id: batchId,
      entity_type: scope, spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id,
      items: stored.map((item) => ({ row_id: item.row_id, expected: item.expected, target: item.target })) });
    assertBridgePatchBudget(payload);
    const digest = await sha256Base64Url(JSON.stringify(payload));
    const items = await Promise.all(stored.map(async (item) => ({ item,
      expectedDigest: `sha256_v1:${await sha256Base64Url(canonicalJson(item.expected))}`,
      targetDigest: `sha256_v1:${await sha256Base64Url(canonicalJson(item.target))}` })));
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      assertExportMayPrepare(sql, event.season_id);
      const currentBinding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", event.season_id);
      const currentOutbox = firstRow<SqlRow>(sql, "SELECT status,payload_json FROM sync_outbox WHERE outbox_id=?", outbox.outbox_id);
      if (!currentBinding || Number(currentBinding.binding_version) !== Number(binding.binding_version) ||
          Number(currentBinding.export_paused) !== 0 ||
          String(currentBinding.runtime_spreadsheet_id) !== page.spreadsheet_id ||
          currentOutbox?.status !== "PENDING" || currentOutbox.payload_json !== outbox.payload_json ||
          firstRow<SqlRow>(sql, `SELECT batch_id FROM sync_batches WHERE season_id=?
            AND direction='CLOUDFLARE_TO_GOOGLE' AND status IN ('PREPARED','SENT','PARTIAL','FAILED')`,
            event.season_id) ||
          stored.some((item) => confirmedStages(sql, outbox.outbox_id,
            Number(binding.binding_version)).has(`${item.scope}:${item.row_id}`))) {
        throw new ApiError("SYNC_EXPORT_STALE", "The associated export changed during inspection.", 409, true);
      }
      assertCursorNext(cursor(sql, event.season_id, Number(binding.binding_version), event.practice_id), event);
      sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,direction,status,
        payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
        VALUES (?,?,?,?,'CLOUDFLARE_TO_GOOGLE','PREPARED',?,?,?,?,?)`,
      batchId, event.season_id, binding.binding_version, Number(this.env.WRITER_EPOCH),
      digest, outbox.outbox_id, outbox.outbox_id, at, at).toArray();
      for (const [index, item] of items.entries()) {
        const logical = item.item.scope === "SIGNUP" ? "SIGNUP" : "SEAT_PLAN_DRAFT";
        sql.exec(`INSERT INTO sync_batch_items(batch_id,item_index,entity_type,entity_id,dependency_group,
          expected_sheet_digest,target_json,target_digest,status,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'PENDING',?)`, batchId, index, logical, item.item.row_id,
        item.item.scope, item.expectedDigest, JSON.stringify(item.item), item.targetDigest, at).toArray();
      }
    });
    return this.send(firstRow<ExportBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batchId)!,
      requestId, identity);
  }

  private async assertReferences(outbox: OutboxEvent, event: AssociatedEvent, binding: SqlRow,
    requestId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    const practicePage = await readGoogleSheet(this.env, { request_id: requestId,
      operation_id: `inspect_${(await sha256Base64Url(`${outbox.outbox_id}\nPRACTICE_REF`)).slice(0, 35)}`,
      season_id: event.season_id, entity_type: "PRACTICE",
      binding_version: Number(binding.binding_version),
      runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
    if (canonicalJson(practicePage.headers) !== canonicalJson(SHEET_SCOPES.PRACTICE.headers)) {
      throw new ApiError("SHEET_STRUCTURE_INVALID", "The practice reference tab changed.", 409);
    }
    const practiceRows = practicePage.rows.filter((row) => row.cells[1] === event.practice_id &&
      row.cells[0] === event.season_id);
    if (practiceRows.length !== 1) throw new ApiError("SYNC_REFERENCE_MISSING",
      "The referenced practice is missing or duplicated in Google.", 409);
    this.assertReferenceBaseline("PRACTICE", event.practice_id, practiceRows[0].cells,
      Number(binding.binding_version), event.season_id);
    const memberIds = new Set<string>();
    for (const stage of event.stages) {
      if (stage.entity_type === "SIGNUP") memberIds.add(String(stage.values.member_id));
      if (stage.entity_type === "SEAT_PLAN_CURRENT" && stage.values.member_id) {
        memberIds.add(String(stage.values.member_id));
      }
    }
    const seating = event.seating;
    const state = seating?.state as Record<string, unknown> | undefined;
    for (const id of [state?.coach_member_id, state?.steerer_member_id]) if (id) memberIds.add(String(id));
    const revision = seating?.revision as Record<string, unknown> | null | undefined;
    if (revision) {
      for (const item of revision.seats as Array<Record<string, unknown>>) memberIds.add(String(item.member_id));
      for (const item of revision.names as Array<Record<string, unknown>>) memberIds.add(String(item.member_id));
    }
    const actorIds = [state?.updated_by, revision?.published_by].filter((id): id is string =>
      typeof id === "string" && id.length > 0);
    for (const id of actorIds) {
      if (!firstRow<SqlRow>(sql, "SELECT 1 AS present FROM coaches WHERE coach_id=?", id)) memberIds.add(id);
    }
    if (memberIds.size) {
      const page = await readGoogleSheet(this.env, { request_id: requestId,
        operation_id: `inspect_${(await sha256Base64Url(`${outbox.outbox_id}\nMEMBER_REF`)).slice(0, 35)}`,
        season_id: event.season_id, entity_type: "MEMBER",
        binding_version: Number(binding.binding_version),
        runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
      if (canonicalJson(page.headers) !== canonicalJson(SHEET_SCOPES.MEMBER.headers)) {
        throw new ApiError("SHEET_STRUCTURE_INVALID", "The member reference tab changed.", 409);
      }
      for (const id of memberIds) {
        if (!idPattern.test(id) || !firstRow<SqlRow>(sql,
          "SELECT 1 AS present FROM members WHERE season_id=? AND member_id=?", event.season_id, id)) {
          throw new ApiError("SYNC_REFERENCE_MISSING", "A referenced member is missing in Cloudflare.", 409);
        }
        const rows = page.rows.filter((row) => row.cells[0] === event.season_id && row.cells[1] === id);
        if (rows.length !== 1) throw new ApiError("SYNC_REFERENCE_MISSING",
          "A referenced member is missing or duplicated in Google.", 409);
        this.assertReferenceBaseline("MEMBER", id, rows[0].cells,
          Number(binding.binding_version), event.season_id);
      }
    }
    const coachIds = actorIds.filter((id) => Boolean(firstRow<SqlRow>(sql,
      "SELECT 1 AS present FROM coaches WHERE coach_id=?", id)));
    if (coachIds.length) {
      const page = await readGoogleSheet(this.env, { request_id: requestId,
        operation_id: `inspect_${(await sha256Base64Url(`${outbox.outbox_id}\nCOACH_REF`)).slice(0, 35)}`,
        season_id: event.season_id, entity_type: "COACH",
        binding_version: Number(binding.binding_version),
        runtime_spreadsheet_id: String(binding.runtime_spreadsheet_id) });
      if (canonicalJson(page.headers) !== canonicalJson(SHEET_SCOPES.COACH.headers)) {
        throw new ApiError("SHEET_STRUCTURE_INVALID", "The Coach reference tab changed.", 409);
      }
      for (const id of new Set(coachIds)) {
        if (!idPattern.test(id) || !firstRow<SqlRow>(sql,
          "SELECT 1 AS present FROM coaches WHERE coach_id=?", id) ||
          page.rows.filter((row) => row.cells[0] === id).length !== 1) {
          throw new ApiError("SYNC_REFERENCE_MISSING", "A referenced Coach is missing.", 409);
        }
      }
    }
  }

  private assertReferenceBaseline(scope: "PRACTICE" | "MEMBER", rowId: string, cells: string[],
    bindingVersion: number, seasonId: string): void {
    const sql = this.ctx.storage.sql;
    const records = sql.exec<SqlRow>(
      `SELECT dependency_group,baseline_json FROM sync_baselines WHERE season_id=?
       AND binding_version=? AND entity_type=? AND entity_id=?`,
      seasonId, bindingVersion, scope, rowId).toArray();
    const all = [...new Set(SYNC_FIELD_DEFINITIONS[scope].map((field) => field.dependency_group))];
    if (records.length !== all.length) throw new ApiError("SYNC_BASELINE_INCOMPLETE",
      "A referenced row needs every confirmed baseline group.", 409);
    const observed = record(SHEET_SCOPES[scope].headers, cells);
    for (const group of all) {
      const saved = records.find((item) => item.dependency_group === group);
      if (!saved || canonicalJson(mappedReference(scope, observed, group)) !==
          canonicalJson(JSON.parse(String(saved.baseline_json)))) {
        throw new ApiError("SYNC_REFERENCE_NEEDS_REVIEW",
          "A referenced Google row differs from its confirmed baseline.", 409);
      }
    }
  }

  private async assertDraftBeforeWrite(outbox: OutboxEvent, event: AssociatedEvent, binding: SqlRow,
    requestId: string, requireBaseline: boolean): Promise<void> {
    const sql = this.ctx.storage.sql;
    const baseline = firstRow<SqlRow>(sql,
      `SELECT baseline_json FROM sync_baselines WHERE season_id=? AND binding_version=?
       AND entity_type='SEAT_PLAN_DRAFT' AND entity_id=? AND dependency_group='SEATING_DRAFT'`,
      event.season_id, binding.binding_version, event.practice_id);
    const version = firstRow<SqlRow>(sql,
      `SELECT baseline_json FROM sync_baselines WHERE season_id=? AND binding_version=?
       AND entity_type='SEAT_PLAN_DRAFT' AND entity_id=? AND dependency_group='SYSTEM_VERSION'`,
      event.season_id, binding.binding_version, event.practice_id);
    if ((!baseline || !version) && requireBaseline) throw new ApiError("SYNC_BASELINE_INCOMPLETE",
      "A revision-only event requires a confirmed draft baseline.", 409);
    if (Boolean(baseline) !== Boolean(version)) throw new ApiError("SYNC_BASELINE_INCOMPLETE",
      "The draft baseline is only partly initialized.", 409);
    const page = await this.readRows(outbox, binding, requestId, "SEAT_PLAN_CURRENT", "DRAFT_PREFLIGHT");
    const current = [...page.rows.entries()].filter(([id]) => id.startsWith(`${event.practice_id}:`));
    if (!baseline || !version) {
      if (current.length) throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
        "Google has draft seats without a confirmed baseline.", 409);
      return;
    }
    const seats = (JSON.parse(String(baseline.baseline_json)) as { seats?: unknown }).seats;
    const seatVersion = Number((JSON.parse(String(version.baseline_json)) as { seat_plan_version?: unknown }).seat_plan_version);
    if (!Array.isArray(seats) || !Number.isSafeInteger(seatVersion)) {
      throw new ApiError("SYNC_BASELINE_INCOMPLETE", "The confirmed draft baseline is invalid.", 409);
    }
    if (current.length !== seats.length) throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
      "Google draft seat cells differ from the confirmed baseline.", 409);
    for (const seat of seats) {
      const item = seat as Record<string, unknown>;
      const rowId = `${event.practice_id}:${item.row_number}:${item.side}`;
      const row = page.rows.get(rowId);
      if (!row || row[4] !== String(item.member_id ?? "") || Number(row[5]) !== seatVersion) {
        throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
          "Google draft seat cells differ from the confirmed baseline.", 409);
      }
      const physical = firstRow<SqlRow>(sql,
        `SELECT cells_json FROM sync_associated_physical_baselines WHERE season_id=?
         AND binding_version=? AND scope='SEAT_PLAN_CURRENT' AND row_id=?`,
        event.season_id, binding.binding_version, rowId);
      if (!physical || canonicalJson(row) !== String(physical.cells_json)) {
        throw new ApiError("SYNC_BASELINE_INCOMPLETE",
          "A confirmed draft seat has no matching full physical baseline.", 409);
      }
    }
  }

  private async send(batch: ExportBatch, requestId: string, identity: Identity): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const saved = sql.exec<SqlRow>(
      "SELECT * FROM sync_batch_items WHERE batch_id=? ORDER BY item_index", batch.batch_id).toArray();
    if (!saved.length || saved.length > 4) throw new ApiError("SYNC_BATCH_INVALID",
      "The associated batch has no bounded targets.", 409);
    const stored: StoredTarget[] = saved.map((item) => {
      try { return JSON.parse(String(item.target_json)) as StoredTarget; }
      catch { throw new ApiError("SYNC_BATCH_INVALID", "A stored associated target is invalid.", 409); }
    });
    const scope = stored[0].scope;
    if (!(["SIGNUP", "SEAT_PLAN_DRAFT", "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION"] as string[])
      .includes(scope) || new Set(stored.map((item) => item.row_id)).size !== stored.length ||
      stored.some((item, index) => item.scope !== scope || saved[index].item_index !== index ||
        saved[index].dependency_group !== item.scope || saved[index].entity_id !== item.row_id ||
        saved[index].entity_type !== (scope === "SIGNUP" ? "SIGNUP" : "SEAT_PLAN_DRAFT") ||
        item.spreadsheet_id !== stored[0].spreadsheet_id || item.tab_id !== stored[0].tab_id)) {
      throw new ApiError("SYNC_BATCH_INVALID", "The associated batch targets changed identity.", 409);
    }
    const result = { season_id: batch.season_id, status: "BATCH_CONFIRMED",
      batch_id: batch.batch_id, outbox_id: batch.first_outbox_id,
      entity_type: scope, row_id: stored[0].row_id,
      row_ids: stored.map((item) => item.row_id), cloud_version: stored[0].event_version };
    if (batch.status === "CONFIRMED") return this.remember(identity, requestId, result);
    const binding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
    const season = firstRow<SqlRow>(sql, "SELECT binding_version FROM seasons WHERE season_id=?", batch.season_id);
    const outbox = firstRow<OutboxEvent>(sql,
      "SELECT outbox_id,payload_json,topic,due_at_ms FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
    if (!binding || !season || !outbox || Number(binding.binding_version) !== Number(batch.binding_version) ||
        Number(season.binding_version) !== Number(batch.binding_version) ||
        String(binding.runtime_spreadsheet_id) !== stored[0].spreadsheet_id ||
        firstRow<SqlRow>(sql, "SELECT status FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id)
          ?.status !== "PENDING") throw new ApiError("SYNC_BINDING_STALE",
      "The prepared associated batch belongs to an old binding or event.", 409);
    const event = parseAssociatedEvent(outbox.topic, outbox.payload_json, batch.season_id);
    for (const item of stored) {
      const stage = event.stages.find((value) => value.entity_type === scope && value.row_id === item.row_id);
      if (!stage || canonicalJson(associatedCells(stage, item.expected)) !== canonicalJson(item.target)) {
        throw new ApiError("SYNC_BATCH_INVALID", "A prepared target differs from its immutable event.", 409);
      }
    }
    this.assertPractice(sql, event);
    assertCursorNext(cursor(sql, batch.season_id, Number(batch.binding_version), event.practice_id), event);
    const patch = stored.map((item) => ({ row_id: item.row_id, expected: item.expected, target: item.target }));
    const payload = associatedPatchPayload({ season_id: batch.season_id, batch_id: batch.batch_id,
      entity_type: scope, spreadsheet_id: stored[0].spreadsheet_id,
      tab_id: stored[0].tab_id, items: patch });
    for (const [index, item] of stored.entries()) {
      await verifyStoredPatch(batch, saved[index], payload, item.expected, item.target,
        Number(this.env.WRITER_EPOCH));
    }
    // A prior send may already have written some or all target cells before losing its reply.
    // Reuse its immutable operation ID; the bridge receipt owns recovery of that batch.
    if (batch.status === "PREPARED") {
      const confirmed = confirmedStages(sql, outbox.outbox_id, Number(batch.binding_version));
      if (confirmed.size === 0) await this.assertReferences(outbox, event, binding, requestId);
      if (event.seating && scope !== "SIGNUP" &&
          ![...confirmed.keys()].some((key) => key.startsWith("SEAT_PLAN_"))) {
        await this.assertDraftBeforeWrite(outbox, event, binding, requestId,
          event.seating.draft_seats === null);
      }
    }
    if (beginExportSend(this.ctx, batch)) return this.remember(identity, requestId, result);
    let receipt: AssociatedPatchReceipt;
    try {
      receipt = await patchGoogleAssociatedRows(this.env, { request_id: requestId,
        batch_id: batch.batch_id, season_id: batch.season_id,
        binding_version: Number(batch.binding_version), entity_type: scope,
        spreadsheet_id: stored[0].spreadsheet_id, tab_id: stored[0].tab_id, items: patch });
    } catch (error) { recordExportFailure(sql, batch.batch_id, error); throw error; }
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      const currentBatch = firstRow<ExportBatch>(sql, "SELECT * FROM sync_batches WHERE batch_id=?", batch.batch_id);
      const currentBinding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", batch.season_id);
      const currentOutbox = firstRow<SqlRow>(sql, "SELECT status,payload_json FROM sync_outbox WHERE outbox_id=?", batch.first_outbox_id);
      if (currentBatch?.status === "CONFIRMED") return;
      assertSentBatch(currentBatch);
      if (!currentBinding || Number(currentBinding.binding_version) !== Number(batch.binding_version) ||
          String(currentBinding.runtime_spreadsheet_id) !== stored[0].spreadsheet_id ||
          String(currentBatch!.payload_digest) !== receipt.payload_digest ||
          currentOutbox?.status !== "PENDING" || currentOutbox.payload_json !== outbox.payload_json) {
        changed = true;
        recordExportPartial(sql, batch.batch_id,
          "Google verified an associated row, but its binding or event changed before confirmation.");
        return;
      }
      confirmExportReceipt(sql, batch, receipt, new Date().toISOString(), "BATCH", stored.length);
    });
    if (changed) throw new ApiError("SYNC_BINDING_CHANGED_AFTER_WRITE",
      "Google verified an associated row, but its binding or event changed before confirmation.", 409);
    return this.remember(identity, requestId, result);
  }

  private async finalize(outbox: OutboxEvent, event: AssociatedEvent, binding: SqlRow,
    requestId: string, identity: Identity): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    await this.assertReferences(outbox, event, binding, requestId);
    if (event.seating && event.seating.draft_seats === null) {
      await this.assertDraftBeforeWrite(outbox, event, binding, requestId, true);
    }
    const verified = confirmedStages(sql, outbox.outbox_id, Number(binding.binding_version));
    const pages = new Map<AssociatedSheetScope, PageRows>();
    for (const stage of event.stages) {
      const key = `${stage.entity_type}:${stage.row_id}`;
      const target = verified.get(key);
      if (!target) throw new ApiError("SYNC_BATCH_INVALID", "An associated stage has no verified receipt.", 409);
      let page = pages.get(stage.entity_type);
      if (!page) {
        page = await this.readRows(outbox, binding, requestId, stage.entity_type, "FINAL");
        pages.set(stage.entity_type, page);
      }
      if (page.spreadsheet_id !== target.spreadsheet_id || page.tab_id !== target.tab_id ||
          canonicalJson(page.rows.get(stage.row_id) ?? null) !== canonicalJson(target.target)) {
        throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
          "A previously verified associated row changed in Google before event completion.", 409);
      }
    }
    if (event.seating && Array.isArray(event.seating.draft_seats)) {
      const seats = pages.get("SEAT_PLAN_CURRENT");
      const targets = event.stages.filter((stage) => stage.entity_type === "SEAT_PLAN_CURRENT");
      const actual = [...(seats?.rows.keys() ?? [])].filter((id) => id.startsWith(`${event.practice_id}:`));
      if (!seats || actual.length !== targets.length ||
          actual.some((id) => !targets.some((stage) => stage.row_id === id))) {
        throw new ApiError("SYNC_ASSOCIATED_NEEDS_REVIEW",
          "The final Google draft contains an extra or missing seat cell.", 409);
      }
    }
    const baselines: Array<{ scope: "SIGNUP" | "SEAT_PLAN_DRAFT"; id: string;
      group: string; value: Record<string, unknown>; version: number }> = [];
    for (const stage of event.stages.filter((row) => row.entity_type === "SIGNUP")) {
      const cells = verified.get(`SIGNUP:${stage.row_id}`)!.target;
      const source = record(SHEET_SCOPES.SIGNUP.headers, cells);
      for (const group of groups("SIGNUP")) baselines.push({ scope: "SIGNUP", id: stage.row_id,
        group, value: mapped("SIGNUP", source, group), version: event.signup_version });
    }
    if (event.seating) {
      const state = event.seating.state as Record<string, unknown>;
      const saved = firstRow<SqlRow>(sql,
        `SELECT baseline_json FROM sync_baselines WHERE season_id=? AND binding_version=?
         AND entity_type='SEAT_PLAN_DRAFT' AND entity_id=? AND dependency_group='SEATING_DRAFT'`,
        event.season_id, binding.binding_version, event.practice_id);
      const previous = saved ? JSON.parse(String(saved.baseline_json)) as Record<string, unknown> : null;
      const draft = event.seating.draft_seats;
      const seats = Array.isArray(draft) ? draft : previous?.seats;
      if (!Array.isArray(seats)) throw new ApiError("SYNC_BASELINE_INCOMPLETE",
        "The final seating snapshot has no full draft or prior baseline.", 409);
      const source = { ...state, seats };
      const version = event.seat_plan_version ?? Number(cursor(sql, event.season_id,
        Number(binding.binding_version), event.practice_id).seat_plan_version);
      for (const group of groups("SEAT_PLAN_DRAFT")) baselines.push({ scope: "SEAT_PLAN_DRAFT",
        id: event.practice_id, group, value: mapped("SEAT_PLAN_DRAFT", source, group), version });
    }
    const prepared = await Promise.all(baselines.map(async (item) => ({ ...item,
      digest: `sha256_v1:${await sha256Base64Url(canonicalJson(item.value))}` })));
    const physicalPrepared = await Promise.all(event.stages.map(async (stage) => {
      const target = verified.get(`${stage.entity_type}:${stage.row_id}`)!;
      const cellsJson = canonicalJson(target.target);
      return { scope: stage.entity_type, row_id: stage.row_id, cellsJson,
        digest: `sha256_v1:${await sha256Base64Url(cellsJson)}` };
    }));
    const result = { season_id: event.season_id, status: "EVENT_CONFIRMED",
      outbox_id: outbox.outbox_id, signup_version: event.signup_version,
      seat_plan_version: event.seat_plan_version,
      published_revision: event.published_revision };
    this.ctx.storage.transactionSync(() => {
      const currentBinding = firstRow<SqlRow>(sql, "SELECT * FROM sync_bindings WHERE season_id=?", event.season_id);
      const currentOutbox = firstRow<SqlRow>(sql, "SELECT status,payload_json FROM sync_outbox WHERE outbox_id=?", outbox.outbox_id);
      if (!currentBinding || Number(currentBinding.binding_version) !== Number(binding.binding_version) ||
          String(currentBinding.runtime_spreadsheet_id) !== String(binding.runtime_spreadsheet_id) ||
          currentOutbox?.status !== "PENDING" || currentOutbox.payload_json !== outbox.payload_json ||
          confirmedStages(sql, outbox.outbox_id, Number(binding.binding_version)).size !== event.stages.length) {
        throw new ApiError("SYNC_EXPORT_STALE", "The associated event changed before completion.", 409, true);
      }
      assertCursorNext(cursor(sql, event.season_id, Number(binding.binding_version), event.practice_id), event);
      const at = new Date().toISOString();
      for (const item of prepared) {
        sql.exec(`INSERT INTO sync_baselines(season_id,binding_version,entity_type,entity_id,
          dependency_group,baseline_json,baseline_digest,cloud_version,sheet_digest,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(season_id,binding_version,entity_type,entity_id,dependency_group)
          DO UPDATE SET baseline_json=excluded.baseline_json,baseline_digest=excluded.baseline_digest,
            cloud_version=excluded.cloud_version,sheet_digest=excluded.sheet_digest,updated_at=excluded.updated_at`,
        event.season_id, binding.binding_version, item.scope, item.id, item.group,
        canonicalJson(item.value), item.digest, item.version, item.digest, at).toArray();
      }
      for (const item of physicalPrepared) {
        sql.exec(`INSERT INTO sync_associated_physical_baselines(season_id,binding_version,scope,row_id,
          cells_json,cells_digest,updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(season_id,binding_version,scope,row_id) DO UPDATE SET
          cells_json=excluded.cells_json,cells_digest=excluded.cells_digest,updated_at=excluded.updated_at`,
        event.season_id, binding.binding_version, item.scope, item.row_id,
        item.cellsJson, item.digest, at).toArray();
      }
      sql.exec(`INSERT INTO sync_associated_cursors(season_id,binding_version,practice_id,
        signup_version,seat_plan_version,published_revision,updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(season_id,binding_version,practice_id) DO UPDATE SET
        signup_version=excluded.signup_version,seat_plan_version=excluded.seat_plan_version,
        published_revision=excluded.published_revision,updated_at=excluded.updated_at`,
      event.season_id, binding.binding_version, event.practice_id, event.signup_version,
      event.seat_plan_version ?? cursor(sql, event.season_id, Number(binding.binding_version), event.practice_id).seat_plan_version,
      event.published_revision ?? cursor(sql, event.season_id, Number(binding.binding_version), event.practice_id).published_revision,
      at).toArray();
      sql.exec("UPDATE sync_outbox SET status='CONFIRMED',completed_at=?,last_error='' WHERE outbox_id=? AND status='PENDING'",
        at, outbox.outbox_id).toArray();
      sql.exec("UPDATE sync_bindings SET last_push_at=?,updated_at=? WHERE season_id=? AND binding_version=?",
        at, at, event.season_id, binding.binding_version).toArray();
      sql.exec("DELETE FROM sync_export_retries WHERE season_id=? AND binding_version=?",
        event.season_id, binding.binding_version).toArray();
    });
    return this.remember(identity, requestId, result);
  }
}
