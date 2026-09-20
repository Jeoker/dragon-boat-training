const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hmacSha256Base64Url(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export function legacyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export async function legacyCredentialDigest(
  salt: string,
  coachCode: string,
  codeSecret: string
): Promise<string> {
  return hmacSha256Base64Url(`${salt}\n${coachCode}`, codeSecret);
}

export async function legacyPayloadDigest(payload: unknown, codeSecret: string): Promise<string> {
  return hmacSha256Base64Url(legacyJson(payload), codeSecret);
}

export async function legacyRequestKey(
  actorId: string,
  action: string,
  requestId: string,
  codeSecret: string
): Promise<string> {
  return `req_${await hmacSha256Base64Url(`${actorId}\n${action}\n${requestId}`, codeSecret)}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index % left.length) || 0) ^
      (right.charCodeAt(index % right.length) || 0);
  }
  return mismatch === 0;
}
