// Explicit, resumable acceptance against the disposable c2test Worker and Google file only.
// Never use this script for production or the original staging environment.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
assert.ok(["preflight", "inspect", "inspect-outbox", "backup", "coach-ready", "open-week", "export-schedule", "signup", "export-signup",
  "save-draft", "export-draft", "publish-seats", "export-revision", "final"].includes(phase),
"Choose one isolated associated acceptance phase.");
if (!["preflight", "inspect", "inspect-outbox", "backup", "coach-ready", "final"].includes(phase)) {
  assert.ok(process.argv.includes("--write-test-data"), "Explicit --write-test-data is required.");
}
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.href, "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
const spreadsheetId = process.env.C2_RUNTIME_SHEET_ID;
assert.ok(c1Key && c2Key && spreadsheetId, "Isolated keys and Sheet identity are required.");
const privateRoot = new URL("../../.c2-form-test/", import.meta.url);
const { coach_code: coachCode } = JSON.parse(readFileSync(new URL("review-private.json", privateRoot), "utf8"));
const { GOOGLE_BRIDGE_URL: bridgeUrlText, GOOGLE_BRIDGE_SECRET: bridgeSecret } = JSON.parse(
  readFileSync(new URL("worker-secrets.json", privateRoot), "utf8"));
const identities = JSON.parse(readFileSync(new URL("isolated-identities.json", privateRoot), "utf8"));
const privateConfig = JSON.parse(readFileSync(new URL("private-test-config.json", privateRoot), "utf8"));
assert.equal(privateConfig.fixture.seasonId, "season_c2_isolated_2026");
assert.equal(privateConfig.fixture.runtimeSheetId, spreadsheetId);
assert.ok(coachCode && bridgeSecret && /^[A-Za-z0-9_-]{30,}$/u.test(identities.deployment_id));
const bridgeUrl = new URL(bridgeUrlText);
assert.equal(bridgeUrl.protocol, "https:");
assert.equal(bridgeUrl.hostname, "script.google.com");
assert.ok(bridgeUrl.pathname.includes(identities.deployment_id), "Google deployment identity changed.");

const seasonId = "season_c2_isolated_2026";
const teamId = "pentasus-c2-test";
const weekDate = "2026-10-05";
const requestId = (label) => `c2_assoc_${label}_${randomUUID().replaceAll("-", "")}`;
const fixedId = (label) => `c2_assoc_20260930_${label}`;
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => `sha256_v1:${createHash("sha256").update(value).digest("base64url")}`;
const scopes = {
  SIGNUP: { tab: "SignupsCurrent", headers: ["season_id", "practice_id", "member_id", "preference",
    "status", "queue_at", "queue_sequence", "updated_at", "last_request_id"] },
  SEAT_PLAN_DRAFT: { tab: "SeatPlanState", headers: ["season_id", "practice_id", "seat_plan_version",
    "coach_member_id", "steerer_member_id", "published_revision", "frozen_revision", "frozen_at",
    "updated_by", "updated_at"] },
  SEAT_PLAN_CURRENT: { tab: "SeatPlanCurrent", headers: ["season_id", "practice_id", "row_number",
    "side", "member_id", "seat_plan_version", "updated_by", "updated_at"] },
  SEAT_PLAN_REVISION: { tab: "SeatPlanRevisions", headers: ["season_id", "practice_id",
    "revision_number", "revision_id", "source", "seat_plan_version", "coach_member_id",
    "steerer_member_id", "seats_json", "names_json", "published_by", "published_at", "request_id"] }
};

async function api(path, key, payload) {
  const response = await fetch(new URL(path, base), { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId("api"), ...payload }), signal: AbortSignal.timeout(45_000) });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  if (!response.ok || !body.ok) throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  return body.data;
}
async function publicRead(path) {
  const url = new URL(path, base);
  url.searchParams.set("request_id", requestId("read"));
  url.searchParams.set("season_id", seasonId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${c1Key}` },
    signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return body.data;
}
async function publicPractice(practiceId) {
  const url = new URL("/internal/c1/public-practice", base);
  url.searchParams.set("request_id", requestId("practice"));
  url.searchParams.set("season_id", seasonId);
  url.searchParams.set("practice_id", practiceId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${c1Key}` },
    signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return body.data;
}
async function bridgeRead(scope) {
  const payload_json = JSON.stringify({ season_id: seasonId, entity_type: scope });
  const request = { action: "cloudflareReadSheetRecords", request_id: requestId("bridge"),
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE", team_id: teamId,
    binding_version: `${seasonId}:1`, writer_epoch: 0, timestamp_ms: Date.now(),
    nonce: requestId("nonce"), operation_id: requestId("operation"), payload_json,
    payload_digest: createHash("sha256").update(payload_json).digest("base64url") };
  const signature = createHmac("sha256", bridgeSecret).update([
    request.protocol_version, request.direction, request.team_id, request.binding_version,
    request.writer_epoch, request.timestamp_ms, request.nonce, request.operation_id,
    request.payload_digest
  ].join("\n")).digest("base64url");
  const response = await fetch(bridgeUrl, { method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...request, signature }), redirect: "follow", signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${scope}: ${body.error?.code}`);
  assert.equal(body.ok, true, `${scope}: ${body.error?.code}`);
  assert.equal(body.meta?.request_id, request.request_id);
  const page = body.data;
  assert.equal(page.team_id, teamId);
  assert.equal(page.season_id, seasonId);
  assert.equal(page.entity_type, scope);
  assert.equal(page.binding_version, 1);
  assert.equal(page.writer_epoch, 0);
  assert.equal(page.operation_id, request.operation_id);
  assert.equal(page.payload_digest, request.payload_digest);
  assert.equal(page.spreadsheet_id, scope === "COACH" || scope === "SEASON" ?
    privateConfig.fixture.systemSheetId : spreadsheetId);
  if (scopes[scope]) {
    assert.equal(page.tab_name, scopes[scope].tab);
    assert.deepEqual(page.headers, scopes[scope].headers);
  }
  assert.ok(/^\d+$/u.test(page.tab_id));
  assert.ok(Array.isArray(page.rows));
  if (scope !== "COACH") assert.ok(page.rows.every((row) => row.cells?.[0] === seasonId));
  return page;
}
function matchingWeek(workspace) {
  const weeks = workspace.weeks.filter((week) => week.week_start_date === weekDate);
  assert.equal(weeks.length, 1, "The isolated acceptance week changed.");
  const practices = workspace.practices.filter((practice) => practice.week_id === weeks[0].week_id);
  assert.equal(practices.length, 1, "The isolated acceptance week must have one practice.");
  assert.match(practices[0].location, /^C2 /u, "Only the fictitious practice may be used.");
  return { week: weeks[0], practice: practices[0] };
}
async function assertClean(token, compared) {
  const inspected = {};
  for (const entity_type of compared) {
    const checked = await api("/internal/c2/check-sheet-differences", c2Key,
      { session_token: token, season_id: seasonId, entity_type });
    assert.equal(checked.status, "OK", `${entity_type} inspection status`);
    assert.equal(checked.findings_count, 0, `${entity_type} B/C/G findings`);
    assert.equal(checked.truncated, false);
    inspected[entity_type] = checked.rows_read;
  }
  return inspected;
}
async function assertCoachReady() {
  const seasons = await bridgeRead("SEASON");
  assert.equal(seasons.rows.length, 1, "System Sheet must contain only the isolated season.");
  assert.equal(seasons.rows[0].cells[0], seasonId);
  const coaches = await bridgeRead("COACH");
  assert.equal(coaches.rows.length, 1, "System Sheet must contain only one isolated Coach reference.");
  assert.equal(coaches.rows[0].cells[0], "coach_c2_isolated_2026");
  return { system_seasons: 1, google_coach_references: 1 };
}
async function associatedEvent(token, overview, topic, label) {
  assert.ok([0, 1].includes(overview.counts.pending_batches));
  assert.equal(overview.counts.open_conflicts, 0);
  assert.equal(overview.export_control.retry?.action_required ?? false, false);
  if (overview.counts.pending_outbox === 0) return { status: "ALREADY_CONFIRMED", calls: [] };
  assert.equal(overview.counts.pending_outbox, 1);
  assert.equal(overview.export_control.oldest_pending.topic, topic);
  const dueAt = overview.export_control.oldest_pending.due_at;
  if (overview.counts.pending_batches === 0 && Date.parse(dueAt) > Date.now()) {
    return { status: "WAITING_FOR_DUE", due_at: dueAt, calls: [] };
  }
  const calls = [];
  for (let index = 1; index <= 12; index += 1) {
    const exported = await api("/internal/c2/export-next-associated", c2Key,
      { request_id: fixedId(`${label}_${index}`), season_id: seasonId });
    assert.ok(["BATCH_CONFIRMED", "EVENT_CONFIRMED"].includes(exported.status),
      `Unexpected associated export status: ${exported.status}`);
    calls.push({ status: exported.status, entity_type: exported.entity_type ?? null });
    if (exported.status === "EVENT_CONFIRMED") break;
  }
  assert.equal(calls.at(-1).status, "EVENT_CONFIRMED",
    "The associated event did not finish within 12 bounded calls.");
  const after = await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(after.counts.pending_outbox, 0);
  assert.equal(after.counts.pending_batches, 0);
  assert.equal(after.counts.open_conflicts, 0);
  return { status: "EVENT_CONFIRMED", calls };
}
function acceptanceMember(roster, name) {
  const matches = roster.members.filter((member) => member.display_name === name);
  assert.equal(matches.length, 1, `The isolated fixture must contain exactly one ${name}.`);
  return matches[0];
}

const healthResponse = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(20_000) });
const health = await healthResponse.json();
assert.equal(healthResponse.status, 200);
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.ok(["0.16.0-c2-associated-export", "0.16.1-c2-associated-export"].includes(
  health.meta?.service_version), "Only the original c2test build or reviewed hotfix is allowed.");
if (["export-draft", "publish-seats", "export-revision", "final"].includes(phase)) {
  assert.equal(health.meta?.service_version, "0.16.1-c2-associated-export",
    "The reviewed c2test hotfix must be deployed before seating export resumes.");
}
assert.equal(health.meta?.writer_epoch, 0);
const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.result.session_token;
let result;
try {
  const overview = await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(overview.schema_version, 13);
  assert.equal(overview.binding_current, true);
  assert.equal(overview.binding.binding_version, 1);
  assert.equal(overview.counts.open_conflicts, 0);
  assert.equal(overview.export_control.status, "RUNNING");
  assert.equal(overview.export_control.pause_requested, false);
  const roster = await publicRead("/internal/c1/public-roster");
  assert.equal(roster.members.length, 10);
  assert.ok(roster.members.every((member) => /^C2 Test Member /u.test(member.display_name)),
    "The isolated roster has a non-fictitious member.");
  const schedule = await publicRead("/internal/c1/public-schedule");
  const workspace = await api("/internal/c1/schedule-workspace", c1Key,
    { session_token: token, season_id: seasonId });
  const { week, practice } = matchingWeek(workspace);
  if (phase === "inspect") {
    const sheet = {};
    for (const scope of Object.keys(scopes)) {
      const page = await bridgeRead(scope);
      sheet[scope] = { rows: page.rows.length, tab_id_present: true };
    }
    const coaches = await bridgeRead("COACH");
    const googleWeeks = await bridgeRead("TRAINING_WEEK");
    const googleWeek = googleWeeks.rows.find((row) => row.cells[1] === week.week_id);
    const confirmedBy = googleWeek?.cells[googleWeeks.headers.indexOf("confirmed_by")] ?? "";
    result = { phase, service_version: health.meta.service_version,
      schema_version: overview.schema_version, week_status: week.status,
      practice_version: practice.practice_version, signup_version: practice.signup_version,
      public_practices: schedule.practices.length, pending_outbox: overview.counts.pending_outbox,
      pending_batches: overview.counts.pending_batches,
      oldest_pending: overview.export_control.oldest_pending,
      export_retry: overview.export_control.retry, sheet,
      google_coaches: coaches.rows.length,
      confirmed_by_in_google: Boolean(confirmedBy) &&
        coaches.rows.some((row) => row.cells[0] === confirmedBy) };
  } else if (phase === "inspect-outbox") {
    assert.equal(overview.counts.pending_outbox, 1);
    assert.equal(overview.counts.pending_batches, 0);
    const created = await api("/internal/c1/create-backup-snapshot", c1Key,
      { session_token: token });
    const manifest = created.result.manifest;
    assert.equal(manifest.schema_version, 13);
    const verified = await api("/internal/c1/verify-backup-snapshot", c1Key,
      { session_token: token, snapshot_id: manifest.snapshot_id,
        content_digest: manifest.content_digest });
    assert.equal(verified.verified, true);
    const table = manifest.tables.find((item) => item.name === "sync_outbox");
    assert.ok(table);
    const rows = [];
    for (const chunk_index of table.chunk_indices) {
      const chunk = await api("/internal/c1/get-backup-chunk", c1Key,
        { session_token: token, snapshot_id: manifest.snapshot_id, chunk_index });
      assert.equal(chunk.chunk.table_name, "sync_outbox");
      rows.push(...chunk.chunk.payload.rows);
    }
    const pending = rows.filter((row) => row.status === "PENDING" &&
      JSON.parse(row.payload_json).entity?.season_id === seasonId);
    assert.equal(pending.length, 1);
    const payload = JSON.parse(pending[0].payload_json);
    const entity = payload.entity;
    const seats = entity.seating_snapshot?.draft_seats;
    const sample = (row) => Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) =>
      [key, { type: typeof value, value: key === "member_id" ? (value ? "<fixture-member-id>" : "") : value }]));
    result = { phase, snapshot_verified: true, topic: pending[0].topic,
      action: payload.action, snapshot_schema: entity.snapshot_schema,
      seat_plan_version: entity.seat_plan_version,
      entity_has_published_revision: Object.hasOwn(entity, "published_revision"),
      published_revision: entity.published_revision,
      state_published_revision: entity.seating_snapshot?.state?.published_revision,
      state_updated_by: entity.seating_snapshot?.state?.updated_by,
      state_updated_by_type: typeof entity.seating_snapshot?.state?.updated_by,
      state_updated_at_type: typeof entity.seating_snapshot?.state?.updated_at,
      draft_seats_type: Array.isArray(seats) ? "array" : typeof seats,
      draft_seats_length: seats?.length ?? null,
      first_draft: sample(seats?.[0]), last_draft: sample(seats?.at(-1)),
      revision: entity.seating_snapshot?.revision === null ? null : "present",
      pending_batches: overview.counts.pending_batches };
  } else if (phase === "backup") {
    assert.ok(process.argv.includes("--capture-private-backup"),
      "Explicit --capture-private-backup is required.");
    assert.equal(overview.counts.pending_outbox, 1);
    assert.equal(overview.counts.pending_batches, 0);
    assert.equal(overview.export_control.oldest_pending.topic, "SEATING_CHANGED");
    const created = await api("/internal/c1/create-backup-snapshot", c1Key,
      { session_token: token });
    const manifest = created.result.manifest;
    assert.equal(manifest.schema_version, 13);
    const tables = new Set(manifest.tables.map((table) => table.name));
    assert.ok(tables.has("sync_associated_cursors") &&
      tables.has("sync_associated_physical_baselines"));
    const verified = await api("/internal/c1/verify-backup-snapshot", c1Key,
      { session_token: token, snapshot_id: manifest.snapshot_id,
        content_digest: manifest.content_digest });
    assert.equal(verified.verified, true);
    const chunks = [];
    for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index += 1) {
      const read = await api("/internal/c1/get-backup-chunk", c1Key,
        { session_token: token, snapshot_id: manifest.snapshot_id, chunk_index });
      assert.equal(read.chunk.payload_digest, digest(canonicalJson(read.chunk.payload)));
      chunks.push(read.chunk);
    }
    const artifactDir = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
    mkdirSync(fileURLToPath(artifactDir), { recursive: true });
    writeFileSync(new URL(`${manifest.snapshot_id}.json`, artifactDir),
      `${JSON.stringify({ manifest, chunks }, null, 2)}\n`, { flag: "wx" });
    result = { phase, schema_version: manifest.schema_version, chunk_count: chunks.length,
      verified: true, downloaded_private: true,
      pending_outbox: overview.counts.pending_outbox, pending_batches: 0 };
  } else if (phase === "coach-ready") {
    result = { phase, ...(await assertCoachReady()),
      pending_outbox: overview.counts.pending_outbox, pending_batches: overview.counts.pending_batches };
  } else if (phase === "preflight") {
    assert.equal(overview.counts.pending_outbox, 0);
    assert.equal(overview.counts.pending_batches, 0);
    assert.equal(overview.export_control.retry, null);
    assert.equal(week.status, "DRAFT");
    assert.equal(schedule.practices.length, 0);
    const sheet = {};
    for (const scope of Object.keys(scopes)) {
      const page = await bridgeRead(scope);
      sheet[scope] = { rows: page.rows.length, tab_id_present: true };
    }
    result = { phase, service_version: health.meta.service_version, schema_version: overview.schema_version,
      pending_outbox: 0, public_practices: 0, roster_members: 10,
      practice_version: practice.practice_version, week_version: week.week_version,
      left_capacity: practice.left_capacity, right_capacity: practice.right_capacity, sheet };
  } else if (phase === "open-week") {
    assert.equal(overview.counts.pending_outbox, 0);
    assert.equal(overview.counts.pending_batches, 0);
    assert.equal(week.status, "DRAFT");
    assert.equal(schedule.practices.length, 0);
    const opened = await api("/internal/c1/confirm-training-week", c1Key, {
      request_id: fixedId("open_week"), session_token: token, season_id: seasonId,
      week_id: week.week_id, week_version: week.week_version
    });
    assert.equal(opened.result.week.status, "OPENED");
    assert.equal(opened.result.practices.length, 1);
    const visible = await publicRead("/internal/c1/public-schedule");
    assert.equal(visible.practices.length, 1);
    assert.equal(visible.practices[0].practice_id, practice.practice_id);
    const after = await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId });
    assert.equal(after.counts.pending_outbox, 1);
    assert.equal(after.export_control.oldest_pending.topic, "SCHEDULE_CHANGED");
    result = { phase, status: opened.result.week.status,
      public_practices: visible.practices.length, pending_outbox: after.counts.pending_outbox,
      due_at: after.export_control.oldest_pending.due_at };
  } else if (phase === "export-schedule") {
    assert.equal(week.status, "OPENED");
    await assertCoachReady();
    assert.equal(schedule.practices.length, 1);
    assert.equal(overview.counts.pending_batches, 0);
    const pending = overview.export_control.oldest_pending;
    assert.equal(overview.counts.pending_outbox, 1);
    assert.equal(pending.topic, "SCHEDULE_CHANGED");
    assert.ok(Date.parse(pending.due_at) <= Date.now(), "The schedule outbox is not due yet.");
    const calls = [];
    for (let index = 1; index <= 12; index += 1) {
      const exported = await api("/internal/c2/export-next-schedule", c2Key,
        { request_id: fixedId(`export_schedule_${index}`), season_id: seasonId });
      assert.ok(["BATCH_CONFIRMED", "EVENT_CONFIRMED"].includes(exported.status),
        `Unexpected schedule export status: ${exported.status}`);
      calls.push({ status: exported.status, entity_type: exported.entity_type ?? null });
      if (exported.status === "EVENT_CONFIRMED") break;
    }
    assert.equal(calls.at(-1).status, "EVENT_CONFIRMED", "Schedule event did not finish within 12 calls.");
    const after = await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId });
    assert.equal(after.counts.pending_outbox, 0);
    assert.equal(after.counts.pending_batches, 0);
    assert.equal(after.counts.open_conflicts, 0);
    const compared = await assertClean(token,
      ["SEASON", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE"]);
    const googleWeek = await bridgeRead("TRAINING_WEEK");
    const googlePractice = await bridgeRead("PRACTICE");
    assert.equal(googleWeek.rows.filter((row) => row.cells[1] === week.week_id).length, 1);
    assert.equal(googlePractice.rows.filter((row) => row.cells[1] === practice.practice_id).length, 1);
    result = { phase, calls, pending_outbox: 0, pending_batches: 0,
      google_week_rows: googleWeek.rows.length, google_practice_rows: googlePractice.rows.length,
      compared };
  } else if (phase === "signup") {
    assert.equal(week.status, "OPENED");
    assert.equal(overview.counts.pending_batches, 0);
    await assertClean(token, ["SEASON", "TRAINING_WEEK", "PRACTICE"]);
    const before = await publicPractice(practice.practice_id);
    const member = acceptanceMember(roster, "C2 Test Member Alpha");
    assert.equal(before.practice.practice_version, 2);
    if (before.signup_version === 0) {
      assert.equal(overview.counts.pending_outbox, 0);
      assert.equal(before.signup_open, true);
      assert.equal(before.signups.length, 0);
      assert.equal((await bridgeRead("SIGNUP")).rows.length, 0);
      const saved = await api("/internal/c1/signup", c1Key, {
        request_id: fixedId("signup_alpha"), season_id: seasonId,
        practice_id: practice.practice_id, member_id: member.member_id,
        practice_version: before.practice.practice_version,
        signup_version: before.signup_version, preference: "LEFT"
      });
      assert.equal(saved.result.signup_version, 1);
      assert.equal(saved.result.signup.member_id, member.member_id);
      assert.equal(saved.result.signup.status, "CONFIRMED");
    } else {
      assert.equal(overview.counts.pending_outbox, 1);
      assert.equal(overview.export_control.oldest_pending.topic, "SIGNUPS_CHANGED");
      assert.equal(before.signup_version, 1,
        "An existing unrelated signup version prevents fixture replay.");
      assert.equal(before.signups.length, 1);
      assert.equal(before.signups[0].member_id, member.member_id);
      assert.equal(before.signups[0].status, "CONFIRMED");
      assert.equal(before.signups[0].preference, "LEFT");
    }
    const after = await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId });
    assert.equal(after.counts.pending_outbox, 1);
    assert.equal(after.counts.pending_batches, 0);
    assert.equal(after.export_control.oldest_pending.topic, "SIGNUPS_CHANGED");
    result = { phase, signup_version: 1, preference: "LEFT", member: "C2 Test Member Alpha",
      pending_outbox: 1, due_at: after.export_control.oldest_pending.due_at };
  } else if (phase === "export-signup") {
    assert.equal(week.status, "OPENED");
    const member = acceptanceMember(roster, "C2 Test Member Alpha");
    const current = await publicPractice(practice.practice_id);
    assert.equal(current.signup_version, 1);
    assert.equal(current.signups.length, 1);
    assert.equal(current.signups[0].member_id, member.member_id);
    const exported = await associatedEvent(token, overview, "SIGNUPS_CHANGED", "export_signup");
    if (exported.status === "WAITING_FOR_DUE") {
      result = { phase, ...exported, pending_outbox: 1 };
    } else {
      const google = await bridgeRead("SIGNUP");
      const matches = google.rows.filter((row) => row.cells[1] === practice.practice_id);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].cells[2], member.member_id);
      assert.equal(matches[0].cells[3], "LEFT");
      assert.equal(matches[0].cells[4], "CONFIRMED");
      const compared = await assertClean(token, ["SIGNUP"]);
      result = { phase, ...exported, google_signup_rows: matches.length, compared,
        pending_outbox: 0 };
    }
  } else if (phase === "save-draft") {
    assert.equal(week.status, "OPENED");
    assert.equal(overview.counts.pending_batches, 0);
    assert.equal((await bridgeRead("SIGNUP")).rows.filter((row) =>
      row.cells[1] === practice.practice_id).length, 1);
    const member = acceptanceMember(roster, "C2 Test Member Alpha");
    const seating = await api("/internal/c1/get-seating-workspace", c1Key,
      { session_token: token, season_id: seasonId, practice_id: practice.practice_id });
    assert.equal(seating.mode, "UPCOMING");
    assert.equal(seating.signup_version, 1);
    assert.equal(seating.practice.practice_version, 2);
    assert.equal(seating.published_revision, 0);
    assert.equal(seating.signups.length, 1);
    assert.equal(seating.signups[0].member_id, member.member_id);
    if (seating.seat_plan_version === 0) {
      assert.equal(overview.counts.pending_outbox, 0);
      assert.equal(seating.draft.seats.length, 0);
      assert.equal((await bridgeRead("SEAT_PLAN_CURRENT")).rows.length, 0);
      const seats = [];
      for (let row_number = 1; row_number <= 10; row_number += 1) {
        for (const side of ["LEFT", "RIGHT"]) seats.push({ row_number, side,
          member_id: row_number === 1 && side === "LEFT" ? member.member_id : "" });
      }
      const saved = await api("/internal/c1/save-seat-plan-draft", c1Key, {
        request_id: fixedId("save_draft"), session_token: token, season_id: seasonId,
        practice_id: practice.practice_id, practice_version: seating.practice.practice_version,
        signup_version: seating.signup_version, seat_plan_version: seating.seat_plan_version,
        coach_member_id: "", steerer_member_id: "", seats, change_kind: "EDIT"
      });
      assert.equal(saved.result.seat_plan_version, 1);
    } else {
      assert.equal(overview.counts.pending_outbox, 1);
      assert.equal(overview.export_control.oldest_pending.topic, "SEATING_CHANGED");
      assert.equal(seating.seat_plan_version, 1,
        "An existing unrelated seat plan version prevents fixture replay.");
      assert.equal(seating.draft.seats.length, 1);
      assert.equal(seating.draft.seats[0].member_id, member.member_id);
    }
    const after = await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId });
    assert.equal(after.counts.pending_outbox, 1);
    assert.equal(after.export_control.oldest_pending.topic, "SEATING_CHANGED");
    result = { phase, seat_plan_version: 1, occupied_seats: 1, pending_outbox: 1,
      due_at: after.export_control.oldest_pending.due_at };
  } else if (phase === "export-draft") {
    const seating = await api("/internal/c1/get-seating-workspace", c1Key,
      { session_token: token, season_id: seasonId, practice_id: practice.practice_id });
    assert.equal(seating.seat_plan_version, 1);
    assert.equal(seating.published_revision, 0);
    const exported = await associatedEvent(token, overview, "SEATING_CHANGED", "export_draft_hotfix");
    if (exported.status === "WAITING_FOR_DUE") {
      result = { phase, ...exported, pending_outbox: 1 };
    } else {
      const current = await bridgeRead("SEAT_PLAN_CURRENT");
      const seats = current.rows.filter((row) => row.cells[1] === practice.practice_id);
      assert.equal(seats.length, 20);
      const member = acceptanceMember(roster, "C2 Test Member Alpha");
      assert.equal(seats.filter((row) => row.cells[4] !== "").length, 1);
      assert.ok(seats.some((row) => row.cells[2] === "1" && row.cells[3] === "LEFT" &&
        row.cells[4] === member.member_id && row.cells[5] === "1"));
      const state = await bridgeRead("SEAT_PLAN_DRAFT");
      const matches = state.rows.filter((row) => row.cells[1] === practice.practice_id);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].cells[2], "1");
      assert.equal(matches[0].cells[5], "0");
      const compared = await assertClean(token, ["SEAT_PLAN_DRAFT"]);
      result = { phase, ...exported, google_current_seats: seats.length,
        google_state_rows: matches.length, compared, pending_outbox: 0 };
    }
  } else if (phase === "publish-seats") {
    assert.equal(overview.counts.pending_batches, 0);
    const seating = await api("/internal/c1/get-seating-workspace", c1Key,
      { session_token: token, season_id: seasonId, practice_id: practice.practice_id });
    assert.equal(seating.seat_plan_version, 1);
    assert.equal(seating.signup_version, 1);
    assert.equal(seating.practice.practice_version, 2);
    if (seating.published_revision === 0) {
      assert.equal(overview.counts.pending_outbox, 0);
      assert.equal(seating.draft.seats.length, 1);
      const published = await api("/internal/c1/publish-seat-plan", c1Key, {
        request_id: fixedId("publish_seats"), session_token: token, season_id: seasonId,
        practice_id: practice.practice_id, practice_version: seating.practice.practice_version,
        signup_version: seating.signup_version, seat_plan_version: seating.seat_plan_version,
        published_revision: seating.published_revision,
        acknowledge_preference_mismatch: false
      });
      assert.equal(published.result.published_revision, 1);
    } else {
      assert.equal(overview.counts.pending_outbox, 1);
      assert.equal(overview.export_control.oldest_pending.topic, "SEATING_CHANGED");
      assert.equal(seating.published_revision, 1,
        "An existing unrelated published revision prevents fixture replay.");
    }
    const after = await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId });
    assert.equal(after.counts.pending_outbox, 1);
    assert.equal(after.export_control.oldest_pending.topic, "SEATING_CHANGED");
    result = { phase, published_revision: 1, pending_outbox: 1,
      due_at: after.export_control.oldest_pending.due_at };
  } else if (phase === "export-revision") {
    const seating = await api("/internal/c1/get-seating-workspace", c1Key,
      { session_token: token, season_id: seasonId, practice_id: practice.practice_id });
    assert.equal(seating.seat_plan_version, 1);
    assert.equal(seating.published_revision, 1);
    const exported = await associatedEvent(token, overview, "SEATING_CHANGED", "export_revision");
    if (exported.status === "WAITING_FOR_DUE") {
      result = { phase, ...exported, pending_outbox: 1 };
    } else {
      const revisions = await bridgeRead("SEAT_PLAN_REVISION");
      const matches = revisions.rows.filter((row) => row.cells[1] === practice.practice_id);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].cells[2], "1");
      assert.equal(matches[0].cells[5], "1");
      const revisionSeats = JSON.parse(matches[0].cells[8]);
      assert.equal(revisionSeats.length, 1);
      assert.equal(revisionSeats[0].member_id,
        acceptanceMember(roster, "C2 Test Member Alpha").member_id);
      assert.equal(revisionSeats[0].side, "LEFT");
      assert.equal(revisionSeats[0].row_number, 1);
      const states = await bridgeRead("SEAT_PLAN_DRAFT");
      const state = states.rows.filter((row) => row.cells[1] === practice.practice_id);
      assert.equal(state.length, 1);
      assert.equal(state[0].cells[5], "1");
      const compared = await assertClean(token, ["SEAT_PLAN_DRAFT"]);
      result = { phase, ...exported, google_revisions: matches.length,
        google_published_revision: state[0].cells[5], compared, pending_outbox: 0 };
    }
  } else if (phase === "final") {
    assert.equal(overview.counts.pending_outbox, 0);
    assert.equal(overview.counts.pending_batches, 0);
    assert.equal(overview.counts.open_conflicts, 0);
    assert.equal(overview.export_control.retry, null);
    const compared = await assertClean(token,
      ["SEASON", "MEMBER", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE",
        "SIGNUP", "SEAT_PLAN_DRAFT"]);
    const current = await publicPractice(practice.practice_id);
    const seats = await bridgeRead("SEAT_PLAN_CURRENT");
    const revisions = await bridgeRead("SEAT_PLAN_REVISION");
    const members = seats.rows.filter((row) => row.cells[1] === practice.practice_id && row.cells[4]);
    assert.equal(current.signup_version, 1);
    assert.equal(current.seat_plan.status, "PUBLISHED");
    assert.equal(members.length, 1);
    assert.equal(revisions.rows.filter((row) => row.cells[1] === practice.practice_id).length, 1);
    result = { phase, compared, pending_outbox: 0, published_revision: 1,
      google_occupied_seats: members.length, google_revisions: 1 };
  } else {
    throw new Error(`Phase ${phase} has not yet passed the read-only gate.`);
  }
} finally {
  await api("/internal/c1/coach-logout", c1Key, { session_token: token });
}
console.log(JSON.stringify({ status: "passed", ...result, coach_logged_out: true }));
