// Private C2.5 preflight backup for the disposable c2test Durable Object only.
// Creates a verified snapshot but does not change business rows or Google.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

assert.ok(process.argv.includes("--capture-isolated-backup"),
  "Explicit --capture-isolated-backup is required.");
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.href,
  "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key);
const { coach_code: coachCode } = JSON.parse(readFileSync(
  new URL("../../.c2-form-test/review-private.json", import.meta.url), "utf8"));
assert.ok(coachCode);
const seasonId = "season_c2_isolated_2026";
const requestId = () => `c25_backup_${randomUUID().replaceAll("-", "")}`;
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
    body: JSON.stringify({ request_id: requestId(), ...payload }), signal: AbortSignal.timeout(60_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(response.status, 200, `${path}: ${body.error?.code}`);
  assert.equal(body.ok, true);
  return body.data;
}
const health = await (await fetch(new URL("/health", base), {
  signal: AbortSignal.timeout(20_000) })).json();
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.service_version, "0.16.1-c2-associated-export");
assert.equal(health.meta?.writer_epoch, 0);
const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.result.session_token;
try {
  const overview = await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(overview.schema_version, 13);
  assert.equal(overview.binding_current, true);
  assert.equal(overview.binding.binding_version, 1);
  assert.equal(overview.export_control.status, "RUNNING");
  assert.equal(overview.export_control.pause_requested, false);
  assert.equal(overview.export_control.retry, null);
  assert.equal(overview.counts.pending_outbox, 0);
  assert.equal(overview.counts.pending_batches, 0);
  assert.equal(overview.counts.open_conflicts, 0);
  assert.ok(overview.counts.baselines >= 97);
  const backup = await api("/internal/c1/create-backup-snapshot", c1Key,
    { session_token: token });
  const manifest = backup.result.manifest;
  assert.equal(manifest.schema_version, 13);
  const tables = new Set(manifest.tables.map((table) => table.name));
  for (const name of ["sync_outbox", "sync_batches", "sync_batch_items", "sync_baselines",
    "sync_export_controls", "sync_export_retries", "sync_associated_cursors",
    "sync_associated_physical_baselines"]) assert.ok(tables.has(name), `Missing backup table ${name}`);
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
  const artifactDir = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(new URL(`${manifest.snapshot_id}.json`, artifactDir),
    `${JSON.stringify({ manifest, chunks }, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ service_version: health.meta.service_version,
    schema_version: overview.schema_version, snapshot_id: manifest.snapshot_id,
    chunk_count: chunks.length, verified: true, downloaded: true,
    pending_outbox: 0, pending_batches: 0, open_conflicts: 0 }));
} finally {
  try {
    await api("/internal/c1/coach-logout", c1Key, { session_token: token });
  } catch (error) {
    console.error("Isolated Coach logout failed; inspect before proceeding.");
    throw error;
  }
}
