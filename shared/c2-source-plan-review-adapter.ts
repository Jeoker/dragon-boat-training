// Private local adapter only. No source IO, authentication, storage or runtime imports.
import { SOURCE_FORMAT, parseSourceJson, sourceAssert } from "./c2-source-capture-contract";
import { SOURCE_NAMESPACES } from "./c2-source-capture-records";
import { validateLocalSourcePlanCore } from "./c2-source-plan-validation-projection";
import {
  REVIEW_LIMITS, assertFreshContext, boundedText, contextIdentity, parseMappingCommand,
  readReviewContext, reviewJson,
  type ReviewContext, type ReviewContextPort, type ReviewHashPort,
} from "./c2-source-mapping-review-contract";
import {
  planPreparedMappingReview, prepareReviewRecords, type RetainedReviewRecord,
} from "./c2-source-mapping-review-internal";

export const REVIEW_PLAN_VALIDATION_MODE = "RETAINED_PLAN_ONLY";

/** Every child context read rechecks the full review authority before projecting source fields. */
function planContextPort(port: ReviewContextPort, initial: ReviewContext) {
  return () => {
    const current = readReviewContext(port);
    sourceAssert(contextIdentity(current) === contextIdentity(initial), "REVIEW_OWNERSHIP_CHANGED");
    return { source: current.source, source_format: SOURCE_FORMAT, source_plan_digest: current.source_plan_digest };
  };
}

async function prepareFromPlan(coreText: unknown, contextPort: ReviewContextPort, hashPort: ReviewHashPort) {
  const context = readReviewContext(contextPort);
  // Never accept caller-assembled validated objects, selected chunks or a proof boolean.
  const validated = await validateLocalSourcePlanCore(coreText, planContextPort(contextPort, context), hashPort);
  assertFreshContext(contextPort, context);
  const records: RetainedReviewRecord[] = [];
  for (const namespace of SOURCE_NAMESPACES) records.push(...validated.private_collection.records[namespace]);
  return prepareReviewRecords(records, context, contextPort, hashPort);
}

function wrap<T>(result: T, limit: number) {
  const wrapped = { validation_mode: REVIEW_PLAN_VALIDATION_MODE, result };
  // Include actual new wrapper bytes; an old bounded inner result does not exempt the wrapper.
  boundedText(reviewJson(wrapped), limit);
  return wrapped;
}

export async function prepareLocalMappingReviewFromPlan(
  coreText: unknown, contextPort: ReviewContextPort, hashPort: ReviewHashPort,
) {
  const prepared = await prepareFromPlan(coreText, contextPort, hashPort);
  const result = wrap(prepared.view, REVIEW_LIMITS.view_bytes);
  assertFreshContext(contextPort, prepared.context);
  return result;
}

export async function planLocalMappingReviewFromPlan(
  coreText: unknown, priorLedgerText: unknown, commandText: unknown,
  contextPort: ReviewContextPort, hashPort: ReviewHashPort,
) {
  const priorText = boundedText(priorLedgerText, REVIEW_LIMITS.ledger_bytes);
  parseSourceJson(priorText);
  const command = parseMappingCommand(commandText);
  const prepared = await prepareFromPlan(coreText, contextPort, hashPort);
  const planned = await planPreparedMappingReview(prepared, priorText, command, contextPort, hashPort);
  const result = wrap(planned, REVIEW_LIMITS.view_bytes);
  assertFreshContext(contextPort, prepared.context);
  return result;
}
