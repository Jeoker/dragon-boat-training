import assert from "node:assert/strict";
import test from "node:test";

import {
  COACH_SESSION_STORAGE_KEY,
  clearCoachSession,
  isCoachSessionError,
  loadCoachSession,
  saveCoachSession
} from "../frontend/lib/coach-session.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

test("Coach sessions use session storage and expire locally", () => {
  const storage = memoryStorage();
  saveCoachSession("signed-token", { expires_at: "2026-08-31T12:00:00.000Z" }, storage);
  assert.equal(storage.values.has(COACH_SESSION_STORAGE_KEY), true);
  assert.deepEqual(
    loadCoachSession(storage, Date.parse("2026-08-31T11:00:00.000Z")),
    { token: "signed-token", expires_at: "2026-08-31T12:00:00.000Z" }
  );
  assert.equal(loadCoachSession(storage, Date.parse("2026-08-31T12:00:00.000Z")), null);
  assert.equal(storage.values.has(COACH_SESSION_STORAGE_KEY), false);
});

test("malformed sessions are removed and logout clears protected state", () => {
  const storage = memoryStorage();
  storage.setItem(COACH_SESSION_STORAGE_KEY, "{");
  assert.equal(loadCoachSession(storage), null);
  saveCoachSession("signed-token", { expires_at: "2099-01-01T00:00:00.000Z" }, storage);
  clearCoachSession(storage);
  assert.equal(storage.values.size, 0);
});

test("session error classification excludes ordinary request failures", () => {
  assert.equal(isCoachSessionError({ code: "SESSION_EXPIRED" }), true);
  assert.equal(isCoachSessionError({ code: "SESSION_REVOKED" }), true);
  assert.equal(isCoachSessionError({ code: "NETWORK_ERROR" }), false);
});

test("unavailable session storage never interrupts login, restore, or logout", () => {
  const denied = () => { throw new Error("Storage access denied"); };
  const storage = { getItem: denied, setItem: denied, removeItem: denied };
  assert.equal(saveCoachSession("signed-token", { expires_at: "2099-01-01T00:00:00Z" }, storage), false);
  assert.equal(loadCoachSession(storage), null);
  assert.equal(clearCoachSession(storage), false);
});

test("session storage getter failures are handled inside the storage boundary", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("Blocked storage getter"); } });
  try {
    assert.equal(saveCoachSession("signed-token", { expires_at: "2099-01-01T00:00:00Z" }), false);
    assert.equal(loadCoachSession(), null);
    assert.equal(clearCoachSession(), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  }
});

test("invalid cached sessions remain unusable when removing them fails", () => {
  const storage = { getItem: () => '{"token":"old","expires_at":"2000-01-01T00:00:00Z"}', removeItem() { throw new Error("Read-only storage"); } };
  assert.equal(loadCoachSession(storage), null);
});
