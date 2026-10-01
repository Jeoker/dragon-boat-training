// Shared v1 record emitters and chunk assembly. No input reconstruction or runtime imports.
import {
  SOURCE_FORMAT, SOURCE_LIMITS, responseSupported, sourceArray, sourceAssert, sourceBytes,
  sourceCanonical, sourceInteger, sourceInstant, sourceObject, sourceText,
  type SourceJson, type SourceObject, type SourcePinnedContext,
} from "./c2-source-capture-contract";

export const SOURCE_NAMESPACES = ["FORM_CURRENT", "SHEET_CURRENT", "EXCLUDED_IDENTITIES", "PRIVATE_PENDING", "GAP_LEDGER"] as const;
export type SourceNamespace = typeof SOURCE_NAMESPACES[number];
export type SourceRecordGroups = Record<SourceNamespace, SourceObject[]>;
export interface LocalSourceChunk {
  namespace: SourceNamespace;
  chunk_index: number;
  row_offset: number;
  row_count: number;
  payload_text: string;
  utf8_bytes: number;
}
const has = (row: SourceObject, key: string) => Object.hasOwn(row, key);
const known = (row: SourceObject, keys: string[]) => Object.keys(row).every(key => keys.includes(key));

function sourceCellUnsupported(cell: SourceJson): boolean {
  const row = sourceObject(cell);
  let unsupported = !known(row, ["userEnteredValue", "effectiveValue", "formattedValue", "userEnteredFormat",
    "effectiveFormat", "hyperlink", "note"]);
  for (const key of ["formattedValue", "hyperlink", "note"]) {
    if (has(row, key)) sourceText(row[key], 0, SOURCE_LIMITS.record_bytes);
  }
  for (const key of ["userEnteredValue", "effectiveValue"]) {
    if (!has(row, key)) continue;
    const value = sourceObject(row[key]);
    const types = ["numberValue", "stringValue", "boolValue", "formulaValue", "errorValue"];
    const fields = types.filter(type => has(value, type));
    unsupported = !known(value, types) || unsupported;
    sourceAssert(fields.length <= 1, "CELL_VALUE_UNION_INVALID");
    if (fields.length === 0) continue;
    const type = fields[0];
    if (type === "numberValue") {
      sourceAssert(typeof value[type] === "number" && Number.isFinite(value[type]), "NONFINITE_NUMBER");
    } else if (type === "boolValue") {
      sourceAssert(typeof value[type] === "boolean", "BOOLEAN_REQUIRED");
    } else if (type === "errorValue") {
      const error = sourceObject(value[type]);
      unsupported = !known(error, ["type", "message"]) || unsupported;
      if (has(error, "type")) {
        const errorType = sourceText(error.type, 1);
        unsupported = !["ERROR_TYPE_UNSPECIFIED", "ERROR", "NULL_VALUE", "DIVIDE_BY_ZERO", "VALUE", "REF",
          "NAME", "NUM", "N_A", "LOADING"].includes(errorType) || unsupported;
      } else unsupported = true;
      if (has(error, "message")) sourceText(error.message, 0, SOURCE_LIMITS.record_bytes);
    } else sourceText(value[type], 0, SOURCE_LIMITS.record_bytes);
    if (key === "effectiveValue" && type === "formulaValue") unsupported = true;
  }
  for (const key of ["userEnteredFormat", "effectiveFormat"]) {
    if (!has(row, key)) continue;
    const format = sourceObject(row[key]);
    unsupported = !known(format, ["numberFormat"]) || unsupported;
    if (has(format, "numberFormat")) {
      const number = sourceObject(format.numberFormat);
      unsupported = !known(number, ["type", "pattern"]) || unsupported;
      if (has(number, "type")) {
        const type = sourceText(number.type, 1);
        unsupported = !["TEXT", "NUMBER", "PERCENT", "CURRENCY", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC"].includes(type) || unsupported;
      }
      if (has(number, "pattern")) sourceText(number.pattern, 0, SOURCE_LIMITS.record_bytes);
    }
  }
  return unsupported;
}

function addSourceRecord(groups: SourceRecordGroups, namespace: SourceNamespace, record: SourceObject) {
  sourceAssert(sourceBytes(sourceCanonical(record)) <= SOURCE_LIMITS.record_bytes, "RECORD_BYTES_EXCEEDED");
  groups[namespace].push(record);
}

function condition(groups: SourceRecordGroups, code: string, identity: SourceObject = {}, classification = "SOURCE_GAP") {
  addSourceRecord(groups, "GAP_LEDGER", { record_type: "SOURCE_EVIDENCE_CONDITION", classification, code, identity });
}

export function initialSourceRecords(formSchema: SourceObject, supported: boolean, sheetSchema: SourceObject): SourceRecordGroups {
  const groups: SourceRecordGroups = { FORM_CURRENT: [], SHEET_CURRENT: [], EXCLUDED_IDENTITIES: [], PRIVATE_PENDING: [], GAP_LEDGER: [] };
  condition(groups, "READ_COMPLETENESS_AND_OBSERVATION_UNPROVEN", {}, "PROOF_REQUIRED");
  condition(groups, "HISTORIC_UNOBSERVED_RESPONSES_NOT_RECOVERABLE", {}, "COVERAGE_LIMIT");
  if (supported) addSourceRecord(groups, "FORM_CURRENT", { record_type: "FORM_SCHEMA", raw: formSchema });
  else {
    addSourceRecord(groups, "PRIVATE_PENDING", { record_type: "FORM_SCHEMA", reasons: ["FORM_SCHEMA_UNSUPPORTED"], raw: formSchema });
    condition(groups, "FORM_SCHEMA_UNSUPPORTED", {}, "UNSUPPORTED");
  }
  let unsupported = !known(sheetSchema, ["spreadsheetId", "sheetId", "title", "locale", "timeZone", "rowCount",
    "columnCount", "headerRowIndex", "headers"]);
  for (const cell of sourceArray(sheetSchema.headers)) unsupported = sourceCellUnsupported(cell) || unsupported;
  addSourceRecord(groups, "PRIVATE_PENDING", { record_type: "SHEET_SCHEMA",
    reasons: ["SHEET_SCOPE_UNPROVEN", ...(unsupported ? ["SHEET_SCHEMA_UNSUPPORTED"] : [])], raw: sheetSchema });
  condition(groups, "SHEET_MAPPING_VERIFICATION_NOT_IMPLEMENTED", {}, "PROOF_REQUIRED");
  if (unsupported) condition(groups, "SHEET_SCHEMA_UNSUPPORTED", {}, "UNSUPPORTED");
  return groups;
}

export function appendEligibleSourceResponse(
  groups: SourceRecordGroups, response: SourceObject, pinned: SourcePinnedContext,
  schemaSupported: boolean, status: ReturnType<typeof responseSupported>,
) {
  const identity = { form_id: pinned.form_id, response_id: sourceText(response.responseId, 1, 512) };
  const reasons = [...(!schemaSupported ? ["FORM_SCHEMA_UNSUPPORTED"] : []), ...(!status.supported ? ["FORM_RESPONSE_UNSUPPORTED"] : []),
    ...(status.unknown_question ? ["ANSWER_SCHEMA_UNMATCHABLE"] : []), ...(status.attachment ? ["ATTACHMENT_CONTENT_NOT_CAPTURED"] : [])];
  if (reasons.length) {
    addSourceRecord(groups, "PRIVATE_PENDING", { record_type: "FORM_RESPONSE", identity, reasons, raw: response });
    for (const code of reasons) {
      condition(groups, code, identity, code === "ATTACHMENT_CONTENT_NOT_CAPTURED" ? "PROOF_REQUIRED" :
        code === "ANSWER_SCHEMA_UNMATCHABLE" ? "SOURCE_GAP" : "UNSUPPORTED");
    }
  } else addSourceRecord(groups, "FORM_CURRENT", { record_type: "FORM_RESPONSE", raw: response });
}

export function appendExcludedSourceIdentity(groups: SourceRecordGroups, pinned: SourcePinnedContext, id: string, createTime: string) {
  addSourceRecord(groups, "EXCLUDED_IDENTITIES", { record_type: "FORM_RESPONSE_EXCLUDED",
    reason: "FIRST_SUBMISSION_NOT_BEFORE_CUTOFF", identity: { form_id: pinned.form_id, response_id: id, createTime } });
}

export function appendSourceSheetRows(
  groups: SourceRecordGroups, rows: SourceObject[], mappings: SourceObject[],
  responseTimes: Map<string, string>, pinned: SourcePinnedContext,
) {
  const byRow = new Map(mappings.map(row => [sourceInteger(row.row_index, 1), row]));
  const cutoff = sourceInstant(pinned.season_ends_at);
  for (const row of rows) {
    const rowIndex = sourceInteger(row.row_index, 1);
    let unsupported = !known(row, ["row_index", "cells"]);
    for (const cell of sourceArray(row.cells)) unsupported = sourceCellUnsupported(cell) || unsupported;
    const mapping = byRow.get(rowIndex);
    const responseTime = mapping ? responseTimes.get(String(mapping.response_id)) : undefined;
    const candidate = responseTime ? (sourceInstant(responseTime) < cutoff ? "BEFORE_CUTOFF" : "AT_OR_AFTER_CUTOFF") : "UNKNOWN";
    addSourceRecord(groups, "PRIVATE_PENDING", { record_type: "SHEET_ROW",
      identity: { spreadsheet_id: pinned.spreadsheet_id, sheet_id: pinned.sheet_id, row_index: rowIndex },
      reasons: ["SHEET_SCOPE_UNPROVEN", ...(unsupported ? ["SHEET_ROW_UNSUPPORTED"] : [])],
      candidate_submission_scope: candidate, mapping_status: "DECLARED_EXTERNAL_EVIDENCE_REQUIRED",
      declared_mapping: mapping ?? null, raw: row });
    if (unsupported) condition(groups, "SHEET_ROW_UNSUPPORTED", { row_index: rowIndex }, "UNSUPPORTED");
    if (mapping && responseTime === undefined) condition(groups, "DECLARED_MAPPING_RESPONSE_NOT_OBSERVED",
      { row_index: rowIndex, response_id: mapping.response_id });
  }
}

export function appendSourceCensusConditions(groups: SourceRecordGroups, census: SourceObject[], responseTimes: Map<string, string>) {
  for (const source of census) {
    if (source.kind === "FORM_RESPONSE") {
      if (!responseTimes.has(String(source.response_id))) condition(groups, "KNOWN_RESPONSE_NOT_OBSERVED", source);
    } else condition(groups, source.kind === "LEGACY_ROW" ? "LEGACY_ROW_RESPONSE_UNMATCHABLE" : "MEMBER_RESPONSE_UNMATCHABLE", source);
  }
}

export function sourceNamespaceCounts(groups: SourceRecordGroups): Record<SourceNamespace, number> {
  return Object.fromEntries(SOURCE_NAMESPACES.map(namespace => [namespace, groups[namespace].length])) as Record<SourceNamespace, number>;
}

export function assembleSourceChunks(groups: SourceRecordGroups, operation: string): LocalSourceChunk[] {
  const chunks: LocalSourceChunk[] = [];
  for (const namespace of SOURCE_NAMESPACES) {
    let offset = 0;
    let index = 0;
    while (offset < groups[namespace].length) {
      const block: SourceObject[] = [];
      const payload = (records: SourceObject[]) => ({ format: SOURCE_FORMAT, source_operation_id: operation,
        namespace, chunk_index: index, row_offset: offset, records });
      while (offset + block.length < groups[namespace].length && block.length < SOURCE_LIMITS.chunk_records) {
        const candidate = [...block, groups[namespace][offset + block.length]];
        if (sourceBytes(sourceCanonical(payload(candidate))) > SOURCE_LIMITS.chunk_bytes) break;
        block.push(candidate[candidate.length - 1]);
      }
      sourceAssert(block.length > 0, "CHUNK_BYTES_EXCEEDED");
      const payload_text = sourceCanonical(payload(block));
      chunks.push({ namespace, chunk_index: index, row_offset: offset, row_count: block.length,
        payload_text, utf8_bytes: sourceBytes(payload_text) });
      offset += block.length;
      index++;
    }
  }
  return chunks;
}

export function sourceMetadata(
  pinned: SourcePinnedContext, observedStart: SourceJson, observedEnd: SourceJson,
  census: SourceObject[], inputBytes: number, groups: SourceRecordGroups,
) {
  return { format: SOURCE_FORMAT, pinned_context: pinned as unknown as SourceJson,
    submission_cutoff_at: pinned.season_ends_at, observed_start_at: observedStart, observed_end_at: observedEnd,
    observation_status: "INPUT_DECLARATIONS_ONLY", mapping_status: "DECLARED_EXTERNAL_EVIDENCE_REQUIRED",
    known_sources: census, input_bytes: inputBytes, numeric_model: "FINITE_IEEE754_JSON_ALREADY_PARSED_MINUS_ZERO_CANONICAL_ZERO",
    historical_coverage: "CURRENT_ACCESSIBLE_DECLARED_INPUT_AND_KNOWN_CENSUS_ONLY", sheet_archive_eligible_rows: 0,
    evidence_condition_counts: Object.fromEntries(["SOURCE_GAP", "UNSUPPORTED", "PROOF_REQUIRED", "COVERAGE_LIMIT"].map(category =>
      [category, groups.GAP_LEDGER.filter(row => row.classification === category).length])) };
}
