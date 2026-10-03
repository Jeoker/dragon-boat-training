// Isolated preflight for the disposable C2 Worker and Google test spreadsheet.
// It may record read-only difference diagnostics and an optional private backup in the DO.
// It never prepares an export batch, changes a Sheet row or deploys either service.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--read-isolated-schedule")) {
  throw new Error("Explicit --read-isolated-schedule is required.");
}
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key, "The isolated acceptance keys are required.");
const privateRoot = new URL("../../.c2-form-test/", import.meta.url);
const { coach_code: coachCode } = JSON.parse(readFileSync(new URL("review-private.json", privateRoot), "utf8"));
const { GOOGLE_BRIDGE_URL: googleUrl, GOOGLE_BRIDGE_SECRET: googleSecret } = JSON.parse(
  readFileSync(new URL("worker-secrets.json", privateRoot), "utf8"));
assert.ok(coachCode && googleSecret, "The isolated Coach and bridge credentials are required.");
const bridgeUrl = new URL(googleUrl);
assert.equal(bridgeUrl.protocol, "https:");
assert.equal(bridgeUrl.hostname, "script.google.com");
const seasonId = "season_c2_isolated_2026";
const teamId = "pentasus-c2-test";
const requestId = (label) => `c2_schedule_preflight_${label}_${randomUUID().replaceAll("-", "")}`;
const scopes = {
  SCHEDULE_TEMPLATE: { tab: "ScheduleTemplates", headers: ["season_id", "template_id", "day_of_week",
    "start_time", "end_time", "timezone", "location", "address", "map_url", "active",
    "template_version", "created_at", "updated_at"] },
  TRAINING_WEEK: { tab: "TrainingWeeks", headers: ["season_id", "week_id", "week_start_date",
    "scheduled_open_at", "status", "week_version", "confirmed_version", "confirmed_by",
    "confirmed_at", "published_at", "created_at", "updated_at"] },
  PRACTICE: { tab: "Practices", headers: ["season_id", "practice_id", "week_id", "template_id",
    "generation_key", "start_at", "end_at", "timezone", "location", "address", "map_url",
    "left_capacity", "right_capacity", "signup_cutoff_at", "practice_version", "cancelled_at",
    "cancelled_by", "schedule_published_at", "schedule_published_by", "created_at", "updated_at"] }
};
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => `sha256_v1:${createHash("sha256").update(value).digest("base64url")}`;

async function api(path, key, payload) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId("api"), ...payload }), signal: AbortSignal.timeout(45_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  if (!response.ok || !body.ok) throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  return body.data;
}

async function publicRead(path) {
  const url = new URL(path, base);
  url.searchParams.set("request_id", requestId("public"));
  url.searchParams.set("season_id", seasonId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${c1Key}` }, signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  return body.data;
}

async function inspectGoogle(entityType, bindingVersion) {
  const payload_json = JSON.stringify({ season_id: seasonId, entity_type: entityType });
  const request = {
    action: "cloudflareReadSheetRecords", request_id: requestId("google"),
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: teamId, binding_version: `${seasonId}:${bindingVersion}`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: requestId("nonce"), operation_id: requestId("operation"),
    payload_json, payload_digest: createHash("sha256").update(payload_json).digest("base64url")
  };
  const signature = createHmac("sha256", googleSecret).update([
    request.protocol_version, request.direction, request.team_id, request.binding_version,
    request.writer_epoch, request.timestamp_ms, request.nonce, request.operation_id,
    request.payload_digest
  ].join("\n")).digest("base64url");
  const response = await fetch(bridgeUrl, {
    method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...request, signature }), redirect: "follow", signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.request_id, request.request_id);
  if (!response.ok || !body.ok) return { status: "UNAVAILABLE", error_code: body.error?.code ?? "INVALID_RESPONSE" };
  const page = body.data;
  assert.equal(page.team_id, teamId);
  assert.equal(page.season_id, seasonId);
  assert.equal(page.entity_type, entityType);
  assert.equal(page.binding_version, bindingVersion);
  assert.equal(page.operation_id, request.operation_id);
  assert.equal(page.payload_digest, request.payload_digest);
  assert.equal(page.tab_name, scopes[entityType].tab);
  assert.deepEqual(page.headers, scopes[entityType].headers);
  assert.ok(Array.isArray(page.rows));
  assert.ok(page.rows.every((row) => row.cells?.[0] === seasonId));
  return { status: "READY", rows: page.rows.length, tab_id_present: /^\d+$/u.test(page.tab_id) };
}

const health = await (await fetch(new URL("/health", base), { signal: AbortSignal.timeout(20_000) })).json();
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.writer_epoch, 0);
const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.result.session_token;
try {
  const overview = await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  const operations = await api("/internal/c1/get-operations", c1Key, { session_token: token });
  assert.equal(operations.counts.jobs_pending, 0);
  assert.equal(operations.counts.outbox_pending, 0);
  assert.equal(overview.binding_current, true);
  assert.equal(overview.counts.pending_batches, 0);
  assert.equal(overview.counts.open_conflicts, 0);
  assert.equal(overview.counts.baselines, 97);
  assert.equal(overview.export_control.status, "RUNNING");
  assert.equal(overview.export_control.pause_requested, false);
  assert.equal(overview.export_control.retry, null,
    "An existing export retry/halt must be recorded separately before a schema upgrade.");
  const publicSchedule = await publicRead("/internal/c1/public-schedule");
  const publicRoster = await publicRead("/internal/c1/public-roster");
  assert.equal(publicSchedule.practices.length, 0,
    "The isolated schedule acceptance weeks must stay private drafts.");
  assert.equal(publicRoster.members.length, 10);
  const bindingVersion = overview.binding.binding_version;
  const sheets = {};
  for (const entityType of Object.keys(scopes)) {
    sheets[entityType] = await inspectGoogle(entityType, bindingVersion);
  }
  const differences = {};
  for (const entityType of ["SEASON", "MEMBER", ...Object.keys(scopes)]) {
    console.error(`Checking isolated ${entityType} B/C/G`);
    const checked = await api("/internal/c2/check-sheet-differences", c2Key,
      { session_token: token, season_id: seasonId, entity_type: entityType });
    assert.equal(checked.status, "OK", `${entityType} inspection status`);
    assert.equal(checked.findings_count, 0, `${entityType} B/C/G difference`);
    assert.equal(checked.truncated, false);
    differences[entityType] = { rows: checked.rows_read, findings: 0 };
  }
  const afterInspection = await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(afterInspection.counts.open_conflicts, 0);
  let backup = null;
  if (process.argv.includes("--capture-isolated-backup")) {
    assert.equal(overview.counts.pending_outbox, 0);
    assert.ok(Object.values(sheets).every((sheet) => sheet.status === "READY"),
      "All three schedule tabs must pass before capturing the migration backup.");
    const result = await api("/internal/c1/create-backup-snapshot", c1Key, { session_token: token });
    const manifest = result.result.manifest;
    if (overview.schema_version >= 12) {
      const tables = new Set(manifest.tables.map((table) => table.name));
      assert.ok(tables.has("sync_export_controls") && tables.has("sync_export_retries"),
        "The v12 private backup must include export operating state.");
    }
    const verified = await api("/internal/c1/verify-backup-snapshot", c1Key,
      { session_token: token, snapshot_id: manifest.snapshot_id,
        content_digest: manifest.content_digest });
    assert.equal(verified.verified, true);
    const chunks = [];
    for (let index = 0; index < manifest.chunk_count; index += 1) {
      const page = await api("/internal/c1/get-backup-chunk", c1Key,
        { session_token: token, snapshot_id: manifest.snapshot_id, chunk_index: index });
      assert.equal(page.chunk.payload_digest, digest(canonicalJson(page.chunk.payload)));
      chunks.push(page.chunk);
    }
    const artifactDir = fileURLToPath(new URL("../cloudflare/.acceptance-artifacts/", import.meta.url));
    await mkdir(artifactDir, { recursive: true });
    await writeFile(new URL(`../cloudflare/.acceptance-artifacts/${manifest.snapshot_id}.json`, import.meta.url),
      `${JSON.stringify({ manifest, chunks }, null, 2)}\n`, { flag: "wx" });
    backup = { snapshot_id: manifest.snapshot_id, schema_version: manifest.schema_version,
      chunk_count: chunks.length, verified: true, downloaded: true };
  }
  console.log(JSON.stringify({ service_version: health.meta.service_version,
    schema_version: overview.schema_version, binding_version: bindingVersion,
    pending_outbox: overview.counts.pending_outbox, pending_jobs: operations.counts.jobs_pending,
    open_conflicts: 0,
    baselines: overview.counts.baselines, export_status: overview.export_control.status,
    export_retry: overview.export_control.retry, public_practices: 0,
    roster_members: publicRoster.members.length, sheets, differences, backup }));
} finally {
  try {
    await api("/internal/c1/coach-logout", c1Key, { session_token: token });
  } catch (error) {
    console.error("Isolated preflight Coach logout requires inspection.");
    throw error;
  }
}
