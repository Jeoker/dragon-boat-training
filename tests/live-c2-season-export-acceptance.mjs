// Explicit one-time acceptance against the disposable C2 Form, Worker and Google Sheet.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--write-test-data")) throw new Error("Explicit --write-test-data is required.");
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
assert.ok(["conflict", "recover"].includes(phase), "Pass --phase=conflict or --phase=recover.");
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key, "The isolated acceptance keys are missing.");
const privateFile = fileURLToPath(new URL("../../.c2-form-test/review-private.json", import.meta.url));
const { coach_code: coachCode } = JSON.parse(readFileSync(privateFile, "utf8"));
assert.ok(coachCode, "The isolated Coach Code is missing.");
const seasonId = "season_c2_isolated_2026";
const requestId = (label) => `c2_season_${label}_${randomUUID().replaceAll("-", "")}`;
const seasonRequest = { request_id: "c2_season_conflict_retry_20260927", season_id: seasonId };

async function apiResult(path, key, payload) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  return { status: response.status, body };
}
async function api(path, key, payload) {
  const { status, body } = await apiResult(path, key, payload);
  if (status >= 400 || !body.ok) throw new Error(`${path}: HTTP ${status}, ${body.error?.code}`);
  return body.data;
}

async function roster() {
  const response = await fetch(new URL(
    `/internal/c1/public-roster?request_id=${requestId("roster")}&season_id=${seasonId}`, base),
  { headers: { authorization: `Bearer ${c1Key}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return body.data;
}
const rosterDigest = (members) => createHash("sha256").update(JSON.stringify(members)).digest("base64url");

const health = await (await fetch(new URL("/health", base))).json();
assert.equal(health.meta?.service_version, "0.12.0-c2-season-export");
assert.equal(health.meta?.writer_epoch, 0);
const beforeRoster = await roster();
assert.equal(beforeRoster.members.length, 10);
assert.equal(beforeRoster.season.roster_version, 10);
const newMember = beforeRoster.members.find((row) => row.display_name === "C2 Test Member Kappa");
assert.ok(newMember);
const beforeDigest = rosterDigest(beforeRoster.members);
const login = await api("/internal/c1/coach-login", c1Key,
  { request_id: requestId("login"), coach_code: coachCode });
const token = login.result.session_token;
let memberResult;
let seasonResult;
try {
  const inspect = (entity_type) => api("/internal/c2/check-sheet-differences", c2Key, {
    request_id: requestId("inspect"), session_token: token, season_id: seasonId, entity_type
  });
  const beforeSeason = await inspect("SEASON");
  const beforeMembers = await inspect("MEMBER");
  assert.equal(beforeSeason.status, "OK");
  assert.equal(beforeSeason.rows_read, 1);
  assert.equal(beforeSeason.findings_count, phase === "conflict" ? 1 : 0);
  if (phase === "conflict") {
    assert.equal(beforeSeason.findings[0].dependency_group, "SEASON_IDENTITY");
    assert.equal(beforeSeason.findings[0].outcome, "REVIEW_REQUIRED");
  }
  assert.equal(beforeMembers.status, "OK");
  if (phase === "conflict") {
    assert.equal(beforeMembers.rows_read, 9);
    assert.equal(beforeMembers.findings_count, 1);
    assert.equal(beforeMembers.findings[0].entity_id, newMember.member_id);
    assert.equal(beforeMembers.findings[0].outcome, "EXPORT");
    const memberRequest = { request_id: requestId("member"), season_id: seasonId };
    memberResult = await api("/internal/c2/export-next-member", c2Key, memberRequest);
    if (memberResult.status === "IDLE") throw new Error("The ten-minute outbox due time has not arrived.");
    assert.equal(memberResult.status, "BATCH_CONFIRMED");
    assert.equal(memberResult.member_id, newMember.member_id);
    assert.deepEqual(await api("/internal/c2/export-next-member", c2Key, memberRequest), memberResult);
    const afterMember = await inspect("MEMBER");
    assert.equal(afterMember.rows_read, 10);
    assert.equal(afterMember.findings_count, 0);
    const blocked = await apiResult("/internal/c2/export-next-member", c2Key, seasonRequest);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error?.code, "SYNC_SEASON_NEEDS_REVIEW");
    assert.equal((await inspect("SEASON")).findings_count, 1);
  } else {
    assert.equal(beforeMembers.rows_read, 10);
    assert.equal(beforeMembers.findings_count, 0);
    seasonResult = await api("/internal/c2/export-next-member", c2Key, seasonRequest);
    assert.equal(seasonResult.status, "EVENT_CONFIRMED");
    assert.equal(seasonResult.roster_version, 10);
    assert.deepEqual(await api("/internal/c2/export-next-member", c2Key, seasonRequest), seasonResult);
  }
  const afterSeason = await inspect("SEASON");
  assert.equal(afterSeason.rows_read, 1);
  assert.equal(afterSeason.findings_count, phase === "conflict" ? 1 : 0);
  const overview = await api("/internal/c2/get-sync-overview", c2Key, {
    request_id: requestId("overview"), session_token: token, season_id: seasonId
  });
  assert.equal(overview.counts.pending_outbox, phase === "conflict" ? 1 : 0);
  assert.equal(overview.counts.pending_batches, 0);
} finally {
  await api("/internal/c1/coach-logout", c1Key,
    { request_id: requestId("logout"), session_token: token });
}
const afterRoster = await roster();
assert.equal(rosterDigest(afterRoster.members), beforeDigest);
console.log(JSON.stringify({ status: "passed", phase, member_batch: memberResult?.batch_id,
  season_batch: seasonResult?.batch_id, roster_version: seasonResult?.roster_version,
  member_rows: 10, roster_unchanged: true, coach_logged_out: true }));
