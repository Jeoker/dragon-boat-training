// Resumable fault acceptance for the disposable c2test season. Never use production credentials.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

assert.ok(process.argv.includes("--write-test-data"), "Explicit --write-test-data is required.");
const phase = process.argv.find((value) => value.startsWith("--phase="))?.slice(8);
assert.ok(["prepare", "probe-overlay", "export-week", "partial", "recover-partial", "lost-reply", "recover-reply", "finish"].includes(phase));
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
const expectedSpreadsheetId = process.env.C2_RUNTIME_SHEET_ID;
assert.ok(c1Key && c2Key && expectedSpreadsheetId, "Isolated keys and Sheet ID are required.");
const privateRoot = new URL("../../.c2-form-test/", import.meta.url);
const { coach_code: coachCode } = JSON.parse(readFileSync(new URL("review-private.json", privateRoot), "utf8"));
const { GOOGLE_BRIDGE_URL: bridgeUrlText, GOOGLE_BRIDGE_SECRET: bridgeSecret } = JSON.parse(
  readFileSync(new URL("worker-secrets.json", privateRoot), "utf8"));
const identity = JSON.parse(readFileSync(new URL("isolated-identities.json", privateRoot), "utf8"));
assert.match(identity.deployment_id, /^[A-Za-z0-9_-]{30,}$/);
const bridgeUrl = new URL(bridgeUrlText);
assert.equal(bridgeUrl.protocol, "https:");
assert.equal(bridgeUrl.hostname, "script.google.com");
assert.ok(bridgeUrl.pathname.includes(identity.deployment_id));
const stateUrl = new URL("schedule-fault-state.json", privateRoot);
const seasonId = "season_c2_isolated_2026";
const weekDate = "2026-10-12";
const teamId = "pentasus-c2-test";
const fixedId = (label) => `c2_schedule_fault_20260930_${label}`;
const batchId = (label) => `batch_${createHash("sha256").update(
  `${teamId}\nC2:EXPORT\nexportNextSchedule\n${fixedId(label)}`).digest("base64url")}`;
const requestId = () => `c2_schedule_fault_check_${randomUUID().replaceAll("-", "")}`;

async function api(path, key, payload, status = 200) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId(), ...payload }), signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(response.status, status, `${path}: ${body.error?.code}`);
  if (status === 200) assert.equal(body.ok, true, `${path}: ${body.error?.code}`);
  return body;
}

async function bridge(action, payload) {
  const payload_json = JSON.stringify(payload);
  const request = {
    action, request_id: requestId(), protocol_version: "2026-09-19.bridge.v1",
    direction: "CLOUDFLARE_TO_GOOGLE", team_id: teamId,
    binding_version: `${seasonId}:1`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: requestId(), operation_id: requestId(),
    payload_json, payload_digest: createHash("sha256").update(payload_json).digest("base64url")
  };
  const signature = createHmac("sha256", bridgeSecret).update([
    request.protocol_version, request.direction, request.team_id,
    request.binding_version, request.writer_epoch, request.timestamp_ms,
    request.nonce, request.operation_id, request.payload_digest
  ].join("\n")).digest("base64url");
  const response = await fetch(bridgeUrl, {
    method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...request, signature }), redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true, body.error?.code);
  assert.equal(body.meta?.request_id, request.request_id);
  return body.data;
}

async function sheetRow(scope, id) {
  const page = await bridge("cloudflareReadSheetRecords",
    { season_id: seasonId, entity_type: scope });
  assert.equal(page.entity_type, scope);
  if (scope === "PRACTICE") assert.equal(page.spreadsheet_id, expectedSpreadsheetId);
  const identity = scope === "SEASON" ? 0 : 1;
  const rows = page.rows.filter((row) => row.cells[identity] === id);
  assert.equal(rows.length, 1);
  return Object.fromEntries(page.headers.map((header, index) => [header, rows[0].cells[index]]));
}

async function receipt(batch) {
  const result = await bridge("c2TestReadFaultReceipt", { season_id: seasonId, batch_id: batch });
  assert.equal(result.batch_id, batch);
  assert.equal(result.season_id, seasonId);
  assert.equal(result.binding_version, "1");
  assert.equal(result.writer_epoch, "0");
  return result;
}

function expectCounts(overview, outbox, batches) {
  assert.equal(overview.schema_version, 11);
  assert.equal(overview.binding_current, true);
  assert.equal(overview.counts.open_conflicts, 0);
  assert.equal(overview.counts.pending_outbox, outbox);
  assert.equal(overview.counts.pending_batches, batches);
}

async function inspect(token) {
  const overview = (await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId })).data;
  const workspace = (await api("/internal/c1/schedule-workspace", c1Key,
    { session_token: token, season_id: seasonId })).data;
  const week = workspace.weeks.find((item) => item.week_start_date === weekDate);
  assert.ok(week);
  const matches = workspace.practices.filter((item) => item.week_id === week.week_id);
  assert.equal(matches.length, 1);
  return { overview, week, practice: matches[0] };
}

async function checkGoogle(token, scope, expectedFindings = 0) {
  const checked = (await api("/internal/c2/check-sheet-differences", c2Key,
    { session_token: token, season_id: seasonId, entity_type: scope })).data;
  assert.equal(checked.status, "OK");
  assert.equal(checked.findings_count, expectedFindings, `${scope} findings`);
}

const health = await (await fetch(new URL("/health", base), { signal: AbortSignal.timeout(20_000) })).json();
assert.equal(health.meta?.service_version, "0.14.0-c2-operations");
assert.equal(health.meta?.writer_epoch, 0);
const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.data.result.session_token;
let outcome;
try {
  const { overview, week, practice } = await inspect(token);
  const state = phase === "prepare" ? null : JSON.parse(readFileSync(stateUrl, "utf8"));
  if (state) {
    assert.equal(state.season_id, seasonId);
    assert.equal(state.week_id, week.week_id);
    assert.equal(state.practice_id, practice.practice_id);
    assert.equal(state.partial_batch_id, batchId("partial"));
    assert.equal(state.reply_batch_id, batchId("lost_reply"));
  }
  if (phase === "prepare") {
    assert.equal(overview.counts.open_conflicts, 0);
    assert.equal(overview.counts.pending_batches, 0);
    assert.ok([0, 1].includes(overview.counts.pending_outbox));
    assert.ok([1, 2].includes(practice.practice_version));
    assert.equal(practice.schedule_published_at, null);
    const values = { practice_date: "2026-10-14", start_time: "18:00", end_time: "20:00",
      timezone: "America/New_York", location: "C2 Partial Test Dock",
      address: "C2 Partial Test Road", map_url: "" };
    writeFileSync(stateUrl, JSON.stringify({ season_id: seasonId, week_id: week.week_id,
      practice_id: practice.practice_id, partial_request_id: fixedId("partial"),
      partial_batch_id: batchId("partial"), reply_request_id: fixedId("lost_reply"),
      reply_batch_id: batchId("lost_reply") }, null, 2));
    if (practice.practice_version === 1) {
      expectCounts(overview, 0, 0);
      assert.equal(practice.location, "C2 Isolated Test Dock");
      assert.equal(practice.address, "Test River Road");
      await checkGoogle(token, "PRACTICE");
      await checkGoogle(token, "TRAINING_WEEK");
      const preview = (await api("/internal/c1/preview-practice-change", c1Key,
        { session_token: token, season_id: seasonId, practice_id: practice.practice_id,
          change: "UPDATE", ...values })).data;
      assert.equal(preview.practice_version, 1);
      assert.equal(preview.week_version, week.week_version);
      const updated = (await api("/internal/c1/update-practice", c1Key,
        { request_id: fixedId("mutate"), session_token: token, season_id: seasonId,
          week_id: week.week_id, week_version: week.week_version,
          practice_id: practice.practice_id, practice_version: practice.practice_version,
          signup_version: preview.signup_version, preview_token: preview.preview_token,
          ...values })).data.result;
      assert.equal(updated.practice.practice_version, 2);
    } else {
      expectCounts(overview, 1, 0);
    }
    const current = (await inspect(token)).practice;
    assert.equal(current.practice_version, 2);
    assert.equal(current.location, values.location);
    assert.equal(current.address, values.address);
    outcome = { phase, practice_version: 2, state_saved: true };
  } else if (phase === "probe-overlay") {
    expectCounts(overview, 1, 0);
    const missing = await bridge("c2TestReadFaultReceipt",
      { season_id: seasonId, batch_id: state.partial_batch_id });
    assert.equal(missing.status, "MISSING");
    assert.equal(missing.batch_id, state.partial_batch_id);
    const googlePractice = await sheetRow("PRACTICE", practice.practice_id);
    assert.equal(googlePractice.location, "C2 Isolated Test Dock");
    assert.equal(googlePractice.address, "Test River Road");
    assert.equal(googlePractice.practice_version, "1");
    outcome = { phase, temporary_overlay_active: true, target_row_unchanged: true };
  } else if (phase === "export-week") {
    expectCounts(overview, 1, 0);
    assert.equal(practice.practice_version, 2);
    assert.equal(practice.location, "C2 Partial Test Dock");
    assert.equal(practice.address, "C2 Partial Test Road");
    const googlePractice = await sheetRow("PRACTICE", practice.practice_id);
    assert.equal(googlePractice.location, "C2 Isolated Test Dock");
    assert.equal(googlePractice.address, "Test River Road");
    assert.equal(googlePractice.practice_version, "1");
    const result = (await api("/internal/c2/export-next-schedule", c2Key,
      { season_id: seasonId })).data;
    assert.equal(result.status, "BATCH_CONFIRMED");
    assert.equal(result.entity_type, "TRAINING_WEEK");
    outcome = { phase, week_batch_id: result.batch_id };
  } else if (phase === "partial") {
    assert.equal(overview.counts.pending_outbox, 1);
    assert.equal(practice.practice_version, 2);
    if (overview.counts.pending_batches === 0) {
      const result = await api("/internal/c2/export-next-schedule", c2Key,
        { request_id: state.partial_request_id, season_id: seasonId }, 502);
      assert.equal(result.error?.code, "TEST_INJECTED_PARTIAL");
    }
    const after = (await inspect(token)).overview;
    expectCounts(after, 1, 1);
    assert.equal(after.export_control.unfinished_batch.batch_id, state.partial_batch_id);
    const row = await sheetRow("PRACTICE", practice.practice_id);
    assert.equal(row.location, "C2 Partial Test Dock");
    assert.equal(row.address, "Test River Road");
    assert.equal(row.practice_version, "1");
    assert.equal((await receipt(state.partial_batch_id)).status, "PREPARED");
    outcome = { phase, failed_batch_id: state.partial_batch_id,
      mixed_google_row: true, receipt_status: "PREPARED" };
  } else if (phase === "recover-partial") {
    expectCounts(overview, 1, 1);
    assert.equal(overview.export_control.unfinished_batch.batch_id, state.partial_batch_id);
    const result = (await api("/internal/c2/export-next-schedule", c2Key,
      { request_id: fixedId("recover_partial"), season_id: seasonId })).data;
    assert.equal(result.status, "BATCH_CONFIRMED");
    assert.equal(result.entity_type, "PRACTICE");
    assert.equal(result.batch_id, state.partial_batch_id);
    await checkGoogle(token, "PRACTICE");
    outcome = { phase, recovered_batch_id: result.batch_id };
  } else if (phase === "lost-reply") {
    assert.equal(overview.counts.pending_outbox, 1);
    if (overview.counts.pending_batches === 0) {
      const result = await api("/internal/c2/export-next-schedule", c2Key,
        { request_id: state.reply_request_id, season_id: seasonId }, 503);
      assert.equal(result.error?.code, "BRIDGE_UNAVAILABLE");
    }
    const after = (await inspect(token)).overview;
    expectCounts(after, 1, 1);
    assert.equal(after.export_control.unfinished_batch.batch_id, state.reply_batch_id);
    const googleSeason = await sheetRow("SEASON", seasonId);
    assert.equal(googleSeason.season_version, "3");
    const savedReceipt = await receipt(state.reply_batch_id);
    assert.equal(savedReceipt.status, "VERIFIED");
    const verified = JSON.parse(savedReceipt.result_json);
    assert.equal(verified.status, "verified");
    assert.deepEqual(verified.verified_season_ids, [seasonId]);
    outcome = { phase, failed_batch_id: state.reply_batch_id,
      google_receipt_verified: true };
  } else if (phase === "recover-reply") {
    expectCounts(overview, 1, 1);
    assert.equal(overview.export_control.unfinished_batch.batch_id, state.reply_batch_id);
    const result = (await api("/internal/c2/export-next-schedule", c2Key,
      { request_id: fixedId("recover_reply"), season_id: seasonId })).data;
    assert.equal(result.status, "EVENT_CONFIRMED");
    assert.equal(result.batch_id, state.reply_batch_id);
    outcome = { phase, recovered_batch_id: result.batch_id };
  } else {
    expectCounts(overview, 0, 0);
    for (const scope of ["SEASON", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE"])
      await checkGoogle(token, scope);
    outcome = { phase, four_scopes_zero_difference: true, pending_outbox: 0 };
  }
} finally {
  await api("/internal/c1/coach-logout", c1Key, { session_token: token });
}
console.log(JSON.stringify({ ...outcome, coach_logged_out: true }));
