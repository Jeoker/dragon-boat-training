import { hmacSha256Base64Url, sha256Base64Url } from "./crypto";
import { ApiError } from "./http";

export const BRIDGE_PROTOCOL = "2026-09-19.bridge.v1";
export const BRIDGE_DIRECTION = "CLOUDFLARE_TO_GOOGLE";

interface BridgeEnvelope {
  action: "cloudflareBridgeProbe";
  request_id: string;
  protocol_version: string;
  direction: string;
  team_id: string;
  binding_version: string;
  writer_epoch: number;
  timestamp_ms: number;
  nonce: string;
  operation_id: string;
  payload_json: string;
  payload_digest: string;
  signature: string;
}

export type C0BridgeProbeScenario =
  | "valid"
  | "expired"
  | "tampered_payload"
  | "wrong_team"
  | "wrong_binding"
  | "wrong_epoch";

export function bridgeSignatureInput(envelope: Omit<BridgeEnvelope, "signature">): string {
  return [
    envelope.protocol_version,
    envelope.direction,
    envelope.team_id,
    envelope.binding_version,
    envelope.writer_epoch,
    envelope.timestamp_ms,
    envelope.nonce,
    envelope.operation_id,
    envelope.payload_digest
  ].join("\n");
}

export async function createBridgeEnvelope(input: {
  requestId: string;
  teamId: string;
  writerEpoch: number;
  operationId: string;
  payload: Record<string, unknown>;
  secret: string;
  bindingVersion?: string;
  timestampMs?: number;
  nonce?: string;
}): Promise<BridgeEnvelope> {
  const payloadJson = JSON.stringify(input.payload);
  const unsigned = {
    action: "cloudflareBridgeProbe" as const,
    request_id: input.requestId,
    protocol_version: BRIDGE_PROTOCOL,
    direction: BRIDGE_DIRECTION,
    team_id: input.teamId,
    binding_version: input.bindingVersion ?? "c0",
    writer_epoch: input.writerEpoch,
    timestamp_ms: input.timestampMs ?? Date.now(),
    nonce: input.nonce ?? crypto.randomUUID().replaceAll("-", "_"),
    operation_id: input.operationId,
    payload_json: payloadJson,
    payload_digest: await sha256Base64Url(payloadJson)
  };
  return {
    ...unsigned,
    signature: await hmacSha256Base64Url(bridgeSignatureInput(unsigned), input.secret)
  };
}

export async function callGoogleBridgeProbe(
  env: Env,
  requestId: string,
  challenge: string,
  scenario: C0BridgeProbeScenario = "valid"
): Promise<Record<string, unknown>> {
  if (!env.GOOGLE_BRIDGE_URL || !env.GOOGLE_BRIDGE_SECRET) {
    throw new ApiError(
      "BRIDGE_CONFIGURATION_REQUIRED",
      "The Google bridge is not configured.",
      503,
      true
    );
  }
  let bridgeUrl: URL;
  try {
    bridgeUrl = new URL(env.GOOGLE_BRIDGE_URL);
  } catch {
    throw new ApiError("BRIDGE_CONFIGURATION_REQUIRED", "The Google bridge URL is invalid.", 503, true);
  }
  if (bridgeUrl.protocol !== "https:" || bridgeUrl.hostname !== "script.google.com") {
    throw new ApiError("BRIDGE_CONFIGURATION_REQUIRED", "The Google bridge URL is not allowed.", 503, true);
  }

  const envelope = await createBridgeEnvelope({
    requestId,
    teamId: scenario === "wrong_team" ? `${env.TEAM_ID}_wrong` : env.TEAM_ID,
    writerEpoch:
      scenario === "wrong_epoch" ? Number(env.WRITER_EPOCH) + 1 : Number(env.WRITER_EPOCH),
    operationId: `c0_probe_${requestId}`,
    payload: { challenge },
    secret: env.GOOGLE_BRIDGE_SECRET,
    bindingVersion: scenario === "wrong_binding" ? "c0_wrong" : "c0",
    timestampMs: scenario === "expired" ? Date.now() - 10 * 60 * 1000 : undefined
  });
  if (scenario === "tampered_payload") {
    envelope.payload_json = JSON.stringify({ challenge: `${challenge}-tampered` });
  }
  let response: Response;
  try {
    response = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(envelope),
      redirect: "follow",
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new ApiError(
      "BRIDGE_UNAVAILABLE",
      "The Google bridge could not be reached.",
      503,
      true
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError("BRIDGE_INVALID_RESPONSE", "The Google bridge returned an unreadable response.", 502, true);
  }
  const envelopeResponse = parsed as {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string; retryable?: boolean };
  };
  if (!response.ok || envelopeResponse.ok !== true || !envelopeResponse.data) {
    throw new ApiError(
      envelopeResponse.error?.code || "BRIDGE_REJECTED",
      envelopeResponse.error?.message || "The Google bridge rejected the request.",
      502,
      envelopeResponse.error?.retryable === true
    );
  }
  if (
    envelopeResponse.data.operation_id !== envelope.operation_id ||
    envelopeResponse.data.payload_digest !== envelope.payload_digest ||
    envelopeResponse.data.team_id !== env.TEAM_ID ||
    Number(envelopeResponse.data.writer_epoch) !== Number(env.WRITER_EPOCH)
  ) {
    throw new ApiError("BRIDGE_INVALID_RESPONSE", "The Google bridge response scope does not match.", 502, true);
  }
  return envelopeResponse.data;
}
