import { describe, expect, it } from "vitest";
import { bridgeSignatureInput, createBridgeEnvelope } from "../src/bridge";
import { hmacSha256Base64Url, sha256Base64Url } from "../src/crypto";

describe("Cloudflare to Apps Script bridge envelope", () => {
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
