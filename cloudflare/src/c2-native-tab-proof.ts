import { callGoogleBridge } from "./bridge";
import { constantTimeEqual, hmacSha256Base64Url } from "./crypto";
import type { SourceAuthorityPin } from "../../shared/c2-source-authority-contract";

const failure = (): never => { throw new Error("NATIVE_TAB_PROOF_UNCONFIRMED"); };
export async function verifyNativeTabProof(value: unknown, pin: SourceAuthorityPin, requestId: string,
  nonce: string, secret: string, startedAt: number, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure();
  const reply = value as Record<string, unknown>;
  if (Object.keys(reply).sort().join() !== "proof_text,signature" || typeof reply.proof_text !== "string" ||
      reply.proof_text.length > 8_000 || typeof reply.signature !== "string" || !secret ||
      !constantTimeEqual(reply.signature, await hmacSha256Base64Url("c2-native-tab-proof-v1\n" + reply.proof_text, secret))) return failure();
  const proof = JSON.parse(reply.proof_text) as Record<string, unknown>;
  const expected = { format: "c2-native-tab-proof-v1", evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED",
    action: "READ_NATIVE_TAB_LINK", direction: "GOOGLE_TO_CLOUDFLARE_NATIVE_TAB", request_id: requestId,
    nonce, team_id: pin.source.team_id, backend_generation: pin.source.backend_generation, writer_epoch: pin.source.writer_epoch,
    season_id: pin.source.season_id, binding_version: pin.source.binding_version, source_operation_id: pin.source.source_operation_id,
    authority_digest: pin.authority_digest, form_id: pin.source.form_id, spreadsheet_id: pin.source.spreadsheet_id, sheet_id: pin.source.sheet_id };
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || JSON.stringify(proof) !== reply.proof_text ||
      Object.keys(proof).length !== Object.keys(expected).length + 1 ||
      Object.entries(expected).some(([key, value]) => proof[key] !== value) ||
      !Number.isSafeInteger(proof.observed_at_ms) || Number(proof.observed_at_ms) < startedAt - 5_000 ||
      Number(proof.observed_at_ms) > now + 5_000 || now - startedAt > 30_000) return failure();
  return proof;
}

/** Fresh signed observation of the exact native numeric Tab. Does not upgrade
 * capture completeness, source status, snapshot atomicity or annual authority. */
export async function readNativeTabProof(env: Env, pin: SourceAuthorityPin, requestId: string) {
  const nonce = crypto.randomUUID().replaceAll("-", "_"), startedAt = Date.now();
  const bridge = await callGoogleBridge(env, { action: "cloudflareReadNativeTabProof", request_id: requestId,
    operation_id: `native_tab_${requestId}`, season_id: pin.source.season_id, binding_version: pin.source.binding_version,
    payload: { ...pin.source, authority_digest: pin.authority_digest, request_id: requestId, nonce,
      proof_action: "READ_NATIVE_TAB_LINK", proof_direction: "CLOUDFLARE_TO_GOOGLE_NATIVE_TAB" } });
  return verifyNativeTabProof(bridge.data, pin, requestId, nonce, env.GOOGLE_BRIDGE_SECRET ?? "", startedAt);
}
