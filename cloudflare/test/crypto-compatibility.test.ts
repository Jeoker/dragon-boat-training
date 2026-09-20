import { describe, expect, it } from "vitest";
import {
  legacyCredentialDigest,
  legacyPayloadDigest,
  legacyRequestKey
} from "../src/crypto";

describe("legacy Apps Script digest compatibility", () => {
  const secret = "c0-fixture-secret-2026";

  it("matches the credential HMAC format", async () => {
    await expect(legacyCredentialDigest("salt-fixture-01", "pen-test-001", secret)).resolves.toBe(
      "lWnuYIYwI9McVVgkbz786B5wPEbcL_E7oCJBwtPTd5U"
    );
  });

  it("preserves JSON insertion order for old payload digests", async () => {
    const payload = {
      season_id: "season_fixture",
      practice_id: "practice_fixture",
      preference: "AMBIENT"
    };
    await expect(legacyPayloadDigest(payload, secret)).resolves.toBe(
      "WPmc6SmqDDqbuN8PVpC7eUvWbYJi4FwJHu6BrP2at78"
    );
    await expect(
      legacyPayloadDigest(
        {
          preference: "AMBIENT",
          practice_id: "practice_fixture",
          season_id: "season_fixture"
        },
        secret
      )
    ).resolves.not.toBe("WPmc6SmqDDqbuN8PVpC7eUvWbYJi4FwJHu6BrP2at78");
  });

  it("matches the old request-key construction", async () => {
    await expect(
      legacyRequestKey("coach_fixture", "signupByCoach", "request_fixture_001", secret)
    ).resolves.toBe("req_Xkzc0-7V1dhLIu-VzKV4ZvTMasmGTC6zq3TQAmtOfsE");
  });
});
