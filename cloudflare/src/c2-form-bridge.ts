import { BRIDGE_PROTOCOL, createBridgeEnvelope } from "./bridge";
import { ApiError } from "./http";
import { isRecord } from "./c1-support";

export interface FormCursorRequest {
  window_start_ms: number;
  after_at_ms: number;
  after_id: string;
}

export interface FormResponseRow {
  response_id: string;
  submitted_at: string;
  display_name: string;
}

export interface FormResponsePage extends FormCursorRequest {
  read_at_ms: number;
  has_more: boolean;
  next_after_at_ms: number;
  next_after_id: string;
  responses: FormResponseRow[];
}

function invalid(): never {
  throw new ApiError("BRIDGE_INVALID_RESPONSE", "The Form bridge returned an invalid batch.", 502, true);
}

export async function readGoogleFormPage(env: Env, input: {
  request_id: string;
  operation_id: string;
  season_id: string;
  form_id: string;
  binding_version: number;
  cursor: FormCursorRequest;
  limit: number;
}): Promise<FormResponsePage> {
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
    action: "cloudflareReadFormResponses", requestId: input.request_id,
    teamId: env.TEAM_ID, writerEpoch: Number(env.WRITER_EPOCH),
    bindingVersion: `${input.season_id}:${input.binding_version}`,
    operationId: input.operation_id,
    payload: { season_id: input.season_id, ...input.cursor, limit: input.limit },
    secret: env.GOOGLE_BRIDGE_SECRET
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
    throw new ApiError("BRIDGE_UNAVAILABLE", "The Form bridge could not be reached.", 503, true);
  }
  if (isRecord(body) && body.ok === false && isRecord(body.meta) &&
      body.meta.request_id === input.request_id && isRecord(body.error) &&
      typeof body.error.code === "string" && typeof body.error.message === "string" &&
      typeof body.error.retryable === "boolean") {
    throw new ApiError(body.error.code, body.error.message, 502, body.error.retryable);
  }
  if (!response.ok || !isRecord(body) || body.ok !== true || !isRecord(body.meta) ||
      body.meta.request_id !== input.request_id || !isRecord(body.data)) invalid();
  const page = body.data;
  if (page.protocol_version !== BRIDGE_PROTOCOL || page.team_id !== env.TEAM_ID ||
      page.season_id !== input.season_id || page.form_id !== input.form_id ||
      page.binding_version !== input.binding_version || page.writer_epoch !== Number(env.WRITER_EPOCH) ||
      page.operation_id !== input.operation_id || page.payload_digest !== envelope.payload_digest ||
      page.window_start_ms !== input.cursor.window_start_ms ||
      page.after_at_ms !== input.cursor.after_at_ms || page.after_id !== input.cursor.after_id ||
      typeof page.has_more !== "boolean" || typeof page.read_at_ms !== "number" ||
      !Number.isSafeInteger(page.read_at_ms) || page.read_at_ms < input.cursor.window_start_ms ||
      typeof page.next_after_at_ms !== "number" ||
      !Number.isSafeInteger(page.next_after_at_ms) || page.next_after_at_ms < input.cursor.after_at_ms ||
      typeof page.next_after_id !== "string" || !Array.isArray(page.responses) ||
      page.responses.length > input.limit || page.has_more && page.responses.length === 0) invalid();
  const seen = new Set<string>();
  let previousAt = input.cursor.after_at_ms;
  let previousId = input.cursor.after_id;
  for (const row of page.responses) {
    if (!isRecord(row) || typeof row.response_id !== "string" ||
        !/^[A-Za-z0-9_-]{8,256}$/u.test(row.response_id) || seen.has(row.response_id) ||
        typeof row.submitted_at !== "string" || !Number.isFinite(Date.parse(row.submitted_at)) ||
        new Date(row.submitted_at).toISOString() !== row.submitted_at ||
        typeof row.display_name !== "string" || row.display_name.length > 1_000) invalid();
    const at = Date.parse(row.submitted_at);
    if (at < input.cursor.window_start_ms || at > page.read_at_ms ||
        at < previousAt || at === previousAt && row.response_id <= previousId) invalid();
    seen.add(row.response_id);
    previousAt = at;
    previousId = row.response_id;
  }
  if (page.next_after_at_ms !== previousAt || page.next_after_id !== previousId) invalid();
  return {
    ...input.cursor, read_at_ms: page.read_at_ms, has_more: page.has_more,
    next_after_at_ms: page.next_after_at_ms, next_after_id: page.next_after_id,
    responses: page.responses as FormResponseRow[]
  };
}
