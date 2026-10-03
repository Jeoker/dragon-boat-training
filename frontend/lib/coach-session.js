const COACH_SESSION_STORAGE_KEY = "dragon_boat_coach_session_v1";

export function saveCoachSession(sessionToken, session, storage) {
  if (typeof sessionToken !== "string" || !sessionToken) {
    throw new TypeError("A session token is required.");
  }
  const value = {
    token: sessionToken,
    expires_at: session?.expires_at || ""
  };
  try {
    const target = storage === undefined ? globalThis.sessionStorage : storage;
    if (!target) return false;
    target.setItem(COACH_SESSION_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    // Persistence is optional; the page retains its authenticated token in memory.
    return false;
  }
}

export function loadCoachSession(storage, now = Date.now()) {
  try {
    const target = storage === undefined ? globalThis.sessionStorage : storage;
    if (!target) return null;
    const raw = target.getItem(COACH_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const expiresAt = Date.parse(value?.expires_at);
    if (typeof value?.token !== "string" || !value.token || !Number.isFinite(expiresAt) || expiresAt <= now) {
      clearCoachSession(target);
      return null;
    }
    return { token: value.token, expires_at: value.expires_at };
  } catch {
    clearCoachSession(storage);
    return null;
  }
}

export function clearCoachSession(storage) {
  try {
    const target = storage === undefined ? globalThis.sessionStorage : storage;
    if (!target) return false;
    target.removeItem(COACH_SESSION_STORAGE_KEY);
    return true;
  } catch {
    // A failed removal must not prevent clearing private UI or revoking remotely.
    return false;
  }
}

export function isCoachSessionError(error) {
  return ["SESSION_INVALID", "SESSION_EXPIRED", "SESSION_REVOKED"].includes(error?.code);
}

export { COACH_SESSION_STORAGE_KEY };
