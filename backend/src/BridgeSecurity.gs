var DRAGON_BOAT_BRIDGE_PROTOCOL_ = "2026-09-19.bridge.v1";
var DRAGON_BOAT_BRIDGE_DIRECTION_ = "CLOUDFLARE_TO_GOOGLE";
var DRAGON_BOAT_BRIDGE_CLOCK_SKEW_MS_ = 5 * 60 * 1000;
var DRAGON_BOAT_BRIDGE_REPLAY_TTL_MS_ = 24 * 60 * 60 * 1000;
var DRAGON_BOAT_BRIDGE_MAX_NONCES_ = 24;
var DRAGON_BOAT_BRIDGE_MAX_RECEIPTS_ = 8;

function bridgeSha256_(value) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, "");
}

function bridgeSignatureInput_(request) {
  return [
    String(request.protocol_version),
    String(request.direction),
    String(request.team_id),
    String(request.binding_version),
    String(request.writer_epoch),
    String(request.timestamp_ms),
    String(request.nonce),
    String(request.operation_id),
    String(request.payload_digest)
  ].join("\n");
}

function bridgeReplayState_() {
  var raw = getScriptProperties_().getProperty(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_REPLAY_STATE);
  if (!raw) return { nonces: [], receipts: [] };
  try {
    var parsed = JSON.parse(raw);
    return {
      nonces: Array.isArray(parsed.nonces) ? parsed.nonces : [],
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : []
    };
  } catch (error) {
    throw dragonBoatRequestError_(
      "BRIDGE_STATE_INVALID",
      "The bridge replay state could not be read.",
      true
    );
  }
}

function pruneBridgeReplayState_(state, nowMs) {
  state.nonces = state.nonces.filter(function (entry) {
    return entry && Number(entry.expires_at_ms) > nowMs;
  }).slice(-DRAGON_BOAT_BRIDGE_MAX_NONCES_);
  state.receipts = state.receipts.filter(function (entry) {
    return entry && Number(entry.created_at_ms) + DRAGON_BOAT_BRIDGE_REPLAY_TTL_MS_ > nowMs;
  }).slice(-DRAGON_BOAT_BRIDGE_MAX_RECEIPTS_);
  return state;
}

function withBridgeScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(DRAGON_BOAT_SCRIPT_LOCK_TIMEOUT_MS_);
  } catch (error) {
    throw dragonBoatRequestError_("SERVICE_BUSY", "The bridge is busy. Retry the same operation.", true);
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function cloudflareBridgeProbe_(request) {
  var protocol = requireRequestString_(request, "protocol_version", 1, 80);
  var direction = requireRequestString_(request, "direction", 1, 80);
  var teamId = requireRequestString_(request, "team_id", 1, 128);
  var bindingVersion = requireRequestString_(request, "binding_version", 1, 128);
  var nonce = requireRequestString_(request, "nonce", 8, 160);
  var operationId = requireRequestString_(request, "operation_id", 8, 160);
  var payloadDigest = requireRequestString_(request, "payload_digest", 16, 160);
  var payloadJson = requireRequestString_(request, "payload_json", 2, 10000);
  var signature = requireRequestString_(request, "signature", 16, 160);
  var writerEpoch = Number(request.writer_epoch);
  var timestampMs = Number(request.timestamp_ms);
  if (protocol !== DRAGON_BOAT_BRIDGE_PROTOCOL_ || direction !== DRAGON_BOAT_BRIDGE_DIRECTION_) {
    throw dragonBoatRequestError_("BRIDGE_PROTOCOL_INVALID", "The bridge protocol is not supported.");
  }
  if (!Number.isSafeInteger(writerEpoch) || writerEpoch < 0 || !Number.isSafeInteger(timestampMs)) {
    throw dragonBoatRequestError_("BRIDGE_ENVELOPE_INVALID", "The bridge envelope is invalid.");
  }
  var nowMs = new Date().getTime();
  if (Math.abs(nowMs - timestampMs) > DRAGON_BOAT_BRIDGE_CLOCK_SKEW_MS_) {
    throw dragonBoatRequestError_("BRIDGE_TIMESTAMP_INVALID", "The bridge request timestamp is outside the allowed window.");
  }

  var properties = getScriptProperties_();
  var expectedTeam = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_TEAM_ID);
  var expectedBindingVersion = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_BINDING_VERSION);
  var expectedEpoch = Number(getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_WRITER_EPOCH));
  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_SECRET);
  if (
    teamId !== expectedTeam ||
    bindingVersion !== expectedBindingVersion ||
    writerEpoch !== expectedEpoch
  ) {
    throw dragonBoatRequestError_("BRIDGE_OWNERSHIP_INVALID", "The bridge request has the wrong ownership scope.");
  }
  if (bridgeSha256_(payloadJson) !== payloadDigest) {
    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "The bridge payload digest does not match.");
  }
  var expectedSignature = hmacDigest_(bridgeSignatureInput_(request), secret);
  if (!constantTimeEqual_(expectedSignature, signature)) {
    throw dragonBoatRequestError_("BRIDGE_SIGNATURE_INVALID", "The bridge signature is invalid.");
  }

  var payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (error) {
    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "The bridge payload is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "The bridge payload must be an object.");
  }

  return withBridgeScriptLock_(function () {
    var state = pruneBridgeReplayState_(bridgeReplayState_(), nowMs);
    var receipt = null;
    state.receipts.some(function (entry) {
      if (String(entry.operation_id) === operationId) {
        receipt = entry;
        return true;
      }
      return false;
    });
    if (receipt) {
      if (String(receipt.payload_digest) !== payloadDigest) {
        throw dragonBoatRequestError_(
          "BRIDGE_OPERATION_CONFLICT",
          "The bridge operation identifier was already used with different input."
        );
      }
      return JSON.parse(String(receipt.result_json));
    }

    var nonceSeen = state.nonces.some(function (entry) {
      return String(entry.nonce) === nonce;
    });
    if (nonceSeen) {
      throw dragonBoatRequestError_("BRIDGE_REPLAY", "The bridge transport nonce was already used.");
    }
    state.nonces.push({ nonce: nonce, expires_at_ms: nowMs + DRAGON_BOAT_BRIDGE_CLOCK_SKEW_MS_ });

    var result = {
      status: "verified",
      protocol_version: protocol,
      team_id: teamId,
      binding_version: bindingVersion,
      writer_epoch: writerEpoch,
      operation_id: operationId,
      payload_digest: payloadDigest,
      challenge: typeof payload.challenge === "string" ? payload.challenge : "",
      acknowledged_at: new Date(nowMs).toISOString()
    };
    state.receipts.push({
      operation_id: operationId,
      payload_digest: payloadDigest,
      result_json: JSON.stringify(result),
      created_at_ms: nowMs
    });
    pruneBridgeReplayState_(state, nowMs);
    properties.setProperty(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_REPLAY_STATE, JSON.stringify(state));
    return result;
  });
}
