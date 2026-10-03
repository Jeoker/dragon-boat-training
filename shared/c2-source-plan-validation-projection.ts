import {
  SOURCE_FORMAT, SOURCE_LIMITS, exactSourceKeys, parseGeneratedSourceJson, parseSourceJson,
  responseSupported, sourceArray, sourceAssert, sourceBytes, sourceCanonical, sourceDeclaredMappings,
  sourceFormSchema, sourceInteger, sourceInstant, sourceKnownSources, sourceObject, sourcePinnedContext,
  sourceResponseIdentity, sourceSheetCoverage, sourceText, type SourceJson, type SourceObject,
} from "./c2-source-capture-contract";
import {
  SOURCE_NAMESPACES, appendEligibleSourceResponse, appendExcludedSourceIdentity, appendSourceCensusConditions,
  appendSourceSheetRows, assembleSourceChunks, initialSourceRecords, sourceMetadata, sourceNamespaceCounts,
  type SourceNamespace, type SourceRecordGroups,
} from "./c2-source-capture-records";
import {
  PLAN_VALIDATION_FORMAT, PLAN_VALIDATION_LIMITS, assertFreshPlanContext, hashOriginalPlan,
  planBoundedText, readPlanValidationContext, type PlanContextPort, type PlanHashPort, type PlanValidationContext,
} from "./c2-source-plan-validation-contract";

export interface ValidatedSourceRecord {
  locator: { namespace: SourceNamespace; chunk_index: number; record_offset: number };
  record: SourceObject;
}
export interface ValidatedLocalSourcePlan {
  format: typeof PLAN_VALIDATION_FORMAT;
  state: "LOCAL_PLAN_VALIDATION_ONLY";
  source_status: "SOURCE_NOT_VERIFIED";
  control: {
    source: PlanValidationContext["source"];
    source_plan_digest: string;
    namespace_counts: Record<SourceNamespace, number>;
    record_count: number;
    input_bytes_declared: number;
    input_byte_evidence: "ORIGINAL_DECLARATION_ONLY";
    excluded_body_evidence: "NOT_PRESENT_NOT_RECONSTRUCTED";
    authority_evidence: "LOCAL_CONTEXT_DECLARATIONS_ONLY";
    source_authenticity: "NOT_PROVEN";
    annual_export_authorized: false;
  };
  private_collection: {
    metadata: SourceObject;
    records: Record<SourceNamespace, ValidatedSourceRecord[]>;
  };
}

function assertExact(value: SourceJson, expected: SourceJson, code: string) {
  sourceAssert(sourceCanonical(value) === sourceCanonical(expected), code);
}

/** Only the fixed original parent path is used for raw lexical/depth checks; never the input builder. */
function retainedRaw(raw: SourceObject, field: string, array: boolean): SourceObject {
  sourceAssert(sourceBytes(sourceCanonical(raw)) <= SOURCE_LIMITS.record_bytes, "RECORD_BYTES_EXCEEDED");
  parseSourceJson(sourceCanonical({ [field]: array ? [raw] : raw }));
  return raw;
}

function readChunkGroups(core: SourceObject, operation: string) {
  const chunks = sourceArray(core.chunks);
  sourceAssert(chunks.length <= SOURCE_LIMITS.records, "RECORD_COUNT_EXCEEDED");
  const groups: SourceRecordGroups = { FORM_CURRENT: [], SHEET_CURRENT: [], EXCLUDED_IDENTITIES: [], PRIVATE_PENDING: [], GAP_LEDGER: [] };
  const located: Record<SourceNamespace, ValidatedSourceRecord[]> = {
    FORM_CURRENT: [], SHEET_CURRENT: [], EXCLUDED_IDENTITIES: [], PRIVATE_PENDING: [], GAP_LEDGER: [],
  };
  const indices = new Map<SourceNamespace, number>();
  let namespacePosition = -1;
  let recordCount = 0;
  for (const raw of chunks) {
    const chunk = sourceObject(raw);
    exactSourceKeys(chunk, ["namespace", "chunk_index", "row_offset", "row_count", "payload_text", "utf8_bytes"]);
    const position = SOURCE_NAMESPACES.indexOf(chunk.namespace as SourceNamespace);
    sourceAssert(position >= 0 && position >= namespacePosition, "PLAN_CHUNK_LAYOUT_INVALID");
    namespacePosition = position;
    const namespace = SOURCE_NAMESPACES[position];
    const index = sourceInteger(chunk.chunk_index, 0, SOURCE_LIMITS.records);
    const offset = sourceInteger(chunk.row_offset, 0, SOURCE_LIMITS.records);
    const count = sourceInteger(chunk.row_count, 1, SOURCE_LIMITS.chunk_records);
    sourceAssert(index === (indices.get(namespace) ?? 0) && offset === groups[namespace].length,
      "PLAN_CHUNK_LAYOUT_INVALID");
    const text = planBoundedText(chunk.payload_text, SOURCE_LIMITS.chunk_bytes);
    sourceAssert(sourceInteger(chunk.utf8_bytes, 1, SOURCE_LIMITS.chunk_bytes) === sourceBytes(text), "PLAN_CHUNK_BYTES_INVALID");
    const payload = sourceObject(parseGeneratedSourceJson(text));
    exactSourceKeys(payload, ["format", "source_operation_id", "namespace", "chunk_index", "row_offset", "records"]);
    sourceAssert(payload.format === SOURCE_FORMAT && payload.source_operation_id === operation && payload.namespace === namespace &&
      payload.chunk_index === index && payload.row_offset === offset, "PLAN_CHUNK_IDENTITY_INVALID");
    sourceAssert(sourceCanonical(payload) === text, "PLAN_CHUNK_NONCANONICAL");
    const records = sourceArray(payload.records);
    sourceAssert(records.length === count, "PLAN_CHUNK_COUNT_INVALID");
    recordCount += count;
    sourceAssert(recordCount <= SOURCE_LIMITS.records, "RECORD_COUNT_EXCEEDED");
    records.forEach((value, i) => {
      const record = sourceObject(value);
      sourceAssert(sourceBytes(sourceCanonical(record)) <= SOURCE_LIMITS.record_bytes, "RECORD_BYTES_EXCEEDED");
      groups[namespace].push(record);
      located[namespace].push({ locator: { namespace, chunk_index: index, record_offset: offset + i }, record });
    });
    indices.set(namespace, index + 1);
  }
  assertExact(core.namespace_counts, sourceNamespaceCounts(groups), "PLAN_COUNTS_INVALID");
  sourceAssert(sourceInteger(core.record_count, 0, SOURCE_LIMITS.records) === recordCount, "PLAN_COUNTS_INVALID");
  sourceAssert(groups.SHEET_CURRENT.length === 0, "PLAN_LAYOUT_INVALID");
  return { groups, located };
}

function readRetainedLayout(groups: SourceRecordGroups) {
  const current = groups.FORM_CURRENT;
  const pending = groups.PRIVATE_PENDING;
  let index = 0;
  let formWrapper: SourceObject;
  if (current.length) {
    sourceAssert(current[0].record_type === "FORM_SCHEMA", "PLAN_LAYOUT_INVALID");
    formWrapper = current[0];
  } else {
    sourceAssert(pending[0]?.record_type === "FORM_SCHEMA", "PLAN_LAYOUT_INVALID");
    formWrapper = pending[index++];
  }
  sourceAssert(pending[index]?.record_type === "SHEET_SCHEMA", "PLAN_LAYOUT_INVALID");
  const sheetWrapper = pending[index++];
  const currentResponses = current.slice(1);
  sourceAssert(currentResponses.every(row => row.record_type === "FORM_RESPONSE"), "PLAN_LAYOUT_INVALID");
  const pendingResponses: SourceObject[] = [];
  while (pending[index]?.record_type === "FORM_RESPONSE") pendingResponses.push(pending[index++]);
  const sheetRows = pending.slice(index);
  sourceAssert(sheetRows.every(row => row.record_type === "SHEET_ROW"), "PLAN_LAYOUT_INVALID");
  sourceAssert(groups.EXCLUDED_IDENTITIES.every(row => row.record_type === "FORM_RESPONSE_EXCLUDED") &&
    groups.GAP_LEDGER.every(row => row.record_type === "SOURCE_EVIDENCE_CONDITION"), "PLAN_LAYOUT_INVALID");
  return { formWrapper, sheetWrapper, currentResponses, pendingResponses, sheetRows };
}

function validateRetainedSemantics(core: SourceObject, metadata: SourceObject, groups: SourceRecordGroups, context: PlanValidationContext) {
  const pinned = sourcePinnedContext(metadata.pinned_context);
  assertExact(pinned as unknown as SourceJson, context.source as unknown as SourceJson, "PLAN_SOURCE_IDENTITY_INVALID");
  const start = sourceInstant(sourceText(metadata.observed_start_at, 1));
  const end = sourceInstant(sourceText(metadata.observed_end_at, 1));
  const cutoff = sourceInstant(pinned.season_ends_at);
  sourceAssert(start <= end && end >= cutoff, "OBSERVED_INTERVAL_INVALID");
  const inputBytes = sourceInteger(metadata.input_bytes, 1, SOURCE_LIMITS.input_bytes);
  const censusValues = sourceArray(metadata.known_sources);
  sourceAssert(censusValues.length <= SOURCE_LIMITS.records, "RECORD_COUNT_EXCEEDED");
  const census = censusValues.map(sourceObject);
  census.forEach(row => retainedRaw(row, "known_sources", true));
  sourceKnownSources(census, pinned);
  const layout = readRetainedLayout(groups);
  const form = retainedRaw(sourceObject(layout.formWrapper.raw), "form_schema", false);
  const sheet = retainedRaw(sourceObject(layout.sheetWrapper.raw), "sheet_schema", false);
  sourceAssert(form.formId === pinned.form_id && (!Object.hasOwn(form, "linkedSheetId") || form.linkedSheetId === pinned.spreadsheet_id),
    "SOURCE_IDENTITY_MISMATCH");
  const schema = sourceFormSchema(form);
  sourceAssert(schema.supported === (groups.FORM_CURRENT.length > 0), "PLAN_LAYOUT_INVALID");
  const expected = initialSourceRecords(form, schema.supported, sheet);
  const responseTimes = new Map<string, string>();
  const fullResponses = [...layout.currentResponses, ...layout.pendingResponses];
  for (const wrapper of fullResponses) {
    const response = retainedRaw(sourceObject(wrapper.raw), "form_responses", true);
    const id = sourceResponseIdentity(response, pinned, end);
    sourceAssert(!responseTimes.has(id), "DUPLICATE_RESPONSE_ID");
    const status = responseSupported(response, schema.questions);
    const createTime = sourceText(response.createTime, 1);
    sourceAssert(sourceInstant(createTime) < cutoff, "PLAN_RETAINED_SCOPE_INVALID");
    responseTimes.set(id, createTime);
    appendEligibleSourceResponse(expected, response, pinned, schema.supported, status);
  }
  for (const wrapper of groups.EXCLUDED_IDENTITIES) {
    exactSourceKeys(wrapper, ["record_type", "reason", "identity"]);
    const identity = sourceObject(wrapper.identity);
    exactSourceKeys(identity, ["form_id", "response_id", "createTime"]);
    const id = sourceText(identity.response_id, 1, 512);
    const createTime = sourceText(identity.createTime, 1);
    const instant = sourceInstant(createTime);
    sourceAssert(identity.form_id === pinned.form_id, "SOURCE_IDENTITY_MISMATCH");
    sourceAssert(instant >= cutoff && instant <= end, "PLAN_EXCLUDED_SCOPE_INVALID");
    sourceAssert(!responseTimes.has(id), "DUPLICATE_RESPONSE_ID");
    responseTimes.set(id, createTime);
    appendExcludedSourceIdentity(expected, pinned, id, createTime);
  }
  const rows = layout.sheetRows.map(wrapper => retainedRaw(sourceObject(wrapper.raw), "sheet_rows", true));
  const { rowCount } = sourceSheetCoverage(sheet, rows, pinned);
  const mappings: SourceObject[] = [];
  for (const wrapper of layout.sheetRows) {
    sourceAssert(Object.hasOwn(wrapper, "declared_mapping"), "PLAN_RECORD_INVALID");
    if (wrapper.declared_mapping !== null) {
      const mapping = retainedRaw(sourceObject(wrapper.declared_mapping), "declared_mappings", true);
      sourceAssert(mapping.row_index === sourceObject(wrapper.raw).row_index, "PLAN_MAPPING_ROW_INVALID");
      mappings.push(mapping);
    }
  }
  sourceDeclaredMappings(mappings, rowCount);
  sourceAssert(responseTimes.size + rows.length + census.length + mappings.length + 2 <= SOURCE_LIMITS.records,
    "RECORD_COUNT_EXCEEDED");
  appendSourceSheetRows(expected, rows, mappings, responseTimes, pinned);
  appendSourceCensusConditions(expected, census, responseTimes);
  for (const namespace of SOURCE_NAMESPACES) {
    assertExact(groups[namespace], expected[namespace], namespace === "GAP_LEDGER" ? "PLAN_CONDITIONS_INVALID" : "PLAN_RECORD_INVALID");
  }
  const expectedMetadata = sourceMetadata(pinned, metadata.observed_start_at, metadata.observed_end_at, census, inputBytes, expected);
  assertExact(metadata, expectedMetadata, "PLAN_METADATA_INVALID");
  assertExact(core.chunks, assembleSourceChunks(expected, pinned.source_operation_id) as unknown as SourceJson,
    "PLAN_GREEDY_CHUNKS_INVALID");
  return inputBytes;
}

/** Validate retained canonical content, never reconstruct an input or assert source provenance. */
export async function validateLocalSourcePlanCore(
  originalCoreText: unknown, contextPort: PlanContextPort, hashPort: PlanHashPort,
): Promise<ValidatedLocalSourcePlan> {
  const text = planBoundedText(originalCoreText, PLAN_VALIDATION_LIMITS.core_bytes);
  const context = readPlanValidationContext(contextPort);
  const core = sourceObject(parseGeneratedSourceJson(text));
  exactSourceKeys(core, ["format", "state", "source_status", "metadata_text", "namespace_counts", "record_count", "chunks"]);
  sourceAssert(core.format === SOURCE_FORMAT && core.state === "LOCAL_SOURCE_PLAN_ONLY" &&
    core.source_status === "SOURCE_NOT_VERIFIED", "PLAN_FORMAT_INVALID");
  sourceAssert(sourceCanonical(core) === text, "PLAN_NONCANONICAL");
  // Metadata can legitimately exceed 64KB; the original whole-core budget bounds it.
  const metadataText = planBoundedText(core.metadata_text, PLAN_VALIDATION_LIMITS.core_bytes);
  const metadata = sourceObject(parseGeneratedSourceJson(metadataText));
  sourceAssert(sourceCanonical(metadata) === metadataText, "PLAN_METADATA_NONCANONICAL");
  const { groups, located } = readChunkGroups(core, context.source.source_operation_id);
  const inputBytes = validateRetainedSemantics(core, metadata, groups, context);
  const control: ValidatedLocalSourcePlan["control"] = {
    source: context.source, source_plan_digest: context.source_plan_digest,
    namespace_counts: sourceNamespaceCounts(groups), record_count: sourceInteger(core.record_count, 0, SOURCE_LIMITS.records),
    input_bytes_declared: inputBytes, input_byte_evidence: "ORIGINAL_DECLARATION_ONLY",
    excluded_body_evidence: "NOT_PRESENT_NOT_RECONSTRUCTED", authority_evidence: "LOCAL_CONTEXT_DECLARATIONS_ONLY",
    source_authenticity: "NOT_PROVEN", annual_export_authorized: false,
  };
  planBoundedText(sourceCanonical(control as unknown as SourceJson), PLAN_VALIDATION_LIMITS.control_bytes, "PLAN_CONTROL_BYTES_EXCEEDED");
  const result: ValidatedLocalSourcePlan = { format: PLAN_VALIDATION_FORMAT, state: "LOCAL_PLAN_VALIDATION_ONLY",
    source_status: "SOURCE_NOT_VERIFIED", control, private_collection: { metadata, records: located } };
  planBoundedText(sourceCanonical(result as unknown as SourceJson), PLAN_VALIDATION_LIMITS.private_bytes, "PLAN_PRIVATE_OUTPUT_EXCEEDED");
  const digest = await hashOriginalPlan(hashPort, text);
  sourceAssert(digest === context.source_plan_digest, "PLAN_ORIGINAL_DIGEST_MISMATCH");
  assertFreshPlanContext(contextPort, context);
  return result;
}
