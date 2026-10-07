// Run only against the isolated c2test deployment with its temporary Apps Script reply-drop overlay.
// A no-visible-change member update must already be due (see live-c2-debt-export.mjs enqueue).
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

assert.ok(process.argv.includes("--recover-isolated-batch"),
  "Explicit --recover-isolated-batch is required.");
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key, "The isolated acceptance keys are required.");
const privateDir = new URL("../.c2-form-test/", import.meta.url);
const { coach_code: coachCode } = JSON.parse(readFileSync(fileURLToPath(
  new URL("review-private.json", privateDir)), "utf8"));
const { GOOGLE_BRIDGE_URL: bridgeRawUrl, GOOGLE_BRIDGE_SECRET: bridgeSecret } = JSON.parse(
  readFileSync(fileURLToPath(new URL("worker-secrets.json", privateDir)), "utf8"));
const bridgeUrl = new URL(bridgeRawUrl);
assert.equal(bridgeUrl.protocol, "https:");
assert.equal(bridgeUrl.hostname, "script.google.com");
assert.ok(coachCode && bridgeSecret);
const seasonId = "season_c2_isolated_2026";
const teamId = "pentasus-c2-test";
const protocol = "2026-09-19.bridge.v1";
const requestId = (prefix = "c2_loss_") => `${prefix}${randomUUID().replaceAll("-", "")}`;

async function api(path, key, payload) {
  const id = payload.request_id || requestId();
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, request_id: id }), signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  return { response, body };
}

async function success(path, key, payload) {
  const { response, body } = await api(path, key, payload);
  assert.equal(response.status, 200, `${path}: ${body.error?.code}`);
  assert.equal(body.ok, true);
  return body.data;
}

async function readSheet(entityType) {
  const payload_json = JSON.stringify({ season_id: seasonId, entity_type: entityType });
  const envelope = {
    action: "cloudflareReadSheetRecords", request_id: requestId(),
    protocol_version: protocol, direction: "CLOUDFLARE_TO_GOOGLE", team_id: teamId,
    binding_version: `${seasonId}:1`, writer_epoch: 0, timestamp_ms: Date.now(),
    nonce: requestId("nonce_"), operation_id: requestId("inspect_"), payload_json,
    payload_digest: createHash("sha256").update(payload_json).digest("base64url")
  };
  const signature = createHmac("sha256", bridgeSecret).update([
    envelope.protocol_version, envelope.direction, envelope.team_id,
    envelope.binding_version, envelope.writer_epoch, envelope.timestamp_ms,
    envelope.nonce, envelope.operation_id, envelope.payload_digest
  ].join("\n")).digest("base64url");
  const response = await fetch(bridgeUrl, {
    method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...envelope, signature }), redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true, body.error?.code);
  assert.equal(body.meta?.request_id, envelope.request_id);
  assert.equal(body.data?.entity_type, entityType);
  assert.equal(body.data?.season_id, seasonId);
  return body.data;
}

async function failedBatch(sessionToken) {
  const backup = await success("/internal/c1/create-backup-snapshot", c1Key,
    { session_token: sessionToken });
  const manifest = backup.result.manifest;
  assert.equal(manifest.schema_version, 9);
  const table = manifest.tables.find((entry) => entry.name === "sync_batches");
  assert.ok(table);
  const rows = [];
  for (const chunk_index of table.chunk_indices) {
    const part = await success("/internal/c1/get-backup-chunk", c1Key,
      { session_token: sessionToken, snapshot_id: manifest.snapshot_id, chunk_index });
    assert.equal(part.chunk.table_name, "sync_batches");
    rows.push(...part.chunk.payload.rows);
  }
  assert.equal(rows.length, table.row_count);
  const pending = rows.filter((row) => row.season_id === seasonId && row.status !== "CONFIRMED");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "FAILED");
  assert.equal(pending[0].attempt_count, 1);
  return pending[0].batch_id;
}

const health = await (await fetch(new URL("/health", base))).json();
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
const login = await success("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.result.session_token;
try {
  const before = await success("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(before.binding_current, true);
  assert.equal(before.counts.pending_batches, 0);
  assert.equal(before.counts.pending_outbox, 1);
  const rosterResponse = await fetch(new URL(
    `/internal/c1/public-roster?request_id=${requestId()}&season_id=${seasonId}`, base),
  { headers: { authorization: `Bearer ${c1Key}` }, signal: AbortSignal.timeout(20_000) });
  const rosterBody = await rosterResponse.json();
  assert.equal(rosterResponse.status, 200);
  assert.equal(rosterBody.ok, true);
  const roster = rosterBody.data.members;
  assert.equal(roster.length, 10);
  const member = roster[0];
  const beforeSheet = await readSheet("MEMBER");
  assert.equal(beforeSheet.rows.length, 10);
  const memberRow = beforeSheet.rows.find((row) => row.cells[1] === member.member_id);
  assert.ok(memberRow);
  const memberVersionIndex = beforeSheet.headers.indexOf("member_version");
  assert.equal(Number(memberRow.cells[memberVersionIndex]), member.member_version - 1);

  const dropped = await api("/internal/c2/export-next-member", c2Key,
    { season_id: seasonId, request_id: requestId("c2_reply_drop_") });
  assert.equal(dropped.response.status, 503);
  assert.equal(dropped.body.error?.code, "BRIDGE_UNAVAILABLE");
  const written = await readSheet("MEMBER");
  assert.equal(written.rows.length, 10);
  const updated = written.rows.find((row) => row.cells[1] === member.member_id);
  assert.ok(updated);
  assert.equal(Number(updated.cells[memberVersionIndex]), member.member_version,
    "Google must have written before its reply was dropped.");
  const pending = await success("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(pending.counts.pending_batches, 1);
  assert.equal(pending.counts.pending_outbox, 1);
  const originalBatchId = await failedBatch(token);

  const replay = await success("/internal/c2/export-next-member", c2Key, { season_id: seasonId });
  assert.equal(replay.status, "BATCH_CONFIRMED");
  assert.equal(replay.member_id, member.member_id);
  assert.equal(replay.batch_id, originalBatchId, "Retry must confirm the original batch.");
  const completed = await success("/internal/c2/export-next-member", c2Key, { season_id: seasonId });
  assert.equal(completed.status, "EVENT_CONFIRMED");
  assert.equal((await readSheet("MEMBER")).rows.length, 10,
    "The retry must not add another member row.");
  for (const entity_type of ["MEMBER", "SEASON"]) {
    const checked = await success("/internal/c2/check-sheet-differences", c2Key,
      { session_token: token, season_id: seasonId, entity_type });
    assert.equal(checked.status, "OK");
    assert.equal(checked.findings_count, 0);
  }
  const final = await success("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(final.counts.pending_batches, 0);
  assert.equal(final.counts.pending_outbox, 0);
  console.log(JSON.stringify({ status: "passed", google_written_before_error: true,
    reused_original_batch: true,
    member_rows: 10, final_pending_batches: 0, final_pending_outbox: 0 }));
} finally {
  await success("/internal/c1/coach-logout", c1Key, { session_token: token });
}
