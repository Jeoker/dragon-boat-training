import { constantTimeEqual, hmacSha256Base64Url, sha256Base64Url } from "./crypto";
import { ApiError } from "./http";

export const FORM_NOTIFY_PROTOCOL = "2026-09-25.form-notify.v1";
export const FORM_NOTIFY_PATH = "/internal/c2/form-submit-notification";

interface FormNotification {
  protocol_version: string;
  team_id: string;
  writer_epoch: number;
  season_id: string;
  binding_version: number;
  form_id: string;
  response_id: string;
  timestamp_ms: number;
  nonce: string;
  signature: string;
}

export function notificationSignatureInput(value: Omit<FormNotification, "signature">): string {
  return [value.protocol_version, value.team_id, value.writer_epoch, value.season_id,
    value.binding_version, value.form_id, value.response_id, value.timestamp_ms, value.nonce].join("\n");
}

export async function verifyFormNotification(raw: Record<string, unknown>, env: Env): Promise<{
  request_id: string;
  season_id: string;
  binding_version: number;
  form_id: string;
  response_id: string;
}> {
  if (env.ENVIRONMENT === "production" || !env.GOOGLE_BRIDGE_SECRET) {
    throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
  }
  const value = raw as unknown as FormNotification;
  if (value.protocol_version !== FORM_NOTIFY_PROTOCOL || value.team_id !== env.TEAM_ID ||
      value.writer_epoch !== Number(env.WRITER_EPOCH) ||
      typeof value.season_id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.season_id) ||
      typeof value.binding_version !== "number" || !Number.isSafeInteger(value.binding_version) || value.binding_version < 1 ||
      typeof value.form_id !== "string" || !/^[A-Za-z0-9_-]{8,256}$/u.test(value.form_id) ||
      typeof value.response_id !== "string" || !/^[A-Za-z0-9_-]{8,256}$/u.test(value.response_id) ||
      typeof value.timestamp_ms !== "number" || !Number.isSafeInteger(value.timestamp_ms) ||
      Math.abs(Date.now() - value.timestamp_ms) > 5 * 60 * 1000 ||
      typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.nonce) ||
      typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{40,64}$/u.test(value.signature)) {
    throw new ApiError("FORM_NOTIFICATION_INVALID", "The Form notification is invalid.", 403);
  }
  const expected = await hmacSha256Base64Url(notificationSignatureInput(value), env.GOOGLE_BRIDGE_SECRET);
  if (!constantTimeEqual(expected, value.signature)) {
    throw new ApiError("FORM_NOTIFICATION_INVALID", "The Form notification is invalid.", 403);
  }
  const requestId = `c2_notice_${(await sha256Base64Url(notificationSignatureInput(value))).slice(0, 40)}`;
  return { request_id: requestId, season_id: value.season_id, binding_version: value.binding_version,
    form_id: value.form_id, response_id: value.response_id };
}
