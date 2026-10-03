import {
  exactSourceKeys,
  parseSourceJson,
  sourceAssert,
  sourceBytes,
  sourceCanonical,
  sourceInteger,
  sourceInstant,
  sourceObject,
  sourceText,
  type SourceJson,
  type SourceObject,
  type SourcePinnedContext,
} from "./c2-source-capture-contract";

export const REVIEW_FORMAT = "c2-source-mapping-review-v1";
export const LEDGER_FORMAT = "c2-source-mapping-ledger-v1";
export const DERIVED_FORMAT = "c2-source-mapping-qualification-v1";
export const REVIEW_LIMITS = Object.freeze({
  input_bytes: 2_000_000,
  view_bytes: 2_000_000,
  control_bytes: 8_000,
  ledger_bytes: 512_000,
  evidence: 1000,
  derived_bytes: 512_000,
});
export const REVIEW_DOMAINS = Object.freeze({
  source: "c2-source-review-source-v1\n",
  schema: "c2-source-review-schema-v1\n",
  record: "c2-source-review-record-v1\n",
  command: "c2-source-review-command-v1\n",
  ledger: "c2-source-review-ledger-v1\n",
  gaps: "c2-source-review-gaps-v1\n",
});
export const REVIEW_REASONS = ["REVIEWED_FIXED_RECORDS", "DIRECT_KNOWLEDGE_OF_SUBMISSION"] as const;
export type ReviewReason = typeof REVIEW_REASONS[number];
export type ReviewHashPort = (text: string) => Promise<string>;
export type ReviewContextPort = () => unknown;

export interface ReviewBundle {
  source_input_text: string;
  source_plan_text: string;
}

/** An internal caller assertion; this type does not authenticate a session. */
export interface ReviewContext {
  source: SourcePinnedContext;
  actor_id: string;
  permission_scope: "COACH_SOURCE_MAPPING_REVIEW";
  reviewed_at: string;
  source_plan_digest: string;
  local_snapshot_id: string;
  ledger_version: number;
  ledger_digest: string;
}

export interface ReviewAnchor {
  source: SourcePinnedContext;
  source_plan_digest: string;
  local_snapshot_id: string;
  provenance: "LOCAL_INPUT_DECLARATIONS_ONLY";
}

export interface MappingCommand {
  request_id: string;
  local_snapshot_id: string;
  row_index: number;
  response_id: string;
  expected_sheet_digest: string;
  expected_form_digest: string;
  decision: "CONFIRM_LINK";
  reason: ReviewReason;
}

export interface RecordLocator {
  namespace: "FORM_CURRENT" | "PRIVATE_PENDING";
  chunk_index: number;
  record_offset: number;
  record_type: "FORM_RESPONSE" | "SHEET_ROW";
}

export interface ReviewEvidence {
  sequence: number;
  anchor: ReviewAnchor;
  actor_id: string;
  reviewed_at: string;
  command: MappingCommand;
  command_digest: string;
  prior_ledger_digest: string;
  form_locator: RecordLocator;
  sheet_locator: RecordLocator;
  mapping_status: "HUMAN_ATTESTED";
}

export interface ReviewLedger {
  format: typeof LEDGER_FORMAT;
  state: "LOCAL_REVIEW_PLAN_ONLY";
  source_status: "SOURCE_NOT_VERIFIED";
  anchor: ReviewAnchor;
  version: number;
  evidence: ReviewEvidence[];
}

export const reviewJson = (value: unknown) => sourceCanonical(value as SourceJson);

export function boundedText(value: unknown, limit: number): string {
  sourceAssert(typeof value === "string", "RAW_JSON_REQUIRED");
  sourceAssert(value.length <= limit && sourceBytes(value) <= limit, "REVIEW_BYTES_EXCEEDED");
  return value;
}

export function reviewDigest(value: SourceJson): string {
  const text = sourceText(value, 43, 43);
  sourceAssert(/^[A-Za-z0-9_-]{43}$/u.test(text), "REVIEW_DIGEST_INVALID");
  return text;
}

function pinnedSource(value: SourceJson): SourcePinnedContext {
  const row = sourceObject(value);
  exactSourceKeys(row, ["source_operation_id", "team_id", "season_id", "binding_version", "backend_generation",
    "writer_epoch", "form_id", "spreadsheet_id", "sheet_id", "season_ends_at"]);
  const result: SourcePinnedContext = {
    source_operation_id: sourceText(row.source_operation_id, 1, 512),
    team_id: sourceText(row.team_id, 1, 512),
    season_id: sourceText(row.season_id, 1, 512),
    binding_version: sourceInteger(row.binding_version, 1),
    backend_generation: sourceText(row.backend_generation, 1, 512),
    writer_epoch: sourceInteger(row.writer_epoch),
    form_id: sourceText(row.form_id, 1, 512),
    spreadsheet_id: sourceText(row.spreadsheet_id, 1, 512),
    sheet_id: sourceInteger(row.sheet_id),
    season_ends_at: sourceText(row.season_ends_at, 1, 128),
  };
  sourceInstant(result.season_ends_at);
  return result;
}

export function readReviewContext(port: ReviewContextPort): ReviewContext {
  try {
    const row = sourceObject(port() as SourceJson);
    // Object/descriptor checks reject getters before any property values are read.
    exactSourceKeys(row, ["source", "actor_id", "permission_scope", "reviewed_at", "source_plan_digest",
      "local_snapshot_id", "ledger_version", "ledger_digest"]);
    sourceAssert(row.permission_scope === "COACH_SOURCE_MAPPING_REVIEW", "REVIEW_PERMISSION_REQUIRED");
    const result: ReviewContext = {
      source: pinnedSource(row.source),
      actor_id: sourceText(row.actor_id, 1, 512),
      permission_scope: "COACH_SOURCE_MAPPING_REVIEW",
      reviewed_at: sourceText(row.reviewed_at, 1, 128),
      source_plan_digest: reviewDigest(row.source_plan_digest),
      local_snapshot_id: sourceText(row.local_snapshot_id, 1, 128),
      ledger_version: sourceInteger(row.ledger_version, 0, REVIEW_LIMITS.evidence),
      ledger_digest: reviewDigest(row.ledger_digest),
    };
    sourceInstant(result.reviewed_at);
    sourceAssert(result.local_snapshot_id === `LOCAL_INPUT_${result.source_plan_digest}`, "REVIEW_SNAPSHOT_INVALID");
    boundedText(reviewJson(result), REVIEW_LIMITS.control_bytes);
    return result;
  } catch {
    // The port is an internal dependency. Its thrown message/key/value is never exposed.
    sourceAssert(false, "REVIEW_CONTEXT_INVALID");
  }
}

export function contextIdentity(context: ReviewContext): string {
  const { reviewed_at: ignoredTime, ...identity } = context;
  void ignoredTime;
  return reviewJson(identity);
}

export function assertFreshContext(port: ReviewContextPort, context: ReviewContext): void {
  sourceAssert(contextIdentity(readReviewContext(port)) === contextIdentity(context), "REVIEW_OWNERSHIP_CHANGED");
}

export async function hashReview(port: ReviewHashPort, domain: string, text: string): Promise<string> {
  try {
    return reviewDigest(await port(domain + text));
  } catch {
    sourceAssert(false, "REVIEW_HASH_FAILED");
  }
}

export function reviewAnchor(context: ReviewContext): ReviewAnchor {
  return {
    source: { ...context.source },
    source_plan_digest: context.source_plan_digest,
    local_snapshot_id: context.local_snapshot_id,
    provenance: "LOCAL_INPUT_DECLARATIONS_ONLY",
  };
}

export function emptyReviewLedger(anchor: ReviewAnchor): ReviewLedger {
  return {
    format: LEDGER_FORMAT,
    state: "LOCAL_REVIEW_PLAN_ONLY",
    source_status: "SOURCE_NOT_VERIFIED",
    anchor,
    version: 0,
    evidence: [],
  };
}

export function parseMappingCommand(text: unknown): MappingCommand {
  const row = sourceObject(parseSourceJson(boundedText(text, REVIEW_LIMITS.control_bytes)));
  exactSourceKeys(row, ["request_id", "local_snapshot_id", "row_index", "response_id",
    "expected_sheet_digest", "expected_form_digest", "decision", "reason"]);
  sourceAssert(row.decision === "CONFIRM_LINK", "REVIEW_DECISION_INVALID");
  sourceAssert(REVIEW_REASONS.includes(row.reason as ReviewReason), "REVIEW_REASON_INVALID");
  return {
    request_id: sourceText(row.request_id, 1, 512),
    local_snapshot_id: sourceText(row.local_snapshot_id, 1, 128),
    row_index: sourceInteger(row.row_index, 1, 5000),
    response_id: sourceText(row.response_id, 1, 512),
    expected_sheet_digest: reviewDigest(row.expected_sheet_digest),
    expected_form_digest: reviewDigest(row.expected_form_digest),
    decision: "CONFIRM_LINK",
    reason: row.reason as ReviewReason,
  };
}

export function parseLocator(value: SourceJson, type: RecordLocator["record_type"]): RecordLocator {
  const row = sourceObject(value);
  exactSourceKeys(row, ["namespace", "chunk_index", "record_offset", "record_type"]);
  sourceAssert(row.record_type === type && (row.namespace === "PRIVATE_PENDING" ||
    (type === "FORM_RESPONSE" && row.namespace === "FORM_CURRENT")), "REVIEW_LOCATOR_INVALID");
  return {
    namespace: row.namespace as RecordLocator["namespace"],
    chunk_index: sourceInteger(row.chunk_index, 0, 5000),
    record_offset: sourceInteger(row.record_offset, 0, 5000),
    record_type: type,
  };
}

export function parseLedgerEnvelope(text: unknown, anchor: ReviewAnchor): SourceObject {
  const row = sourceObject(parseSourceJson(boundedText(text, REVIEW_LIMITS.ledger_bytes)));
  exactSourceKeys(row, ["format", "state", "source_status", "anchor", "version", "evidence"]);
  sourceAssert(row.format === LEDGER_FORMAT && row.state === "LOCAL_REVIEW_PLAN_ONLY" &&
    row.source_status === "SOURCE_NOT_VERIFIED", "REVIEW_LEDGER_INVALID");
  sourceAssert(reviewJson(row.anchor) === reviewJson(anchor), "REVIEW_LEDGER_OWNERSHIP_CHANGED");
  sourceAssert(Array.isArray(row.evidence) && row.evidence.length <= REVIEW_LIMITS.evidence &&
    sourceInteger(row.version, 0, REVIEW_LIMITS.evidence) === row.evidence.length, "REVIEW_LEDGER_COUNT_INVALID");
  sourceAssert(reviewJson(row) === text, "REVIEW_LEDGER_NONCANONICAL");
  return row;
}
