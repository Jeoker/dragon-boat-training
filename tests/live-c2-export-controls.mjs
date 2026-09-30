// Reversible C2.5 operator-control acceptance for the disposable c2test season only.
// It never enables polling, creates a business event, or writes a Google Sheet.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

if (!process.argv.includes("--verify-isolated-controls")) {
  throw new Error("Explicit --verify-isolated-controls is required.");
}
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key);
const { coach_code: coachCode } = JSON.parse(readFileSync(
  new URL("../../.c2-form-test/review-private.json", import.meta.url), "utf8"));
assert.ok(coachCode);
const seasonId = "season_c2_isolated_2026";
const requestId = (label) => `c2_controls_${label}_${randomUUID().replaceAll("-", "")}`;

async function api(path, key, payload) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId("api"), ...payload }),
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  return { status: response.status, body };
}
function success(result) {
  assert.equal(result.status, 200, JSON.stringify(result.body.error));
  assert.equal(result.body.ok, true);
  return result.body.data;
}
async function overview(token) {
  return success(await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId }));
}

const health = await (await fetch(new URL("/health", base), {
  signal: AbortSignal.timeout(20_000)
})).json();
assert.equal(health.meta?.service_version, "0.15.0-c2-export-action-required");
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.writer_epoch, 0);
const login = success(await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode }));
const token = login.result.session_token;
let paused = false;
try {
  const before = await overview(token);
  assert.equal(before.schema_version, 12);
  assert.equal(before.binding_current, true);
  assert.equal(before.counts.baselines, 97);
  assert.equal(before.counts.pending_batches, 0);
  assert.equal(before.counts.pending_outbox, 0);
  assert.equal(before.counts.open_conflicts, 0);
  assert.equal(before.export_control.status, "RUNNING");
  assert.equal(before.export_control.retry, null);

  const denied = await api("/internal/c2/set-export-pause", c2Key, {
    session_token: "x".repeat(40), season_id: seasonId, paused: true
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error?.code, "SESSION_INVALID");

  const pauseId = requestId("pause");
  const pausePayload = { request_id: pauseId, session_token: token, season_id: seasonId, paused: true };
  paused = true;
  const pause = success(await api("/internal/c2/set-export-pause", c2Key, pausePayload));
  assert.equal(pause.result.status, "PAUSED");
  assert.deepEqual(success(await api("/internal/c2/set-export-pause", c2Key, pausePayload)), pause);
  assert.equal((await overview(token)).export_control.status, "PAUSED");

  const retry = await api("/internal/c2/retry-export", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error?.code, "SYNC_EXPORT_ACTION_NOT_REQUIRED");

  const resumed = success(await api("/internal/c2/set-export-pause", c2Key,
    { session_token: token, season_id: seasonId, paused: false }));
  assert.equal(resumed.result.status, "RUNNING");
  paused = false;
  const after = await overview(token);
  assert.equal(after.export_control.status, "RUNNING");
  assert.equal(after.export_control.retry, null);
  assert.deepEqual(after.counts, before.counts);
  console.log(JSON.stringify({ service_version: health.meta.service_version,
    schema_version: after.schema_version, pause_replay: true, unauthorized_rejected: true,
    unnecessary_retry_rejected: true, final_export_status: after.export_control.status,
    pending_outbox: after.counts.pending_outbox, pending_batches: after.counts.pending_batches }));
} finally {
  let cleanupError = null;
  if (paused) {
    try {
      success(await api("/internal/c2/set-export-pause", c2Key,
        { session_token: token, season_id: seasonId, paused: false }));
    } catch (error) {
      console.error("Isolated export-pause cleanup requires inspection.");
      cleanupError = error;
    }
  }
  try {
    success(await api("/internal/c1/coach-logout", c1Key, { session_token: token }));
  } catch (error) {
    console.error("Isolated Coach session cleanup requires inspection.");
    cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}
