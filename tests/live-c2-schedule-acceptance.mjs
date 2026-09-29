// Explicit, resumable writes to the disposable C2 Worker and bound Google test file only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

if (!process.argv.includes("--write-test-data")) throw new Error("Explicit --write-test-data is required.");
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
assert.ok(["seed-template", "export-template", "prepare-week", "export-week"].includes(phase),
  "Choose one explicit isolated schedule acceptance phase.");
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key, "The isolated acceptance keys are required.");
const { coach_code: coachCode } = JSON.parse(readFileSync(
  new URL("../../.c2-form-test/review-private.json", import.meta.url), "utf8"));
assert.ok(coachCode, "The isolated Coach credential is required.");
const seasonId = "season_c2_isolated_2026";
const requestId = (label) => `c2_schedule_${label}_${randomUUID().replaceAll("-", "")}`;
const fixedId = (label) => `c2_schedule_accept_20260929_${label}`;

async function api(path, key, payload) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  if (!response.ok || !body.ok) throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  return body.data;
}

async function roster() {
  const response = await fetch(new URL(
    `/internal/c1/public-roster?request_id=${requestId("roster")}&season_id=${seasonId}`, base),
  { headers: { authorization: `Bearer ${c1Key}` }, signal: AbortSignal.timeout(20_000) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  return body.data;
}
async function publicSchedule() {
  const response = await fetch(new URL(
    `/internal/c1/public-schedule?request_id=${requestId("public")}&season_id=${seasonId}`, base),
  { headers: { authorization: `Bearer ${c1Key}` }, signal: AbortSignal.timeout(20_000) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return body.data;
}
const memberDigest = (members) => createHash("sha256").update(JSON.stringify(members)).digest("base64url");

const health = await (await fetch(new URL("/health", base), { signal: AbortSignal.timeout(20_000) })).json();
assert.equal(health.meta?.service_version, "0.14.0-c2-operations");
assert.equal(health.meta?.writer_epoch, 0);
const before = await roster();
assert.equal(before.members.length, 10);
const beforeDigest = memberDigest(before.members);
const login = await api("/internal/c1/coach-login", c1Key,
  { request_id: requestId("login"), coach_code: coachCode });
const token = login.result.session_token;
let outcome;
try {
  const overview = await api("/internal/c2/get-sync-overview", c2Key,
    { request_id: requestId("overview"), session_token: token, season_id: seasonId });
  assert.equal(overview.schema_version, 11);
  assert.equal(overview.binding_current, true);
  assert.equal(overview.counts.open_conflicts, 0);
  if (!phase.startsWith("export-")) assert.equal(overview.counts.pending_batches, 0);
  if (phase === "seed-template") {
    assert.equal(before.season.season_version, 2);
    assert.equal(overview.counts.pending_outbox, 0);
    const result = await api("/internal/c1/update-schedule-templates", c1Key, {
      request_id: fixedId("seed_template"), session_token: token,
      season_id: seasonId, season_version: 2,
      templates: [{ day_of_week: 3, start_time: "18:00", end_time: "20:00",
        location: "C2 Isolated Test Dock", address: "Test River Road", map_url: "" }]
    });
    assert.equal(result.result.season_version, 3);
    assert.equal(result.result.templates.length, 1);
    outcome = { phase, season_version: 3, template_id: result.result.templates[0].template_id };
  } else if (phase === "export-template") {
    assert.equal(before.season.season_version, 3);
    assert.equal(overview.counts.pending_outbox, 1);
    const firstPayload = { request_id: fixedId("export_template_row"), season_id: seasonId };
    const first = await api("/internal/c2/export-next-schedule", c2Key, firstPayload);
    assert.equal(first.status, "BATCH_CONFIRMED");
    assert.equal(first.entity_type, "SCHEDULE_TEMPLATE");
    assert.deepEqual(await api("/internal/c2/export-next-schedule", c2Key, firstPayload), first);
    const finalPayload = { request_id: fixedId("export_template_season"), season_id: seasonId };
    const final = await api("/internal/c2/export-next-schedule", c2Key, finalPayload);
    assert.equal(final.status, "EVENT_CONFIRMED");
    assert.equal(final.season_version, 3);
    assert.deepEqual(await api("/internal/c2/export-next-schedule", c2Key, finalPayload), final);
    outcome = { phase, template_batch: first.batch_id, season_batch: final.batch_id };
  } else if (phase === "prepare-week") {
    assert.equal(before.season.season_version, 3);
    assert.equal(overview.counts.pending_outbox, 0);
    const result = await api("/internal/c1/prepare-training-week", c1Key, {
      request_id: fixedId("prepare_week"), session_token: token, season_id: seasonId,
      season_version: 3, week_start_date: "2026-10-05"
    });
    assert.equal(result.result.created, true);
    assert.equal(result.result.practices.length, 1);
    outcome = { phase, week_id: result.result.week.week_id,
      practice_id: result.result.practices[0].practice_id };
  } else {
    assert.equal(before.season.season_version, 3);
    assert.equal(overview.counts.pending_outbox, 1);
    const expected = ["TRAINING_WEEK", "PRACTICE"];
    const batches = [];
    for (let index = 0; index < expected.length; index += 1) {
      const payload = { request_id: fixedId(`export_week_row_${index + 1}`), season_id: seasonId };
      const result = await api("/internal/c2/export-next-schedule", c2Key, payload);
      assert.equal(result.status, "BATCH_CONFIRMED");
      assert.equal(result.entity_type, expected[index]);
      assert.deepEqual(await api("/internal/c2/export-next-schedule", c2Key, payload), result);
      batches.push(result.batch_id);
    }
    const payload = { request_id: fixedId("export_week_season"), season_id: seasonId };
    const final = await api("/internal/c2/export-next-schedule", c2Key, payload);
    assert.equal(final.status, "EVENT_CONFIRMED");
    assert.equal(final.season_version, 3);
    assert.deepEqual(await api("/internal/c2/export-next-schedule", c2Key, payload), final);
    outcome = { phase, row_batches: batches, season_batch: final.batch_id };
  }
  const after = await api("/internal/c2/get-sync-overview", c2Key,
    { request_id: requestId("after"), session_token: token, season_id: seasonId });
  assert.equal(after.counts.pending_batches, 0);
  assert.equal(after.counts.pending_outbox, phase.startsWith("export-") ? 0 : 1);
  if (phase.startsWith("export-")) {
    const scopes = phase === "export-template" ? ["SEASON", "SCHEDULE_TEMPLATE"] :
      ["SEASON", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE"];
    for (const entity_type of scopes) {
      const inspected = await api("/internal/c2/check-sheet-differences", c2Key,
        { request_id: requestId("inspect"), session_token: token, season_id: seasonId, entity_type });
      assert.equal(inspected.status, "OK");
      assert.equal(inspected.findings_count, 0);
    }
    outcome.verified_scopes = scopes;
  }
  outcome.pending_outbox = after.counts.pending_outbox;
} finally {
  await api("/internal/c1/coach-logout", c1Key,
    { request_id: requestId("logout"), session_token: token });
}
assert.equal(memberDigest((await roster()).members), beforeDigest);
const visible = await publicSchedule();
assert.equal(visible.practices.length, 0, "The test week must remain a private draft.");
console.log(JSON.stringify({ status: "passed", ...outcome,
  roster_unchanged: true, public_practices: 0, coach_logged_out: true }));
