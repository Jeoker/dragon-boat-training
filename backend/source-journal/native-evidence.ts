import { sourceCanonical, sourceObject, sourceInstant, sourceBytes, type SourceJson } from "../../shared/c2-source-capture-contract";
import type { SourceAuthorityPin } from "../../shared/c2-source-authority-contract";
import type { PrivateSourceOperationContext } from "./operation";
import { journalAssert } from "./service";

const canonical = (value: unknown) => sourceCanonical(value as SourceJson);
export const nativeCaptureUrl = (context: PrivateSourceOperationContext, digest: string) =>
  `https://native-tab-proof.internal/capture/${encodeURIComponent(context.read_context.source.source_operation_id)}/${encodeURIComponent(context.attempt_id)}?authority_digest=${digest}`;
const exact = (value: unknown, keys: string[]) => {
  const row = sourceObject(JSON.parse(canonical(value)));
  journalAssert(Object.keys(row).length === keys.length && Object.keys(row).every(key => keys.includes(key)), "SOURCE_NATIVE_EVIDENCE_INVALID");
  return row;
};

/** Trusted server verification is the origin of this evidence. Digests retain
 * that observation; they cannot authenticate a client-supplied proof. */
export async function createNativeCaptureEvidence(proof: unknown, pin: SourceAuthorityPin, context: PrivateSourceOperationContext,
  hash: (text: string) => Promise<string>) {
  const core = { format: "c2-capture-native-tab-evidence-v1", verification: "SERVER_HMAC_VERIFIED",
    actor_id: context.actor_id, attempt_id: context.attempt_id, authority_digest: pin.authority_digest,
    context_digest: await hash("c2-native-capture-context-v1\n" + canonical(context)), proof };
  return { ...core, evidence_digest: await hash("c2-native-capture-evidence-v1\n" + canonical(core)) };
}

/** Replays validate retained identity and the ORIGINAL observation interval,
 * never freshness against today's clock. Current authorization is separate. */
export async function validateNativeCaptureEvidence(value: unknown, context: PrivateSourceOperationContext, authorityDigest: string | undefined,
  hash: (text: string) => Promise<string>, start: string, end: string) {
  journalAssert(sourceBytes(canonical(value)) <= 16_000, "SOURCE_NATIVE_EVIDENCE_INVALID");
  const row = exact(value, ["format", "verification", "actor_id", "attempt_id", "authority_digest", "context_digest", "proof", "evidence_digest"]);
  journalAssert(row.format === "c2-capture-native-tab-evidence-v1" && row.verification === "SERVER_HMAC_VERIFIED" &&
    row.actor_id === context.actor_id && row.attempt_id === context.attempt_id && authorityDigest && row.authority_digest === authorityDigest &&
    row.context_digest === await hash("c2-native-capture-context-v1\n" + canonical(context)), "SOURCE_NATIVE_EVIDENCE_INVALID");
  const proof = exact(row.proof, ["format", "evidence", "action", "direction", "request_id", "nonce", "team_id", "backend_generation",
    "writer_epoch", "season_id", "binding_version", "source_operation_id", "authority_digest", "form_id", "spreadsheet_id", "sheet_id", "observed_at_ms"]);
  const source = context.read_context.source;
  const expected = { format: "c2-native-tab-proof-v1", evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED", action: "READ_NATIVE_TAB_LINK",
    direction: "GOOGLE_TO_CLOUDFLARE_NATIVE_TAB", authority_digest: authorityDigest, team_id: source.team_id,
    backend_generation: source.backend_generation, writer_epoch: source.writer_epoch, season_id: source.season_id,
    binding_version: source.binding_version, source_operation_id: source.source_operation_id, form_id: source.form_id,
    spreadsheet_id: source.spreadsheet_id, sheet_id: source.sheet_id };
  journalAssert(Object.entries(expected).every(([key, expected]) => proof[key] === expected) &&
    typeof proof.request_id === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(proof.request_id) &&
    typeof proof.nonce === "string" && /^[A-Za-z0-9_-]{16,128}$/u.test(proof.nonce) &&
    typeof proof.observed_at_ms === "number" && Number.isSafeInteger(proof.observed_at_ms), "SOURCE_NATIVE_EVIDENCE_INVALID");
  const observed = BigInt(proof.observed_at_ms as number) * 1_000_000n;
  journalAssert(observed >= sourceInstant(start) - 5_000_000_000n && observed <= sourceInstant(end) + 5_000_000_000n,
    "SOURCE_NATIVE_EVIDENCE_INVALID");
  const { evidence_digest, ...core } = row;
  journalAssert(evidence_digest === await hash("c2-native-capture-evidence-v1\n" + canonical(core)), "SOURCE_NATIVE_EVIDENCE_INVALID");
  return row;
}
