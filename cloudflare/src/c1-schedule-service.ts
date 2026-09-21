import {
  parseCancelPractice, parseConfirmTrainingWeek, parseCreatePractice, parseImportScheduleSnapshot,
  parsePrepareTrainingWeek, parsePreviewPracticeChange, parsePublishAdditionalPractice,
  parseScheduleWorkspace, parseUpdatePractice, parseUpdateScheduleTemplates, parseWeekMutation,
  type ImportScheduleSnapshotRequest, type PracticeSnapshot, type PracticeValues,
  type ScheduleTemplateSnapshot, type TrainingWeekSnapshot
} from "../../shared/c1-schedule-contract";
import {
  addCalendarDays, canonicalJson, dateInTimezone, isMonday, localDateTimeToIso
} from "../../shared/c1-rules";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";
import { C1Service, type AuthenticatedCoach, type C1RequestIdentity } from "./c1-service";
import { firstRow, isRecord, operationReceipt, parseContract, type SqlRow } from "./c1-support";

interface DueWeekJob {
  season_id: string;
  week_id: string;
  week_version: number;
  backend_generation: string;
  writer_epoch: number;
}

function parseDueWeekJob(value: unknown): DueWeekJob {
  if (!isRecord(value) || typeof value.season_id !== "string" || !value.season_id ||
      typeof value.week_id !== "string" || !value.week_id ||
      typeof value.week_version !== "number" || !Number.isSafeInteger(value.week_version) || value.week_version < 1 ||
      typeof value.backend_generation !== "string" || !value.backend_generation ||
      typeof value.writer_epoch !== "number" || !Number.isSafeInteger(value.writer_epoch) || value.writer_epoch < 0) {
    throw new Error("Invalid OPEN_TRAINING_WEEK payload.");
  }
  return value as unknown as DueWeekJob;
}

interface PracticeChangePreview extends Record<string, unknown> {
  season_id: string;
  practice_id: string;
  week_id: string;
  season_version: number;
  practice_version: number;
  week_version: number;
  signup_version: number;
  preview_token: string;
  change: "UPDATE" | "CANCEL";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  confirmed_count: number;
  waitlisted_count: number;
  cutoff_effect: string;
  invalidates_week_confirmation: boolean;
  values: Record<string, unknown>;
}

function practiceInputPayload(input: PracticeValues): Record<string, unknown> {
  return {
    practice_date: input.practice_date,
    start_time: input.start_time,
    end_time: input.end_time,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    location: input.location,
    address: input.address,
    map_url: input.map_url
  };
}

function templateProjection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    template_id: String(row.template_id), day_of_week: Number(row.day_of_week),
    start_time: String(row.start_time), end_time: String(row.end_time), timezone: String(row.timezone),
    location: String(row.location), address: String(row.address), map_url: String(row.map_url || ""),
    template_version: Number(row.template_version)
  };
}

function weekProjection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    week_id: String(row.week_id), week_start_date: String(row.week_start_date),
    scheduled_open_at: row.scheduled_open_at ? String(row.scheduled_open_at) : null,
    status: String(row.status), week_version: Number(row.week_version),
    confirmed_version: row.confirmed_version === null || row.confirmed_version === undefined
      ? null : Number(row.confirmed_version),
    confirmed_at: row.confirmed_at ? String(row.confirmed_at) : null,
    published_at: row.published_at ? String(row.published_at) : null,
    updated_at: String(row.updated_at)
  };
}

function practiceProjection(row: Record<string, unknown> | PracticeSnapshot): Record<string, unknown> {
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

function importComparable(table: "schedule_templates" | "training_weeks" | "practices", row: Record<string, unknown>): unknown {
  if (table === "schedule_templates") return {
    season_id: row.season_id, template_id: row.template_id, day_of_week: Number(row.day_of_week),
    start_time: row.start_time, end_time: row.end_time, timezone: row.timezone, location: row.location,
    address: row.address, map_url: row.map_url, active: Number(row.active) === 1,
    template_version: Number(row.template_version), created_at: row.created_at, updated_at: row.updated_at
  };
  if (table === "training_weeks") return {
    season_id: row.season_id, week_id: row.week_id, week_start_date: row.week_start_date,
    scheduled_open_at: row.scheduled_open_at, status: row.status, week_version: Number(row.week_version),
    confirmed_version: row.confirmed_version === null ? null : Number(row.confirmed_version),
    confirmed_by: row.confirmed_by, confirmed_at: row.confirmed_at, published_at: row.published_at,
    created_at: row.created_at, updated_at: row.updated_at
  };
  return {
    season_id: row.season_id, practice_id: row.practice_id, week_id: row.week_id,
    template_id: row.template_id, generation_key: row.generation_key,
    start_at: row.start_at, end_at: row.end_at, timezone: row.timezone, location: row.location,
    address: row.address, map_url: row.map_url, left_capacity: Number(row.left_capacity),
    right_capacity: Number(row.right_capacity), signup_cutoff_at: row.signup_cutoff_at,
    practice_version: Number(row.practice_version), cancelled_at: row.cancelled_at,
    cancelled_by: row.cancelled_by, schedule_published_at: row.schedule_published_at,
    schedule_published_by: row.schedule_published_by, created_at: row.created_at, updated_at: row.updated_at
  };
}

export class C1ScheduleService {
  private readonly core: C1Service;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.core = new C1Service(ctx, env);
  }

  async handle(path: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (path) {
      case "/internal/c1/import-schedule": return this.importSchedule(raw);
      case "/internal/c1/schedule-workspace": return this.scheduleWorkspace(raw);
      case "/internal/c1/update-schedule-templates": return this.updateTemplates(raw);
      case "/internal/c1/prepare-training-week": return this.prepareWeek(raw);
      case "/internal/c1/confirm-training-week": return this.confirmWeek(raw);
      case "/internal/c1/publish-training-week": return this.publishWeek(raw);
      case "/internal/c1/create-practice": return this.createPractice(raw);
      case "/internal/c1/publish-additional-practice": return this.publishAdditionalPractice(raw);
      case "/internal/c1/preview-practice-change": return this.previewPracticeChange(raw);
      case "/internal/c1/update-practice": return this.updatePractice(raw);
      case "/internal/c1/cancel-practice": return this.cancelPractice(raw);
      default: throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    }
  }

  publicSchedule(seasonId: string): Record<string, unknown> {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(seasonId)) throw new ApiError("INVALID_REQUEST", "season_id is invalid.");
    const season = this.requireSeason(seasonId);
    if (!["OPEN", "COMPLETED"].includes(String(season.status))) {
      throw new ApiError("SEASON_NOT_PUBLIC", "The season is not publicly available.", 404);
    }
    const now = new Date().toISOString();
    const weeks = this.ctx.storage.sql.exec<SqlRow>(
      `SELECT * FROM training_weeks WHERE season_id = ? AND status = 'OPENED'
       AND published_at IS NOT NULL AND published_at <= ? ORDER BY week_start_date, week_id`, seasonId, now
    ).toArray();
    const openedWeekIds = new Set(weeks.map((row) => String(row.week_id)));
    const practices = this.ctx.storage.sql.exec<SqlRow>(
      `SELECT * FROM practices WHERE season_id = ? AND cancelled_at IS NULL
       AND schedule_published_at IS NOT NULL AND schedule_published_at <= ? ORDER BY start_at, practice_id`, seasonId, now
    ).toArray().filter((row) => openedWeekIds.has(String(row.week_id))).map(practiceProjection);
    const visibleWeekIds = new Set(practices.map((row) => String(row.week_id)));
    return { season_id: seasonId, weeks: weeks.filter((row) => visibleWeekIds.has(String(row.week_id))).map(weekProjection),
      practices, generated_at: now };
  }

  private requireSeason(seasonId: string): SqlRow {
    const row = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM seasons WHERE season_id = ?", seasonId);
    if (!row) throw new ApiError("SEASON_NOT_FOUND", "The season does not exist.", 404);
    return row;
  }

  private requireOpenSeason(seasonId: string): SqlRow {
    const row = this.requireSeason(seasonId);
    if (row.status !== "OPEN") throw new ApiError("SEASON_NOT_OPEN", "The season is not open.", 409);
    return row;
  }

  private requireWeek(seasonId: string, weekId: string): SqlRow {
    const row = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM training_weeks WHERE season_id = ? AND week_id = ?", seasonId, weekId);
    if (!row) throw new ApiError("WEEK_NOT_FOUND", "The training week does not exist.", 404);
    return row;
  }

  private requirePractice(seasonId: string, practiceId: string): SqlRow {
    const row = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM practices WHERE season_id = ? AND practice_id = ?", seasonId, practiceId);
    if (!row) throw new ApiError("PRACTICE_NOT_FOUND", "The training does not exist.", 404);
    return row;
  }

  private practiceRows(seasonId: string, weekId: string): SqlRow[] {
    return this.ctx.storage.sql.exec<SqlRow>(
      "SELECT * FROM practices WHERE season_id = ? AND week_id = ? ORDER BY start_at, practice_id", seasonId, weekId
    ).toArray();
  }

  private workspaceProjection(seasonId: string): Record<string, unknown> {
    this.requireSeason(seasonId);
    const sql = this.ctx.storage.sql;
    return {
      season_id: seasonId,
      templates: sql.exec<SqlRow>(
        "SELECT * FROM schedule_templates WHERE season_id = ? AND active = 1 ORDER BY day_of_week, start_time, template_id",
        seasonId).toArray().map(templateProjection),
      weeks: sql.exec<SqlRow>(
        "SELECT * FROM training_weeks WHERE season_id = ? ORDER BY week_start_date, week_id", seasonId
      ).toArray().map(weekProjection),
      practices: sql.exec<SqlRow>(
        "SELECT * FROM practices WHERE season_id = ? ORDER BY start_at, practice_id", seasonId
      ).toArray().map(practiceProjection),
      generated_at: new Date().toISOString()
    };
  }

  private currentView(response: Record<string, unknown>, seasonId: string): Record<string, unknown> {
    try { return { ...response, view_status: "ready", current_view: this.workspaceProjection(seasonId) }; }
    catch { return { ...response, view_status: "reload_required" }; }
  }

  private async scheduleWorkspace(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseScheduleWorkspace(raw));
    await this.core.authenticateSession(input.session_token);
    return this.workspaceProjection(input.season_id);
  }

  private assertImportVersion(table: "schedule_templates" | "training_weeks" | "practices", keys: SqlStorageValue[],
    versionColumn: string, incomingVersion: number, comparable: unknown): SqlRow | null {
    const keyWhere = table === "schedule_templates" ? "season_id = ? AND template_id = ?" :
      table === "training_weeks" ? "season_id = ? AND week_id = ?" : "season_id = ? AND practice_id = ?";
    const current = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT *, ${versionColumn} AS imported_version FROM ${table} WHERE ${keyWhere}`, ...keys);
    if (!current) return null;
    const currentVersion = Number(current.imported_version);
    if (incomingVersion < currentVersion) {
      throw new ApiError("IMPORT_VERSION_REGRESSION", "The snapshot contains an older schedule version.", 409);
    }
    if (incomingVersion === currentVersion && canonicalJson(comparable) !== canonicalJson(importComparable(table, current))) {
      throw new ApiError("IMPORT_CONFLICT", "The same schedule version contains different data.", 409);
    }
    return current;
  }

  private validateImportGraph(input: ImportScheduleSnapshotRequest): void {
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) throw new ApiError("IMPORT_CONFLICT", `${label} contains duplicates.`, 409);
    };
    unique(input.templates.map((row) => `${row.season_id}\n${row.template_id}`), "templates");
    unique(input.weeks.map((row) => `${row.season_id}\n${row.week_id}`), "weeks");
    unique(input.weeks.map((row) => `${row.season_id}\n${row.week_start_date}`), "week dates");
    unique(input.practices.map((row) => `${row.season_id}\n${row.practice_id}`), "practices");
    unique(input.practices.filter((row) => row.generation_key)
      .map((row) => `${row.season_id}\n${row.generation_key}`), "generation keys");
    const sql = this.ctx.storage.sql;
    const seasons = new Map(sql.exec<SqlRow>("SELECT * FROM seasons").toArray().map((row) => [String(row.season_id), row]));
    const coaches = new Set(sql.exec<SqlRow>("SELECT coach_id FROM coaches").toArray().map((row) => String(row.coach_id)));
    const templateIds = new Set(input.templates.map((row) => `${row.season_id}\n${row.template_id}`));
    const weekIds = new Set(input.weeks.map((row) => `${row.season_id}\n${row.week_id}`));
    const weeksById = new Map(input.weeks.map((row) => [`${row.season_id}\n${row.week_id}`, row]));
    for (const template of input.templates) {
      const season = seasons.get(template.season_id);
      if (!season) throw new ApiError("IMPORT_REFERENCE_MISSING", "A schedule template has an unknown season.", 409);
      if (template.timezone !== season.timezone) throw new ApiError("IMPORT_CONFLICT", "A template timezone differs from its season.", 409);
    }
    for (const week of input.weeks) {
      const season = seasons.get(week.season_id);
      if (!season) throw new ApiError("IMPORT_REFERENCE_MISSING", "A training week has an unknown season.", 409);
      if (!isMonday(week.week_start_date)) throw new ApiError("WEEK_START_NOT_MONDAY", "A training week must start on Monday.", 409);
      if (week.week_start_date > String(season.end_date) || addCalendarDays(week.week_start_date, 6) < String(season.start_date)) {
        throw new ApiError("WEEK_OUTSIDE_SEASON", "A training week is outside its season.", 409);
      }
      if (week.confirmed_by && !coaches.has(week.confirmed_by)) {
        throw new ApiError("IMPORT_REFERENCE_MISSING", "A training week has an unknown confirming coach.", 409);
      }
      if (week.status === "SCHEDULED" && (!week.scheduled_open_at || !week.confirmed_by || !week.confirmed_at ||
          week.confirmed_version !== week.week_version)) {
        throw new ApiError("IMPORT_CONFLICT", "A scheduled week has incomplete confirmation data.", 409);
      }
      if (week.status === "DRAFT" && (week.scheduled_open_at || week.confirmed_version || week.confirmed_by ||
          week.confirmed_at || week.published_at)) {
        throw new ApiError("IMPORT_CONFLICT", "A draft week contains confirmation data.", 409);
      }
      if (week.status === "SCHEDULED" && week.published_at) {
        throw new ApiError("IMPORT_CONFLICT", "A scheduled week is already marked published.", 409);
      }
      if (week.status === "OPENED" && (!week.scheduled_open_at || !week.confirmed_version || !week.confirmed_by ||
          !week.confirmed_at || !week.published_at)) {
        throw new ApiError("IMPORT_CONFLICT", "An opened week has incomplete publication data.", 409);
      }
    }
    for (const practice of input.practices) {
      const season = seasons.get(practice.season_id);
      if (!season || !weekIds.has(`${practice.season_id}\n${practice.week_id}`)) {
        throw new ApiError("IMPORT_REFERENCE_MISSING", "A training has an unknown season or week.", 409);
      }
      if (practice.template_id && !templateIds.has(`${practice.season_id}\n${practice.template_id}`)) {
        throw new ApiError("IMPORT_REFERENCE_MISSING", "A training has an unknown template.", 409);
      }
      const week = weeksById.get(`${practice.season_id}\n${practice.week_id}`)!;
      if (Date.parse(practice.end_at) <= Date.parse(practice.start_at) ||
          practice.start_at < localDateTimeToIso(String(season.start_date), "00:00", String(season.timezone)) ||
          practice.end_at > String(season.season_ends_at)) {
        throw new ApiError("PRACTICE_OUTSIDE_SEASON", "A training has invalid season time boundaries.", 409);
      }
      if (Date.parse(practice.signup_cutoff_at) !== Date.parse(practice.start_at) - 7_200_000) {
        throw new ApiError("IMPORT_CONFLICT", "A training has an invalid signup cutoff.", 409);
      }
      if (Boolean(practice.cancelled_at) !== Boolean(practice.cancelled_by) ||
          Boolean(practice.schedule_published_at) !== Boolean(practice.schedule_published_by) ||
          practice.schedule_published_at && week.status !== "OPENED") {
        throw new ApiError("IMPORT_CONFLICT", "A training has inconsistent publication or cancellation data.", 409);
      }
      if (practice.cancelled_by && !coaches.has(practice.cancelled_by) ||
          practice.schedule_published_by && !coaches.has(practice.schedule_published_by)) {
        throw new ApiError("IMPORT_REFERENCE_MISSING", "A training refers to an unknown coach.", 409);
      }
    }
  }

  private async importSchedule(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseImportScheduleSnapshot(raw));
    const { request_id: _requestId, ...snapshot } = input;
    const identity = await this.core.createRequestIdentity("C1:MIGRATION", "importScheduleSnapshot", input.request_id, snapshot);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    this.validateImportGraph(input);
    const prior = firstRow<{ payload_digest: string }>(this.ctx.storage.sql,
      "SELECT payload_digest FROM schedule_migration_snapshots WHERE source_snapshot_id = ?", input.source_snapshot_id);
    if (prior && prior.payload_digest !== identity.payloadDigest) {
      throw new ApiError("IMPORT_SNAPSHOT_CONFLICT", "This schedule snapshot identifier has different content.", 409);
    }
    const at = new Date().toISOString();
    const response = { operation: operationReceipt("importScheduleSnapshot", input.request_id, at), result: {
      source_snapshot_id: input.source_snapshot_id, templates: input.templates.length,
      weeks: input.weeks.length, practices: input.practices.length
    } };
    this.ctx.storage.transactionSync(() => {
      input.templates.forEach((row) => this.upsertTemplate(row));
      input.weeks.forEach((row) => this.upsertWeek(row));
      input.practices.forEach((row) => this.upsertPractice(row));
      this.core.recordRequest(identity, "C1:MIGRATION", "importScheduleSnapshot", input.request_id, response,
        { source_snapshot_id: input.source_snapshot_id, counts: response.result }, at);
      this.ctx.storage.sql.exec(
        `INSERT INTO schedule_migration_snapshots(source_snapshot_id, payload_digest, imported_at, request_key)
         VALUES (?, ?, ?, ?) ON CONFLICT(source_snapshot_id) DO NOTHING`,
        input.source_snapshot_id, identity.payloadDigest, at, identity.requestKey).toArray();
    });
    return response;
  }

  private upsertTemplate(row: ScheduleTemplateSnapshot): void {
    this.assertImportVersion("schedule_templates", [row.season_id, row.template_id], "template_version", row.template_version, row);
    this.ctx.storage.sql.exec(
      `INSERT INTO schedule_templates(season_id, template_id, day_of_week, start_time, end_time, timezone,
         location, address, map_url, active, template_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id, template_id) DO UPDATE SET day_of_week=excluded.day_of_week,
         start_time=excluded.start_time, end_time=excluded.end_time, timezone=excluded.timezone,
         location=excluded.location, address=excluded.address, map_url=excluded.map_url,
         active=excluded.active, template_version=excluded.template_version,
         created_at=excluded.created_at, updated_at=excluded.updated_at`,
      row.season_id, row.template_id, row.day_of_week, row.start_time, row.end_time, row.timezone,
      row.location, row.address, row.map_url, row.active ? 1 : 0, row.template_version, row.created_at, row.updated_at).toArray();
  }

  private upsertWeek(row: TrainingWeekSnapshot): void {
    const current = this.assertImportVersion("training_weeks", [row.season_id, row.week_id], "week_version", row.week_version, row);
    if (current && current.week_start_date !== row.week_start_date) {
      throw new ApiError("IMPORT_CONFLICT", "A training week date cannot be reassigned.", 409);
    }
    const owner = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT week_id FROM training_weeks WHERE season_id = ? AND week_start_date = ?", row.season_id, row.week_start_date);
    if (owner && owner.week_id !== row.week_id) throw new ApiError("IMPORT_CONFLICT", "A week date belongs to another week.", 409);
    this.ctx.storage.sql.exec(
      `INSERT INTO training_weeks(season_id, week_id, week_start_date, scheduled_open_at, status,
         week_version, confirmed_version, confirmed_by, confirmed_at, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id, week_id) DO UPDATE SET week_start_date=excluded.week_start_date,
         scheduled_open_at=excluded.scheduled_open_at, status=excluded.status, week_version=excluded.week_version,
         confirmed_version=excluded.confirmed_version, confirmed_by=excluded.confirmed_by,
         confirmed_at=excluded.confirmed_at, published_at=excluded.published_at,
         created_at=excluded.created_at, updated_at=excluded.updated_at`,
      row.season_id, row.week_id, row.week_start_date, row.scheduled_open_at, row.status,
      row.week_version, row.confirmed_version, row.confirmed_by, row.confirmed_at, row.published_at,
      row.created_at, row.updated_at).toArray();
  }

  private upsertPractice(row: PracticeSnapshot): void {
    const current = this.assertImportVersion("practices", [row.season_id, row.practice_id], "practice_version", row.practice_version, row);
    if (current && (current.week_id !== row.week_id || current.generation_key !== row.generation_key)) {
      throw new ApiError("IMPORT_CONFLICT", "A training publication identity cannot be reassigned.", 409);
    }
    if (row.generation_key) {
      const owner = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT practice_id FROM practices WHERE season_id = ? AND generation_key = ?", row.season_id, row.generation_key);
      if (owner && owner.practice_id !== row.practice_id) {
        throw new ApiError("IMPORT_CONFLICT", "A generation key belongs to another training.", 409);
      }
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO practices(season_id, practice_id, week_id, template_id, generation_key, start_at, end_at,
         timezone, location, address, map_url, left_capacity, right_capacity, signup_cutoff_at,
         practice_version, cancelled_at, cancelled_by, schedule_published_at, schedule_published_by,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id, practice_id) DO UPDATE SET week_id=excluded.week_id, template_id=excluded.template_id,
         generation_key=excluded.generation_key, start_at=excluded.start_at, end_at=excluded.end_at,
         timezone=excluded.timezone, location=excluded.location, address=excluded.address, map_url=excluded.map_url,
         left_capacity=excluded.left_capacity, right_capacity=excluded.right_capacity,
         signup_cutoff_at=excluded.signup_cutoff_at, practice_version=excluded.practice_version,
         cancelled_at=excluded.cancelled_at, cancelled_by=excluded.cancelled_by,
         schedule_published_at=excluded.schedule_published_at,
         schedule_published_by=excluded.schedule_published_by, created_at=excluded.created_at,
         updated_at=excluded.updated_at`,
      row.season_id, row.practice_id, row.week_id, row.template_id, row.generation_key,
      row.start_at, row.end_at, row.timezone, row.location, row.address, row.map_url,
      row.left_capacity, row.right_capacity, row.signup_cutoff_at, row.practice_version,
      row.cancelled_at, row.cancelled_by, row.schedule_published_at, row.schedule_published_by,
      row.created_at, row.updated_at).toArray();
    this.ctx.storage.sql.exec(
      `INSERT INTO practice_versions(season_id, practice_id, signup_version, seat_plan_version, published_revision)
       VALUES (?, ?, 0, 0, 0) ON CONFLICT(season_id, practice_id) DO NOTHING`, row.season_id, row.practice_id).toArray();
  }

  private async updateTemplates(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseUpdateScheduleTemplates(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, season_version: input.season_version, templates: input.templates };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "updateScheduleTemplates", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id);
    const at = new Date().toISOString();
    let response: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth);
      const season = this.requireOpenSeason(input.season_id);
      if (Number(season.season_version) !== input.season_version) throw new ApiError("VERSION_CONFLICT", "The season changed.", 409);
      this.ctx.storage.sql.exec(
        `UPDATE schedule_templates SET active=0, template_version=template_version+1, updated_at=?
         WHERE season_id=? AND active=1`, at, input.season_id).toArray();
      const created = input.templates.map((template, index) => {
        const row = { ...template, season_id: input.season_id,
          template_id: `template_${identity.requestKey.slice(7, 39)}_${index + 1}`,
          timezone: String(season.timezone), active: true, template_version: 1, created_at: at, updated_at: at };
        this.upsertTemplate(row);
        return templateProjection(row);
      });
      const nextSeasonVersion = Number(season.season_version) + 1;
      this.ctx.storage.sql.exec("UPDATE seasons SET season_version=?, updated_at=? WHERE season_id=?",
        nextSeasonVersion, at, input.season_id).toArray();
      response = { operation: operationReceipt("updateScheduleTemplates", input.request_id, at),
        result: { season_id: input.season_id, season_version: nextSeasonVersion, templates: created } };
      this.core.recordRequest(identity, auth.coach_id, "updateScheduleTemplates", input.request_id, response,
        { season_id: input.season_id, template_count: created.length }, at);
      this.core.enqueueChange(identity, "SCHEDULE_CHANGED", "updateScheduleTemplates", { season_id: input.season_id }, at);
    });
    return this.currentView(response, input.season_id);
  }

  private practiceValues(input: PracticeValues, season: SqlRow): Record<string, unknown> {
    const timezone = input.timezone || String(season.timezone);
    const startAt = parseContract(() => localDateTimeToIso(input.practice_date, input.start_time, timezone));
    const endAt = parseContract(() => localDateTimeToIso(input.practice_date, input.end_time, timezone));
    if (Date.parse(endAt) <= Date.parse(startAt)) throw new ApiError("INVALID_TIME_RANGE", "A training must end after it starts.");
    return { start_at: startAt, end_at: endAt, timezone, location: input.location, address: input.address,
      map_url: input.map_url, signup_cutoff_at: new Date(Date.parse(startAt) - 7_200_000).toISOString() };
  }

  private validatePracticeTiming(values: Record<string, unknown>, season: SqlRow, week?: SqlRow): void {
    const startAt = String(values.start_at);
    const endAt = String(values.end_at);
    const seasonStart = parseContract(() => localDateTimeToIso(String(season.start_date), "00:00", String(season.timezone)));
    if (startAt < seasonStart || endAt > String(season.season_ends_at)) {
      throw new ApiError("PRACTICE_OUTSIDE_SEASON", "Both training times must be inside the season.", 409);
    }
    if (week) {
      const seasonDate = dateInTimezone(startAt, String(season.timezone));
      if (seasonDate < String(week.week_start_date) || seasonDate > addCalendarDays(String(week.week_start_date), 6)) {
        throw new ApiError("PRACTICE_OUTSIDE_WEEK", "Keep the training within its selected week.", 409);
      }
    }
  }

  private async prepareWeek(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parsePrepareTrainingWeek(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, season_version: input.season_version, week_start_date: input.week_start_date };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "prepareTrainingWeek", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id);
    const at = new Date().toISOString();
    let response: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth);
      const season = this.requireOpenSeason(input.season_id);
      if (!isMonday(input.week_start_date)) throw new ApiError("WEEK_START_NOT_MONDAY", "The training week must start on Monday.");
      if (input.week_start_date > String(season.end_date) || addCalendarDays(input.week_start_date, 6) < String(season.start_date)) {
        throw new ApiError("WEEK_OUTSIDE_SEASON", "The training week is outside the season.", 409);
      }
      let week = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT * FROM training_weeks WHERE season_id=? AND week_start_date=?", input.season_id, input.week_start_date);
      let created = false;
      if (!week) {
        if (Number(season.season_version) !== input.season_version) throw new ApiError("VERSION_CONFLICT", "The season changed.", 409);
        const templates = this.ctx.storage.sql.exec<SqlRow>(
          `SELECT * FROM schedule_templates WHERE season_id=? AND active=1
           ORDER BY day_of_week, start_time, template_id`, input.season_id).toArray();
        if (!templates.length) throw new ApiError("SCHEDULE_TEMPLATES_REQUIRED", "Configure a training template first.", 409);
        const weekId = `week_${identity.requestKey.slice(7, 39)}`;
        this.ctx.storage.sql.exec(
          `INSERT INTO training_weeks(season_id, week_id, week_start_date, scheduled_open_at, status,
             week_version, confirmed_version, confirmed_by, confirmed_at, published_at, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'DRAFT', 1, NULL, NULL, NULL, NULL, ?, ?)`,
          input.season_id, weekId, input.week_start_date, at, at).toArray();
        week = this.requireWeek(input.season_id, weekId);
        templates.forEach((template, index) => {
          const practiceDate = addCalendarDays(input.week_start_date, Number(template.day_of_week) - 1);
          if (practiceDate < String(season.start_date) || practiceDate > String(season.end_date)) return;
          const values = this.practiceValues({ practice_date: practiceDate, start_time: String(template.start_time),
            end_time: String(template.end_time), timezone: String(template.timezone), location: String(template.location),
            address: String(template.address), map_url: String(template.map_url) }, season);
          const practice: PracticeSnapshot = {
            season_id: input.season_id, practice_id: `practice_${identity.requestKey.slice(7, 35)}_${index + 1}`,
            week_id: weekId, template_id: String(template.template_id),
            generation_key: `${input.season_id}:${weekId}:${String(template.template_id)}`,
            start_at: String(values.start_at), end_at: String(values.end_at), timezone: String(values.timezone),
            location: String(values.location), address: String(values.address), map_url: String(values.map_url),
            left_capacity: 10, right_capacity: 10, signup_cutoff_at: String(values.signup_cutoff_at),
            practice_version: 1, cancelled_at: null, cancelled_by: null, schedule_published_at: null,
            schedule_published_by: null, created_at: at, updated_at: at
          };
          this.upsertPractice(practice);
        });
        created = true;
      }
      const practices = this.practiceRows(input.season_id, String(week.week_id)).map(practiceProjection);
      response = { operation: operationReceipt("prepareTrainingWeek", input.request_id, at), result: {
        season_id: input.season_id, created, week: weekProjection(week), practices
      } };
      this.core.recordRequest(identity, auth.coach_id, "prepareTrainingWeek", input.request_id, response,
        { season_id: input.season_id, week_id: week.week_id, created }, at);
      if (created) this.core.enqueueChange(identity, "SCHEDULE_CHANGED", "prepareTrainingWeek",
        { season_id: input.season_id, week_id: week.week_id }, at);
    });
    return this.currentView(response, input.season_id);
  }

  private changeWeek(week: SqlRow, at: string): void {
    week.week_version = Number(week.week_version) + 1;
    week.updated_at = at;
    if (week.status !== "OPENED") {
      week.status = "DRAFT"; week.scheduled_open_at = null; week.confirmed_version = null;
      week.confirmed_by = null; week.confirmed_at = null;
    }
  }

  private saveWeek(week: SqlRow): void {
    this.ctx.storage.sql.exec(
      `UPDATE training_weeks SET scheduled_open_at=?, status=?, week_version=?, confirmed_version=?,
         confirmed_by=?, confirmed_at=?, published_at=?, updated_at=? WHERE season_id=? AND week_id=?`,
      week.scheduled_open_at, week.status, week.week_version, week.confirmed_version, week.confirmed_by,
      week.confirmed_at, week.published_at, week.updated_at, week.season_id, week.week_id).toArray();
  }

  private openWeek(week: SqlRow, practices: SqlRow[], actorId: string, at: string,
    preserveConfirmation: boolean): void {
    week.week_version = Number(week.week_version) + 1;
    if (!preserveConfirmation) {
      week.confirmed_version = week.week_version;
      week.confirmed_by = actorId;
      week.confirmed_at = at;
      week.scheduled_open_at = at;
    }
    week.status = "OPENED"; week.published_at = at; week.updated_at = at;
    this.saveWeek(week);
    practices.filter((row) => !row.cancelled_at).forEach((row) => {
      this.ctx.storage.sql.exec(
        `UPDATE practices SET schedule_published_at=?, schedule_published_by=?,
           practice_version=practice_version+1, updated_at=? WHERE season_id=? AND practice_id=?`,
        at, actorId, at, row.season_id, row.practice_id).toArray();
    });
  }

  private async confirmWeek(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseConfirmTrainingWeek(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, week_id: input.week_id, week_version: input.week_version,
      open_at: input.open_at ?? null, open_date: input.open_date ?? null, open_time: input.open_time ?? null };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "confirmTrainingWeek", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id);
    const season = this.requireSeason(input.season_id);
    const openDate = input.open_date;
    const openTime = input.open_time;
    const normalizedOpen = input.open_at || (openDate && openTime
      ? parseContract(() => localDateTimeToIso(openDate, openTime, String(season.timezone))) : "IMMEDIATE");
    const at = new Date().toISOString();
    const openAt = normalizedOpen === "IMMEDIATE" ? at : normalizedOpen;
    let response: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth);
      this.requireOpenSeason(input.season_id);
      const week = this.requireWeek(input.season_id, input.week_id);
      if (Number(week.week_version) !== input.week_version) throw new ApiError("VERSION_CONFLICT", "The training week changed.", 409);
      if (!["DRAFT", "SCHEDULED"].includes(String(week.status))) throw new ApiError("WEEK_ALREADY_OPEN", "The week is already public.", 409);
      const practices = this.practiceRows(input.season_id, input.week_id);
      const active = practices.filter((row) => !row.cancelled_at);
      if (!active.length) throw new ApiError("WEEK_EMPTY", "Add a training before confirming the week.", 409);
      if (active.some((row) => Date.parse(String(row.start_at)) <= Math.max(Date.now(), Date.parse(openAt)))) {
        throw new ApiError("OPEN_TIME_TOO_LATE", "Open the week before its first training starts.", 409);
      }
      if (Date.parse(openAt) <= Date.now()) {
        this.openWeek(week, practices, auth.coach_id, at, false);
      } else {
        week.week_version = Number(week.week_version) + 1; week.confirmed_version = week.week_version;
        week.confirmed_by = auth.coach_id; week.confirmed_at = at; week.scheduled_open_at = openAt;
        week.status = "SCHEDULED"; week.updated_at = at;
        this.saveWeek(week);
        const jobPayload: DueWeekJob = { season_id: input.season_id, week_id: input.week_id,
          week_version: Number(week.week_version), backend_generation: this.env.BACKEND_GENERATION,
          writer_epoch: Number(this.env.WRITER_EPOCH) };
        this.ctx.storage.sql.exec(
          `INSERT INTO scheduled_jobs(job_id, job_type, payload_json, status, due_at_ms, created_at, updated_at)
           VALUES (?, 'OPEN_TRAINING_WEEK', ?, 'PENDING', ?, ?, ?)`,
          `job_${identity.requestKey.slice(7)}`, JSON.stringify(jobPayload), Date.parse(openAt), at, at).toArray();
      }
      const currentWeek = this.requireWeek(input.season_id, input.week_id);
      response = { operation: operationReceipt("confirmTrainingWeek", input.request_id, at), result: {
        season_id: input.season_id, week: weekProjection(currentWeek),
        practices: this.practiceRows(input.season_id, input.week_id).map(practiceProjection)
      } };
      this.core.recordRequest(identity, auth.coach_id, "confirmTrainingWeek", input.request_id, response,
        { season_id: input.season_id, week_id: input.week_id, open_at: openAt }, at);
      this.core.enqueueChange(identity, "SCHEDULE_CHANGED", "confirmTrainingWeek",
        { season_id: input.season_id, week_id: input.week_id }, at);
    });
    return this.currentView(response, input.season_id);
  }

  private async publishWeek(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseWeekMutation(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, week_id: input.week_id, week_version: input.week_version };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "publishTrainingWeek", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id);
    const response = this.publishWeekTransaction(identity, input.request_id, auth.coach_id, auth,
      input.season_id, input.week_id, input.week_version, new Date().toISOString());
    return this.currentView(response, input.season_id);
  }

  private publishWeekTransaction(identity: C1RequestIdentity, requestId: string, actorId: string,
    auth: AuthenticatedCoach | null, seasonId: string, weekId: string, weekVersion: number,
    at: string): Record<string, unknown> {
    let response: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      if (auth) this.core.assertSessionCurrent(auth);
      this.requireOpenSeason(seasonId);
      const week = this.requireWeek(seasonId, weekId);
      if (Number(week.week_version) !== weekVersion) throw new ApiError("VERSION_CONFLICT", "The training week changed.", 409);
      if (week.status !== "SCHEDULED" || !week.scheduled_open_at || Date.parse(String(week.scheduled_open_at)) > Date.now() ||
          Number(week.confirmed_version) !== Number(week.week_version)) {
        throw new ApiError("WEEK_NOT_DUE", "The confirmed week is not due to open.", 409);
      }
      const practices = this.practiceRows(seasonId, weekId);
      this.openWeek(week, practices, actorId, at, true);
      response = { operation: operationReceipt("publishTrainingWeek", requestId, at), result: {
        season_id: seasonId, week: weekProjection(this.requireWeek(seasonId, weekId)),
        practices: this.practiceRows(seasonId, weekId).map(practiceProjection)
      } };
      this.core.recordRequest(identity, auth ? auth.coach_id : "C1:SYSTEM", "publishTrainingWeek", requestId, response,
        { season_id: seasonId, week_id: weekId }, at);
      this.core.enqueueChange(identity, "SCHEDULE_CHANGED", "publishTrainingWeek",
        { season_id: seasonId, week_id: weekId }, at);
    });
    return response;
  }

  async publishDueWeek(raw: unknown): Promise<boolean> {
    const payload = parseDueWeekJob(raw);
    if (payload.backend_generation !== this.env.BACKEND_GENERATION ||
        payload.writer_epoch !== Number(this.env.WRITER_EPOCH)) return false;
    const week = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM training_weeks WHERE season_id=? AND week_id=?", payload.season_id, payload.week_id);
    const season = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT status FROM seasons WHERE season_id=?", payload.season_id);
    if (!season || season.status !== "OPEN" || !week || week.status !== "SCHEDULED" || Number(week.week_version) !== payload.week_version ||
        Number(week.confirmed_version) !== payload.week_version || !week.scheduled_open_at ||
        Date.parse(String(week.scheduled_open_at)) > Date.now()) return false;
    const requestId = `due_${payload.week_id}_${payload.week_version}`;
    const identity = await this.core.createRequestIdentity("C1:SYSTEM", "publishTrainingWeek", requestId,
      { season_id: payload.season_id, week_id: payload.week_id, week_version: payload.week_version });
    if (this.core.replayRequest(identity.requestKey, identity.payloadDigest)) return true;
    const actorId = String(week.confirmed_by || "scheduled_publisher");
    this.publishWeekTransaction(identity, requestId, actorId, null, payload.season_id, payload.week_id,
      payload.week_version, new Date().toISOString());
    return true;
  }

  private async createPractice(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseCreatePractice(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, week_id: input.week_id, week_version: input.week_version,
      values: practiceInputPayload(input) };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "createPractice", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id);
    const values = this.practiceValues(input, this.requireSeason(input.season_id));
    const at = new Date().toISOString();
    let response: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth);
      const season = this.requireOpenSeason(input.season_id);
      const week = this.requireWeek(input.season_id, input.week_id);
      if (Number(week.week_version) !== input.week_version) throw new ApiError("VERSION_CONFLICT", "The training week changed.", 409);
      if (!["DRAFT", "SCHEDULED", "OPENED"].includes(String(week.status))) throw new ApiError("WEEK_NOT_EDITABLE", "The week is not editable.", 409);
      this.validatePracticeTiming(values, season, week);
      if (Date.parse(String(values.start_at)) <= Date.now()) throw new ApiError("PRACTICE_ALREADY_STARTED", "Choose a future training time.", 409);
      const practice: PracticeSnapshot = { season_id: input.season_id,
        practice_id: `practice_${identity.requestKey.slice(7, 39)}`, week_id: input.week_id,
        template_id: null, generation_key: null, start_at: String(values.start_at), end_at: String(values.end_at),
        timezone: String(values.timezone), location: String(values.location), address: String(values.address),
        map_url: String(values.map_url), left_capacity: 10, right_capacity: 10,
        signup_cutoff_at: String(values.signup_cutoff_at), practice_version: 1, cancelled_at: null,
        cancelled_by: null, schedule_published_at: null, schedule_published_by: null, created_at: at, updated_at: at };
      this.upsertPractice(practice);
      this.changeWeek(week, at); this.saveWeek(week);
      response = { operation: operationReceipt("createPractice", input.request_id, at), result: {
        season_id: input.season_id, week: weekProjection(week), practice: practiceProjection(practice)
      } };
      this.core.recordRequest(identity, auth.coach_id, "createPractice", input.request_id, response,
        { season_id: input.season_id, week_id: input.week_id, practice_id: practice.practice_id }, at);
      this.core.enqueueChange(identity, "SCHEDULE_CHANGED", "createPractice",
        { season_id: input.season_id, week_id: input.week_id, practice_id: practice.practice_id }, at);
    });
    return this.currentView(response, input.season_id);
  }

  private async publishAdditionalPractice(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parsePublishAdditionalPractice(raw));
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, week_id: input.week_id, practice_id: input.practice_id,
      week_version: input.week_version, practice_version: input.practice_version };
    const identity = await this.core.createRequestIdentity(auth.coach_id, "publishAdditionalPractice", input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id);
    const at = new Date().toISOString();
    let response: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth); this.requireOpenSeason(input.season_id);
      const week = this.requireWeek(input.season_id, input.week_id);
      const practice = this.requirePractice(input.season_id, input.practice_id);
      if (Number(week.week_version) !== input.week_version || Number(practice.practice_version) !== input.practice_version) {
        throw new ApiError("VERSION_CONFLICT", "The week or training changed.", 409);
      }
      if (week.status !== "OPENED" || practice.week_id !== input.week_id) throw new ApiError("WEEK_NOT_OPEN", "Select an open week.", 409);
      if (practice.cancelled_at || practice.schedule_published_at || Date.parse(String(practice.start_at)) <= Date.now()) {
        throw new ApiError("PRACTICE_NOT_PUBLISHABLE", "Only a future draft training can be published.", 409);
      }
      practice.schedule_published_at = at; practice.schedule_published_by = auth.coach_id;
      practice.practice_version = Number(practice.practice_version) + 1; practice.updated_at = at;
      this.ctx.storage.sql.exec(
        `UPDATE practices SET schedule_published_at=?, schedule_published_by=?, practice_version=?, updated_at=?
         WHERE season_id=? AND practice_id=?`, at, auth.coach_id, practice.practice_version, at,
        input.season_id, input.practice_id).toArray();
      this.changeWeek(week, at); this.saveWeek(week);
      response = { operation: operationReceipt("publishAdditionalPractice", input.request_id, at), result: {
        season_id: input.season_id, week: weekProjection(week), practice: practiceProjection(practice)
      } };
      this.core.recordRequest(identity, auth.coach_id, "publishAdditionalPractice", input.request_id, response,
        { season_id: input.season_id, week_id: input.week_id, practice_id: input.practice_id }, at);
      this.core.enqueueChange(identity, "SCHEDULE_CHANGED", "publishAdditionalPractice",
        { season_id: input.season_id, week_id: input.week_id, practice_id: input.practice_id }, at);
    });
    return this.currentView(response, input.season_id);
  }

  private async buildPreview(seasonId: string, practiceId: string, change: "UPDATE" | "CANCEL",
    input?: PracticeValues): Promise<PracticeChangePreview> {
    const season = this.requireOpenSeason(seasonId);
    const practice = this.requirePractice(seasonId, practiceId);
    const week = this.requireWeek(seasonId, String(practice.week_id));
    if (practice.cancelled_at) throw new ApiError("PRACTICE_CANCELLED", "The training is already cancelled.", 409);
    if (Date.parse(String(practice.start_at)) <= Date.now()) throw new ApiError("PRACTICE_ALREADY_STARTED", "Started training is read-only.", 409);
    const values = change === "UPDATE" ? this.practiceValues(input!, season) : {};
    if (change === "UPDATE") {
      this.validatePracticeTiming(values, season);
      if (Date.parse(String(values.start_at)) <= Date.now()) throw new ApiError("PRACTICE_ALREADY_STARTED", "Choose a future training time.", 409);
    }
    const state = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM practice_versions WHERE season_id=? AND practice_id=?", seasonId, practiceId);
    const signupVersion = Number(state?.signup_version ?? 0);
    const fingerprint = { season_id: seasonId, season_version: Number(season.season_version),
      practice_id: practiceId, practice_version: Number(practice.practice_version),
      week_version: Number(week.week_version), signup_version: signupVersion, change, values };
    const token = `sha256_v1:${await sha256Base64Url(canonicalJson(fingerprint))}`;
    const next = { ...practice, ...values };
    const signupCounts = this.ctx.storage.sql.exec<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM signups
       WHERE season_id=? AND practice_id=? AND status IN ('CONFIRMED', 'WAITLISTED') GROUP BY status`,
      seasonId, practiceId).toArray();
    const count = (status: string) => Number(signupCounts.find((row) => row.status === status)?.count ?? 0);
    return { season_id: seasonId, practice_id: practiceId, week_id: String(week.week_id),
      season_version: Number(season.season_version), practice_version: Number(practice.practice_version),
      week_version: Number(week.week_version), signup_version: signupVersion, preview_token: token,
      change, before: practiceProjection(practice), after: { ...practiceProjection(next), cancelled: change === "CANCEL" },
      confirmed_count: count("CONFIRMED"), waitlisted_count: count("WAITLISTED"),
      cutoff_effect: change === "CANCEL" ? "CLOSE" : next.signup_cutoff_at === practice.signup_cutoff_at ? "UNCHANGED" : "RECALCULATED",
      invalidates_week_confirmation: week.status === "SCHEDULED", values };
  }

  private async previewPracticeChange(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parsePreviewPracticeChange(raw));
    await this.core.authenticateSession(input.session_token);
    return this.buildPreview(input.season_id, input.practice_id, input.change,
      input.change === "UPDATE" ? input as PracticeValues : undefined);
  }

  private async updatePractice(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseUpdatePractice(raw));
    return this.commitPracticeChange(input, "UPDATE");
  }

  private async cancelPractice(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseCancelPractice(raw));
    return this.commitPracticeChange(input, "CANCEL");
  }

  private async commitPracticeChange(input: ReturnType<typeof parseUpdatePractice> | ReturnType<typeof parseCancelPractice>,
    change: "UPDATE" | "CANCEL"): Promise<Record<string, unknown>> {
    const auth = await this.core.authenticateSession(input.session_token);
    const payload = { season_id: input.season_id, week_id: input.week_id, practice_id: input.practice_id,
      week_version: input.week_version, practice_version: input.practice_version,
      signup_version: input.signup_version, preview_token: input.preview_token,
      ...(change === "UPDATE" ? { values: practiceInputPayload(input as PracticeValues) } : {}) };
    const action = change === "UPDATE" ? "updatePractice" : "cancelPractice";
    const identity = await this.core.createRequestIdentity(auth.coach_id, action, input.request_id, payload);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return this.currentView(replay, input.season_id);
    const preview = await this.buildPreview(input.season_id, input.practice_id, change,
      change === "UPDATE" ? input as PracticeValues : undefined);
    if (preview.preview_token !== input.preview_token) throw new ApiError("PREVIEW_STALE", "Preview the latest changes.", 409);
    const at = new Date().toISOString();
    let response: Record<string, unknown> = {};
    this.ctx.storage.transactionSync(() => {
      this.core.assertSessionCurrent(auth);
      const season = this.requireOpenSeason(input.season_id);
      const week = this.requireWeek(input.season_id, input.week_id);
      const practice = this.requirePractice(input.season_id, input.practice_id);
      const state = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT * FROM practice_versions WHERE season_id=? AND practice_id=?", input.season_id, input.practice_id);
      if (practice.week_id !== input.week_id) throw new ApiError("PRACTICE_OUTSIDE_WEEK", "The training belongs to another week.", 409);
      if (Number(season.season_version) !== Number(preview.season_version) ||
          Number(week.week_version) !== input.week_version || Number(practice.practice_version) !== input.practice_version ||
          Number(state?.signup_version ?? 0) !== input.signup_version) {
        throw new ApiError("VERSION_CONFLICT", "The schedule or signup list changed.", 409);
      }
      if (practice.cancelled_at || Date.parse(String(practice.start_at)) <= Date.now()) {
        throw new ApiError("PRACTICE_ALREADY_STARTED", "The training is no longer editable.", 409);
      }
      if (change === "UPDATE") {
        const values = preview.values as Record<string, unknown>;
        Object.assign(practice, values);
        this.ctx.storage.sql.exec(
          `UPDATE practices SET start_at=?, end_at=?, timezone=?, location=?, address=?, map_url=?,
             signup_cutoff_at=?, practice_version=practice_version+1, updated_at=?
           WHERE season_id=? AND practice_id=?`, values.start_at, values.end_at, values.timezone,
          values.location, values.address, values.map_url, values.signup_cutoff_at, at,
          input.season_id, input.practice_id).toArray();
      } else {
        practice.cancelled_at = at; practice.cancelled_by = auth.coach_id;
        this.ctx.storage.sql.exec(
          `UPDATE practices SET cancelled_at=?, cancelled_by=?, practice_version=practice_version+1, updated_at=?
           WHERE season_id=? AND practice_id=?`, at, auth.coach_id, at, input.season_id, input.practice_id).toArray();
      }
      this.changeWeek(week, at); this.saveWeek(week);
      const current = this.requirePractice(input.season_id, input.practice_id);
      response = { operation: operationReceipt(action, input.request_id, at), result: {
        season_id: input.season_id, week: weekProjection(week), practice: practiceProjection(current)
      } };
      this.core.recordRequest(identity, auth.coach_id, action, input.request_id, response,
        { season_id: input.season_id, week_id: input.week_id, practice_id: input.practice_id,
          before: preview.before, after: preview.after, signup_version: input.signup_version }, at);
      this.core.enqueueChange(identity, "SCHEDULE_CHANGED", action,
        { season_id: input.season_id, week_id: input.week_id, practice_id: input.practice_id }, at);
    });
    return this.currentView(response, input.season_id);
  }
}
