function configureC0BridgeProbe(secret, teamId, bindingVersion, writerEpoch) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 256) {
    throw new Error("A bridge secret from 32 to 256 characters is required.");
  }
  if (typeof teamId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) {
    throw new Error("A valid bridge team ID is required.");
  }
  if (
    typeof bindingVersion !== "string" ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(bindingVersion)
  ) {
    throw new Error("A valid bridge binding version is required.");
  }
  var epoch = Number(writerEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("A non-negative bridge writer epoch is required.");
  }

  var properties = getScriptProperties_();
  var values = {};
  values[DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_SECRET] = secret;
  values[DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_TEAM_ID] = teamId;
  values[DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_BINDING_VERSION] = bindingVersion;
  values[DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_WRITER_EPOCH] = String(epoch);
  properties.setProperties(values, false);
  properties.deleteProperty(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_REPLAY_STATE);
  return {
    configured: true,
    team_id: teamId,
    binding_version: bindingVersion,
    writer_epoch: epoch
  };
}

function getC0BridgeProbeConfiguration() {
  var properties = getScriptProperties_();
  return {
    configured: Boolean(
      properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_SECRET)
    ),
    team_id:
      properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_TEAM_ID) || "",
    binding_version:
      properties.getProperty(
        DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_BINDING_VERSION
      ) || "",
    writer_epoch: Number(
      properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.BRIDGE_WRITER_EPOCH) || -1
    )
  };
}
