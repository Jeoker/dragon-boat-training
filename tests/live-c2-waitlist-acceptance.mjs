// Explicit c2test-only acceptance. No execution through npm test; no production fallback.
// A private journal preserves original request payloads and immutable outbox snapshots.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
const stepArg = process.argv.find((arg) => arg.startsWith("--step="))?.slice(7);
const maxCallsArg = process.argv.find((arg) => arg.startsWith("--max-calls="))?.slice(12);
const maxCalls = maxCallsArg === undefined ? 12 : Number(maxCallsArg);
// Assertions can contain private identities/cells. Keep failures redacted too.
process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ status: "FAILED_STOP", phase,
    error_code: error.message?.startsWith("DATA_PRECONDITION_REQUIRED") ? "DATA_PRECONDITION_REQUIRED" :
      error.code === "ERR_ASSERTION" ? "PRECONDITION_OR_EVIDENCE_MISMATCH" : "REQUEST_OR_LOCAL_IO_FAILED",
    next_action: "Inspect the private journal and server state; do not create a replacement request or bypass the gate." }));
  process.exitCode = 1;
});
assert.ok(["preflight", "backup", "enqueue", "audit-queued", "export", "cancel", "final"].includes(phase),
  "Choose one waitlist acceptance phase.");
assert.ok(maxCallsArg === undefined || phase === "export", "--max-calls is only valid for export.");
assert.ok(Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 12, "--max-calls must be 1 through 12.");
if (["enqueue", "export", "cancel"].includes(phase)) {
  assert.ok(process.argv.includes("--write-test-data"), "Explicit --write-test-data is required.");
}
if (["backup", "audit-queued", "final"].includes(phase)) {
  assert.ok(process.argv.includes("--capture-private-backup"), "Explicit private backup flag required.");
}
const worker = new URL(process.env.C2_TEST_URL || "");
assert.equal(worker.href, "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/");
const seasonId = "season_c2_isolated_2026";
const teamId = "pentasus-c2-test";
const version = "0.16.2-c2-physical-diagnostics";
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
const privateRoot = new URL("../../.c2-form-test/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("private-test-config.json", privateRoot), "utf8")).fixture;
const identities = JSON.parse(readFileSync(new URL("isolated-identities.json", privateRoot), "utf8"));
const { coach_code: coachCode } = JSON.parse(readFileSync(new URL("review-private.json", privateRoot), "utf8"));
const { GOOGLE_BRIDGE_URL: bridgeText, GOOGLE_BRIDGE_SECRET: bridgeSecret } = JSON.parse(
  readFileSync(new URL("worker-secrets.json", privateRoot), "utf8"));
const bridge = new URL(bridgeText);
assert.equal(fixture.seasonId, seasonId);
assert.equal(fixture.runtimeSheetId, process.env.C2_RUNTIME_SHEET_ID);
assert.ok(fixture.systemSheetId && fixture.runtimeSheetId !== fixture.systemSheetId);
assert.ok(c1Key && c2Key && coachCode && bridgeSecret);
assert.equal(bridge.protocol, "https:");
assert.equal(bridge.hostname, "script.google.com");
assert.match(identities.deployment_id, /^[A-Za-z0-9_-]{30,}$/u);
assert.ok(bridge.pathname.includes(identities.deployment_id));
const config = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
assert.equal(config.env.c2test.name, "dragon-boat-training-api-c2-test");
assert.equal(config.env.c2test.vars.SERVICE_VERSION, version);
assert.equal(config.env.c2test.vars.TEAM_ID, teamId);
assert.equal(config.env.c2test.vars.C2_ASSOCIATED_EXPORT_ENABLED, "true");
assert.equal(config.env.c2test.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.deepEqual(config.env.c2test.triggers.crons, []);
for (const vars of [config.vars, config.env.production.vars]) {
  assert.equal(vars.C2_EXPORT_POLL_ENABLED, "false");
  assert.equal(vars.C2_ASSOCIATED_EXPORT_ENABLED, "false");
}
const artifactDir = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
const journalFile = new URL("c2-waitlist-journal.json", artifactDir);
const id = (label) => `c2_wait_${label}_${randomUUID().replaceAll("-", "")}`;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => `sha256_v1:${createHash("sha256").update(value).digest("base64url")}`;
const scopes = {
  SIGNUP: { tab: "SignupsCurrent", headers: ["season_id", "practice_id", "member_id", "preference",
    "status", "queue_at", "queue_sequence", "updated_at", "last_request_id"] },
  SEAT_PLAN_DRAFT: { tab: "SeatPlanState", headers: ["season_id", "practice_id", "seat_plan_version",
    "coach_member_id", "steerer_member_id", "published_revision", "frozen_revision", "frozen_at",
    "updated_by", "updated_at"] },
  SEAT_PLAN_CURRENT: { tab: "SeatPlanCurrent", headers: ["season_id", "practice_id", "row_number", "side",
    "member_id", "seat_plan_version", "updated_by", "updated_at"] },
  SEAT_PLAN_REVISION: { tab: "SeatPlanRevisions", headers: ["season_id", "practice_id", "revision_number",
    "revision_id", "source", "seat_plan_version", "coach_member_id", "steerer_member_id", "seats_json",
    "names_json", "published_by", "published_at", "request_id"] }
};
const cell = (value) => value === null || value === undefined ? "" : String(value);
const cellsFor = (scope, row) => scopes[scope].headers.map((key) => cell(row[key]));
function saveJournal(journal) {
  mkdirSync(fileURLToPath(artifactDir), { recursive: true });
  const temporary = new URL("c2-waitlist-journal.tmp", artifactDir);
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(temporary, journalFile);
}
async function api(path, key, payload) {
  const response = await fetch(new URL(path, worker), { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: id("api"), ...payload }), signal: AbortSignal.timeout(45_000) });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(body.meta?.service_version, version);
  assert.equal(body.meta?.writer_epoch, 0);
  if (!response.ok || !body.ok) throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  return body.data;
}
async function readPublic(path, practiceId) {
  const url = new URL(path, worker);
  url.searchParams.set("request_id", id("public"));
  url.searchParams.set("season_id", seasonId);
  if (practiceId) url.searchParams.set("practice_id", practiceId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${c1Key}` },
    signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(body.meta?.service_version, version);
  return body.data;
}
async function bridgeRead(scope) {
  const payload_json = JSON.stringify({ season_id: seasonId, entity_type: scope });
  const request = { action: "cloudflareReadSheetRecords", request_id: id("bridge"),
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE", team_id: teamId,
    binding_version: `${seasonId}:1`, writer_epoch: 0, timestamp_ms: Date.now(), nonce: id("nonce"),
    operation_id: id("operation"), payload_json,
    payload_digest: createHash("sha256").update(payload_json).digest("base64url") };
  const signature = createHmac("sha256", bridgeSecret).update([request.protocol_version, request.direction,
    request.team_id, request.binding_version, request.writer_epoch, request.timestamp_ms, request.nonce,
    request.operation_id, request.payload_digest].join("\n")).digest("base64url");
  const response = await fetch(bridge, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...request, signature }), redirect: "follow", signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true, `${scope}: ${body.error?.code}`);
  assert.equal(body.meta?.request_id, request.request_id);
  const page = body.data;
  for (const [key, expected] of Object.entries({ season_id: seasonId, team_id: teamId,
    binding_version: 1, writer_epoch: 0, entity_type: scope, operation_id: request.operation_id,
    payload_digest: request.payload_digest,
    spreadsheet_id: ["SEASON", "COACH"].includes(scope) ? fixture.systemSheetId : fixture.runtimeSheetId })) {
    assert.equal(page[key], expected);
  }
  assert.match(page.tab_id, /^\d+$/u);
  assert.ok(Array.isArray(page.rows));
  assert.ok(page.rows.every((row) => row.cells[0] === seasonId));
  if (scopes[scope]) {
    assert.equal(page.tab_name, scopes[scope].tab);
    assert.deepEqual(page.headers, scopes[scope].headers);
  }
  assert.ok(!page.next_cursor && !page.truncated, "A full single-page fixture is required.");
  return page;
}
async function overview(token) {
  const value = await api("/internal/c2/get-sync-overview", c2Key, { session_token: token, season_id: seasonId });
  assert.equal(value.schema_version, 13);
  assert.equal(value.binding_current, true);
  assert.equal(value.binding.binding_version, 1);
  assert.equal(value.binding.runtime_spreadsheet_id, fixture.runtimeSheetId);
  assert.equal(value.binding.form_id, fixture.formId);
  assert.equal(value.binding.response_sheet_id, fixture.responseSheetId);
  assert.equal(value.binding.response_sheet_name, fixture.responseSheetName);
  assert.equal(value.counts.sources_needing_review, 0);
  assert.equal(value.counts.open_conflicts, 0);
  assert.equal(value.export_control.status, "RUNNING");
  assert.equal(value.export_control.pause_requested, false);
  assert.equal(value.export_control.retry?.action_required ?? false, false);
  assert.equal(value.export_control.retry?.failure_count ?? 0, 0);
  return value;
}
async function clean(token) {
  const summary = {};
  for (const entity_type of ["SEASON", "MEMBER", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE",
    "SIGNUP", "SEAT_PLAN_DRAFT"]) {
    const result = await api("/internal/c2/check-sheet-differences", c2Key,
      { session_token: token, season_id: seasonId, entity_type });
    assert.equal(result.status, "OK", `${entity_type} semantic status`);
    assert.equal(result.findings_count, 0);
    assert.equal(result.truncated, false);
    summary[entity_type] = result.rows_read;
  }
  for (const scope of Object.keys(scopes)) {
    const result = await api("/internal/c2/check-associated-physical-differences", c2Key,
      { session_token: token, season_id: seasonId, scope });
    assert.equal(result.status, "OK", `${scope} physical status`);
    assert.equal(result.coverage, "complete");
    assert.equal(result.findings_count, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.rows_read, result.baselines_checked);
  }
  return summary;
}
async function captureBackup(token) {
  const created = await api("/internal/c1/create-backup-snapshot", c1Key, { session_token: token });
  const manifest = created.result.manifest;
  assert.equal(manifest.schema_version, 13);
  const verified = await api("/internal/c1/verify-backup-snapshot", c1Key,
    { session_token: token, snapshot_id: manifest.snapshot_id, content_digest: manifest.content_digest });
  assert.equal(verified.verified, true);
  assert.equal(verified.expected_content_digest, manifest.content_digest);
  const chunks = [];
  for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index += 1) {
    const read = await api("/internal/c1/get-backup-chunk", c1Key,
      { session_token: token, snapshot_id: manifest.snapshot_id, chunk_index });
    assert.equal(read.chunk.payload_digest, digest(canonical(read.chunk.payload)));
    chunks.push(read.chunk);
  }
  mkdirSync(fileURLToPath(artifactDir), { recursive: true });
  writeFileSync(new URL(`${manifest.snapshot_id}.json`, artifactDir), `${JSON.stringify({ manifest, chunks }, null, 2)}\n`,
    { flag: "wx" });
  const tables = Object.fromEntries(manifest.tables.map((table) => [table.name,
    chunks.filter((chunk) => chunk.table_name === table.name).flatMap((chunk) => chunk.payload.rows)]));
  return { manifest, tables };
}
function sameRows(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} row count`);
  assert.deepEqual(actual.map(canonical).sort(), expected.map(canonical).sort(), `${label} exact cells`);
}
async function sheets(practiceId) {
  const pages = {};
  for (const scope of Object.keys(scopes)) {
    const page = await bridgeRead(scope);
    assert.ok(page.rows.every((row) => row.cells[1] === practiceId), "Unexpected other associated practice rows.");
    pages[scope] = page.rows.map((row) => row.cells);
  }
  return pages;
}
function assertOriginalRevision(pages, journal) {
  const old = pages.SEAT_PLAN_REVISION.filter((row) => row[2] === "1");
  assert.equal(old.length, 1);
  assert.deepEqual(old[0], journal.initial.SEAT_PLAN_REVISION[0], "Revision 1 must remain byte-for-byte unchanged.");
}
function expectedSheets(journal, through) {
  const expected = structuredClone(journal.initial);
  const events = [...journal.events, ...(journal.cancel ? [journal.cancel] : [])];
  for (const event of events.slice(0, through)) {
    assert.ok(event.snapshot, "audit-queued must capture the immutable outbox snapshot before export.");
    const snapshot = event.snapshot;
    for (const row of snapshot.signup_rows) {
      const cells = cellsFor("SIGNUP", row);
      const index = expected.SIGNUP.findIndex((candidate) => candidate[2] === row.member_id);
      if (index < 0) expected.SIGNUP.push(cells); else expected.SIGNUP[index] = cells;
    }
    if (snapshot.seating_snapshot) {
      const seating = snapshot.seating_snapshot;
      const common = { season_id: seasonId, practice_id: journal.practice_id };
      expected.SEAT_PLAN_DRAFT = [cellsFor("SEAT_PLAN_DRAFT", { ...common, ...seating.state,
        frozen_revision: expected.SEAT_PLAN_DRAFT[0][6], frozen_at: expected.SEAT_PLAN_DRAFT[0][7] })];
      if (seating.draft_seats) expected.SEAT_PLAN_CURRENT = seating.draft_seats.map((row) =>
        cellsFor("SEAT_PLAN_CURRENT", { ...common, ...row, seat_plan_version: seating.state.seat_plan_version,
          updated_by: seating.state.updated_by, updated_at: seating.state.updated_at }));
      if (seating.revision) expected.SEAT_PLAN_REVISION.push(cellsFor("SEAT_PLAN_REVISION", {
        ...common, ...seating.revision, seats_json: JSON.stringify(seating.revision.seats),
        names_json: JSON.stringify(seating.revision.names) }));
    }
  }
  return expected;
}
async function assertGoogle(journal, through) {
  const pages = await sheets(journal.practice_id);
  assertOriginalRevision(pages, journal);
  const expected = expectedSheets(journal, through);
  for (const scope of Object.keys(scopes)) sameRows(pages[scope], expected[scope], scope);
  return pages;
}
function assertCurrent(current, journal, count, cancelled = false) {
  assert.equal(current.practice.practice_version, 2);
  assert.equal(current.signup_version, 1 + count + (cancelled ? 1 : 0));
  assert.equal(current.signups.length, 1 + count - (cancelled ? 1 : 0));
  assert.equal(current.counts.left, Math.min(10, count + 1));
  assert.equal(current.counts.right, 0);
  assert.equal(current.counts.ambient, 0);
  assert.equal(current.counts.waitlisted, count === 10 && !cancelled ? 1 : 0);
  assert.equal(current.seat_plan.published_revision, cancelled ? 2 : 1);
  assert.equal(current.seat_plan.seat_plan_version, cancelled ? 2 : 1);
  assert.equal(current.seat_plan.seats.length, 1);
  assert.equal(current.seat_plan.seats[0].member_id, cancelled ? journal.waiter_id : journal.alpha_id);
  assert.equal(current.seat_plan.seats[0].side, "LEFT");
  assert.equal(current.seat_plan.seats[0].row_number, 1);
  const expected = [journal.alpha_id, ...journal.fill_ids.slice(0, Math.min(count, 9)),
    ...(count === 10 ? [journal.waiter_id] : [])].filter((memberId) => !cancelled || memberId !== journal.alpha_id);
  assert.deepEqual(current.signups.map((row) => row.member_id).sort(), expected.sort());
  for (const row of current.signups) {
    assert.equal(row.preference, "LEFT");
    assert.equal(row.status, row.member_id === journal.waiter_id && !cancelled ? "WAITLISTED" : "CONFIRMED");
  }
}

const healthResponse = await fetch(new URL("/health", worker), { signal: AbortSignal.timeout(20_000) });
const health = await healthResponse.json();
assert.equal(healthResponse.status, 200);
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.service_version, version);
assert.equal(health.meta?.writer_epoch, 0);
const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.result.session_token;
let result;
try {
  let status = await overview(token);
  const roster = await readPublic("/internal/c1/public-roster");
  assert.ok(roster.members.every((member) => /^C2 Test Member /u.test(member.display_name)));
  const workspace = await api("/internal/c1/schedule-workspace", c1Key, { session_token: token, season_id: seasonId });
  const weeks = workspace.weeks.filter((week) => week.week_start_date === "2026-10-05");
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].status, "OPENED");
  const practices = workspace.practices.filter((practice) => practice.week_id === weeks[0].week_id);
  assert.equal(practices.length, 1);
  const practice = practices[0];
  assert.match(practice.location, /^C2 /u);
  assert.equal(practice.left_capacity, 10);
  assert.equal(practice.right_capacity, 10);
  assert.equal(practice.practice_version, 2);
  const practiceId = practice.practice_id;
  let journal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, "utf8")) : null;
  if (journal) {
    assert.equal(journal.worker_url, worker.href);
    assert.equal(journal.runtime_sheet_id, fixture.runtimeSheetId);
    assert.equal(journal.deployment_id, identities.deployment_id);
    assert.equal(journal.practice_id, practiceId);
    assert.equal(journal.service_version, version);
    assert.deepEqual(roster.members.map((row) => row.member_id).sort(), journal.roster_ids);
  }
  const current = await readPublic("/internal/c1/public-practice", practiceId);
  if (["preflight", "backup"].includes(phase)) {
    assert.equal(status.counts.pending_outbox, 0);
    assert.equal(status.counts.pending_batches, 0);
    assert.equal(current.signup_version, 1);
    assert.equal(current.signup_open, true);
    assert.equal(current.signups.length, 1);
    const alpha = roster.members.filter((row) => row.display_name === "C2 Test Member Alpha");
    assert.equal(alpha.length, 1);
    assert.equal(current.signups[0].member_id, alpha[0].member_id);
    assert.equal(current.signups[0].status, "CONFIRMED");
    assert.equal(current.signups[0].preference, "LEFT");
    const initial = await sheets(practiceId);
    assert.equal(initial.SIGNUP.length, 1);
    assert.equal(initial.SEAT_PLAN_DRAFT.length, 1);
    assert.equal(initial.SEAT_PLAN_DRAFT[0][2], "1");
    assert.equal(initial.SEAT_PLAN_DRAFT[0][5], "1");
    assert.equal(initial.SEAT_PLAN_CURRENT.length, 20);
    assert.equal(initial.SEAT_PLAN_CURRENT.filter((row) => row[4]).length, 1);
    assert.equal(initial.SEAT_PLAN_REVISION.length, 1);
    assert.equal(initial.SEAT_PLAN_REVISION[0][2], "1");
    assert.deepEqual(JSON.parse(initial.SEAT_PLAN_REVISION[0][8]),
      [{ member_id: alpha[0].member_id, row_number: 1, side: "LEFT" }]);
    const compared = await clean(token);
    const waiter = roster.members.filter((row) => row.display_name === "C2 Test Member Lambda");
    const ready = roster.members.length === 11 && waiter.length === 1;
    if (phase === "preflight") {
      result = { phase, status: ready ? "READY_FOR_BACKUP" : "DATA_PRECONDITION_REQUIRED",
        roster_count: roster.members.length, required_members: 11, left_capacity: 10,
        required_waiter_name: "C2 Test Member Lambda", original_revision: 1, compared };
    } else {
      assert.ok(ready, "DATA_PRECONDITION_REQUIRED: import isolated fictitious Lambda through Form and confirm MEMBER first.");
      assert.equal(journal, null, "An existing journal must be resumed, never replaced.");
      const backup = await captureBackup(token);
      journal = { format: 1, run_id: id("run"), worker_url: worker.href, runtime_sheet_id: fixture.runtimeSheetId,
        deployment_id: identities.deployment_id, service_version: version, practice_id: practiceId,
        roster_ids: roster.members.map((row) => row.member_id).sort(), alpha_id: alpha[0].member_id,
        waiter_id: waiter[0].member_id, fill_ids: roster.members.filter((row) =>
          row.member_id !== alpha[0].member_id && row.member_id !== waiter[0].member_id)
          .sort((a, b) => a.display_name.localeCompare(b.display_name)).map((row) => row.member_id),
        initial, backup: { snapshot_id: backup.manifest.snapshot_id, digest: backup.manifest.content_digest }, events: [] };
      saveJournal(journal);
      result = { phase, status: "BACKUP_VERIFIED", private_chunks: backup.manifest.chunk_count,
        original_revision_captured: true, roster_count: 11 };
    }
  } else {
    assert.ok(journal, "Run backup first; never reconstruct original revision from changed current state.");
    if (phase === "enqueue" || phase === "cancel") {
      const cancel = phase === "cancel";
      const index = cancel ? 10 : Number(stepArg) - 1;
      assert.ok(cancel || /^(0[1-9]|10)$/u.test(stepArg ?? ""), "Use --step=01 through --step=10.");
      assert.equal(status.counts.pending_batches, 0);
      if (cancel) {
        assert.equal(journal.events.length, 10);
        assert.ok(journal.events.every((event) => event.confirmed));
        assert.ok(journal.cancel ? [0, 1].includes(status.counts.pending_outbox) : status.counts.pending_outbox === 0);
      } else {
        assert.ok(!journal.cancel && !journal.events.some((event) => event.confirmed));
        assert.ok(journal.events.length === index || journal.events.length === index + 1,
          "Only the next step or the uncertain current step may be invoked.");
      }
      let event = cancel ? journal.cancel : journal.events[index];
      if (event) {
        const beforeVersion = event.payload.signup_version;
        assert.ok([beforeVersion, beforeVersion + 1].includes(current.signup_version),
          "Unrelated progress prevents replay of this step.");
        assertCurrent(current, journal, cancel ? 10 : index + (current.signup_version > beforeVersion ? 1 : 0),
          cancel && current.signup_version > beforeVersion);
      }
      if (!event) {
        assertCurrent(current, journal, cancel ? 10 : index);
        assert.equal(current.signup_open, true);
        if (cancel) await assertGoogle(journal, 10);
        else await assertGoogle(journal, 0);
        event = { path: cancel ? "/internal/c1/cancel-signup" : "/internal/c1/signup",
          payload: { request_id: `${journal.run_id}_${cancel ? "cancel" : `signup_${index + 1}`}`,
            season_id: seasonId, practice_id: practiceId,
            member_id: cancel ? journal.alpha_id : index === 9 ? journal.waiter_id : journal.fill_ids[index],
            practice_version: 2, signup_version: current.signup_version, ...(cancel ? {} : { preference: "LEFT" }) },
          export_calls: [] };
        if (cancel) journal.cancel = event; else journal.events.push(event);
        saveJournal(journal); // Persist original payload BEFORE the potentially ambiguous network call.
      }
      const saved = await api(event.path, c1Key, event.payload);
      assert.equal(saved.result.signup_version, cancel ? 12 : index + 2);
      assert.equal(saved.result.signup.status, cancel ? "CANCELLED" : index === 9 ? "WAITLISTED" : "CONFIRMED");
      if (cancel) {
        assert.deepEqual(saved.result.promoted_member_ids, [journal.waiter_id]);
        assert.equal(saved.result.seat_plan_version, 2);
        assert.equal(saved.result.published_revision, 2);
      } else assert.deepEqual(saved.result.promoted_member_ids, []);
      if (event.result) assert.deepEqual(saved.result, event.result);
      event.result = saved.result;
      saveJournal(journal);
      const after = await readPublic("/internal/c1/public-practice", practiceId);
      assertCurrent(after, journal, cancel ? 10 : index + 1, cancel);
      status = await overview(token);
      assert.equal(status.counts.pending_outbox, cancel ? 1 : index + 1);
      assert.equal(status.export_control.oldest_pending.topic, "SIGNUPS_CHANGED");
      await assertGoogle(journal, cancel ? 10 : 0);
      result = { phase, step: cancel ? "cancel" : stepArg, status: "BUSINESS_COMMITTED",
        signup_version: after.signup_version, confirmed: after.counts.confirmed, waitlisted: after.counts.waitlisted,
        pending_outbox: status.counts.pending_outbox, natural_due_at: status.export_control.oldest_pending.due_at };
    } else if (phase === "audit-queued") {
      assert.equal(journal.events.length, 10);
      assert.ok(journal.events.every((event) => event.result));
      const cancellation = Boolean(journal.cancel);
      const pending = cancellation ? [journal.cancel] : journal.events;
      assert.ok(pending.every((event) => !event.confirmed));
      assert.equal(status.counts.pending_outbox, pending.length);
      assert.equal(status.counts.pending_batches, 0);
      assertCurrent(current, journal, 10, cancellation);
      const backup = await captureBackup(token);
      const rows = backup.tables.sync_outbox.filter((row) => row.status === "PENDING" &&
        JSON.parse(row.payload_json).entity?.season_id === seasonId);
      assert.equal(rows.length, pending.length);
      for (let index = 0; index < pending.length; index += 1) {
        const row = rows[index]; // Backup payload keeps SQLite insertion order; versions prove the sequence.
        assert.equal(row.topic, "SIGNUPS_CHANGED");
        const entity = JSON.parse(row.payload_json).entity;
        const event = pending[index];
        assert.equal(entity.practice_id, practiceId);
        assert.equal(entity.signup_version, event.result.signup_version);
        assert.equal(entity.snapshot_schema, 2);
        assert.ok(entity.signup_rows.every((signup) => signup.last_request_id === event.payload.request_id));
        assert.equal(entity.signup_rows.length, cancellation ? 2 : 1);
        assert.equal(entity.member_id, event.payload.member_id);
        if (cancellation) {
          const waiterBefore = journal.events[9].snapshot.signup_rows.find((signup) => signup.member_id === journal.waiter_id);
          const waiterAfter = entity.signup_rows.find((signup) => signup.member_id === journal.waiter_id);
          assert.ok(waiterBefore && waiterAfter);
          assert.equal(waiterBefore.status, "WAITLISTED");
          assert.equal(waiterAfter.status, "CONFIRMED");
          assert.equal(waiterAfter.queue_at, waiterBefore.queue_at, "Promotion preserves original queue time.");
          assert.equal(waiterAfter.queue_sequence, waiterBefore.queue_sequence, "Promotion preserves original queue sequence.");
          assert.equal(entity.seating_snapshot.revision.source, "SYSTEM_CANCELSIGNUP");
          assert.deepEqual(entity.seating_snapshot.revision.seats,
            [{ row_number: 1, side: "LEFT", member_id: journal.waiter_id }]);
          assert.equal(entity.seating_snapshot.draft_seats.length, 20);
        } else assert.ok(!entity.seating_snapshot);
        if (event.snapshot) assert.deepEqual(event.snapshot, entity);
        event.snapshot = entity;
        event.outbox_id = row.outbox_id;
        event.due_at_ms = Number(row.due_at_ms);
      }
      const cursor = backup.tables.sync_associated_cursors.filter((row) => row.season_id === seasonId && row.practice_id === practiceId);
      assert.equal(cursor.length, 1);
      assert.equal(Number(cursor[0].signup_version), cancellation ? 11 : 1);
      assert.equal(Number(cursor[0].published_revision), 1);
      saveJournal(journal);
      result = { phase, status: "IMMUTABLE_OUTBOX_CAPTURED", events: pending.length,
        versions: pending.map((event) => event.snapshot.signup_version), private_chunks: backup.manifest.chunk_count };
    } else if (phase === "export") {
      assert.equal(journal.events.length, 10);
      const index = stepArg === "cancel" ? 10 : Number(stepArg) - 1;
      assert.ok(stepArg === "cancel" || /^(0[1-9]|10)$/u.test(stepArg ?? ""));
      const events = [...journal.events, ...(journal.cancel ? [journal.cancel] : [])];
      const event = events[index];
      assert.ok(event?.snapshot, "audit-queued must capture this event first.");
      assert.ok(events.slice(0, index).every((item) => item.confirmed));
      assert.ok(events.slice(index + 1).every((item) => !item.confirmed));
      if (event.confirmed) {
        await assertGoogle(journal, index + 1);
        result = { phase, step: stepArg, status: "ALREADY_CONFIRMED" };
      } else if (event.due_at_ms > Date.now() && status.counts.pending_batches === 0) {
        result = { phase, step: stepArg, status: "WAITING_FOR_DUE", calls: [],
          natural_due_at: new Date(event.due_at_ms).toISOString() };
      } else {
        const pendingBefore = events.length - index;
        assert.ok([pendingBefore, pendingBefore - 1].includes(status.counts.pending_outbox),
          "Unrelated or missing outbox work prevents export.");
        if (status.counts.pending_outbox === pendingBefore) {
          assert.equal(status.export_control.oldest_pending.topic, "SIGNUPS_CHANGED");
          assert.equal(Date.parse(status.export_control.oldest_pending.due_at), event.due_at_ms);
        } else assert.ok(event.inflight, "Only an unknown final receipt may explain an already-removed event.");
        // If the final response was lost, the same saved ID recovers EVENT_CONFIRMED.
        for (let attempts = 0; attempts < maxCalls; attempts += 1) {
          const callIndex = event.export_calls.length;
          const request_id = `${journal.run_id}_export_${index}_${callIndex}`;
          if (!event.inflight) { event.inflight = { request_id, season_id: seasonId }; saveJournal(journal); }
          const exported = await api("/internal/c2/export-next-associated", c2Key, event.inflight);
          assert.ok(["BATCH_CONFIRMED", "EVENT_CONFIRMED"].includes(exported.status),
            `Unexpected export status ${exported.status}; stop and inspect before continuing.`);
          event.export_calls.push(exported);
          event.inflight = null;
          if (exported.status === "EVENT_CONFIRMED") {
            assert.equal(exported.signup_version, event.snapshot.signup_version);
            event.confirmed = true;
            saveJournal(journal);
            break;
          }
          saveJournal(journal);
        }
        status = await overview(token);
        assert.equal(status.counts.pending_batches, 0);
        if (!event.confirmed) {
          assert.ok(maxCallsArg !== undefined, "Bounded export did not finish; rerun the same step.");
          assert.equal(status.counts.pending_outbox, events.length - index);
          const revisionPage = await bridgeRead("SEAT_PLAN_REVISION");
          assertOriginalRevision({ SEAT_PLAN_REVISION: revisionPage.rows.map((row) => row.cells) }, journal);
          result = { phase, step: stepArg, status: "BATCH_PROGRESS", event_confirmed: false,
            calls: event.export_calls.map((call) => ({ status: call.status, entity_type: call.entity_type ?? null })),
            old_revision_unchanged: true, pending_outbox: status.counts.pending_outbox };
        } else {
          await assertGoogle(journal, index + 1);
          assert.equal(status.counts.pending_outbox, events.length - index - 1);
          result = { phase, step: stepArg, status: "EVENT_CONFIRMED", signup_version: event.snapshot.signup_version,
            calls: event.export_calls.map((call) => ({ status: call.status, entity_type: call.entity_type ?? null })),
            old_revision_unchanged: true, pending_outbox: status.counts.pending_outbox };
        }
      }
    } else {
      assert.ok(journal.cancel?.confirmed && journal.events.every((event) => event.confirmed));
      assertCurrent(current, journal, 10, true);
      assert.equal(status.counts.pending_outbox, 0);
      assert.equal(status.counts.pending_batches, 0);
      assert.equal(status.export_control.retry, null);
      const pages = await assertGoogle(journal, 11);
      const compared = await clean(token);
      const finalBackup = await captureBackup(token);
      const cursors = finalBackup.tables.sync_associated_cursors.filter((row) =>
        row.season_id === seasonId && row.practice_id === practiceId);
      assert.equal(cursors.length, 1);
      assert.equal(Number(cursors[0].signup_version), 12);
      assert.equal(Number(cursors[0].seat_plan_version), 2);
      assert.equal(Number(cursors[0].published_revision), 2);
      for (const event of [...journal.events, journal.cancel]) {
        const rows = finalBackup.tables.sync_outbox.filter((row) => row.outbox_id === event.outbox_id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "CONFIRMED");
        assert.deepEqual(JSON.parse(rows[0].payload_json).entity, event.snapshot);
      }
      const physical = finalBackup.tables.sync_associated_physical_baselines.filter((row) => row.season_id === seasonId);
      assert.equal(physical.length, 34);
      const fullCells = physical.map((row) => JSON.parse(row.cells_json));
      sameRows(fullCells, Object.values(pages).flat(), "Persisted physical B against Google");
      journal.final_backup = { snapshot_id: finalBackup.manifest.snapshot_id, digest: finalBackup.manifest.content_digest };
      saveJournal(journal);
      result = { phase, status: "FINAL_CONFIRMED", signup_version: 12, confirmed: 10, waitlisted: 0,
        google_rows: Object.fromEntries(Object.entries(pages).map(([scope, rows]) => [scope, rows.length])),
        published_revision: 2, old_revision_unchanged: true, compared, pending_outbox: 0, pending_batches: 0,
        cursor_verified: true, physical_baselines_verified: 34, backup_restored: false };
    }
  }
} finally {
  await api("/internal/c1/coach-logout", c1Key, { session_token: token });
}
console.log(JSON.stringify({ ...result, coach_logged_out: true }));
