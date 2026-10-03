// Inspect the dedicated C2 test state without exporting or changing business rows.
// Creates one protected backup snapshot in that isolated Durable Object.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--capture-isolated-backup")) {
  throw new Error("Explicit --capture-isolated-backup is required.");
}
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key, "The ignored isolated acceptance keys are required.");
const privateFile = fileURLToPath(new URL("../../.c2-form-test/review-private.json", import.meta.url));
const { coach_code: coachCode } = JSON.parse(readFileSync(privateFile, "utf8"));
assert.ok(coachCode, "The isolated Coach Code is required.");
const secretFile = fileURLToPath(new URL("../../.c2-form-test/worker-secrets.json", import.meta.url));
const { GOOGLE_BRIDGE_URL: googleUrl, GOOGLE_BRIDGE_SECRET: googleSecret } =
  JSON.parse(readFileSync(secretFile, "utf8"));
const bridgeUrl = new URL(googleUrl);
assert.equal(bridgeUrl.protocol, "https:");
assert.equal(bridgeUrl.hostname, "script.google.com");
assert.ok(googleSecret);
const seasonId = "season_c2_isolated_2026";
const requestId = (label) => `c2_audit_${label}_${randomUUID().replaceAll("-", "")}`;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const digest = (value) => `sha256_v1:${createHash("sha256").update(value).digest("base64url")}`;

async function api(path, key, payload) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  if (!response.ok || !body.ok) throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  return body.data;
}

async function googleSeasonRow() {
  const payload_json = JSON.stringify({ season_id: seasonId, entity_type: "SEASON" });
  const request = {
    action: "cloudflareReadSheetRecords", request_id: requestId("google"),
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: "pentasus-c2-test", binding_version: `${seasonId}:1`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: requestId("nonce"),
    operation_id: requestId("inspect"), payload_json,
    payload_digest: createHash("sha256").update(payload_json).digest("base64url")
  };
  const signatureInput = [request.protocol_version, request.direction, request.team_id,
    request.binding_version, request.writer_epoch, request.timestamp_ms,
    request.nonce, request.operation_id, request.payload_digest].join("\n");
  const signature = createHmac("sha256", googleSecret).update(signatureInput).digest("base64url");
  const response = await fetch(bridgeUrl, {
    method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...request, signature }), redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`Isolated Google read: HTTP ${response.status}, ${body.error?.code}`);
  assert.equal(body.meta?.request_id, request.request_id);
  const page = body.data;
  assert.equal(page.team_id, request.team_id);
  assert.equal(page.season_id, seasonId);
  assert.equal(page.entity_type, "SEASON");
  assert.equal(page.payload_digest, request.payload_digest);
  assert.equal(page.operation_id, request.operation_id);
  assert.equal(page.rows.length, 1);
  const record = Object.fromEntries(page.headers.map((header, index) =>
    [header, page.rows[0].cells[index]]));
  assert.equal(record.season_id, seasonId);
  return Object.fromEntries(["name", "start_date", "end_date", "timezone", "status", "form_url",
    "season_version", "roster_version", "binding_version", "updated_at"].map((key) => [key, record[key]]));
}

const health = await (await fetch(new URL("/health", base))).json();
assert.ok(["0.11.0-c2-member-export", "0.12.0-c2-season-export"].includes(health.meta?.service_version),
  "The isolated Worker version changed; audit against its current contract first.");
const login = await api("/internal/c1/coach-login", c1Key,
  { request_id: requestId("login"), coach_code: coachCode });
const token = login.result.session_token;
try {
  const backup = await api("/internal/c1/create-backup-snapshot", c1Key,
    { request_id: requestId("backup"), session_token: token });
  const manifest = backup.result.manifest;
  assert.equal(manifest.schema_version, 9);
  const wanted = new Set(["seasons", "members", "system_requests", "sync_bindings",
    "sync_baselines", "sync_outbox", "sync_batches", "sync_batch_items"]);
  const tables = {};
  for (const table of manifest.tables.filter((table) => wanted.has(table.name))) {
    const rows = [];
    for (const index of table.chunk_indices) {
      const result = await api("/internal/c1/get-backup-chunk", c1Key, {
        request_id: requestId("chunk"), session_token: token,
        snapshot_id: manifest.snapshot_id, chunk_index: index
      });
      assert.equal(result.chunk.table_name, table.name);
      assert.equal(result.chunk.payload_digest, digest(canonicalJson(result.chunk.payload)));
      rows.push(...result.chunk.payload.rows);
    }
    assert.equal(rows.length, table.row_count);
    tables[table.name] = rows;
  }
  const season = tables.seasons.find((row) => row.season_id === seasonId);
  const binding = tables.sync_bindings.find((row) => row.season_id === seasonId);
  assert.ok(season && binding);
  const baselines = tables.sync_baselines.filter((row) => row.season_id === seasonId &&
    row.binding_version === binding.binding_version && row.entity_type === "SEASON");
  const events = tables.sync_outbox.filter((row) => {
    const payload = JSON.parse(row.payload_json);
    return payload.entity?.season_id === seasonId;
  }).map((row, index) => {
    const payload = JSON.parse(row.payload_json);
    const request = tables.system_requests.find((candidate) => candidate.request_key === row.request_key);
    const recorded = request ? JSON.parse(request.result_json).result : null;
    return { sequence: index + 1, outbox_id: row.outbox_id, topic: row.topic,
      action: payload.action, status: row.status,
      captured_roster_version: payload.entity?.roster_version ?? null,
      target_count: payload.entity?.member_ids?.length ?? (payload.entity?.member_id ? 1 : 0),
      due_at_ms: row.due_at_ms,
      request_result: recorded && { created: recorded.created ?? null, updated: recorded.updated ?? null,
        member_id: recorded.member_id ?? null },
      completed_at: row.completed_at ?? null };
  });
  const batches = tables.sync_batches.filter((row) => row.season_id === seasonId)
    .map((row) => ({ batch_id: row.batch_id, status: row.status,
      first_outbox_id: row.first_outbox_id,
      items: tables.sync_batch_items.filter((item) => item.batch_id === row.batch_id)
        .map((item) => ({ entity_type: item.entity_type, status: item.status })) }));
  const inspection = await api("/internal/c2/check-sheet-differences", c2Key, {
    request_id: requestId("season"), session_token: token,
    season_id: seasonId, entity_type: "SEASON"
  });
  const googleSeason = await googleSeasonRow();
  let baselineImport = null;
  if (process.argv.includes("--import-isolated-season-baselines")) {
    assert.equal(health.meta.service_version, "0.11.0-c2-member-export");
    const overview = await api("/internal/c2/get-sync-overview", c2Key, {
      request_id: requestId("overview"), session_token: token, season_id: seasonId
    });
    const memberInspection = await api("/internal/c2/check-sheet-differences", c2Key, {
      request_id: requestId("members"), session_token: token,
      season_id: seasonId, entity_type: "MEMBER"
    });
    assert.equal(overview.counts.pending_outbox, 0);
    assert.equal(overview.counts.pending_batches, 0);
    assert.equal(memberInspection.status, "OK");
    assert.equal(memberInspection.rows_read, 9);
    assert.equal(memberInspection.findings_count, 0);
    assert.equal(season.roster_version, 9);
    assert.equal(season.season_version, 2);
    assert.equal(tables.members.filter((row) => row.season_id === seasonId).length, 9);
    assert.equal(events.length, 9);
    assert.ok(events.every((row) => row.status === "CONFIRMED"));
    assert.equal(batches.length, 9);
    assert.ok(batches.every((row) => row.status === "CONFIRMED" && row.items.length === 1 &&
      row.items[0].entity_type === "MEMBER" && row.items[0].status === "VERIFIED"));
    assert.deepEqual(baselines.map((row) => row.dependency_group), ["SEASON_IDENTITY"]);
    assert.equal(inspection.status, "OK");
    assert.deepEqual(inspection.findings.map((row) => row.dependency_group), ["BASELINE_INCOMPLETE"]);
    assert.deepEqual(inspection.findings[0].google?.missing_groups,
      ["IDENTITY", "SEASON_BOUNDARY", "SEASON_LIFECYCLE", "SYSTEM_VERSION"]);
    const { form_url: formUrl, ...googleBusiness } = googleSeason;
    assert.match(formUrl, /^https:\/\/docs\.google\.com\/forms\//u);
    assert.deepEqual(googleBusiness, {
      name: "C2 Isolated Test 2026", start_date: "2026-09-01", end_date: "2026-12-31",
      timezone: "America/New_York", status: "OPEN", season_version: "1",
      roster_version: "0", binding_version: "1", updated_at: "2026-09-26T02:46:20.803Z"
    });
    const at = events[events.length - 1].completed_at;
    const groups = [
      ["IDENTITY", { season_id: seasonId }],
      ["SEASON_BOUNDARY", { start_date: googleSeason.start_date,
        end_date: googleSeason.end_date, timezone: googleSeason.timezone }],
      ["SEASON_LIFECYCLE", { status: googleSeason.status }],
      ["SYSTEM_VERSION", { binding_version: Number(googleSeason.binding_version),
        season_version: Number(googleSeason.season_version),
        roster_version: Number(googleSeason.roster_version) }]
    ];
    const result = await api("/internal/c2/import-sync-foundation", c2Key, {
      request_id: "c2_isolated_legacy_season_baseline_20260927",
      source_snapshot_id: "c2_isolated_legacy_season_baseline_snapshot_20260927",
      bindings: [], source_imports: [],
      baselines: groups.map(([dependency_group, baseline]) => ({
        season_id: seasonId, binding_version: 1, entity_type: "SEASON",
        entity_id: seasonId, dependency_group, baseline, cloud_version: 1,
        sheet_digest: digest(canonicalJson(baseline)), updated_at: at
      }))
    });
    assert.equal(result.result.baselines, 4);
    const checked = await api("/internal/c2/check-sheet-differences", c2Key, {
      request_id: requestId("season_after"), session_token: token,
      season_id: seasonId, entity_type: "SEASON"
    });
    assert.equal(checked.status, "OK");
    assert.equal(checked.findings_count, 0);
    baselineImport = { imported: 4, post_check_findings: 0 };
  }
  console.log(JSON.stringify({
    service_version: health.meta.service_version, backup_schema: manifest.schema_version,
    season: { status: season.status, season_version: season.season_version,
      roster_version: season.roster_version, binding_version: season.binding_version },
    member_count: tables.members.filter((row) => row.season_id === seasonId).length,
    binding: { binding_version: binding.binding_version, export_paused: binding.export_paused },
    google_season: googleSeason,
    season_baselines: baselines.map((row) => ({ group: row.dependency_group,
      baseline: JSON.parse(row.baseline_json), cloud_version: row.cloud_version })),
    season_sheet_findings: inspection.findings.map((finding) => ({
      group: finding.dependency_group, outcome: finding.outcome,
      reason: finding.reason, missing_groups: finding.google?.missing_groups ?? [] })),
    events, batches, baseline_import: baselineImport
  }, null, 2));
} finally {
  await api("/internal/c1/coach-logout", c1Key,
    { request_id: requestId("logout"), session_token: token });
}
