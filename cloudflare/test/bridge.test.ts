import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { bridgeSignatureInput, callGoogleBridgeProbe, createBridgeEnvelope } from "../src/bridge";
import { hmacSha256Base64Url, sha256Base64Url } from "../src/crypto";

describe("Cloudflare to Apps Script bridge envelope", () => {
  afterEach(() => vi.restoreAllMocks());

  const probeEnv = () => ({ ...env, GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/fixture/exec", GOOGLE_BRIDGE_SECRET: "fixture-secret" });
  function mockReceipt(transform: (value: Record<string, any>) => unknown, status = 200) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json(transform({ ok: true, meta: { request_id: request.request_id }, data: {
        status: "verified", protocol_version: request.protocol_version, team_id: request.team_id,
        binding_version: request.binding_version, writer_epoch: request.writer_epoch,
        operation_id: request.operation_id, payload_digest: request.payload_digest,
        challenge: JSON.parse(request.payload_json).challenge, acknowledged_at: "2026-09-19T12:00:00.000Z"
      } }), { status });
    });
  }

  it("accepts only a complete receipt belonging to this operation and binding", async () => {
    mockReceipt(value => value);
    await expect(callGoogleBridgeProbe(probeEnv(), "probe_request_01", "round-trip")).resolves.toMatchObject({ status: "verified", challenge: "round-trip" });
    for (const patch of [
      { status: "pending" }, { protocol_version: "other" }, { binding_version: "other" },
      { writer_epoch: "0" }, { operation_id: "another_operation" }, { team_id: "other" },
      { payload_digest: "wrong" }, { challenge: "wrong" }, { acknowledged_at: "invalid" }
    ]) {
      mockReceipt(value => ({ ...value, data: { ...value.data, ...patch } }));
      await expect(callGoogleBridgeProbe(probeEnv(), "probe_request_01", "round-trip")).rejects.toMatchObject({ code: "BRIDGE_INVALID_RESPONSE", retryable: true });
    }
    for (const value of [null, [], { ok: true }, { ok: false, error: { code: "wrong" } }]) {
      mockReceipt(() => value);
      await expect(callGoogleBridgeProbe(probeEnv(), "probe_request_01", "round-trip")).rejects.toMatchObject({ code: "BRIDGE_INVALID_RESPONSE", retryable: true });
    }
    mockReceipt(value => value, 503);
    await expect(callGoogleBridgeProbe(probeEnv(), "probe_request_01", "round-trip")).rejects.toMatchObject({ code: "BRIDGE_INVALID_RESPONSE", retryable: true });
  });

  it("keeps transport failures uncertain and preserves validated Google rejections", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ json: async () => { throw new Error("body read interrupted"); } } as unknown as Response);
    await expect(callGoogleBridgeProbe(probeEnv(), "probe_request_01", "test")).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE", retryable: true });
    mockReceipt(value => ({ ok: false, meta: value.meta, error: { code: "BRIDGE_OWNERSHIP_INVALID", message: "Wrong binding.", retryable: false } }));
    await expect(callGoogleBridgeProbe(probeEnv(), "probe_request_01", "test")).rejects.toMatchObject({ code: "BRIDGE_OWNERSHIP_INVALID", retryable: false });
  });

  it("binds ownership, time, nonce, operation and payload to one signature", async () => {
    const envelope = await createBridgeEnvelope({
      requestId: "bridge_request_001",
      teamId: "pentasus",
      writerEpoch: 0,
      operationId: "c0_probe_bridge_request_001",
      payload: { challenge: "round-trip" },
      secret: "fixture-secret",
      timestampMs: 1_800_000_000_000,
      nonce: "nonce_fixture_001"
    });
    expect(envelope.payload_digest).toBe(await sha256Base64Url(envelope.payload_json));
    expect(envelope.signature).toBe(
      await hmacSha256Base64Url(bridgeSignatureInput(envelope), "fixture-secret")
    );

    const changed = { ...envelope, writer_epoch: 1 };
    expect(await hmacSha256Base64Url(bridgeSignatureInput(changed), "fixture-secret")).not.toBe(
      envelope.signature
    );
  });
});
