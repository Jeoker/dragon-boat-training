import {
  SOURCE_FORMAT, SOURCE_LIMITS, parseSourceCaptureInput, responseSupported, sourceAssert,
  sourceBytes, sourceCanonical, sourceInstant, sourceText, type SourceJson,
} from "./c2-source-capture-contract";
import {
  appendEligibleSourceResponse, appendExcludedSourceIdentity, appendSourceCensusConditions,
  appendSourceSheetRows, assembleSourceChunks, initialSourceRecords, sourceMetadata, sourceNamespaceCounts,
  type LocalSourceChunk, type SourceNamespace,
} from "./c2-source-capture-records";
export { SOURCE_NAMESPACES } from "./c2-source-capture-records";
export type { LocalSourceChunk, SourceNamespace } from "./c2-source-capture-records";

export interface LocalSourcePlan {
  format: typeof SOURCE_FORMAT;
  state: "LOCAL_SOURCE_PLAN_ONLY";
  source_status: "SOURCE_NOT_VERIFIED";
  metadata_text: string;
  namespace_counts: Record<SourceNamespace, number>;
  record_count: number;
  chunks: LocalSourceChunk[];
  canonical_text: string;
}

/** Pure declarations only. A well-shaped mapping cannot promote a Sheet row into annual scope. */
export function buildLocalSourcePlan(rawJsonText: unknown, pinnedContext: unknown): LocalSourcePlan {
  const input = parseSourceCaptureInput(rawJsonText, pinnedContext);
  const cutoff = sourceInstant(input.pinned.season_ends_at);
  const groups = initialSourceRecords(input.form_schema, input.schema_supported, input.sheet_schema);
  const responseTimes = new Map<string, string>();
  for (const response of input.form_responses) {
    const id = sourceText(response.responseId, 1, 512);
    const status = responseSupported(response, input.question_ids);
    const createTime = String(response.createTime);
    responseTimes.set(id, createTime);
    if (sourceInstant(createTime) >= cutoff) {
      sourceAssert(status.supported, "UNSUPPORTED_LATE_RESPONSE");
      appendExcludedSourceIdentity(groups, input.pinned, id, createTime);
    } else appendEligibleSourceResponse(groups, response, input.pinned, input.schema_supported, status);
  }
  appendSourceSheetRows(groups, input.sheet_rows, input.declared_mappings, responseTimes, input.pinned);
  appendSourceCensusConditions(groups, input.known_sources, responseTimes);
  const namespace_counts = sourceNamespaceCounts(groups);
  const record_count = Object.values(namespace_counts).reduce((sum, count) => sum + count, 0);
  sourceAssert(record_count <= SOURCE_LIMITS.records, "RECORD_COUNT_EXCEEDED");
  const chunks = assembleSourceChunks(groups, input.pinned.source_operation_id);
  const metadata_text = sourceCanonical(sourceMetadata(input.pinned, input.raw.observed_start_at,
    input.raw.observed_end_at, input.known_sources, input.input_bytes, groups));
  const core = { format: SOURCE_FORMAT as typeof SOURCE_FORMAT, state: "LOCAL_SOURCE_PLAN_ONLY" as const,
    source_status: "SOURCE_NOT_VERIFIED" as const, metadata_text, namespace_counts, record_count, chunks };
  const canonical_text = sourceCanonical(core as unknown as SourceJson);
  sourceAssert(sourceBytes(canonical_text) <= SOURCE_LIMITS.total_bytes, "TOTAL_BYTES_EXCEEDED");
  return { ...core, canonical_text };
}
