import {
  parseAppendHistoryCorrection, parseAuditRequest, parseBackupChunkRequest, parseHistoryManagement,
  parseImportHistorySnapshot, parseVerifyBackupRequest, type HistoryPracticeSnapshot,
  type HistorySeasonSnapshot, type ImportHistorySnapshotRequest
} from "../../shared/c1-history-contract";
import { parseSessionRequest, type SessionRequest } from "../../shared/c1-contract";
import { canonicalJson } from "../../shared/c1-rules";
import { ApiError } from "./http";
import { base64UrlText, decodeBase64UrlText, sha256Base64Url } from "./crypto";
import { C1Service, type C1RequestIdentity } from "./c1-service";
import { firstRow, operationReceipt, parseContract, type SqlRow } from "./c1-support";
import { APPLICATION_SCHEMA_VERSION } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_MS = 60_000;
const BACKUP_CHUNK_ROWS = 100;

const BACKUP_TABLES = [
  "app_meta", "c0_counters", "system_requests", "audit_events", "sync_outbox", "scheduled_jobs",
  "coaches", "settings", "seasons", "members", "migration_snapshots", "schedule_templates",
  "training_weeks", "practices", "practice_versions", "schedule_migration_snapshots", "signups",
  "signup_migration_snapshots", "seat_plan_states", "seat_plan_draft_seats", "seat_plan_revisions",
  "seat_plan_revision_seats", "seat_plan_revision_names", "seating_migration_snapshots",
  "practice_history", "history_corrections", "season_history", "history_migration_snapshots",
  "usage_snapshots", "sync_bindings", "sync_baselines", "source_imports", "sync_conflicts",
  "sync_batches", "sync_batch_items", "sync_migration_snapshots", "form_import_cursors",
  "form_import_receipts", "form_source_observations", "sync_export_controls",
  "sync_export_retries", "sync_associated_cursors", "sync_associated_physical_baselines"
] as const;

interface HistoryJobOutcome { reschedule_at_ms?: number; }

interface CursorValue { values: Array<string | number>; }

interface PublicHistoryProjection {
  practice: { practice_id: string; start_at: string; end_at: string; timezone: string;
    location: string; address: string; map_url: string };
  final_status: "FROZEN" | "UNPUBLISHED";
  seat_plan: { status: "FROZEN" | "UNPUBLISHED"; published_revision: number;
    published_at: string; source: string; coach: { display_name: string } | null;
    steerer: { display_name: string } | null;
    seats: Array<{ side: string; row_number: number; display_name: string }> };
}

function parseJobPayload(value: unknown, kind: "practice" | "season" | "backup"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history job payload.");
  const row = value as Record<string, unknown>;
  if (typeof row.backend_generation !== "string" || typeof row.writer_epoch !== "number" ||
      !Number.isSafeInteger(row.writer_epoch)) throw new Error("Invalid history job generation.");
  const required = kind === "practice" ? ["season_id", "practice_id"] : kind === "season" ? ["season_id"] : ["snapshot_id"];
  for (const field of required) if (typeof row[field] !== "string" || !row[field]) {
    throw new Error("Invalid history job identity.");
  }
  return row;
}

function encodeCursor(values: Array<string | number>): string {
  return base64UrlText(JSON.stringify({ values } satisfies CursorValue));
}

function decodeCursor(value: string, length: number): Array<string | number> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeBase64UrlText(value)) as CursorValue;
    if (!parsed || !Array.isArray(parsed.values) || parsed.values.length !== length ||
        parsed.values.some((entry) => typeof entry !== "string" && typeof entry !== "number")) throw new Error();
    return parsed.values;
  } catch {
    throw new ApiError("INVALID_CURSOR", "The page cursor is invalid.", 400);
  }
}

function pageLimit(value: string | null): number {
  if (value === null || value === "") return 30;
  if (!/^\d+$/u.test(value)) throw new ApiError("INVALID_REQUEST", "limit must be an integer from 1 to 100.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new ApiError("INVALID_REQUEST", "limit must be an integer from 1 to 100.");
  }
  return parsed;
}

function roleName(names: Map<string, string>, memberId: unknown): string {
  if (!memberId) return "";
  const name = names.get(String(memberId));
  if (!name) throw new Error("A frozen revision participant name is missing.");
  return name;
}

function practicePublicSummary(snapshot: PublicHistoryProjection, historyVersion: number): Record<string, unknown> {
  return {
    practice_id: snapshot.practice.practice_id, start_at: snapshot.practice.start_at,
    end_at: snapshot.practice.end_at, timezone: snapshot.practice.timezone,
    location: snapshot.practice.location, address: snapshot.practice.address, map_url: snapshot.practice.map_url,
    final_status: snapshot.final_status, coach: snapshot.seat_plan.coach,
    steerer: snapshot.seat_plan.steerer, history_version: historyVersion
  };
}

function snapshotComparable(row: HistoryPracticeSnapshot): Record<string, unknown> {
  return {
    season_id: row.season_id, practice_id: row.practice_id, history_version: row.history_version,
    final_status: row.final_status, frozen_revision: row.frozen_revision,
    snapshot: importedPracticeProjection(row), frozen_at: row.frozen_at
  };
}

function importedPracticeProjection(row: HistoryPracticeSnapshot): PublicHistoryProjection {
  const seatPlan: PublicHistoryProjection["seat_plan"] = row.final_status === "UNPUBLISHED" ? {
    status: "UNPUBLISHED", published_revision: 0, published_at: "", source: "",
    coach: null, steerer: null, seats: []
  } : {
    status: "FROZEN", published_revision: row.frozen_revision, published_at: row.published_at, source: row.source,
    coach: row.coach_display_name ? { display_name: row.coach_display_name } : null,
    steerer: row.steerer_display_name ? { display_name: row.steerer_display_name } : null,
    seats: [...row.seats].sort((left, right) => left.row_number - right.row_number || left.side.localeCompare(right.side))
  };
  return {
    practice: { practice_id: row.practice_id, start_at: row.start_at, end_at: row.end_at,
      timezone: row.timezone, location: row.location, address: row.address, map_url: row.map_url },
    final_status: row.final_status, seat_plan: seatPlan
  };
}

function importedSeasonProjection(row: HistorySeasonSnapshot): Record<string, unknown> {
  return { season_id: row.season_id, name: row.name, start_date: row.start_date,
    end_date: row.end_date, timezone: row.timezone, archive_year: row.archive_year };
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class C1HistoryService {
  private readonly core: C1Service;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.core = new C1Service(ctx, env);
  }

  async handle(path: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (path) {
      case "/internal/c1/import-history": return this.importHistory(raw);
      case "/internal/c1/get-history-management": return this.historyManagement(raw);
      case "/internal/c1/append-history-correction": return this.appendCorrection(raw);
      case "/internal/c1/list-management-audit": return this.listAudit(raw);
      case "/internal/c1/create-backup-snapshot": return this.createBackup(raw);
      case "/internal/c1/get-backup-chunk": return this.getBackupChunk(raw);
      case "/internal/c1/verify-backup-snapshot": return this.verifyBackup(raw);
      case "/internal/c1/get-operations": return this.getOperations(raw);
      default: throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    }
  }

  publicHistorySeasons(limitValue: string | null, cursorValue: string | null): Record<string, unknown> {
    const limit = pageLimit(limitValue);
    const cursor = decodeCursor(cursorValue || "", 3);
    const rows = cursor ? this.ctx.storage.sql.exec<SqlRow>(
      `SELECT * FROM season_history
        WHERE archive_year < ? OR (archive_year = ? AND archived_at < ?)
           OR (archive_year = ? AND archived_at = ? AND season_id < ?)
        ORDER BY archive_year DESC, archived_at DESC, season_id DESC LIMIT ?`,
      Number(cursor[0]), Number(cursor[0]), String(cursor[1]), Number(cursor[0]), String(cursor[1]),
      String(cursor[2]), limit + 1).toArray() : this.ctx.storage.sql.exec<SqlRow>(
      "SELECT * FROM season_history ORDER BY archive_year DESC, archived_at DESC, season_id DESC LIMIT ?", limit + 1).toArray();
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      seasons: visible.map((row) => ({ ...JSON.parse(String(row.snapshot_json)),
        practice_count: Number(row.practice_count), published_practice_count: Number(row.published_practice_count),
        archived_at: String(row.archived_at) })),
      next_cursor: rows.length > limit && last ? encodeCursor([Number(last.archive_year), String(last.archived_at),
        String(last.season_id)]) : "",
      total_count: Number(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM season_history").one().count),
      generated_at: new Date().toISOString()
    };
  }

  publicSeasonHistory(seasonId: string, limitValue: string | null, cursorValue: string | null): Record<string, unknown> {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(seasonId)) throw new ApiError("INVALID_REQUEST", "season_id is invalid.");
    const season = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM season_history WHERE season_id=?", seasonId);
    if (!season) throw new ApiError("HISTORY_NOT_FOUND", "The season history is not available.", 404);
    const limit = pageLimit(limitValue);
    const cursor = decodeCursor(cursorValue || "", 2);
    const rows = cursor ? this.ctx.storage.sql.exec<SqlRow>(
      `SELECT ph.*, p.start_at FROM practice_history ph JOIN practices p
         ON p.season_id=ph.season_id AND p.practice_id=ph.practice_id
        WHERE ph.season_id=? AND (p.start_at < ? OR (p.start_at=? AND ph.practice_id < ?))
        ORDER BY p.start_at DESC, ph.practice_id DESC LIMIT ?`, seasonId, String(cursor[0]), String(cursor[0]),
      String(cursor[1]), limit + 1).toArray() : this.ctx.storage.sql.exec<SqlRow>(
      `SELECT ph.*, p.start_at FROM practice_history ph JOIN practices p
         ON p.season_id=ph.season_id AND p.practice_id=ph.practice_id
        WHERE ph.season_id=? ORDER BY p.start_at DESC, ph.practice_id DESC LIMIT ?`, seasonId, limit + 1).toArray();
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      season: { ...JSON.parse(String(season.snapshot_json)), practice_count: Number(season.practice_count),
        published_practice_count: Number(season.published_practice_count), archived_at: String(season.archived_at) },
      practices: visible.map((row) => practicePublicSummary(JSON.parse(String(row.snapshot_json)), Number(row.history_version))),
      next_cursor: rows.length > limit && last ? encodeCursor([String(last.start_at), String(last.practice_id)]) : "",
      total_count: Number(this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM practice_history WHERE season_id=?", seasonId).one().count),
      generated_at: new Date().toISOString()
    };
  }

  publicArchivedPractice(seasonId: string, practiceId: string): Record<string, unknown> {
    if (![seasonId, practiceId].every((value) => /^[A-Za-z0-9_-]{8,128}$/u.test(value))) {
      throw new ApiError("INVALID_REQUEST", "The history identity is invalid.");
    }
    const season = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM season_history WHERE season_id=?", seasonId);
    const practice = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM practice_history WHERE season_id=? AND practice_id=?", seasonId, practiceId);
    if (!season || !practice) throw new ApiError("HISTORY_NOT_FOUND", "The training history is not available.", 404);
    const snapshot = JSON.parse(String(practice.snapshot_json));
    return {
      season: { ...JSON.parse(String(season.snapshot_json)), archived_at: String(season.archived_at) },
      ...snapshot,
      corrections: this.ctx.storage.sql.exec<SqlRow>(
        `SELECT correction_id, history_version, note, created_at FROM history_corrections
          WHERE season_id=? AND practice_id=? ORDER BY history_version`, seasonId, practiceId).toArray()
        .map((row) => ({ correction_id: String(row.correction_id), history_version: Number(row.history_version),
          note: String(row.note), created_at: String(row.created_at) })),
      history_version: Number(practice.history_version), archived_at: String(practice.frozen_at)
    };
  }

  repairScheduledWork(now = Date.now()): void {
    const generation = this.env.BACKEND_GENERATION;
    const epoch = Number(this.env.WRITER_EPOCH);
    const at = new Date(now).toISOString();
    const maintenanceSetting = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT value_json FROM settings WHERE setting_key='history_maintenance_enabled'");
    const maintenanceEnabled = epoch > 0 || maintenanceSetting?.value_json === "true";
    if (!maintenanceEnabled) {
      this.recordUsageSnapshot(at);
      return;
    }
    const practices = this.ctx.storage.sql.exec<SqlRow>(
      `SELECT p.season_id, p.practice_id, p.end_at
         FROM practices p LEFT JOIN practice_history ph
           ON ph.season_id=p.season_id AND ph.practice_id=p.practice_id
        WHERE p.schedule_published_at IS NOT NULL AND p.cancelled_at IS NULL
          AND ph.practice_id IS NULL`).toArray();
    for (const row of practices) {
      const jobId = `history_freeze:${generation}:${epoch}:${row.season_id}:${row.practice_id}`;
      const dueAt = Date.parse(String(row.end_at)) + DAY_MS;
      this.insertJob(jobId, "FREEZE_PRACTICE_HISTORY", {
        backend_generation: generation, writer_epoch: epoch,
        season_id: String(row.season_id), practice_id: String(row.practice_id)
      }, dueAt, at);
    }
    const seasons = this.ctx.storage.sql.exec<SqlRow>(
      "SELECT * FROM seasons WHERE status IN ('OPEN','COMPLETED')").toArray();
    for (const season of seasons) {
      const seasonId = String(season.season_id);
      const endsAt = Date.parse(String(season.season_ends_at));
      if (season.status === "OPEN") this.insertJob(
        `history_complete:${generation}:${epoch}:${seasonId}`, "COMPLETE_SEASON", {
          backend_generation: generation, writer_epoch: epoch, season_id: seasonId
        }, endsAt, at);
      const practiceDue = practices.filter((row) => row.season_id === seasonId && !row.cancelled_at)
        .reduce((maximum, row) => Math.max(maximum, Date.parse(String(row.end_at)) + DAY_MS), endsAt);
      this.insertJob(`history_archive:${generation}:${epoch}:${seasonId}`, "ARCHIVE_SEASON_HISTORY", {
        backend_generation: generation, writer_epoch: epoch, season_id: seasonId
      }, practiceDue + 1, at);
    }
    this.recordUsageSnapshot(at);
  }

  async processScheduledJob(jobType: string, value: unknown): Promise<HistoryJobOutcome> {
    if (jobType === "FREEZE_PRACTICE_HISTORY") return this.freezePractice(value);
    if (jobType === "COMPLETE_SEASON") return this.completeSeason(value);
    if (jobType === "ARCHIVE_SEASON_HISTORY") return this.archiveSeason(value);
    if (jobType === "FINALIZE_BACKUP_SNAPSHOT") {
      const payload = parseJobPayload(value, "backup");
      if (!this.currentGeneration(payload)) return {};
      await this.finalizeBackup(String(payload.snapshot_id));
      return {};
    }
    throw new Error(`Unsupported history job type ${jobType}.`);
  }

  recordUsageSnapshot(at = new Date().toISOString()): void {
    const sql = this.ctx.storage.sql;
    const usageDate = at.slice(0, 10);
    const previous = firstRow<SqlRow>(sql,
      "SELECT captured_at FROM usage_snapshots WHERE usage_date=?", usageDate);
    const elapsed = previous ? Date.parse(at) - Date.parse(String(previous.captured_at)) : Number.POSITIVE_INFINITY;
    if (elapsed >= 0 && elapsed < USAGE_SNAPSHOT_INTERVAL_MS) return;
    const count = (query: string, ...bindings: SqlStorageValue[]) => Number(sql.exec<{ count: number }>(query, ...bindings).one().count);
    sql.exec(
      `INSERT INTO usage_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(usage_date) DO UPDATE SET captured_at=excluded.captured_at,
         database_size_bytes=excluded.database_size_bytes, request_count=excluded.request_count,
         audit_count=excluded.audit_count, outbox_pending=excluded.outbox_pending,
         jobs_pending=excluded.jobs_pending, history_practice_count=excluded.history_practice_count,
         history_season_count=excluded.history_season_count`,
      usageDate, at, sql.databaseSize, count("SELECT COUNT(*) AS count FROM system_requests"),
      count("SELECT COUNT(*) AS count FROM audit_events"),
      count("SELECT COUNT(*) AS count FROM sync_outbox WHERE status='PENDING'"),
      count("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE status IN ('PENDING','RUNNING')"),
      count("SELECT COUNT(*) AS count FROM practice_history"), count("SELECT COUNT(*) AS count FROM season_history")
    ).toArray();
  }

  private insertJob(jobId: string, jobType: string, payload: Record<string, unknown>, dueAt: number, at: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduled_jobs(job_id, job_type, payload_json, status, due_at_ms, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET payload_json=excluded.payload_json,
         due_at_ms=excluded.due_at_ms, updated_at=excluded.updated_at
       WHERE scheduled_jobs.status='PENDING'`,
      jobId, jobType, JSON.stringify(payload), dueAt, at, at).toArray();
  }

  private currentGeneration(payload: Record<string, unknown>): boolean {
    return payload.backend_generation === this.env.BACKEND_GENERATION && payload.writer_epoch === Number(this.env.WRITER_EPOCH);
  }

  private async freezePractice(value: unknown): Promise<HistoryJobOutcome> {
    const payload = parseJobPayload(value, "practice");
    if (!this.currentGeneration(payload)) return {};
    const seasonId = String(payload.season_id);
    const practiceId = String(payload.practice_id);
    const practice = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT p.*, pv.published_revision FROM practices p JOIN practice_versions pv
         ON pv.season_id=p.season_id AND pv.practice_id=p.practice_id
        WHERE p.season_id=? AND p.practice_id=?`, seasonId, practiceId);
    if (!practice || practice.cancelled_at || !practice.schedule_published_at) return {};
    if (firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT 1 AS present FROM practice_history WHERE season_id=? AND practice_id=?", seasonId, practiceId)) return {};
    const dueAt = Date.parse(String(practice.end_at)) + DAY_MS;
    if (Date.now() < dueAt) return { reschedule_at_ms: dueAt };
    const requestId = `freeze_${await sha256Base64Url(`${seasonId}\n${practiceId}`)}`;
    const identity = await this.core.createRequestIdentity("C1:SYSTEM", "freezePracticeHistory", requestId,
      { season_id: seasonId, practice_id: practiceId });
    if (this.core.replayRequest(identity.requestKey, identity.payloadDigest)) return {};
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const current = firstRow<SqlRow>(this.ctx.storage.sql,
        `SELECT p.*, pv.published_revision FROM practices p JOIN practice_versions pv
           ON pv.season_id=p.season_id AND pv.practice_id=p.practice_id
          WHERE p.season_id=? AND p.practice_id=?`, seasonId, practiceId);
      if (!current || current.cancelled_at || !current.schedule_published_at) return;
      if (Date.now() < Date.parse(String(current.end_at)) + DAY_MS) {
        throw new ApiError("ARCHIVE_NOT_DUE", "The final correction window is still open.", 409);
      }
      const existing = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT 1 AS present FROM practice_history WHERE season_id=? AND practice_id=?", seasonId, practiceId);
      if (existing) return;
      const snapshot = this.buildFrozenSnapshot(current);
      this.ctx.storage.sql.exec(
        `INSERT INTO practice_history(season_id, practice_id, history_version, final_status,
           frozen_revision, snapshot_json, frozen_at) VALUES (?, ?, 1, ?, ?, ?, ?)`,
        seasonId, practiceId, snapshot.final_status, Number(current.published_revision),
        JSON.stringify(snapshot), at).toArray();
      const response = { operation: operationReceipt("freezePracticeHistory", requestId, at), result: {
        season_id: seasonId, practice_id: practiceId, final_status: snapshot.final_status,
        frozen_revision: Number(current.published_revision), history_version: 1
      } };
      this.core.recordRequest(identity, "C1:SYSTEM", "freezePracticeHistory", requestId, response,
        { season_id: seasonId, practice_id: practiceId, final_status: snapshot.final_status }, at);
      this.core.enqueueChange(identity, "HISTORY_CHANGED", "freezePracticeHistory",
        { season_id: seasonId, practice_id: practiceId, history_version: 1 }, at);
    });
    return {};
  }

  private buildFrozenSnapshot(practice: SqlRow): PublicHistoryProjection {
    const revisionNumber = Number(practice.published_revision);
    const base = { practice: { practice_id: String(practice.practice_id), start_at: String(practice.start_at),
      end_at: String(practice.end_at), timezone: String(practice.timezone), location: String(practice.location),
      address: String(practice.address), map_url: String(practice.map_url || "") } };
    if (!revisionNumber) return { ...base, final_status: "UNPUBLISHED", seat_plan: {
      status: "UNPUBLISHED", published_revision: 0, published_at: "", source: "",
      coach: null, steerer: null, seats: []
    } };
    const revision = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM seat_plan_revisions WHERE season_id=? AND practice_id=? AND revision_number=?",
      practice.season_id, practice.practice_id, revisionNumber);
    if (!revision) throw new Error("The latest formal seating revision is missing.");
    const names = new Map(this.ctx.storage.sql.exec<SqlRow>(
      `SELECT member_id, display_name FROM seat_plan_revision_names
        WHERE season_id=? AND practice_id=? AND revision_number=?`,
      practice.season_id, practice.practice_id, revisionNumber).toArray()
      .map((row) => [String(row.member_id), String(row.display_name)]));
    const seats = this.ctx.storage.sql.exec<SqlRow>(
      `SELECT side, row_number, member_id FROM seat_plan_revision_seats
        WHERE season_id=? AND practice_id=? AND revision_number=? ORDER BY row_number, side`,
      practice.season_id, practice.practice_id, revisionNumber).toArray().map((row) => ({
        side: String(row.side), row_number: Number(row.row_number), display_name: roleName(names, row.member_id)
      }));
    return { ...base, final_status: "FROZEN", seat_plan: {
      status: "FROZEN", published_revision: revisionNumber, published_at: String(revision.published_at),
      source: String(revision.source),
      coach: revision.coach_member_id ? { display_name: roleName(names, revision.coach_member_id) } : null,
      steerer: revision.steerer_member_id ? { display_name: roleName(names, revision.steerer_member_id) } : null,
      seats
    } };
  }

  private async completeSeason(value: unknown): Promise<HistoryJobOutcome> {
    const payload = parseJobPayload(value, "season");
    if (!this.currentGeneration(payload)) return {};
    const seasonId = String(payload.season_id);
    const season = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM seasons WHERE season_id=?", seasonId);
    if (!season || season.status !== "OPEN") return {};
    const dueAt = Date.parse(String(season.season_ends_at));
    if (Date.now() < dueAt) return { reschedule_at_ms: dueAt };
    const requestId = `complete_${await sha256Base64Url(seasonId)}`;
    const identity = await this.core.createRequestIdentity("C1:SYSTEM", "completeSeason", requestId, { season_id: seasonId });
    if (this.core.replayRequest(identity.requestKey, identity.payloadDigest)) return {};
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const current = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM seasons WHERE season_id=?", seasonId);
      if (!current || current.status !== "OPEN") return;
      if (Date.now() < Date.parse(String(current.season_ends_at))) throw new ApiError("ARCHIVE_NOT_DUE", "The season is still open.", 409);
      this.ctx.storage.sql.exec(
        "UPDATE seasons SET status='COMPLETED', season_version=season_version+1, updated_at=? WHERE season_id=?",
        at, seasonId).toArray();
      const response = { operation: operationReceipt("completeSeason", requestId, at), result: {
        season_id: seasonId, status: "COMPLETED", season_version: Number(current.season_version) + 1
      } };
      this.core.recordRequest(identity, "C1:SYSTEM", "completeSeason", requestId, response, { season_id: seasonId }, at);
      this.core.enqueueChange(identity, "CORE_CHANGED", "completeSeason", { season_id: seasonId }, at);
    });
    return {};
  }

  private async archiveSeason(value: unknown): Promise<HistoryJobOutcome> {
    const payload = parseJobPayload(value, "season");
    if (!this.currentGeneration(payload)) return {};
    const seasonId = String(payload.season_id);
    const season = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM seasons WHERE season_id=?", seasonId);
    if (!season || season.status === "DRAFT" || season.status === "ARCHIVED") return {};
    if (Date.now() < Date.parse(String(season.season_ends_at))) {
      return { reschedule_at_ms: Date.parse(String(season.season_ends_at)) };
    }
    if (season.status === "OPEN") return { reschedule_at_ms: Date.now() + RETRY_MS };
    if (season.status !== "COMPLETED") return {};
    const missing = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT p.end_at FROM practices p LEFT JOIN practice_history ph
         ON ph.season_id=p.season_id AND ph.practice_id=p.practice_id
        WHERE p.season_id=? AND p.schedule_published_at IS NOT NULL AND p.cancelled_at IS NULL
          AND ph.practice_id IS NULL ORDER BY p.end_at LIMIT 1`, seasonId);
    if (missing) return { reschedule_at_ms: Math.max(Date.now() + RETRY_MS, Date.parse(String(missing.end_at)) + DAY_MS) };
    const requestId = `archive_${await sha256Base64Url(seasonId)}`;
    const identity = await this.core.createRequestIdentity("C1:SYSTEM", "archiveSeasonHistory", requestId,
      { season_id: seasonId });
    if (this.core.replayRequest(identity.requestKey, identity.payloadDigest)) return {};
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const current = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM seasons WHERE season_id=?", seasonId);
      if (!current || current.status !== "COMPLETED") return;
      const counts = this.ctx.storage.sql.exec<{ total: number; published: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN final_status='FROZEN' THEN 1 ELSE 0 END) AS published
           FROM practice_history WHERE season_id=?`, seasonId).one();
      const snapshot = { season_id: seasonId, name: String(current.name), start_date: String(current.start_date),
        end_date: String(current.end_date), timezone: String(current.timezone),
        archive_year: Number(String(current.end_date).slice(0, 4)) };
      this.ctx.storage.sql.exec(
        `INSERT INTO season_history(season_id, archive_year, practice_count, published_practice_count,
           snapshot_json, archived_at) VALUES (?, ?, ?, ?, ?, ?)`, seasonId, snapshot.archive_year,
        Number(counts.total), Number(counts.published || 0), JSON.stringify(snapshot), at).toArray();
      this.ctx.storage.sql.exec(
        "UPDATE seasons SET status='ARCHIVED', season_version=season_version+1, updated_at=? WHERE season_id=?",
        at, seasonId).toArray();
      const response = { operation: operationReceipt("archiveSeasonHistory", requestId, at), result: {
        season_id: seasonId, status: "ARCHIVED", practice_count: Number(counts.total),
        published_practice_count: Number(counts.published || 0)
      } };
      this.core.recordRequest(identity, "C1:SYSTEM", "archiveSeasonHistory", requestId, response,
        { season_id: seasonId, practice_count: Number(counts.total) }, at);
      this.core.enqueueChange(identity, "HISTORY_CHANGED", "archiveSeasonHistory", { season_id: seasonId }, at);
    });
    return {};
  }

  private async importHistory(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseImportHistorySnapshot(raw));
    const { request_id: _requestId, ...payload } = input;
    const identity = await this.core.createRequestIdentity("C1:MIGRATION", "importHistorySnapshot", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    this.validateHistoryImport(input);
    const prior = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT payload_digest FROM history_migration_snapshots WHERE source_snapshot_id=?", input.source_snapshot_id);
    if (prior && prior.payload_digest !== identity.payloadDigest) {
      throw new ApiError("IMPORT_SNAPSHOT_CONFLICT", "This history snapshot identifier has different content.", 409);
    }
    const at = new Date().toISOString();
    const response = { operation: operationReceipt("importHistorySnapshot", input.request_id, at), result: {
      source_snapshot_id: input.source_snapshot_id, seasons: input.seasons.length,
      practices: input.practices.length, corrections: input.corrections.length
    } };
    this.ctx.storage.transactionSync(() => {
      for (const practice of input.practices) {
        const snapshot = importedPracticeProjection(practice);
        this.ctx.storage.sql.exec(
          `INSERT INTO practice_history VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(season_id, practice_id) DO UPDATE SET history_version=excluded.history_version`,
          practice.season_id, practice.practice_id,
          practice.history_version, practice.final_status, practice.frozen_revision, JSON.stringify(snapshot), practice.frozen_at).toArray();
      }
      for (const correction of input.corrections) this.ctx.storage.sql.exec(
        `INSERT INTO history_corrections VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(season_id, practice_id, history_version) DO NOTHING`, correction.season_id,
        correction.practice_id, correction.correction_id, correction.history_version, correction.note,
        correction.created_by, correction.created_at).toArray();
      for (const season of input.seasons) {
        const practices = input.practices.filter((row) => row.season_id === season.season_id);
        this.ctx.storage.sql.exec(
          `INSERT INTO season_history VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(season_id) DO NOTHING`,
          season.season_id, season.archive_year, practices.length,
          practices.filter((row) => row.final_status === "FROZEN").length,
          JSON.stringify(importedSeasonProjection(season)), season.archived_at).toArray();
      }
      this.core.recordRequest(identity, "C1:MIGRATION", "importHistorySnapshot", input.request_id, response,
        { source_snapshot_id: input.source_snapshot_id, counts: response.result }, at);
      this.ctx.storage.sql.exec(
        "INSERT INTO history_migration_snapshots VALUES (?, ?, ?, ?) ON CONFLICT(source_snapshot_id) DO NOTHING",
        input.source_snapshot_id, identity.payloadDigest, at, identity.requestKey).toArray();
    });
    return response;
  }

  private validateHistoryImport(input: ImportHistorySnapshotRequest): void {
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) throw new ApiError("IMPORT_CONFLICT", `${label} contains duplicates.`, 409);
    };
    unique(input.seasons.map((row) => row.season_id), "history seasons");
    unique(input.practices.map((row) => `${row.season_id}\n${row.practice_id}`), "history practices");
    unique(input.corrections.map((row) => row.correction_id), "history correction identifiers");
    const seasonInputs = new Map(input.seasons.map((row) => [row.season_id, row]));
    const practiceInputs = new Map(input.practices.map((row) => [`${row.season_id}\n${row.practice_id}`, row]));
    for (const season of input.seasons) {
      const stored = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM seasons WHERE season_id=?", season.season_id);
      if (!stored) throw new ApiError("IMPORT_REFERENCE_MISSING", "A history season does not exist.", 409);
      if (stored.status !== "ARCHIVED") {
        throw new ApiError("IMPORT_CONFLICT", "A history season must already be ARCHIVED in the core snapshot.", 409);
      }
      if (!sameJson(importedSeasonProjection(season), { season_id: stored.season_id, name: stored.name,
        start_date: stored.start_date, end_date: stored.end_date, timezone: stored.timezone,
        archive_year: Number(String(stored.end_date).slice(0, 4)) })) {
        throw new ApiError("IMPORT_CONFLICT", "A history season differs from its source season.", 409);
      }
      const existing = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM season_history WHERE season_id=?", season.season_id);
      const importedPractices = input.practices.filter((row) => row.season_id === season.season_id);
      if (existing && (!sameJson(JSON.parse(String(existing.snapshot_json)), importedSeasonProjection(season)) ||
          existing.archived_at !== season.archived_at || Number(existing.practice_count) !== importedPractices.length ||
          Number(existing.published_practice_count) !== importedPractices.filter((row) => row.final_status === "FROZEN").length)) {
        throw new ApiError("IMPORT_CONFLICT", "The archived season is immutable.", 409);
      }
    }
    for (const practice of input.practices) {
      if (!seasonInputs.has(practice.season_id)) throw new ApiError("IMPORT_REFERENCE_MISSING", "A history practice has no season snapshot.", 409);
      const stored = firstRow<SqlRow>(this.ctx.storage.sql,
        `SELECT p.*, pv.published_revision FROM practices p JOIN practice_versions pv
           ON pv.season_id=p.season_id AND pv.practice_id=p.practice_id
          WHERE p.season_id=? AND p.practice_id=?`, practice.season_id, practice.practice_id);
      if (!stored || stored.cancelled_at || !stored.schedule_published_at) {
        throw new ApiError("IMPORT_REFERENCE_MISSING", "A history practice is missing, cancelled or unpublished.", 409);
      }
      const projection = importedPracticeProjection(practice);
      if (!sameJson(projection.practice, { practice_id: stored.practice_id, start_at: stored.start_at,
        end_at: stored.end_at, timezone: stored.timezone, location: stored.location,
        address: stored.address, map_url: stored.map_url })) {
        throw new ApiError("IMPORT_CONFLICT", "A history practice differs from its source training.", 409);
      }
      if (Number(stored.published_revision) !== practice.frozen_revision ||
          !sameJson(this.buildFrozenSnapshot(stored), projection)) {
        throw new ApiError("IMPORT_CONFLICT", "A history snapshot differs from its final seating revision.", 409);
      }
      const existing = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT * FROM practice_history WHERE season_id=? AND practice_id=?", practice.season_id, practice.practice_id);
      if (existing) {
        if (practice.history_version < Number(existing.history_version)) {
          throw new ApiError("IMPORT_VERSION_REGRESSION", "The snapshot contains an older history version.", 409);
        }
        const comparable = snapshotComparable(practice);
        delete comparable.history_version;
        if (!sameJson({ season_id: practice.season_id, practice_id: practice.practice_id,
          final_status: existing.final_status, frozen_revision: Number(existing.frozen_revision),
          snapshot: JSON.parse(String(existing.snapshot_json)), frozen_at: existing.frozen_at }, comparable)) {
          throw new ApiError("IMPORT_CONFLICT", "The frozen training history is immutable.", 409);
        }
      }
    }
    const correctionsByPractice = new Map<string, typeof input.corrections>();
    for (const correction of input.corrections) {
      const key = `${correction.season_id}\n${correction.practice_id}`;
      if (!practiceInputs.has(key)) throw new ApiError("IMPORT_REFERENCE_MISSING", "A correction has no history practice.", 409);
      const rows = correctionsByPractice.get(key) || [];
      rows.push(correction); correctionsByPractice.set(key, rows);
      const existing = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT * FROM history_corrections WHERE correction_id=?", correction.correction_id);
      if (existing && !sameJson({ season_id: existing.season_id, practice_id: existing.practice_id,
        correction_id: existing.correction_id, history_version: Number(existing.history_version), note: existing.note,
        created_by: existing.created_by, created_at: existing.created_at }, correction)) {
        throw new ApiError("IMPORT_CONFLICT", "A history correction identifier has different content.", 409);
      }
      const versionOwner = firstRow<SqlRow>(this.ctx.storage.sql,
        `SELECT correction_id FROM history_corrections
          WHERE season_id=? AND practice_id=? AND history_version=?`,
        correction.season_id, correction.practice_id, correction.history_version);
      if (versionOwner && versionOwner.correction_id !== correction.correction_id) {
        throw new ApiError("IMPORT_CONFLICT", "A history version belongs to another correction.", 409);
      }
    }
    for (const [key, practice] of practiceInputs) {
      const corrections = (correctionsByPractice.get(key) || []).sort((left, right) => left.history_version - right.history_version);
      if (practice.history_version !== corrections.length + 1 ||
          corrections.some((row, index) => row.history_version !== index + 2)) {
        throw new ApiError("IMPORT_CONFLICT", "History correction versions are not continuous.", 409);
      }
    }
  }

  private async historyManagement(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseHistoryManagement(raw));
    await this.core.authenticateSession(input.session_token);
    const season = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM seasons WHERE season_id=?", input.season_id);
    if (!season) throw new ApiError("SEASON_NOT_FOUND", "The season does not exist.", 404);
    const history = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM season_history WHERE season_id=?", input.season_id);
    return {
      season: { season_id: input.season_id, name: String(season.name), status: String(season.status),
        season_ends_at: String(season.season_ends_at), season_version: Number(season.season_version) },
      archive_status: history ? "ARCHIVED" : Date.now() < Date.parse(String(season.season_ends_at)) ? "NOT_DUE" : "PENDING",
      season_archive: history ? { practice_count: Number(history.practice_count),
        published_practice_count: Number(history.published_practice_count), archived_at: String(history.archived_at) } : null,
      practices: this.ctx.storage.sql.exec<SqlRow>(
        `SELECT p.practice_id, p.start_at, p.end_at, p.cancelled_at, p.schedule_published_at,
                ph.final_status, ph.history_version, ph.frozen_at
           FROM practices p LEFT JOIN practice_history ph
             ON ph.season_id=p.season_id AND ph.practice_id=p.practice_id
          WHERE p.season_id=? ORDER BY p.start_at, p.practice_id`, input.season_id).toArray().map((row) => ({
          practice_id: String(row.practice_id), start_at: String(row.start_at),
          archive_due_at: new Date(Date.parse(String(row.end_at)) + DAY_MS).toISOString(),
          status: row.cancelled_at ? "CANCELLED" : !row.schedule_published_at ? "PRIVATE" : row.final_status || "PENDING",
          history_version: row.history_version === null ? null : Number(row.history_version),
          frozen_at: row.frozen_at || ""
        })), generated_at: new Date().toISOString()
    };
  }

  private async appendCorrection(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseAppendHistoryCorrection(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, practice_id: input.practice_id,
      history_version: input.history_version, note: input.note };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "appendHistoryCorrection", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const history = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT ph.* FROM practice_history ph JOIN season_history sh ON sh.season_id=ph.season_id
        WHERE ph.season_id=? AND ph.practice_id=?`, input.season_id, input.practice_id);
    if (!history) throw new ApiError("HISTORY_NOT_READY", "The public history is not ready.", 409);
    if (Number(history.history_version) !== input.history_version) {
      throw new ApiError("VERSION_CONFLICT", "The history record changed. Refresh and try again.", 409);
    }
    const at = new Date().toISOString();
    const nextVersion = input.history_version + 1;
    const correctionId = `correction_${identity.requestKey.slice(-32)}`;
    const response = { operation: operationReceipt("appendHistoryCorrection", input.request_id, at), result: {
      season_id: input.season_id, practice_id: input.practice_id,
      correction_id: correctionId, history_version: nextVersion
    } };
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth);
      const current = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT history_version FROM practice_history WHERE season_id=? AND practice_id=?",
        input.season_id, input.practice_id);
      if (!current || Number(current.history_version) !== input.history_version) {
        throw new ApiError("VERSION_CONFLICT", "The history record changed. Refresh and try again.", 409);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO history_corrections VALUES (?, ?, ?, ?, ?, ?, ?)", input.season_id,
        input.practice_id, correctionId, nextVersion, input.note, auth.coach_id, at).toArray();
      this.ctx.storage.sql.exec(
        "UPDATE practice_history SET history_version=? WHERE season_id=? AND practice_id=?",
        nextVersion, input.season_id, input.practice_id).toArray();
      this.core.recordRequest(identity, auth.coach_id, "appendHistoryCorrection", input.request_id, response,
        { season_id: input.season_id, practice_id: input.practice_id, history_version: nextVersion }, at);
      this.core.enqueueChange(identity, "HISTORY_CHANGED", "appendHistoryCorrection",
        { season_id: input.season_id, practice_id: input.practice_id, history_version: nextVersion }, at);
    });
    return response;
  }

  private async listAudit(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseAuditRequest(raw));
    await this.core.authenticateSession(input.session_token);
    if (input.limit > 100) throw new ApiError("INVALID_REQUEST", "limit must not exceed 100.");
    const cursor = decodeCursor(input.cursor, 2);
    const rows = cursor ? this.ctx.storage.sql.exec<SqlRow>(
      `SELECT * FROM audit_events WHERE season_id=?
        AND (created_at < ? OR (created_at=? AND event_id < ?))
        ORDER BY created_at DESC, event_id DESC LIMIT ?`, input.season_id,
      String(cursor[0]), String(cursor[0]), String(cursor[1]), input.limit + 1).toArray() :
      this.ctx.storage.sql.exec<SqlRow>(
        "SELECT * FROM audit_events WHERE season_id=? ORDER BY created_at DESC, event_id DESC LIMIT ?",
        input.season_id, input.limit + 1).toArray();
    const visible = rows.slice(0, input.limit);
    const last = visible.at(-1);
    return { season_id: input.season_id, events: visible.map((row) => ({ event_id: String(row.event_id),
      actor_scope: String(row.actor_scope), action: String(row.action),
      details: JSON.parse(String(row.details_json)), created_at: String(row.created_at) })),
      next_cursor: rows.length > input.limit && last ? encodeCursor([String(last.created_at), String(last.event_id)]) : "",
      scan_cap_reached: false, generated_at: new Date().toISOString() };
  }

  private async createBackup(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseSessionRequest(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { schema_version: APPLICATION_SCHEMA_VERSION, backup_format: "sqlite-json-chunks-v1" };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "createBackupSnapshot", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const snapshotId = `backup_${identity.requestKey.slice(-32)}`;
    this.captureBackup(snapshotId, identity, auth.coach_id, input.request_id);
    await this.finalizeBackup(snapshotId);
    const completed = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (!completed) throw new ApiError("BACKUP_NOT_READY", "The backup snapshot is still being finalized.", 503, true);
    return completed;
  }

  private captureBackup(snapshotId: string, identity: C1RequestIdentity, actorScope: string, requestId: string): void {
    if (firstRow<SqlRow>(this.ctx.storage.sql, "SELECT 1 AS present FROM backup_snapshots WHERE snapshot_id=?", snapshotId)) return;
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const tables: Array<{ name: string; row_count: number; chunk_indices: number[] }> = [];
      const chunks: Array<{ index: number; table: string; offset: number; rows: SqlRow[] }> = [];
      let chunkIndex = 0;
      let recordCount = 0;
      for (const table of BACKUP_TABLES) {
        const rows = this.ctx.storage.sql.exec<SqlRow>(`SELECT * FROM ${table} ORDER BY rowid`).toArray();
        const chunkIndices: number[] = [];
        recordCount += rows.length;
        for (let offset = 0; offset < rows.length; offset += BACKUP_CHUNK_ROWS) {
          const index = chunkIndex++;
          chunkIndices.push(index);
          chunks.push({ index, table, offset, rows: rows.slice(offset, offset + BACKUP_CHUNK_ROWS) });
        }
        tables.push({ name: table, row_count: rows.length, chunk_indices: chunkIndices });
      }
      const preliminary = { snapshot_id: snapshotId, schema_version: APPLICATION_SCHEMA_VERSION,
        format: "sqlite-json-chunks-v1", created_at: at, tables };
      this.ctx.storage.sql.exec(
        `INSERT INTO backup_snapshots(snapshot_id, status, schema_version, request_key, request_id,
           actor_scope, payload_digest, event_id, table_count, record_count, chunk_count,
           manifest_json, created_at) VALUES (?, 'BUILDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        snapshotId, APPLICATION_SCHEMA_VERSION, identity.requestKey, requestId, actorScope,
        identity.payloadDigest, identity.eventId, tables.length, recordCount, chunks.length,
        JSON.stringify(preliminary), at).toArray();
      for (const chunk of chunks) this.ctx.storage.sql.exec(
        `INSERT INTO backup_snapshot_chunks(snapshot_id, chunk_index, table_name, row_offset,
           row_count, payload_json) VALUES (?, ?, ?, ?, ?, ?)`, snapshotId, chunk.index,
        chunk.table, chunk.offset, chunk.rows.length, canonicalJson({ table: chunk.table,
          row_offset: chunk.offset, rows: chunk.rows })).toArray();
      this.insertJob(`backup_finalize:${snapshotId}`, "FINALIZE_BACKUP_SNAPSHOT", {
        backend_generation: this.env.BACKEND_GENERATION, writer_epoch: Number(this.env.WRITER_EPOCH), snapshot_id: snapshotId
      }, Date.now(), at);
    });
  }

  private async finalizeBackup(snapshotId: string): Promise<void> {
    const snapshot = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM backup_snapshots WHERE snapshot_id=?", snapshotId);
    if (!snapshot || snapshot.status === "READY") return;
    const chunks = this.ctx.storage.sql.exec<SqlRow>(
      "SELECT * FROM backup_snapshot_chunks WHERE snapshot_id=? ORDER BY chunk_index", snapshotId).toArray();
    const descriptors = await Promise.all(chunks.map(async (chunk) => ({
      chunk_index: Number(chunk.chunk_index), table_name: String(chunk.table_name),
      row_offset: Number(chunk.row_offset), row_count: Number(chunk.row_count),
      payload_digest: `sha256_v1:${await sha256Base64Url(String(chunk.payload_json))}`
    })));
    const preliminary = JSON.parse(String(snapshot.manifest_json));
    const manifestCore = { ...preliminary, table_count: Number(snapshot.table_count),
      record_count: Number(snapshot.record_count), chunk_count: Number(snapshot.chunk_count), chunks: descriptors };
    const contentDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(manifestCore))}`;
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const current = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT status FROM backup_snapshots WHERE snapshot_id=?", snapshotId);
      if (!current || current.status === "READY") return;
      for (const descriptor of descriptors) this.ctx.storage.sql.exec(
        "UPDATE backup_snapshot_chunks SET payload_digest=? WHERE snapshot_id=? AND chunk_index=?",
        descriptor.payload_digest, snapshotId, descriptor.chunk_index).toArray();
      const manifest = { ...manifestCore, content_digest: contentDigest };
      this.ctx.storage.sql.exec(
        `UPDATE backup_snapshots SET status='READY', content_digest=?, manifest_json=?, completed_at=?
          WHERE snapshot_id=?`, contentDigest, JSON.stringify(manifest), at, snapshotId).toArray();
      this.ctx.storage.sql.exec(
        `UPDATE scheduled_jobs SET status='COMPLETED', lease_token=NULL, lease_until_ms=NULL,
           updated_at=?, completed_at=COALESCE(completed_at, ?), last_error=''
         WHERE job_id=?`, at, at, `backup_finalize:${snapshotId}`).toArray();
      const identity: C1RequestIdentity = { requestKey: String(snapshot.request_key),
        payloadDigest: String(snapshot.payload_digest), eventId: String(snapshot.event_id) };
      const response = { operation: operationReceipt("createBackupSnapshot", String(snapshot.request_id), at), result: {
        snapshot_id: snapshotId, manifest
      } };
      this.core.recordRequest(identity, String(snapshot.actor_scope), "createBackupSnapshot",
        String(snapshot.request_id), response, { snapshot_id: snapshotId,
          record_count: Number(snapshot.record_count), content_digest: contentDigest }, at);
    });
  }

  private async getBackupChunk(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseBackupChunkRequest(raw));
    await this.core.authenticateSession(input.session_token);
    const snapshot = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM backup_snapshots WHERE snapshot_id=?", input.snapshot_id);
    if (!snapshot || snapshot.status !== "READY") throw new ApiError("BACKUP_NOT_READY", "The backup snapshot is not ready.", 409);
    const chunk = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM backup_snapshot_chunks WHERE snapshot_id=? AND chunk_index=?", input.snapshot_id, input.chunk_index);
    if (!chunk) throw new ApiError("BACKUP_CHUNK_NOT_FOUND", "The backup chunk does not exist.", 404);
    return { snapshot_id: input.snapshot_id, manifest: JSON.parse(String(snapshot.manifest_json)),
      chunk: { chunk_index: Number(chunk.chunk_index), table_name: String(chunk.table_name),
        row_offset: Number(chunk.row_offset), row_count: Number(chunk.row_count),
        payload_digest: String(chunk.payload_digest), payload: JSON.parse(String(chunk.payload_json)) } };
  }

  private async verifyBackup(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseVerifyBackupRequest(raw));
    await this.core.authenticateSession(input.session_token);
    const snapshot = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM backup_snapshots WHERE snapshot_id=?", input.snapshot_id);
    if (!snapshot || snapshot.status !== "READY") throw new ApiError("BACKUP_NOT_READY", "The backup snapshot is not ready.", 409);
    const chunks = this.ctx.storage.sql.exec<SqlRow>(
      "SELECT * FROM backup_snapshot_chunks WHERE snapshot_id=? ORDER BY chunk_index", input.snapshot_id).toArray();
    const descriptors = [];
    for (const chunk of chunks) {
      const actual = `sha256_v1:${await sha256Base64Url(String(chunk.payload_json))}`;
      if (actual !== chunk.payload_digest) throw new ApiError("BACKUP_INTEGRITY_ERROR", "A stored backup chunk failed verification.", 500);
      descriptors.push({ chunk_index: Number(chunk.chunk_index), table_name: String(chunk.table_name),
        row_offset: Number(chunk.row_offset), row_count: Number(chunk.row_count), payload_digest: actual });
    }
    const manifest = JSON.parse(String(snapshot.manifest_json)) as Record<string, unknown>;
    const { content_digest: _contentDigest, ...manifestCore } = manifest;
    const actualContentDigest = `sha256_v1:${await sha256Base64Url(canonicalJson(manifestCore))}`;
    const manifestMatchesStorage = manifest.snapshot_id === snapshot.snapshot_id &&
      Number(manifest.schema_version) === Number(snapshot.schema_version) &&
      Number(manifest.table_count) === Number(snapshot.table_count) &&
      Number(manifest.record_count) === Number(snapshot.record_count) &&
      Number(manifest.chunk_count) === chunks.length &&
      Number(snapshot.chunk_count) === chunks.length && sameJson(manifest.chunks, descriptors);
    if (!manifestMatchesStorage || actualContentDigest !== snapshot.content_digest ||
        manifest.content_digest !== snapshot.content_digest) {
      throw new ApiError("BACKUP_INTEGRITY_ERROR", "The stored backup manifest failed verification.", 500);
    }
    const verified = input.content_digest === snapshot.content_digest;
    return { snapshot_id: input.snapshot_id, verified, expected_content_digest: String(snapshot.content_digest),
      chunk_count: Number(snapshot.chunk_count), record_count: Number(snapshot.record_count),
      verified_at: new Date().toISOString() };
  }

  private async getOperations(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input: SessionRequest = parseContract(() => parseSessionRequest(raw));
    await this.core.authenticateSession(input.session_token);
    const sql = this.ctx.storage.sql;
    const count = (query: string) => Number(sql.exec<{ count: number }>(query).one().count);
    return { schema_version: APPLICATION_SCHEMA_VERSION, database_size_bytes: sql.databaseSize,
      counts: { requests: count("SELECT COUNT(*) AS count FROM system_requests"),
        audits: count("SELECT COUNT(*) AS count FROM audit_events"),
        outbox_pending: count("SELECT COUNT(*) AS count FROM sync_outbox WHERE status='PENDING'"),
        jobs_pending: count("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE status IN ('PENDING','RUNNING')"),
        history_practices: count("SELECT COUNT(*) AS count FROM practice_history"),
        history_seasons: count("SELECT COUNT(*) AS count FROM season_history") },
      usage: sql.exec<SqlRow>("SELECT * FROM usage_snapshots ORDER BY usage_date DESC LIMIT 30").toArray()
        .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
          key.endsWith("_bytes") || key.endsWith("_count") || key.endsWith("_pending") ? Number(value) : value]))),
      generated_at: new Date().toISOString() };
  }
}
