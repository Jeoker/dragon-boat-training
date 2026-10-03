import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const base = process.env.C2_TEST_URL?.trim();
const c1Key = process.env.C1_TEST_KEY?.trim();
const c2Key = process.env.C2_TEST_KEY?.trim();
if (!base || !c1Key || !c2Key) throw new Error("The ignored C2 acceptance environment is incomplete.");
const url = new URL(base);
if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== "/") {
  throw new Error("This acceptance test only uses the isolated c2test Worker.");
}
const phase = process.argv[2];
if (!["seed", "before", "resolve"].includes(phase)) throw new Error("Use seed, before or resolve.");
if (phase !== "before" && !process.argv.includes("--write-test-data")) {
  throw new Error("Mutating acceptance phases require --write-test-data.");
}
const privateFile = fileURLToPath(new URL("../../.c2-form-test/review-private.json", import.meta.url));
const secretsFile = fileURLToPath(new URL("../../.c2-form-test/worker-secrets.json", import.meta.url));
const privateData = existsSync(privateFile) ? JSON.parse(readFileSync(privateFile, "utf8")) : null;
const seasonId = "season_c2_isolated_2026";
const coachId = "coach_c2_isolated_2026";
const memberId = "member_c2_legacy_theta_001";
const memberName = "C2 Test Member Theta";

async function api(path, key, body) {
  const response = await fetch(new URL(path, url), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const value = await response.json();
  assert.equal(value.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(value.meta?.writer_epoch, 0);
  return { status: response.status, value };
}

async function roster() {
  const response = await fetch(new URL(
    `/internal/c1/public-roster?request_id=c2_review_roster_${Date.now()}&season_id=${seasonId}`, url),
  { headers: { authorization: `Bearer ${c1Key}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  return body.data;
}

async function login() {
  assert.ok(privateData?.coach_code, "The private test Coach code is missing; run seed first.");
  const response = await api("/internal/c1/coach-login", c1Key, {
    request_id: `c2_review_login_${Date.now()}`, coach_code: privateData.coach_code
  });
  assert.equal(response.status, 200);
  assert.equal(response.value.ok, true);
  return response.value.data.result.session_token;
}

async function listReviews(token, cursor = null) {
  const response = await api("/internal/c2/list-form-reviews", c2Key, {
    request_id: `c2_review_list_${Date.now()}`, session_token: token, season_id: seasonId,
    limit: 1, cursor
  });
  assert.equal(response.status, 200);
  return response.value.data;
}

if (phase === "seed") {
  const current = await roster();
  if (current.members.some((member) => member.member_id === memberId)) {
    assert.ok(privateData?.coach_code, "A seeded member requires the existing private Coach code.");
    console.log(JSON.stringify({ phase, already_seeded: true, roster_count: current.members.length }));
  } else {
    assert.equal(current.members.length, 7);
    const coachCode = privateData?.coach_code ?? randomBytes(18).toString("base64url");
    const salt = "c2_review_salt_2026";
    const secret = JSON.parse(readFileSync(secretsFile, "utf8")).COACH_CODE_SECRET;
    assert.ok(typeof secret === "string" && secret.length > 20);
    const digest = createHmac("sha256", secret).update(`${salt}\n${coachCode}`).digest("base64url");
    if (!privateData) writeFileSync(privateFile, JSON.stringify({ coach_code: coachCode }), { flag: "wx" });
    const now = new Date().toISOString();
    const response = await api("/internal/c1/import-core", c1Key, {
      request_id: "c2_review_core_001", source_snapshot_id: "c2_review_core_snapshot_001",
      settings_version: 1, default_season_id: seasonId,
      coaches: [{ coach_id: coachId, display_name: "C2 Isolated Coach", code_salt: salt,
        code_digest: digest, credential_version: 2, active: true,
        created_at: "2026-09-25T12:00:00.000Z", updated_at: now }],
      seasons: [{ season_id: seasonId, name: "C2 Isolated Test 2026",
        start_date: "2026-09-01", end_date: "2026-12-31", timezone: "America/New_York",
        season_ends_at: "2027-01-01T05:00:00.000Z", status: "OPEN", binding_version: 1,
        season_version: current.season.season_version + 1,
        roster_version: current.season.roster_version + 1,
        created_by: coachId, created_at: "2026-09-25T12:00:00.000Z", updated_at: now }],
      members: [{ season_id: seasonId, member_id: memberId, source_key: "legacy-test:theta",
        source_display_name: memberName, display_name_override: "", status: "ACTIVE",
        default_preference: "AMBIENT", member_version: 1, created_at: now, updated_at: now }]
    });
    assert.equal(response.status, 200);
    const next = await roster();
    assert.equal(next.members.length, 8);
    assert.ok(next.members.some((member) => member.member_id === memberId));
    console.log(JSON.stringify({ phase, roster_count: next.members.length, coach_ready: true }));
  }
} else {
  const current = await roster();
  assert.equal(current.members.length, 8);
  const token = await login();
  const list = await listReviews(token);
  if (phase === "before") {
    assert.deepEqual(list.items, []);
    assert.equal(list.next_cursor, null);
    console.log(JSON.stringify({ phase, roster_count: 8, review_count: 0 }));
  } else {
    assert.equal(list.items.length, 1);
    const review = list.items[0];
    assert.equal(review.display_name, memberName);
    assert.equal(review.review_reason, "LEGACY_NAME_MATCH");
    assert.equal(review.source_version, 1);
    assert.equal(list.next_cursor, null);
    const resolution = await api("/internal/c2/resolve-form-source", c2Key, {
      request_id: "c2_review_resolve_001", session_token: token, season_id: seasonId,
      response_id: review.response_id, member_id: memberId, source_version: review.source_version
    });
    assert.equal(resolution.status, 200);
    assert.equal(resolution.value.data.result.member_id, memberId);
    assert.deepEqual((await listReviews(token)).items, []);
    const after = await roster();
    assert.equal(after.members.length, 8);
    assert.ok(after.members.some((member) => member.member_id === memberId));
    console.log(JSON.stringify({ phase, reviewed: 1, resolved: 1, roster_count: 8,
      preserved_member_id: true }));
  }
  const logout = await api("/internal/c1/coach-logout", c1Key, {
    request_id: `c2_review_logout_${Date.now()}`, session_token: token
  });
  assert.equal(logout.status, 200);
}
