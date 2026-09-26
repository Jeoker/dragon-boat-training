import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { FORM_NOTIFY_PATH, FORM_NOTIFY_PROTOCOL, notificationSignatureInput,
  verifyFormNotification } from "../src/c2-form-notify";
import { hmacSha256Base64Url } from "../src/crypto";

const testEnv = () => ({ ...env, TEAM_ID: "c2-notify-fixture" } as unknown as Env);

async function signedNotification(patch: Record<string, unknown> = {}) {
  const value = {
    protocol_version: FORM_NOTIFY_PROTOCOL, team_id: "c2-notify-fixture", writer_epoch: 0,
    season_id: "season_c2_notify_2026", binding_version: 1,
    form_id: "form_c2_notify_fixture", response_id: "response_c2_notify_fixture",
    timestamp_ms: Date.now(), nonce: "nonce_fixture_001", ...patch
  };
  return { ...value, signature: await hmacSha256Base64Url(
    notificationSignatureInput(value), "local-test-bridge-secret") };
}

describe("signed Google Form submit notification", () => {
  it("accepts only a fresh, scoped signature", async () => {
    const value = await signedNotification();
    await expect(verifyFormNotification(value, testEnv())).resolves.toMatchObject({
      season_id: value.season_id, form_id: value.form_id, response_id: value.response_id
    });
    for (const altered of [
      { ...value, form_id: "other_form_fixture" },
      { ...value, response_id: "other_response_fixture" },
      { ...value, team_id: "wrong-team" },
      { ...value, writer_epoch: 1 },
      { ...value, timestamp_ms: value.timestamp_ms - 6 * 60 * 1000 }
    ]) {
      await expect(verifyFormNotification(altered, testEnv())).rejects.toMatchObject({
        code: "FORM_NOTIFICATION_INVALID"
      });
    }
    await expect(verifyFormNotification(value, { ...testEnv(), ENVIRONMENT: "production" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unsigned public requests and checks the binding after authentication", async () => {
    const unsigned = await worker.fetch(new Request(`https://example.test${FORM_NOTIFY_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ season_id: "season_c2_notify_2026" })
    }), testEnv());
    expect(unsigned.status).toBe(403);

    const signed = await worker.fetch(new Request(`https://example.test${FORM_NOTIFY_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(await signedNotification())
    }), testEnv());
    expect(signed.status).toBe(409);
    expect((await signed.json() as any).error.code).toBe("SYNC_BINDING_NOT_FOUND");
  });
});
