import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = "dragon-boat-training-api-staging.dragon-boat-training.workers.dev";
const base = process.env.C1_STAGING_URL?.trim() || `https://${host}`;
const url = new URL(base);
if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== "/") {
  throw new Error("This acceptance script only reads the original isolated staging Worker.");
}
const c0Key = process.env.C0_TEST_KEY?.trim();
const c1Key = process.env.C1_TEST_KEY?.trim();
if (!c0Key || !c1Key) throw new Error("The ignored staging test keys are required.");
const phase = process.argv[2];
if (!["before", "after"].includes(phase)) throw new Error("Use before or after.");
const baselineFile = fileURLToPath(new URL("../cloudflare/.acceptance-artifacts/c2-staging-upgrade-baseline.json",
  import.meta.url));

async function get(path, key) {
  const response = await fetch(new URL(path, url), { headers: { authorization: `Bearer ${key}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-staging");
  assert.equal(body.meta?.writer_epoch, 0);
  return body;
}
const health = await get(`/health?request_id=c2_upgrade_health_${phase}`, c0Key);
const state = await get(`/internal/c0/state?request_id=c2_upgrade_state_${phase}`, c0Key);
const roster = await get(`/internal/c1/public-roster?request_id=c2_upgrade_roster_${phase}` +
  "&season_id=season_c16_active_2035", c1Key);
const members = roster.data.members;
assert.equal(members.length, 123);
const digest = createHash("sha256").update(JSON.stringify(members.map((member) =>
  [member.member_id, member.display_name, member.member_version]).sort((a, b) => a[0].localeCompare(b[0]))))
  .digest("base64url");
const snapshot = { counter_value: state.data.counter_value, roster_count: members.length,
  roster_digest: digest, season_version: roster.data.season.season_version,
  roster_version: roster.data.season.roster_version };
if (phase === "before") {
  assert.equal(health.meta.service_version, "0.7.0-c1-acceptance");
  assert.equal(state.data.schema_version, 6);
  writeFileSync(baselineFile, JSON.stringify(snapshot), { flag: "wx" });
} else {
  assert.equal(health.meta.service_version, "0.9.0-c2-form-import");
  assert.equal(state.data.schema_version, 8);
  assert.deepEqual(snapshot, JSON.parse(readFileSync(baselineFile, "utf8")));
  assert.ok(state.data.outbox.filter((item) => item.status === "PENDING").length >= 2);
  const denied = await fetch(new URL("/internal/c2/get-sync-overview", url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: "c2_staging_gate_001", season_id: "season_c16_active_2035" })
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error?.code, "C2_ACCESS_DENIED");
  const coachCode = process.env.C1_ACCEPTANCE_COACH_CODE?.trim();
  assert.ok(coachCode);
  async function coachAction(path, body) {
    const response = await fetch(new URL(path, url), {
      method: "POST", headers: { authorization: `Bearer ${c1Key}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.ok, true);
    return value.data;
  }
  const nonce = Date.now();
  const login = await coachAction("/internal/c1/coach-login", {
    request_id: `c2_upgrade_login_${nonce}`, coach_code: coachCode
  });
  const token = login.result.session_token;
  const bootstrap = await coachAction("/internal/c1/coach-bootstrap", {
    request_id: `c2_upgrade_bootstrap_${nonce}`, session_token: token
  });
  assert.equal(bootstrap.default_season_id, "season_c16_active_2035");
  const logout = await coachAction("/internal/c1/coach-logout", {
    request_id: `c2_upgrade_logout_${nonce}`, session_token: token
  });
  assert.equal(logout.result.logged_out, true);
}
console.log(JSON.stringify({ phase, service_version: health.meta.service_version,
  schema_version: state.data.schema_version, roster_count: snapshot.roster_count,
  prior_data_preserved: phase === "after" ? true : null }));
