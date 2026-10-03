// Local authority declarations only. No authentication, source IO, storage or receipt.
import {
  SOURCE_FORMAT, SOURCE_LIMITS, sourceAssert, sourceBytes, sourceCanonical, sourceObject,
  sourcePinnedContext, sourceText, type SourceJson, type SourcePinnedContext,
} from "./c2-source-capture-contract";

export const PLAN_VALIDATION_FORMAT = "c2-source-plan-validation-v1";
export const PLAN_DIGEST_DOMAIN = "c2-source-review-source-v1\n";
export const PLAN_VALIDATION_LIMITS = Object.freeze({ core_bytes: SOURCE_LIMITS.total_bytes,
  private_bytes: 2_000_000, control_bytes: 8_000 });
export type PlanContextPort = () => unknown;
export type PlanHashPort = (text: string) => Promise<string>;
export interface PlanValidationContext {
  source: SourcePinnedContext;
  source_format: typeof SOURCE_FORMAT;
  source_plan_digest: string;
}

export function planBoundedText(value: unknown, bytes: number, code = "PLAN_BYTES_EXCEEDED"): string {
  sourceAssert(typeof value === "string", "RAW_JSON_REQUIRED");
  sourceAssert(value.length <= bytes && sourceBytes(value) <= bytes, code);
  return value;
}

function planDigest(value: unknown): string {
  const text = sourceText(value as SourceJson, 43, 43);
  sourceAssert(/^[A-Za-z0-9_-]{43}$/u.test(text), "PLAN_DIGEST_INVALID");
  return text;
}

export function readPlanValidationContext(port: PlanContextPort): PlanValidationContext {
  try {
    const row = sourceObject(port() as SourceJson);
    sourceAssert(Object.keys(row).length === 3 && Object.keys(row).every(key =>
      ["source", "source_format", "source_plan_digest"].includes(key)), "PLAN_CONTEXT_INVALID");
    sourceAssert(row.source_format === SOURCE_FORMAT, "PLAN_CONTEXT_INVALID");
    const context: PlanValidationContext = { source: sourcePinnedContext(row.source), source_format: SOURCE_FORMAT,
      source_plan_digest: planDigest(row.source_plan_digest) };
    planBoundedText(sourceCanonical(context as unknown as SourceJson), PLAN_VALIDATION_LIMITS.control_bytes);
    return context;
  } catch {
    sourceAssert(false, "PLAN_CONTEXT_INVALID");
  }
}

export function assertFreshPlanContext(port: PlanContextPort, initial: PlanValidationContext) {
  const fresh = readPlanValidationContext(port);
  sourceAssert(sourceCanonical(fresh as unknown as SourceJson) === sourceCanonical(initial as unknown as SourceJson),
    "PLAN_OWNERSHIP_CHANGED");
}

export async function hashOriginalPlan(port: PlanHashPort, text: string): Promise<string> {
  try {
    return planDigest(await port(PLAN_DIGEST_DOMAIN + text));
  } catch {
    sourceAssert(false, "PLAN_HASH_FAILED");
  }
}
