import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createBackend, post } from "./backend-test-runtime.mjs";

const bridgeProperties = {
  DRAGON_BOAT_BRIDGE_SECRET: "test-bridge-secret",
  DRAGON_BOAT_BRIDGE_TEAM_ID: "pentasus",
  DRAGON_BOAT_BRIDGE_BINDING_VERSION: "c0",
  DRAGON_BOAT_BRIDGE_WRITER_EPOCH: "0"
};

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("base64url");
}

function sign(value) {
  return crypto.createHmac("sha256", bridgeProperties.DRAGON_BOAT_BRIDGE_SECRET)
    .update(value, "utf8")
    .digest("base64url");
}

function bridgeRequest(overrides = {}) {
  const payloadJson = overrides.payload_json || JSON.stringify({ challenge: "c0-round-trip" });
  const request = {
    action: "cloudflareBridgeProbe",
    request_id: "bridge_request_001",
    protocol_version: "2026-09-19.bridge.v1",
    direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: "pentasus",
    binding_version: "c0",
    writer_epoch: 0,
    timestamp_ms: Date.now(),
    nonce: "nonce_fixture_001",
    operation_id: "operation_fixture_001",
    payload_json: payloadJson,
    payload_digest: digest(payloadJson),
    ...overrides
  };
  request.signature = sign([
    request.protocol_version,
    request.direction,
    request.team_id,
    request.binding_version,
    request.writer_epoch,
    request.timestamp_ms,
    request.nonce,
    request.operation_id,
    request.payload_digest
  ].join("\n"));
  return request;
}

test("signed Cloudflare bridge probe verifies and replays its stored receipt", async () => {
  const { context } = await createBackend({ properties: bridgeProperties });
  const request = bridgeRequest();
  const first = post(context, request);
  const replay = post(context, request);
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "verified");
  assert.equal(first.data.challenge, "c0-round-trip");
  assert.deepEqual(replay.data, first.data);
});

test("bridge rejects tampering, stale timestamps and the wrong owner", async () => {
  const { context } = await createBackend({ properties: bridgeProperties });
  const tampered = bridgeRequest();
  tampered.signature = `${tampered.signature.slice(0, -1)}x`;
  assert.equal(post(context, tampered).error.code, "BRIDGE_SIGNATURE_INVALID");

  const stale = bridgeRequest({
    request_id: "bridge_request_002",
    nonce: "nonce_fixture_002",
    operation_id: "operation_fixture_002",
    timestamp_ms: Date.now() - 600_000
  });
  assert.equal(post(context, stale).error.code, "BRIDGE_TIMESTAMP_INVALID");

  const wrongOwner = bridgeRequest({
    request_id: "bridge_request_003",
    nonce: "nonce_fixture_003",
    operation_id: "operation_fixture_003",
    team_id: "another-team"
  });
  assert.equal(post(context, wrongOwner).error.code, "BRIDGE_OWNERSHIP_INVALID");

  const wrongBinding = bridgeRequest({
    request_id: "bridge_request_006",
    nonce: "nonce_fixture_006",
    operation_id: "operation_fixture_006",
    binding_version: "another-binding"
  });
  assert.equal(post(context, wrongBinding).error.code, "BRIDGE_OWNERSHIP_INVALID");
});

test("bridge separates operation idempotency from transport nonce replay", async () => {
  const { context } = await createBackend({ properties: bridgeProperties });
  const first = bridgeRequest();
  assert.equal(post(context, first).ok, true);

  const conflictPayload = JSON.stringify({ challenge: "different" });
  const conflict = bridgeRequest({
    request_id: "bridge_request_004",
    nonce: "nonce_fixture_004",
    operation_id: first.operation_id,
    payload_json: conflictPayload,
    payload_digest: digest(conflictPayload)
  });
  assert.equal(post(context, conflict).error.code, "BRIDGE_OPERATION_CONFLICT");

  const replayedNonce = bridgeRequest({
    request_id: "bridge_request_005",
    nonce: first.nonce,
    operation_id: "operation_fixture_005"
  });
  assert.equal(post(context, replayedNonce).error.code, "BRIDGE_REPLAY");
});
