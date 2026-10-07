// Resumable C2.5 ACTION_REQUIRED acceptance for the disposable c2test season.
// Each phase is explicit. There is no cron, deployment, production, or staging call here.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { assertFinalMemberRow, drainDisposition } from "./c2-action-required-recovery.mjs";

const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
assert.ok(["preflight", "inspect", "enqueue", "recover-enqueue", "mark-google", "verify-halt", "restore-google",
  "retry", "drain", "final"].includes(phase), "Choose one explicit C2.5 acceptance phase.");
if (!["preflight", "inspect"].includes(phase)) assert.ok(process.argv.includes("--write-test-data"),
  "State-changing phases require --write-test-data.");
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
const expectedSpreadsheetId = process.env.C2_RUNTIME_SHEET_ID;
assert.ok(c1Key && c2Key && expectedSpreadsheetId, "Isolated keys and Sheet ID are required.");
const privateRoot = new URL("../.c2-form-test/", import.meta.url);
const stateUrl = new URL("c25-action-required-state.json", privateRoot);
const { coach_code: coachCode } = JSON.parse(readFileSync(new URL("review-private.json", privateRoot), "utf8"));
const { GOOGLE_BRIDGE_URL: googleUrl, GOOGLE_BRIDGE_SECRET: googleSecret } = JSON.parse(
  readFileSync(new URL("worker-secrets.json", privateRoot), "utf8"));
const { deployment_id: deploymentId } = JSON.parse(readFileSync(
  new URL("isolated-identities.json", privateRoot), "utf8"));
assert.ok(coachCode && googleSecret && deploymentId);
const bridgeUrl = new URL(googleUrl);
assert.equal(bridgeUrl.protocol, "https:");
assert.equal(bridgeUrl.hostname, "script.google.com");
assert.equal(bridgeUrl.pathname, `/macros/s/${deploymentId}/exec`);
const config = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
assert.deepEqual(config.env.c2test.triggers.crons, [], "c2test must have no automatic cron.");
assert.equal(config.env.production.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.equal(config.vars.C2_EXPORT_POLL_ENABLED, "false");
const seasonId = "season_c2_isolated_2026";
const teamId = "pentasus-c2-test";
const requestId = (label) => `c25_${label}_${randomUUID().replaceAll("-", "")}`;
const headers = ["season_id", "member_id", "source_key", "source_row_number",
  "source_display_name", "display_name_override", "status", "default_preference",
  "member_version", "created_at", "updated_at"];
const expectedError = "SYNC_MEMBER_NEEDS_REVIEW";
const inspectableScopes = ["SEASON", "MEMBER", "SCHEDULE_TEMPLATE", "TRAINING_WEEK",
  "PRACTICE", "SIGNUP", "SEAT_PLAN_DRAFT"];

function state() {
  assert.ok(existsSync(stateUrl), "The local acceptance state is missing; do not guess a target row.");
  const saved = JSON.parse(readFileSync(stateUrl, "utf8"));
  assert.equal(saved.season_id, seasonId);
  assert.equal(saved.spreadsheet_id, expectedSpreadsheetId);
  assert.ok(saved.run_id && saved.member_id && saved.original && saved.marker);
  return saved;
}
function save(saved, fresh = false) {
  writeFileSync(stateUrl, `${JSON.stringify(saved, null, 2)}\n`,
    fresh ? { flag: "wx" } : undefined);
}
async function api(path, key, payload, status = 200) {
  const timeoutMs = path === "/internal/c2/check-sheet-differences" ? 60_000 : 30_000;
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId("api"), ...payload }), signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(response.status, status, `${path}: ${body.error?.code}`);
  assert.equal(body.ok, status === 200);
  return body;
}
async function bridge(action, payload, operationId) {
  const payload_json = JSON.stringify(payload);
  const unsigned = { action, request_id: requestId("bridge"),
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: teamId, binding_version: `${seasonId}:1`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: requestId("nonce"), operation_id: operationId,
    payload_json, payload_digest: createHash("sha256").update(payload_json).digest("base64url") };
  const signature = createHmac("sha256", googleSecret).update([
    unsigned.protocol_version, unsigned.direction, unsigned.team_id, unsigned.binding_version,
    unsigned.writer_epoch, unsigned.timestamp_ms, unsigned.nonce, unsigned.operation_id,
    unsigned.payload_digest
  ].join("\n")).digest("base64url");
  const response = await fetch(bridgeUrl, {
    method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...unsigned, signature }), redirect: "follow",
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.error?.code);
  assert.equal(body.ok, true, body.error?.code);
  assert.equal(body.meta?.request_id, unsigned.request_id);
  assert.equal(body.data?.operation_id, operationId);
  assert.equal(body.data?.payload_digest, unsigned.payload_digest);
  assert.equal(body.data?.season_id, seasonId);
  assert.equal(body.data?.team_id, teamId);
  assert.equal(body.data?.binding_version, 1);
  return body.data;
}
async function googleMembers() {
  const page = await bridge("cloudflareReadSheetRecords",
    { season_id: seasonId, entity_type: "MEMBER" }, requestId("read"));
  assert.equal(page.entity_type, "MEMBER");
  assert.equal(page.tab_name, "Members");
  assert.equal(page.spreadsheet_id, expectedSpreadsheetId);
  assert.deepEqual(page.headers, headers);
  assert.ok(page.rows.every((row) => row.cells[0] === seasonId));
  return page;
}
async function memberRow(memberId) {
  const page = await googleMembers();
  const matches = page.rows.filter((row) => row.cells[1] === memberId);
  assert.equal(matches.length, 1, "The isolated member must have exactly one Google row.");
  return { page, cells: matches[0].cells };
}
async function overview(token) {
  const value = (await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId })).data;
  assert.equal(value.schema_version, 13);
  assert.equal(value.binding_current, true);
  assert.equal(value.binding.runtime_spreadsheet_id, expectedSpreadsheetId);
  assert.equal(value.binding.binding_version, 1);
  return value;
}
async function checkDifferences(token, scope, count = 0) {
  const value = (await api("/internal/c2/check-sheet-differences", c2Key,
    { session_token: token, season_id: seasonId, entity_type: scope })).data;
  assert.equal(value.status, "OK");
  assert.equal(value.findings_count, count, `${scope} B/C/G findings`);
}
async function poll() {
  return (await api("/internal/c2/poll-due-exports", c2Key, {})).data;
}
async function roster() {
  const url = new URL("/internal/c1/public-roster", base);
  url.searchParams.set("request_id", requestId("roster"));
  url.searchParams.set("season_id", seasonId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${c1Key}` },
    signal: AbortSignal.timeout(20_000) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.ok(Array.isArray(body.data?.members));
  return body.data.members;
}
function assertClean(value) {
  assert.equal(value.export_control.status, "RUNNING");
  assert.equal(value.export_control.pause_requested, false);
  assert.equal(value.counts.pending_batches, 0);
  assert.equal(value.counts.pending_outbox, 0);
  assert.equal(value.counts.open_conflicts, 0);
  assert.equal(value.export_control.retry?.action_required ?? false, false);
}
async function mutateGoogle(saved, from, to, label) {
  const { page, cells } = await memberRow(saved.member_id);
  assert.equal(page.tab_id, saved.tab_id);
  assert.deepEqual(cells, from, "Google row changed outside this acceptance; stop without overwriting.");
  const receipt = await bridge("cloudflarePatchMemberSheet", {
    season_id: seasonId, batch_id: `c25_${label}_${saved.run_id}`,
    spreadsheet_id: expectedSpreadsheetId, tab_id: saved.tab_id,
    items: [{ member_id: saved.member_id, expected: from, target: to }]
  }, `c25_${label}_${saved.run_id}`);
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.spreadsheet_id, expectedSpreadsheetId);
  assert.equal(receipt.tab_id, saved.tab_id);
  assert.deepEqual(receipt.verified_member_ids, [saved.member_id]);
  assert.deepEqual((await memberRow(saved.member_id)).cells, to);
}

const health = await (await fetch(new URL("/health", base), {
  signal: AbortSignal.timeout(20_000) })).json();
assert.equal(health.meta?.service_version, "0.16.1-c2-associated-export");
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.writer_epoch, 0);
const token = (await api("/internal/c1/coach-login", c1Key,
  { coach_code: coachCode })).data.result.session_token;
let outcome;
try {
  const before = await overview(token);
  if (phase === "preflight") {
    assertClean(before);
    assert.ok(!existsSync(stateUrl), "An earlier C2.5 run state already exists; inspect it first.");
    for (const scope of inspectableScopes) await checkDifferences(token, scope);
    outcome = { phase, ready: true, schema_version: before.schema_version, cron_config_empty: true };
  } else if (phase === "inspect") {
    const saved = state();
    const cells = (await memberRow(saved.member_id)).cells;
    const markerPresent = JSON.stringify(cells) === JSON.stringify(saved.marker);
    const originalPresent = JSON.stringify(cells) === JSON.stringify(saved.original);
    const finalPresent = ["DRAINED", "COMPLETE"].includes(saved.phase);
    if (finalPresent) assertFinalMemberRow(saved, cells, headers);
    else assert.ok(markerPresent || originalPresent, "The isolated member row has an unexpected edit.");
    outcome = { phase, local_state: saved.phase,
      marker_present: markerPresent, original_present: originalPresent, final_present: finalPresent,
      next_due_at: before.export_control.next_due_at,
      export_status: before.export_control.status,
      export_retry: before.export_control.retry,
      pending_outbox: before.counts.pending_outbox,
      pending_batches: before.counts.pending_batches,
      open_conflicts: before.counts.open_conflicts };
  } else if (phase === "enqueue") {
    assertClean(before);
    assert.ok(!existsSync(stateUrl), "An earlier C2.5 run state already exists.");
    assert.deepEqual(await poll(), { polled: 0, results: [] },
      "Manual polling must be enabled before creating the test event.");
    await checkDifferences(token, "MEMBER");
    await checkDifferences(token, "SEASON");
    const members = await roster();
    assert.ok(Array.isArray(members) && members.length >= 10);
    const member = members[0];
    assert.ok(["LEFT", "RIGHT", "AMBIENT"].includes(member.default_preference));
    const original = await memberRow(member.member_id);
    assert.equal(original.cells[headers.indexOf("member_version")], String(member.member_version));
    assert.equal(original.cells[headers.indexOf("default_preference")], member.default_preference);
    const runId = randomUUID().replaceAll("-", "");
    const marker = [...original.cells];
    marker[headers.indexOf("display_name_override")] = `C2.5 transient conflict ${runId}`;
    const saved = { run_id: runId, phase: "PREPARED", season_id: seasonId,
      spreadsheet_id: expectedSpreadsheetId, member_id: member.member_id,
      tab_id: original.page.tab_id, original: original.cells, marker,
      member_version_before: member.member_version, preference: member.default_preference,
      enqueue_request_id: `c25_enqueue_${runId}`,
      retry_request_id: `c25_retry_${runId}` };
    save(saved, true); // Preserve exact recovery target before the first business mutation.
    const updated = (await api("/internal/c1/update-member", c1Key, {
      request_id: saved.enqueue_request_id, session_token: token,
      season_id: seasonId, member_id: member.member_id,
      member_version: member.member_version, default_preference: member.default_preference
    })).data.result;
    assert.equal(updated.member.member_id, member.member_id);
    assert.equal(updated.member.default_preference, member.default_preference);
    assert.equal(updated.member.member_version, member.member_version + 1);
    saved.phase = "ENQUEUED";
    save(saved);
    const after = await overview(token);
    assert.equal(after.counts.pending_outbox, 1);
    assert.equal(after.counts.pending_batches, 0);
    outcome = { phase, pending_outbox: 1, same_preference: true,
      member_version: updated.member.member_version };
  } else if (phase === "recover-enqueue") {
    const saved = state();
    assert.equal(saved.phase, "PREPARED");
    assert.equal(before.counts.pending_batches, 0);
    assert.ok([0, 1].includes(before.counts.pending_outbox));
    const member = (await roster()).find((item) => item.member_id === saved.member_id);
    assert.ok(member);
    assert.equal(member.default_preference, saved.preference);
    if (member.member_version === saved.member_version_before) {
      assert.equal(before.counts.pending_outbox, 0);
    } else {
      assert.equal(member.member_version, saved.member_version_before + 1);
      assert.equal(before.counts.pending_outbox, 1,
        "A changed member without the expected pending event needs manual inspection.");
    }
    // The original idempotency key proves the event belongs to this run. A different
    // concurrent change cannot accept this old member_version as a new mutation.
    const replayed = (await api("/internal/c1/update-member", c1Key, {
      request_id: saved.enqueue_request_id, session_token: token, season_id: seasonId,
      member_id: saved.member_id, member_version: saved.member_version_before,
      default_preference: saved.preference
    })).data.result;
    assert.equal(replayed.member.member_version, saved.member_version_before + 1);
    assert.equal(replayed.member.default_preference, saved.preference);
    assert.deepEqual((await memberRow(saved.member_id)).cells, saved.original);
    assert.equal((await overview(token)).counts.pending_outbox, 1);
    saved.phase = "ENQUEUED";
    save(saved);
    outcome = { phase, recovered: true, same_preference: true, pending_outbox: 1 };
  } else if (phase === "mark-google") {
    const saved = state();
    assert.ok(["ENQUEUED", "MARK_PENDING", "MARKED"].includes(saved.phase));
    assert.equal(before.counts.pending_outbox, 1);
    assert.equal(before.counts.pending_batches, 0);
    const current = (await memberRow(saved.member_id)).cells;
    if (JSON.stringify(current) === JSON.stringify(saved.original)) {
      saved.phase = "MARK_PENDING";
      save(saved);
      await mutateGoogle(saved, saved.original, saved.marker, "mark");
    } else assert.deepEqual(current, saved.marker,
      "The Google row is neither the original nor the test marker; stop.");
    saved.phase = "MARKED";
    save(saved);
    outcome = { phase, google_marker_applied: true, pending_outbox: 1 };
  } else if (phase === "verify-halt") {
    const saved = state();
    assert.equal(saved.phase, "MARKED");
    assert.deepEqual((await memberRow(saved.member_id)).cells, saved.marker);
    assert.equal(before.counts.pending_outbox, 1);
    assert.equal(before.counts.pending_batches, 0);
    assert.equal(before.export_control.retry?.action_required ?? false, false);
    const due = Date.parse(before.export_control.next_due_at);
    assert.ok(Number.isFinite(due) && due <= Date.now(),
      "The ten-minute outbox delay has not elapsed; do not claim a stop test.");
    const first = await poll();
    assert.deepEqual(first.results, [{ season_id: seasonId,
      status: "ACTION_REQUIRED", error_code: expectedError }]);
    const halted = await overview(token);
    assert.equal(halted.export_control.status, "ACTION_REQUIRED");
    assert.equal(halted.export_control.retry?.action_required, true);
    assert.equal(halted.export_control.retry?.next_attempt_at, null);
    assert.equal(halted.export_control.retry?.last_error, expectedError);
    assert.equal(halted.counts.pending_outbox, 1);
    assert.equal(halted.counts.pending_batches, 0);
    assert.equal((await poll()).polled, 0, "The halted season must not be polled again.");
    assert.deepEqual((await memberRow(saved.member_id)).cells, saved.marker);
    saved.phase = "HALTED";
    save(saved);
    outcome = { phase, error_code: expectedError, stopped: true,
      repeated_poll_count: 0, pending_outbox: 1 };
  } else if (phase === "restore-google") {
    const saved = state();
    assert.ok(["MARK_PENDING", "MARKED", "HALTED", "RESTORE_PENDING", "RESTORED"].includes(saved.phase));
    const current = (await memberRow(saved.member_id)).cells;
    if (JSON.stringify(current) === JSON.stringify(saved.marker)) {
      saved.phase = "RESTORE_PENDING";
      save(saved);
      await mutateGoogle(saved, saved.marker, saved.original, "restore");
    } else assert.deepEqual(current, saved.original,
      "Restore CAS cannot proceed: Google has an unexpected edit. Stop and inspect; do not retry export.");
    saved.phase = "RESTORED";
    save(saved);
    assert.deepEqual((await memberRow(saved.member_id)).cells, saved.original);
    await checkDifferences(token, "MEMBER");
    outcome = { phase, google_row_restored: true, member_difference: 0 };
  } else if (phase === "retry") {
    const saved = state();
    assert.ok(["RESTORED", "RETRY_PENDING"].includes(saved.phase),
      "Do not rearm before exact Google recovery.");
    assert.deepEqual((await memberRow(saved.member_id)).cells, saved.original);
    assert.ok(["ACTION_REQUIRED", "RUNNING"].includes(before.export_control.status));
    if (before.export_control.status === "RUNNING") assert.equal(saved.phase, "RETRY_PENDING",
      "An unexpected operator already rearmed export; stop.");
    else assert.equal(before.export_control.retry?.last_error, expectedError);
    await checkDifferences(token, "MEMBER");
    saved.phase = "RETRY_PENDING";
    save(saved);
    const result = (await api("/internal/c2/retry-export", c2Key,
      { request_id: saved.retry_request_id, session_token: token,
        season_id: seasonId })).data.result;
    assert.equal(result.rearmed, true);
    assert.equal(result.previous_error, expectedError);
    assert.equal(result.next_batch_requires_fresh_comparison, true);
    saved.phase = "REARMED";
    save(saved);
    outcome = { phase, coach_retry_rearmed: true, fresh_comparison_required: true };
  } else if (phase === "drain") {
    const saved = state();
    const disposition = drainDisposition(saved, before);
    if (disposition === "VERIFY_FINAL") {
      const finalCells = (await memberRow(saved.member_id)).cells;
      assertFinalMemberRow(saved, finalCells, headers);
      const member = (await roster()).find((item) => item.member_id === saved.member_id);
      assert.ok(member);
      assert.equal(member.member_version, saved.member_version_before + 1);
      assert.equal(member.default_preference, saved.preference);
      for (const scope of ["MEMBER", "SEASON"]) await checkDifferences(token, scope);
      saved.phase = "DRAINED";
      save(saved);
      outcome = { phase, status: "EVENT_CONFIRMED_RECOVERED", pending_outbox: 0,
        pending_batches: 0, member_and_season_difference: 0 };
    } else {
      saved.phase = "DRAINING";
      save(saved);
      const result = await poll();
      if (result.polled === 0) {
        const waiting = await overview(token);
        const nextAttempt = Date.parse(waiting.export_control.retry?.next_attempt_at ?? "");
        assert.ok(Number.isFinite(nextAttempt) && nextAttempt > Date.now(),
          "No season was polled, but no valid one-minute continuation delay exists.");
        assert.equal(waiting.counts.pending_outbox, 1);
        outcome = { phase, status: "WAITING", next_attempt_at: waiting.export_control.retry.next_attempt_at };
      } else {
        assert.equal(result.polled, 1);
        assert.equal(result.results[0].season_id, seasonId);
        assert.ok(["BATCH_CONFIRMED", "EVENT_CONFIRMED"].includes(result.results[0].status));
        const step = result.results[0].status;
        const steps = [...(saved.steps ?? []), step];
        assert.ok(steps.length <= 3, "The isolated one-member event needed too many batches.");
        saved.steps = steps;
        const after = await overview(token);
        if (step === "EVENT_CONFIRMED") {
          assertClean(after);
          for (const scope of ["MEMBER", "SEASON"]) await checkDifferences(token, scope);
          saved.phase = "DRAINED";
          save(saved);
          outcome = { phase, status: step, steps, pending_outbox: 0, pending_batches: 0,
            member_and_season_difference: 0 };
        } else {
          assert.equal(after.counts.pending_outbox, 1);
          assert.equal(after.counts.pending_batches, 0);
          assert.equal(after.export_control.retry?.action_required, false);
          save(saved);
          outcome = { phase, status: step, steps, next_attempt_at:
            after.export_control.retry?.next_attempt_at };
        }
      }
    }
  } else {
    const saved = state();
    assert.equal(saved.phase, "DRAINED");
    assertClean(before);
    const finalCells = (await memberRow(saved.member_id)).cells;
    assertFinalMemberRow(saved, finalCells, headers);
    for (const scope of inspectableScopes) await checkDifferences(token, scope);
    saved.phase = "COMPLETE";
    save(saved);
    outcome = { phase, all_scope_differences: 0, clean: true };
  }
} finally {
  try {
    await api("/internal/c1/coach-logout", c1Key, { session_token: token });
  } catch (error) {
    console.error("Isolated Coach logout failed; inspect this session before continuing.");
    throw error;
  }
}
console.log(JSON.stringify({ ...outcome, coach_logged_out: true }));
