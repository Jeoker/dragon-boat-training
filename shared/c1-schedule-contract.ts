import {
  array, boolean, ContractValidationError, date, enumeration, identifier, integer, isoTimestamp,
  object, requestId, sessionRequest, string, type Input, type SessionRequest
} from "./c1-contract";
import { assertTimezone } from "./c1-rules";
export { C1_SCHEDULE_ACTIONS } from "./c1-actions";

export type WeekStatus = "DRAFT" | "SCHEDULED" | "OPENED";

export interface ScheduleTemplateInput {
  day_of_week: number;
  start_time: string;
  end_time: string;
  location: string;
  address: string;
  map_url: string;
}

export interface ScheduleTemplateSnapshot extends ScheduleTemplateInput {
  season_id: string;
  template_id: string;
  timezone: string;
  active: boolean;
  template_version: number;
  created_at: string;
  updated_at: string;
}

export interface TrainingWeekSnapshot {
  season_id: string;
  week_id: string;
  week_start_date: string;
  scheduled_open_at: string | null;
  status: WeekStatus;
  week_version: number;
  confirmed_version: number | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PracticeSnapshot {
  season_id: string;
  practice_id: string;
  week_id: string;
  template_id: string | null;
  generation_key: string | null;
  start_at: string;
  end_at: string;
  timezone: string;
  location: string;
  address: string;
  map_url: string;
  left_capacity: number;
  right_capacity: number;
  signup_cutoff_at: string;
  practice_version: number;
  cancelled_at: string | null;
  cancelled_by: string | null;
  schedule_published_at: string | null;
  schedule_published_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportScheduleSnapshotRequest {
  request_id: string;
  source_snapshot_id: string;
  templates: ScheduleTemplateSnapshot[];
  weeks: TrainingWeekSnapshot[];
  practices: PracticeSnapshot[];
}

export interface ScheduleWorkspaceRequest extends SessionRequest { season_id: string; }
export interface UpdateScheduleTemplatesRequest extends ScheduleWorkspaceRequest {
  season_version: number;
  templates: ScheduleTemplateInput[];
}
export interface PrepareTrainingWeekRequest extends ScheduleWorkspaceRequest {
  season_version: number;
  week_start_date: string;
}
export interface WeekMutationRequest extends ScheduleWorkspaceRequest {
  week_id: string;
  week_version: number;
}
export interface ConfirmTrainingWeekRequest extends WeekMutationRequest {
  open_at?: string;
  open_date?: string;
  open_time?: string;
}
export interface PracticeValues {
  practice_date: string;
  start_time: string;
  end_time: string;
  timezone?: string;
  location: string;
  address: string;
  map_url: string;
}
export interface CreatePracticeRequest extends WeekMutationRequest, PracticeValues {}
export interface PublishAdditionalPracticeRequest extends WeekMutationRequest {
  practice_id: string;
  practice_version: number;
}
export interface PreviewPracticeChangeRequest extends ScheduleWorkspaceRequest, Partial<PracticeValues> {
  practice_id: string;
  change: "UPDATE" | "CANCEL";
}
export interface CommitPracticeChangeRequest extends WeekMutationRequest, PracticeValues {
  practice_id: string;
  practice_version: number;
  signup_version: number;
  preview_token: string;
}
export interface CancelPracticeRequest extends WeekMutationRequest {
  practice_id: string;
  practice_version: number;
  signup_version: number;
  preview_token: string;
}

function nullableText(input: Input, field: string, maximum: number): string | null {
  if (input[field] === null) return null;
  return string(input, field, 0, maximum);
}

function nullableTimestamp(input: Input, field: string): string | null {
  if (input[field] === null) return null;
  return isoTimestamp(input, field);
}

function localTime(input: Input, field: string): string {
  const value = string(input, field, 5, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new ContractValidationError(`${field} must be HH:MM.`, field);
  }
  return value;
}

function timezone(input: Input, field: string): string {
  const value = string(input, field, 1, 100);
  assertTimezone(value);
  return value;
}

function safeUrl(input: Input, field: string, required = false): string {
  if (!Object.hasOwn(input, field) && !required) return "";
  const value = string(input, field, 0, 2048);
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
  } catch {
    throw new ContractValidationError(`${field} must be an HTTP or HTTPS URL.`, field);
  }
  return value;
}

function templateInput(value: unknown, field = "template", requireMapUrl = false): ScheduleTemplateInput {
  const input = object(value, field);
  const start = localTime(input, "start_time");
  const end = localTime(input, "end_time");
  const dayOfWeek = integer(input, "day_of_week", 1);
  if (dayOfWeek > 7) throw new ContractValidationError("day_of_week must be between 1 and 7.", "day_of_week");
  if (end <= start) throw new ContractValidationError("A training must end after it starts.", "end_time");
  return {
    day_of_week: dayOfWeek, start_time: start, end_time: end,
    location: string(input, "location", 1, 120), address: string(input, "address", 1, 240),
    map_url: safeUrl(input, "map_url", requireMapUrl)
  };
}

function practiceValues(input: Input, requireTimezone = false, requireMapUrl = false): PracticeValues {
  const result: PracticeValues = {
    practice_date: date(input, "practice_date"), start_time: localTime(input, "start_time"),
    end_time: localTime(input, "end_time"), location: string(input, "location", 1, 120),
    address: string(input, "address", 1, 240), map_url: safeUrl(input, "map_url", requireMapUrl)
  };
  if (result.end_time <= result.start_time) {
    throw new ContractValidationError("A training must end after it starts.", "end_time");
  }
  if (requireTimezone && !Object.hasOwn(input, "timezone")) {
    throw new ContractValidationError("timezone is required.", "timezone");
  }
  if (Object.hasOwn(input, "timezone")) result.timezone = timezone(input, "timezone");
  return result;
}

function weekMutation(value: unknown): WeekMutationRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id"),
    week_id: identifier(input, "week_id"), week_version: integer(input, "week_version", 1) };
}

export function parseImportScheduleSnapshot(value: unknown): ImportScheduleSnapshotRequest {
  const input = object(value);
  const templates = array(input, "templates", 7_500).map((entry, index): ScheduleTemplateSnapshot => {
    const row = object(entry, `templates[${index}]`);
    return { season_id: identifier(row, "season_id"), template_id: identifier(row, "template_id"),
      ...templateInput(row, `templates[${index}]`, true), timezone: timezone(row, "timezone"), active: boolean(row, "active"),
      template_version: integer(row, "template_version", 1), created_at: isoTimestamp(row, "created_at"),
      updated_at: isoTimestamp(row, "updated_at") };
  });
  const weeks = array(input, "weeks", 10_000).map((entry, index): TrainingWeekSnapshot => {
    const row = object(entry, `weeks[${index}]`);
    return { season_id: identifier(row, "season_id"), week_id: identifier(row, "week_id"),
      week_start_date: date(row, "week_start_date"), scheduled_open_at: nullableTimestamp(row, "scheduled_open_at"),
      status: enumeration(row, "status", ["DRAFT", "SCHEDULED", "OPENED"]),
      week_version: integer(row, "week_version", 1),
      confirmed_version: row.confirmed_version === null ? null : integer(row, "confirmed_version", 1),
      confirmed_by: row.confirmed_by === null ? null : identifier(row, "confirmed_by"),
      confirmed_at: nullableTimestamp(row, "confirmed_at"), published_at: nullableTimestamp(row, "published_at"),
      created_at: isoTimestamp(row, "created_at"), updated_at: isoTimestamp(row, "updated_at") };
  });
  const practices = array(input, "practices", 50_000).map((entry, index): PracticeSnapshot => {
    const row = object(entry, `practices[${index}]`);
    return { season_id: identifier(row, "season_id"), practice_id: identifier(row, "practice_id"),
      week_id: identifier(row, "week_id"), template_id: row.template_id === null ? null : identifier(row, "template_id"),
      generation_key: nullableText(row, "generation_key", 512), start_at: isoTimestamp(row, "start_at"),
      end_at: isoTimestamp(row, "end_at"), timezone: timezone(row, "timezone"),
      location: string(row, "location", 1, 120), address: string(row, "address", 1, 240), map_url: safeUrl(row, "map_url", true),
      left_capacity: integer(row, "left_capacity", 1), right_capacity: integer(row, "right_capacity", 1),
      signup_cutoff_at: isoTimestamp(row, "signup_cutoff_at"), practice_version: integer(row, "practice_version", 1),
      cancelled_at: nullableTimestamp(row, "cancelled_at"),
      cancelled_by: row.cancelled_by === null ? null : identifier(row, "cancelled_by"),
      schedule_published_at: nullableTimestamp(row, "schedule_published_at"),
      schedule_published_by: row.schedule_published_by === null ? null : identifier(row, "schedule_published_by"),
      created_at: isoTimestamp(row, "created_at"), updated_at: isoTimestamp(row, "updated_at") };
  });
  return { request_id: requestId(input), source_snapshot_id: identifier(input, "source_snapshot_id"),
    templates, weeks, practices };
}

export function parseScheduleWorkspace(value: unknown): ScheduleWorkspaceRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id") };
}

export function parseUpdateScheduleTemplates(value: unknown): UpdateScheduleTemplatesRequest {
  const input = object(value);
  const templates = array(input, "templates", 14);
  if (templates.length < 1) throw new ContractValidationError("At least one template is required.", "templates");
  return { ...parseScheduleWorkspace(input), season_version: integer(input, "season_version", 1),
    templates: templates.map((entry, index) => templateInput(entry, `templates[${index}]`)) };
}

export function parsePrepareTrainingWeek(value: unknown): PrepareTrainingWeekRequest {
  const input = object(value);
  return { ...parseScheduleWorkspace(input), season_version: integer(input, "season_version", 1),
    week_start_date: date(input, "week_start_date") };
}

export function parseConfirmTrainingWeek(value: unknown): ConfirmTrainingWeekRequest {
  const input = object(value);
  const result: ConfirmTrainingWeekRequest = weekMutation(input);
  if (Object.hasOwn(input, "open_at")) result.open_at = isoTimestamp(input, "open_at");
  const hasDate = Object.hasOwn(input, "open_date");
  const hasTime = Object.hasOwn(input, "open_time");
  if (hasDate !== hasTime || (result.open_at && hasDate)) {
    throw new ContractValidationError("Use open_at or both open_date and open_time.");
  }
  if (hasDate) { result.open_date = date(input, "open_date"); result.open_time = localTime(input, "open_time"); }
  return result;
}

export function parseWeekMutation(value: unknown): WeekMutationRequest { return weekMutation(value); }

export function parseCreatePractice(value: unknown): CreatePracticeRequest {
  const input = object(value);
  return { ...weekMutation(input), ...practiceValues(input) };
}

export function parsePublishAdditionalPractice(value: unknown): PublishAdditionalPracticeRequest {
  const input = object(value);
  return { ...weekMutation(input), practice_id: identifier(input, "practice_id"),
    practice_version: integer(input, "practice_version", 1) };
}

export function parsePreviewPracticeChange(value: unknown): PreviewPracticeChangeRequest {
  const input = object(value);
  const base = { ...parseScheduleWorkspace(input), practice_id: identifier(input, "practice_id"),
    change: enumeration<"UPDATE" | "CANCEL">(input, "change", ["UPDATE", "CANCEL"]) };
  if (base.change === "UPDATE") return { ...base, ...practiceValues(input, true) };
  for (const field of ["practice_date", "start_time", "end_time", "timezone", "location", "address", "map_url"]) {
    if (Object.hasOwn(input, field)) throw new ContractValidationError(`${field} is not accepted for cancellation.`, field);
  }
  return base;
}

export function parseUpdatePractice(value: unknown): CommitPracticeChangeRequest {
  const input = object(value);
  return { ...weekMutation(input), ...practiceValues(input, true), practice_id: identifier(input, "practice_id"),
    practice_version: integer(input, "practice_version", 1), signup_version: integer(input, "signup_version"),
    preview_token: string(input, "preview_token", 32, 256) };
}

export function parseCancelPractice(value: unknown): CancelPracticeRequest {
  const input = object(value);
  return { ...weekMutation(input), practice_id: identifier(input, "practice_id"),
    practice_version: integer(input, "practice_version", 1), signup_version: integer(input, "signup_version"),
    preview_token: string(input, "preview_token", 32, 256) };
}
