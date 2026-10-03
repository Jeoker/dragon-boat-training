import {
  exactSourceKeys, parseSourceJson, sourceAssert, sourceObject, type SourceJson,
} from "./c2-source-capture-contract";
import { buildLocalSourcePlan } from "./c2-source-capture-projection";
import {
  REVIEW_DOMAINS, REVIEW_LIMITS, boundedText, hashReview, parseMappingCommand, readReviewContext,
  type ReviewBundle, type ReviewContextPort, type ReviewHashPort,
} from "./c2-source-mapping-review-contract";
import {
  prepareReviewRecords, planPreparedMappingReview, type RetainedReviewRecord,
} from "./c2-source-mapping-review-internal";
export type { PrivateReviewRecord, LocalMappingReviewView } from "./c2-source-mapping-review-internal";

function copyBundle(bundle: ReviewBundle) {
  try {
    const row = sourceObject(bundle as unknown as SourceJson);
    exactSourceKeys(row, ["source_input_text", "source_plan_text"]);
    return { source_input_text: row.source_input_text, source_plan_text: row.source_plan_text };
  } catch {
    sourceAssert(false, "REVIEW_BUNDLE_INVALID");
  }
}

async function prepareBundle(bundle: ReviewBundle, contextPort: ReviewContextPort, hashPort: ReviewHashPort) {
  const context = readReviewContext(contextPort);
  const row = copyBundle(bundle);
  const inputText = boundedText(row.source_input_text, REVIEW_LIMITS.input_bytes);
  const planText = boundedText(row.source_plan_text, REVIEW_LIMITS.input_bytes);
  parseSourceJson(planText);
  const plan = buildLocalSourcePlan(inputText, context.source);
  sourceAssert(plan.canonical_text === planText, "REVIEW_SOURCE_PLAN_MISMATCH");
  const digest = await hashReview(hashPort, REVIEW_DOMAINS.source, planText);
  sourceAssert(digest === context.source_plan_digest, "REVIEW_SOURCE_ANCHOR_MISMATCH");
  const records: RetainedReviewRecord[] = [];
  for (const chunk of plan.chunks) {
    const rows = JSON.parse(chunk.payload_text).records;
    rows.forEach((record: RetainedReviewRecord["record"], index: number) => records.push({ record,
      locator: { namespace: chunk.namespace, chunk_index: chunk.chunk_index, record_offset: chunk.row_offset + index } }));
  }
  return prepareReviewRecords(records, context, contextPort, hashPort);
}

export async function prepareLocalMappingReview(
  bundle: ReviewBundle, contextPort: ReviewContextPort, hashPort: ReviewHashPort,
) {
  return (await prepareBundle(bundle, contextPort, hashPort)).view;
}

export async function planLocalMappingReview(
  bundle: ReviewBundle, priorLedgerText: unknown, commandJsonText: unknown,
  contextPort: ReviewContextPort, hashPort: ReviewHashPort,
) {
  const priorText = boundedText(priorLedgerText, REVIEW_LIMITS.ledger_bytes);
  parseSourceJson(priorText);
  const command = parseMappingCommand(commandJsonText);
  const prepared = await prepareBundle(bundle, contextPort, hashPort);
  return planPreparedMappingReview(prepared, priorText, command, contextPort, hashPort);
}
