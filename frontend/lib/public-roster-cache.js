import { usableRoster } from "./current-view.js";

export const DRAGON_BOAT_ROSTER_CACHE_PREFIX = "dragon_boat_public_roster_v1";

export function rosterCacheKey(season) {
  return [
    DRAGON_BOAT_ROSTER_CACHE_PREFIX,
    season.season_id,
    Number(season.binding_version || 0),
    Number(season.roster_version || 0)
  ].join(":");
}

export function loadRosterSnapshot(season, storage = globalThis.localStorage, now = Date.now()) {
  if (!storage || !season?.season_id) return null;
  const key = rosterCacheKey(season);
  let snapshot;
  try {
    snapshot = JSON.parse(storage.getItem(key) || "null");
  } catch {
    storage.removeItem(key);
    return null;
  }
  if (!usableRoster(snapshot, season, now)) {
    storage.removeItem(key);
    return null;
  }
  return snapshot;
}

export function saveRosterSnapshot(snapshot, storage = globalThis.localStorage) {
  if (!storage || !snapshot?.season_id || !Array.isArray(snapshot.members)) return;
  storage.setItem(rosterCacheKey(snapshot), JSON.stringify(snapshot));
}
