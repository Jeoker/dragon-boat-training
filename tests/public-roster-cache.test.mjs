import assert from "node:assert/strict";
import test from "node:test";

import { loadRosterSnapshot, rosterCacheKey, saveRosterSnapshot } from "../frontend/lib/public-roster-cache.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

test("public roster cache keeps the server absolute expiry and version boundary", () => {
  const storage = memoryStorage();
  const snapshot = {
    season_id: "season_123",
    binding_version: 2,
    roster_version: 3,
    generated_at: "2026-09-02T12:00:00.000Z",
    expires_at: "2026-09-02T12:10:00.000Z",
    members: [{ member_id: "member_1", display_name: "Alice" }]
  };
  saveRosterSnapshot(snapshot, storage);
  assert.deepEqual(
    loadRosterSnapshot(snapshot, storage, Date.parse("2026-09-02T12:09:59.999Z")),
    snapshot
  );
  assert.equal(loadRosterSnapshot(snapshot, storage, Date.parse(snapshot.expires_at)), null);

  saveRosterSnapshot(snapshot, storage);
  assert.equal(loadRosterSnapshot({ ...snapshot, roster_version: 4 }, storage), null);
  assert.equal(storage.values.has(rosterCacheKey(snapshot)), true);
});

test("cached roster versions must be exact safe integers rather than coercible values", () => {
  const season = { season_id: "season_123", binding_version: 2, roster_version: 3 };
  const storage = memoryStorage();
  for (const value of ["3", null, 3.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const snapshot = { ...season, roster_version: value, members: [], expires_at: "2099-01-01T00:00:00Z" };
    storage.setItem(rosterCacheKey(season), JSON.stringify(snapshot));
    assert.equal(loadRosterSnapshot(season, storage), null);
    assert.equal(storage.values.has(rosterCacheKey(season)), false);
  }
});
