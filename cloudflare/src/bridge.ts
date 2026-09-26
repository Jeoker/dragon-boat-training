import { hmacSha256Base64Url, sha256Base64Url } from "./crypto";
import { ApiError } from "./http";

export const BRIDGE_PROTOCOL = "2026-09-19.bridge.v1";
export const BRIDGE_DIRECTION = "CLOUDFLARE_TO_GOOGLE";

interface BridgeEnvelope {
  action: "cloudflareBridgeProbe" | "cloudflareReadFormResponses" | "cloudflareReadSheetRecords";
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
  action?: BridgeEnvelope["action"];
}): Promise<BridgeEnvelope> {
  const payloadJson = JSON.stringify(input.payload);
  const unsigned = {
    action: input.action ?? "cloudflareBridgeProbe",
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

export async function callGoogleBridge(env: Env, input: {
  action: "cloudflareReadFormResponses" | "cloudflareReadSheetRecords";
  request_id: string;
  operation_id: string;
  season_id: string;
  binding_version: number;
  payload: Record<string, unknown>;
}): Promise<{ data: Record<string, unknown>; payload_digest: string }> {
  if (!env.GOOGLE_BRIDGE_URL || !env.GOOGLE_BRIDGE_SECRET) {
    throw new ApiError("BRIDGE_CONFIGURATION_REQUIRED", "The Google bridge is not configured.", 503, true);
  }
  let url: URL;
  try { url = new URL(env.GOOGLE_BRIDGE_URL); }
  catch { throw new ApiError("BRIDGE_CONFIGURATION_REQUIRED", "The Google bridge URL is invalid.", 503, true); }
  if (url.protocol !== "https:" || url.hostname !== "script.google.com") {
    throw new ApiError("BRIDGE_CONFIGURATION_REQUIRED", "The Google bridge URL is not allowed.", 503, true);
  }
  const envelope = await createBridgeEnvelope({
    action: input.action, requestId: input.request_id, teamId: env.TEAM_ID,
    writerEpoch: Number(env.WRITER_EPOCH), bindingVersion: `${input.season_id}:${input.binding_version}`,
    operationId: input.operation_id, payload: input.payload, secret: env.GOOGLE_BRIDGE_SECRET
  });
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(url, {
      method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(envelope), redirect: "follow", signal: AbortSignal.timeout(20_000)
    });
    body = await response.json();
  } catch {
    throw new ApiError("BRIDGE_UNAVAILABLE", "The Google bridge could not be reached.", 503, true);
  }
  if (isRecord(body) && body.ok === false && isRecord(body.meta) &&
      body.meta.request_id === input.request_id && isRecord(body.error) &&
      typeof body.error.code === "string" && typeof body.error.message === "string" &&
      typeof body.error.retryable === "boolean") {
    throw new ApiError(body.error.code, body.error.message, 502, body.error.retryable);
  }
  if (!response.ok || !isRecord(body) || body.ok !== true || !isRecord(body.meta) ||
      body.meta.request_id !== input.request_id || !isRecord(body.data)) {
    throw new ApiError("BRIDGE_INVALID_RESPONSE", "The Google bridge returned an invalid response.", 502, true);
  }
  return { data: body.data, payload_digest: envelope.payload_digest };
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
  let parsed: unknown;
  try {
    response = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(envelope),
      redirect: "follow",
      signal: AbortSignal.timeout(10_000)
    });
    parsed = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ApiError("BRIDGE_INVALID_RESPONSE", "The Google bridge returned an unreadable response.", 502, true);
    }
    throw new ApiError(
      "BRIDGE_UNAVAILABLE",
      "The Google bridge could not be reached.",
      503,
      true
    );
  }

  if (!isRecord(parsed) || typeof parsed.ok !== "boolean" || !isRecord(parsed.meta) || parsed.meta.request_id !== requestId) {
    throw new ApiError("BRIDGE_INVALID_RESPONSE", "The Google bridge returned an invalid envelope.", 502, true);
  }
  if (parsed.ok === false && isRecord(parsed.error) &&
      typeof parsed.error.code === "string" && parsed.error.code && typeof parsed.error.message === "string" && parsed.error.message &&
      typeof parsed.error.retryable === "boolean") {
    throw new ApiError(
      parsed.error.code,
      parsed.error.message,
      502,
      parsed.error.retryable
    );
  }
  const receipt = parsed.data;
  if (
    !response.ok || parsed.ok !== true || !isRecord(receipt) ||
    receipt.status !== "verified" || receipt.protocol_version !== BRIDGE_PROTOCOL ||
    receipt.binding_version !== envelope.binding_version ||
    receipt.operation_id !== envelope.operation_id || receipt.challenge !== challenge ||
    receipt.payload_digest !== envelope.payload_digest || receipt.team_id !== env.TEAM_ID ||
    receipt.writer_epoch !== Number(env.WRITER_EPOCH) ||
    typeof receipt.acknowledged_at !== "string" || !Number.isFinite(Date.parse(receipt.acknowledged_at))
  ) {
    throw new ApiError("BRIDGE_INVALID_RESPONSE", "The Google bridge response scope does not match.", 502, true);
  }
  return receipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
