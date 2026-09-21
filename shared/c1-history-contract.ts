import {
  array, enumeration, identifier, integer, isoTimestamp, object, requestId, sessionRequest, string,
  ContractValidationError, type Input, type SessionRequest
} from "./c1-contract";

export type HistoryFinalStatus = "FROZEN" | "UNPUBLISHED";

export interface HistorySeatSnapshot {
  side: "LEFT" | "RIGHT";
  row_number: number;
  display_name: string;
}

export interface HistoryPracticeSnapshot {
  season_id: string;
  practice_id: string;
  history_version: number;
  final_status: HistoryFinalStatus;
  frozen_revision: number;
  start_at: string;
  end_at: string;
  timezone: string;
  location: string;
  address: string;
  map_url: string;
  coach_display_name: string;
  steerer_display_name: string;
  published_at: string;
  source: string;
  seats: HistorySeatSnapshot[];
  frozen_at: string;
}

export interface HistorySeasonSnapshot {
  season_id: string;
  name: string;
  start_date: string;
  end_date: string;
  timezone: string;
  archive_year: number;
  archived_at: string;
}

export interface HistoryCorrectionSnapshot {
  season_id: string;
  practice_id: string;
  correction_id: string;
  history_version: number;
  note: string;
  created_by: string;
  created_at: string;
}

export interface ImportHistorySnapshotRequest {
  request_id: string;
  source_snapshot_id: string;
  seasons: HistorySeasonSnapshot[];
  practices: HistoryPracticeSnapshot[];
  corrections: HistoryCorrectionSnapshot[];
}

export interface HistoryManagementRequest extends SessionRequest { season_id: string; }
export interface AppendHistoryCorrectionRequest extends HistoryManagementRequest {
  practice_id: string;
  history_version: number;
  note: string;
}
export interface AuditRequest extends SessionRequest { season_id: string; limit: number; cursor: string; }
export interface BackupChunkRequest extends SessionRequest { snapshot_id: string; chunk_index: number; }
export interface VerifyBackupRequest extends SessionRequest { snapshot_id: string; content_digest: string; }

function optionalText(input: Input, field: string, maximum: number): string {
  if (input[field] === undefined || input[field] === null || input[field] === "") return "";
  return string(input, field, 0, maximum);
}

function actorId(input: Input, field: string): string {
  const value = string(input, field, 1, 128);
  if (!/^[A-Za-z0-9_:-]+$/u.test(value)) {
    throw new ContractValidationError(`${field} contains unsupported characters.`, field);
  }
  return value;
}

function correctionNote(input: Input, field = "note"): string {
  const value = string(input, field, 1, 500);
  if (/\r|\n/u.test(value)) throw new ContractValidationError(`${field} must be one line.`, field);
  return value;
}

function historySeat(value: unknown, field: string): HistorySeatSnapshot {
  const input = object(value, field);
  return {
    side: enumeration(input, "side", ["LEFT", "RIGHT"] as const),
    row_number: integer(input, "row_number", 1), display_name: string(input, "display_name", 1, 120)
  };
}

function historySeason(value: unknown, index: number): HistorySeasonSnapshot {
  const input = object(value, `seasons[${index}]`);
  const startDate = string(input, "start_date", 10, 10);
  const endDate = string(input, "end_date", 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(endDate)) {
    throw new ContractValidationError("History season dates must use YYYY-MM-DD.");
  }
  return {
    season_id: identifier(input, "season_id"), name: string(input, "name", 1, 120),
    start_date: startDate, end_date: endDate, timezone: string(input, "timezone", 1, 100),
    archive_year: integer(input, "archive_year", 2000), archived_at: isoTimestamp(input, "archived_at")
  };
}

function historyPractice(value: unknown, index: number): HistoryPracticeSnapshot {
  const input = object(value, `practices[${index}]`);
  const finalStatus = enumeration(input, "final_status", ["FROZEN", "UNPUBLISHED"] as const);
  const frozenRevision = integer(input, "frozen_revision");
  const seats = array(input, "seats", 100).map((entry, seatIndex) =>
    historySeat(entry, `practices[${index}].seats[${seatIndex}]`));
  const coachDisplayName = optionalText(input, "coach_display_name", 120);
  const steererDisplayName = optionalText(input, "steerer_display_name", 120);
  const rawPublishedAt = optionalText(input, "published_at", 40);
  const publishedAt = rawPublishedAt ? isoTimestamp({ published_at: rawPublishedAt }, "published_at") : "";
  const revisionSource = optionalText(input, "source", 64);
  if ((finalStatus === "UNPUBLISHED" && (frozenRevision !== 0 || seats.length > 0)) ||
      (finalStatus === "FROZEN" && frozenRevision < 1)) {
    throw new ContractValidationError("The final history status does not match its frozen revision.");
  }
  if (finalStatus === "UNPUBLISHED" && (coachDisplayName || steererDisplayName || publishedAt || revisionSource)) {
    throw new ContractValidationError("An unpublished history snapshot cannot contain formal seating data.");
  }
  if (finalStatus === "FROZEN" && (!publishedAt || !/^[A-Z0-9_]+$/u.test(revisionSource))) {
    throw new ContractValidationError("A frozen history snapshot requires formal publication metadata.");
  }
  return {
    season_id: identifier(input, "season_id"), practice_id: identifier(input, "practice_id"),
    history_version: integer(input, "history_version", 1), final_status: finalStatus,
    frozen_revision: frozenRevision, start_at: isoTimestamp(input, "start_at"),
    end_at: isoTimestamp(input, "end_at"), timezone: string(input, "timezone", 1, 100),
    location: string(input, "location", 1, 200), address: string(input, "address", 0, 300),
    map_url: optionalText(input, "map_url", 500), coach_display_name: coachDisplayName,
    steerer_display_name: steererDisplayName, published_at: publishedAt, source: revisionSource,
    seats, frozen_at: isoTimestamp(input, "frozen_at")
  };
}

function historyCorrection(value: unknown, index: number): HistoryCorrectionSnapshot {
  const input = object(value, `corrections[${index}]`);
  return {
    season_id: identifier(input, "season_id"), practice_id: identifier(input, "practice_id"),
    correction_id: identifier(input, "correction_id"), history_version: integer(input, "history_version", 2),
    note: correctionNote(input), created_by: actorId(input, "created_by"), created_at: isoTimestamp(input, "created_at")
  };
}

export function parseImportHistorySnapshot(value: unknown): ImportHistorySnapshotRequest {
  const input = object(value);
  return {
    request_id: requestId(input), source_snapshot_id: identifier(input, "source_snapshot_id"),
    seasons: array(input, "seasons", 500).map(historySeason),
    practices: array(input, "practices", 100_000).map(historyPractice),
    corrections: array(input, "corrections", 100_000).map(historyCorrection)
  };
}

export function parseHistoryManagement(value: unknown): HistoryManagementRequest {
  const input = object(value);
  return { ...sessionRequest(input), season_id: identifier(input, "season_id") };
}

export function parseAppendHistoryCorrection(value: unknown): AppendHistoryCorrectionRequest {
  const input = object(value);
  return { ...parseHistoryManagement(input), practice_id: identifier(input, "practice_id"),
    history_version: integer(input, "history_version", 1), note: correctionNote(input) };
}

export function parseAuditRequest(value: unknown): AuditRequest {
  const input = object(value);
  return { ...parseHistoryManagement(input), limit: input.limit === undefined ? 30 : integer(input, "limit", 1),
    cursor: input.cursor === undefined ? "" : string(input, "cursor", 0, 1000) };
}

export function parseBackupChunkRequest(value: unknown): BackupChunkRequest {
  const input = object(value);
  return { ...sessionRequest(input), snapshot_id: identifier(input, "snapshot_id"),
    chunk_index: integer(input, "chunk_index") };
}

export function parseVerifyBackupRequest(value: unknown): VerifyBackupRequest {
  const input = object(value);
  return { ...sessionRequest(input), snapshot_id: identifier(input, "snapshot_id"),
    content_digest: string(input, "content_digest", 20, 200) };
}
