// Explicit, resumable out-of-band edit acceptance in the disposable C2 environment only.
// Each phase checks its own preconditions. Never run against production data.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

assert.ok(process.argv.includes("--write-test-data"), "Explicit --write-test-data is required.");
const phase = process.argv.find((value) => value.startsWith("--phase="))?.slice(8);
assert.ok(["seed-week", "export-week", "edit-google", "verify-blocked", "restore-google", "finish"].includes(phase),
  "Choose one explicit isolated conflict phase.");
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
const expectedSpreadsheetId = process.env.C2_RUNTIME_SHEET_ID;
assert.ok(c1Key && c2Key && expectedSpreadsheetId, "Isolated acceptance keys and Sheet ID are required.");
const privateRoot = new URL("../.c2-form-test/", import.meta.url);
const { coach_code: coachCode } = JSON.parse(readFileSync(new URL("review-private.json", privateRoot), "utf8"));
const { GOOGLE_BRIDGE_URL: googleUrl, GOOGLE_BRIDGE_SECRET: googleSecret } = JSON.parse(
  readFileSync(new URL("worker-secrets.json", privateRoot), "utf8"));
const bridgeUrl = new URL(googleUrl);
assert.equal(bridgeUrl.protocol, "https:");
assert.equal(bridgeUrl.hostname, "script.google.com");
assert.ok(coachCode && googleSecret, "Isolated Google credentials are required.");

const seasonId = "season_c2_isolated_2026";
const weekDate = "2026-10-12";
const teamId = "pentasus-c2-test";
const protocol = "2026-09-19.bridge.v1";
const originalLocation = "C2 Isolated Test Dock";
const temporaryLocation = "C2 out-of-band conflict marker";
const requestId = (label) => `c2_schedule_conflict_${label}_${randomUUID().replaceAll("-", "")}`;
const fixedId = (label) => `c2_schedule_conflict_20260930_${label}`;
const expectedBatchId = (label) => `batch_${createHash("sha256").update(
  `${teamId}\nC2:EXPORT\nexportNextSchedule\n${fixedId(label)}`).digest("base64url")}`;

async function api(path, key, payload, expectedStatus = 200) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId("api"), ...payload }), signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(response.status, expectedStatus, `${path}: ${body.error?.code}`);
  if (expectedStatus === 200) assert.equal(body.ok, true);
  return body;
}

async function bridge(action, payload, operationId) {
  const payload_json = JSON.stringify(payload);
  const unsigned = {
    action, request_id: requestId("bridge"), protocol_version: protocol,
    direction: "CLOUDFLARE_TO_GOOGLE", team_id: teamId,
    binding_version: `${seasonId}:1`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: requestId("nonce"), operation_id: operationId,
    payload_json, payload_digest: createHash("sha256").update(payload_json).digest("base64url")
  };
  const signature = createHmac("sha256", googleSecret).update([
    unsigned.protocol_version, unsigned.direction, unsigned.team_id,
    unsigned.binding_version, unsigned.writer_epoch, unsigned.timestamp_ms,
    unsigned.nonce, unsigned.operation_id, unsigned.payload_digest
  ].join("\n")).digest("base64url");
  const response = await fetch(bridgeUrl, {
    method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...unsigned, signature }), redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.error?.code);
  assert.equal(body.ok, true, body.error?.code);
  assert.equal(body.meta?.request_id, unsigned.request_id);
  assert.equal(body.data?.operation_id, operationId);
  assert.equal(body.data?.payload_digest, unsigned.payload_digest);
  assert.equal(body.data?.team_id, teamId);
  assert.equal(body.data?.season_id, seasonId);
  assert.equal(body.data?.binding_version, 1);
  assert.equal(body.data?.writer_epoch, 0);
  return body.data;
}

const headers = {
  SCHEDULE_TEMPLATE: ["season_id", "template_id", "day_of_week", "start_time", "end_time",
    "timezone", "location", "address", "map_url", "active", "template_version", "created_at", "updated_at"],
  TRAINING_WEEK: ["season_id", "week_id", "week_start_date", "scheduled_open_at", "status",
    "week_version", "confirmed_version", "confirmed_by", "confirmed_at", "published_at", "created_at", "updated_at"],
  PRACTICE: ["season_id", "practice_id", "week_id", "template_id", "generation_key", "start_at",
    "end_at", "timezone", "location", "address", "map_url", "left_capacity", "right_capacity",
    "signup_cutoff_at", "practice_version", "cancelled_at", "cancelled_by", "schedule_published_at",
    "schedule_published_by", "created_at", "updated_at"]
};
const tabNames = { SCHEDULE_TEMPLATE: "ScheduleTemplates", TRAINING_WEEK: "TrainingWeeks",
  PRACTICE: "Practices" };

async function sheetPage(scope) {
  const page = await bridge("cloudflareReadSheetRecords",
    { season_id: seasonId, entity_type: scope }, requestId("read"));
  assert.equal(page.entity_type, scope);
  assert.equal(page.tab_name, tabNames[scope]);
  assert.equal(page.spreadsheet_id, expectedSpreadsheetId);
  assert.deepEqual(page.headers, headers[scope]);
  assert.ok(page.rows.every((row) => row.cells[0] === seasonId));
  return page;
}

async function changeGoogleLocation(from, to, label, templateId) {
  const page = await sheetPage("SCHEDULE_TEMPLATE");
  assert.equal(page.rows.length, 1);
  const row = page.rows[0].cells;
  const locationIndex = page.headers.indexOf("location");
  assert.equal(row[1], templateId);
  assert.ok(row[locationIndex] === from || row[locationIndex] === to,
    "The isolated Google row is not at the expected phase.");
  const expected = [...row];
  expected[locationIndex] = from;
  const target = [...row];
  target[locationIndex] = to;
  const result = await bridge("cloudflarePatchScheduleTemplateSheet", {
    season_id: seasonId, batch_id: fixedId(label), entity_type: "SCHEDULE_TEMPLATE",
    spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id,
    items: [{ template_id: row[1], expected, target }]
  }, fixedId(label));
  assert.equal(result.status, "verified");
  assert.equal(result.entity_type, "SCHEDULE_TEMPLATE");
  assert.equal(result.spreadsheet_id, expectedSpreadsheetId);
  assert.equal(result.tab_id, page.tab_id);
  assert.deepEqual(result.verified_row_ids, [row[1]]);
  assert.equal((await sheetPage("SCHEDULE_TEMPLATE")).rows[0].cells[locationIndex], to);
  return row[locationIndex] === to ? "recovered" : "applied";
}

async function assertZeroDifference(token, scope) {
  const checked = (await api("/internal/c2/check-sheet-differences", c2Key,
    { session_token: token, season_id: seasonId, entity_type: scope })).data;
  assert.equal(checked.status, "OK");
  assert.equal(checked.findings_count, 0, `${scope} must be clean before this phase.`);
}

const health = await (await fetch(new URL("/health", base), { signal: AbortSignal.timeout(20_000) })).json();
assert.equal(health.meta?.service_version, "0.14.0-c2-operations");
assert.equal(health.meta?.writer_epoch, 0);
const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.data.result.session_token;
let outcome;
try {
  const overview = (await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId })).data;
  assert.equal(overview.schema_version, 11);
  assert.equal(overview.binding_current, true);
  if (!["verify-blocked", "restore-google"].includes(phase)) {
    assert.equal(overview.counts.open_conflicts, 0);
  }
  const allowedBatches = phase === "export-week" ? ["export_week"] :
    phase === "finish" ? ["export_practice", "export_season"] : [];
  const unfinished = overview.export_control.unfinished_batch;
  assert.equal(overview.counts.pending_batches, unfinished ? 1 : 0);
  if (unfinished) assert.ok(allowedBatches.some((label) =>
    unfinished.batch_id === expectedBatchId(label)), "An unrelated unfinished batch must not be consumed.");
  const workspace = (await api("/internal/c1/schedule-workspace", c1Key,
    { session_token: token, season_id: seasonId })).data;
  assert.equal(workspace.templates.length, 1);
  const templateId = workspace.templates[0].template_id;
  const template = await sheetPage("SCHEDULE_TEMPLATE");
  assert.equal(template.rows.length, 1);
  assert.equal(template.rows[0].cells[1], templateId);
  if (overview.counts.open_conflicts > 0) {
    assert.ok(overview.counts.open_conflicts <= 20);
    const conflicts = (await api("/internal/c2/list-sync-conflicts", c2Key,
      { session_token: token, season_id: seasonId, limit: 20 })).data;
    assert.equal(conflicts.items.length, overview.counts.open_conflicts);
    assert.ok(conflicts.items.every((item) => item.entity_type === "SCHEDULE_TEMPLATE" &&
      item.entity_id === templateId));
  }
  const templateLocation = template.rows[0].cells[template.headers.indexOf("location")];
  const testWeeks = workspace.weeks.filter((week) => week.week_start_date === weekDate);
  const testWeek = testWeeks[0];
  const testPractices = testWeek ? workspace.practices.filter((practice) => practice.week_id === testWeek.week_id) : [];
  const googleWeeks = await sheetPage("TRAINING_WEEK");
  const googlePractices = await sheetPage("PRACTICE");
  assert.equal(googleWeeks.rows.filter((row) => row.cells[googleWeeks.headers.indexOf("week_start_date")] === weekDate).length,
    testWeek ? Number(googleWeeks.rows.some((row) => row.cells[1] === testWeek.week_id)) : 0);
  assert.ok(!testWeek || googleWeeks.rows.filter((row) => row.cells[1] === testWeek.week_id).length <= 1);
  assert.ok(!testPractices[0] || googlePractices.rows.filter((row) =>
    row.cells[1] === testPractices[0].practice_id).length <= 1);
  const hasGoogleWeek = Boolean(testWeek && googleWeeks.rows.some((row) => row.cells[1] === testWeek.week_id));
  const hasGooglePractice = Boolean(testPractices[0] && googlePractices.rows.some((row) =>
    row.cells[1] === testPractices[0].practice_id));
  assert.ok(testWeeks.length <= 1 && testPractices.length <= 1);
  if (phase === "seed-week") {
    assert.ok(overview.counts.pending_outbox === 0 || overview.counts.pending_outbox === 1);
    assert.equal(testWeeks.length, overview.counts.pending_outbox);
    assert.equal(hasGoogleWeek, false);
    assert.equal(hasGooglePractice, false);
    assert.equal(templateLocation, originalLocation);
    const result = (await api("/internal/c1/prepare-training-week", c1Key, {
      request_id: fixedId("seed_week"), session_token: token, season_id: seasonId,
      season_version: 3, week_start_date: weekDate
    })).data.result;
    assert.equal(result.created, true);
    assert.equal(result.practices.length, 1);
    outcome = { status: "seeded", week_date: weekDate, private_practices: 1 };
  } else if (phase === "export-week") {
    assert.equal(overview.counts.pending_outbox, 1);
    assert.equal(testWeeks.length, 1);
    assert.equal(testPractices.length, 1);
    assert.equal(hasGooglePractice, false);
    assert.equal(templateLocation, originalLocation);
    const result = (await api("/internal/c2/export-next-schedule", c2Key, {
      request_id: fixedId("export_week"), season_id: seasonId
    })).data;
    assert.equal(result.status, "BATCH_CONFIRMED");
    assert.equal(result.entity_type, "TRAINING_WEEK");
    outcome = { status: "week_exported", batch_id: result.batch_id };
  } else if (phase === "edit-google") {
    assert.equal(overview.counts.pending_outbox, 1);
    assert.equal(hasGoogleWeek, true);
    assert.equal(hasGooglePractice, false);
    await assertZeroDifference(token, "TRAINING_WEEK");
    if (templateLocation === originalLocation) await assertZeroDifference(token, "SCHEDULE_TEMPLATE");
    await changeGoogleLocation(originalLocation, temporaryLocation, "manual_edit", templateId);
    outcome = { status: "out_of_band_edit_applied" };
  } else if (phase === "verify-blocked") {
    assert.equal(overview.counts.pending_outbox, 1);
    assert.equal(hasGoogleWeek, true);
    assert.equal(hasGooglePractice, false);
    assert.equal(templateLocation, temporaryLocation);
    await assertZeroDifference(token, "TRAINING_WEEK");
    const result = await api("/internal/c2/export-next-schedule", c2Key, {
      request_id: fixedId("blocked_attempt"), season_id: seasonId
    }, 409);
    assert.equal(result.error?.code, "SYNC_REFERENCE_NEEDS_REVIEW");
    const after = (await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId })).data;
    assert.equal(after.counts.pending_batches, 0);
    assert.equal(after.counts.pending_outbox, 1);
    const checked = (await api("/internal/c2/check-sheet-differences", c2Key,
      { session_token: token, season_id: seasonId, entity_type: "SCHEDULE_TEMPLATE" })).data;
    assert.equal(checked.status, "OK");
    assert.ok(checked.findings_count >= 1);
    outcome = { status: "blocked_without_new_batch", error_code: result.error.code,
      template_difference_detected: true };
  } else if (phase === "restore-google") {
    assert.equal(overview.counts.pending_outbox, 1);
    assert.equal(hasGoogleWeek, true);
    assert.equal(hasGooglePractice, false);
    await changeGoogleLocation(temporaryLocation, originalLocation, "manual_restore", templateId);
    await assertZeroDifference(token, "SCHEDULE_TEMPLATE");
    const after = (await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId })).data;
    assert.equal(after.counts.open_conflicts, 0);
    outcome = { status: "out_of_band_edit_restored", open_conflicts: 0 };
  } else {
    assert.ok(overview.counts.pending_outbox === 0 || overview.counts.pending_outbox === 1);
    assert.equal(hasGoogleWeek, true);
    assert.equal(templateLocation, originalLocation);
    if (overview.counts.pending_outbox === 0) assert.equal(hasGooglePractice, true);
    const practice = (await api("/internal/c2/export-next-schedule", c2Key, {
      request_id: fixedId("export_practice"), season_id: seasonId
    })).data;
    assert.equal(practice.status, "BATCH_CONFIRMED");
    assert.equal(practice.entity_type, "PRACTICE");
    const season = (await api("/internal/c2/export-next-schedule", c2Key, {
      request_id: fixedId("export_season"), season_id: seasonId
    })).data;
    assert.equal(season.status, "EVENT_CONFIRMED");
    assert.equal(season.season_version, 3);
    const after = (await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId })).data;
    assert.equal(after.counts.pending_batches, 0);
    assert.equal(after.counts.pending_outbox, 0);
    for (const entity_type of ["SEASON", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE"]) {
      const checked = (await api("/internal/c2/check-sheet-differences", c2Key,
        { session_token: token, season_id: seasonId, entity_type })).data;
      assert.equal(checked.status, "OK");
      assert.equal(checked.findings_count, 0);
    }
    outcome = { status: "completed", batch_ids: [practice.batch_id, season.batch_id],
      four_scopes_zero_difference: true, pending_batches: 0, pending_outbox: 0 };
  }
} finally {
  await api("/internal/c1/coach-logout", c1Key, { session_token: token });
}
console.log(JSON.stringify({ phase, ...outcome, coach_logged_out: true }));
