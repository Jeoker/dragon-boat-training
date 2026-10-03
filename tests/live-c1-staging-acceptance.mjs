import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_URL = "https://dragon-boat-training-api-staging.dragon-boat-training.workers.dev";
const EXPECTED_SERVICE_VERSION = "0.7.0-c1-acceptance";
const EXPECTED_CONTRACT_VERSION = "2026-09-21.c1.5";
const verifyOnly = process.argv.includes("--verify-only");
const baseUrl = (process.env.C1_STAGING_URL || DEFAULT_URL).replace(/\/$/u, "");
const c1Key = requiredEnv("C1_TEST_KEY");
const c0Key = requiredEnv("C0_TEST_KEY");
const coachSecret = requiredEnv("COACH_CODE_SECRET");
const coachCode = requiredEnv("C1_ACCEPTANCE_COACH_CODE");
const timings = [];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in the local ignored environment file.`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function legacyCredentialDigest(salt, code, secret) {
  return base64Url(createHmac("sha256", secret).update(`${salt}\n${code}`, "utf8").digest());
}

function sha256(value) {
  return `sha256_v1:${base64Url(createHash("sha256").update(value, "utf8").digest())}`;
}

async function request(pathname, { method = "GET", payload, generation = "C1", accessKey } = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${accessKey ?? (generation === "C1" ? c1Key : c0Key)}`,
      ...(payload ? { "content-type": "application/json" } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`${pathname} returned non-JSON HTTP ${response.status}.`); }
  timings.push({ path: pathname.split("?")[0], method, status: response.status,
    milliseconds: Math.round((performance.now() - started) * 10) / 10 });
  return { response, body };
}

function assertMeta(result, contractVersion = EXPECTED_CONTRACT_VERSION) {
  assert.equal(result.body.meta?.contract_version, contractVersion);
  assert.equal(result.body.meta?.service_version, EXPECTED_SERVICE_VERSION);
  assert.equal(result.body.meta?.backend_generation, "cf-c1-staging-2");
  assert.equal(result.body.meta?.writer_epoch, 0);
  assert.equal(result.body.meta?.environment, "staging");
}

function expectOk(result, contractVersion = EXPECTED_CONTRACT_VERSION) {
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  assertMeta(result, contractVersion);
  return result.body.data;
}

function expectError(result, status, code) {
  assert.equal(result.response.status, status, JSON.stringify(result.body));
  assert.equal(result.body.ok, false, JSON.stringify(result.body));
  assert.equal(result.body.error?.code, code, JSON.stringify(result.body));
  assertMeta(result);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function ids() {
  return {
    coach: "coach_c16_acceptance",
    activeSeason: "season_c16_active_2035",
    activeWeek: "week_c16_active_20350604",
    activePractice: "practice_c16_active_20350606",
    activeA: "member_c16_active_left_a",
    activeB: "member_c16_active_left_b",
    activeRole: "member_c16_active_role",
    archivedSeason: "season_c16_archived_2020",
    archivedWeek: "week_c16_archived_20200914",
    archivedPractice: "practice_c16_archived_20200917",
    archivedPaddler: "member_c16_archived_paddler",
    archivedRole: "member_c16_archived_role"
  };
}

function member(seasonId, memberId, displayName, preference, index, at) {
  return { season_id: seasonId, member_id: memberId, source_key: `c16-source-${index}`,
    source_display_name: displayName, display_name_override: "", status: "ACTIVE",
    default_preference: preference, member_version: 1, created_at: at, updated_at: at };
}

function fixture() {
  const id = ids();
  const at = "2020-09-01T12:00:00.000Z";
  const bulkMembers = Array.from({ length: 120 }, (_, index) => member(id.activeSeason,
    `member_c16_load_${String(index + 1).padStart(3, "0")}`,
    `C1.6 Load Member ${String(index + 1).padStart(3, "0")}`, "AMBIENT", `load-${index + 1}`, at));
  const core = {
    request_id: "c16_import_core_001", source_snapshot_id: "c16_core_snapshot_001",
    settings_version: 1, default_season_id: id.activeSeason,
    coaches: [{ coach_id: id.coach, display_name: "C1.6 Test Coach", code_salt: "c16_acceptance_salt_v1",
      code_digest: legacyCredentialDigest("c16_acceptance_salt_v1", coachCode, coachSecret),
      credential_version: 1, active: true, created_at: at, updated_at: at }],
    seasons: [
      { season_id: id.activeSeason, name: "C1.6 Active 2035", start_date: "2035-04-01",
        end_date: "2035-08-31", timezone: "America/New_York", season_ends_at: "2035-09-01T04:00:00.000Z",
        status: "OPEN", binding_version: 1, season_version: 1, roster_version: 1,
        created_by: id.coach, created_at: at, updated_at: at },
      { season_id: id.archivedSeason, name: "C1.6 Archived 2020", start_date: "2020-04-01",
        end_date: "2020-09-20", timezone: "America/New_York", season_ends_at: "2020-09-21T04:00:00.000Z",
        status: "ARCHIVED", binding_version: 1, season_version: 2, roster_version: 1,
        created_by: id.coach, created_at: at, updated_at: "2020-09-22T12:00:00.000Z" }
    ],
    members: [
      member(id.activeSeason, id.activeA, "C1.6 Active A", "LEFT", "active-a", at),
      member(id.activeSeason, id.activeB, "C1.6 Active B", "LEFT", "active-b", at),
      member(id.activeSeason, id.activeRole, "C1.6 Active Role", "AMBIENT", "active-role", at),
      ...bulkMembers,
      member(id.archivedSeason, id.archivedPaddler, "C1.6 Archived Paddler", "LEFT", "archive-paddler", at),
      member(id.archivedSeason, id.archivedRole, "C1.6 Archived Role", "AMBIENT", "archive-role", at)
    ]
  };
  const schedule = {
    request_id: "c16_import_schedule_001", source_snapshot_id: "c16_schedule_snapshot_001", templates: [],
    weeks: [
      { season_id: id.activeSeason, week_id: id.activeWeek, week_start_date: "2035-06-04",
        scheduled_open_at: at, status: "OPENED", week_version: 1, confirmed_version: 1,
        confirmed_by: id.coach, confirmed_at: at, published_at: at, created_at: at, updated_at: at },
      { season_id: id.archivedSeason, week_id: id.archivedWeek, week_start_date: "2020-09-14",
        scheduled_open_at: at, status: "OPENED", week_version: 1, confirmed_version: 1,
        confirmed_by: id.coach, confirmed_at: at, published_at: at, created_at: at, updated_at: at }
    ],
    practices: [
      { season_id: id.activeSeason, practice_id: id.activePractice, week_id: id.activeWeek,
        template_id: null, generation_key: "c16-active-generation", start_at: "2035-06-06T22:00:00.000Z",
        end_at: "2035-06-07T00:00:00.000Z", timezone: "America/New_York", location: "C1.6 Test Dock",
        address: "16 Test River Road", map_url: "", left_capacity: 1, right_capacity: 1,
        signup_cutoff_at: "2035-06-06T20:00:00.000Z", practice_version: 1, cancelled_at: null,
        cancelled_by: null, schedule_published_at: at, schedule_published_by: id.coach,
        created_at: at, updated_at: at },
      { season_id: id.archivedSeason, practice_id: id.archivedPractice, week_id: id.archivedWeek,
        template_id: null, generation_key: "c16-archive-generation", start_at: "2020-09-17T22:00:00.000Z",
        end_at: "2020-09-18T00:00:00.000Z", timezone: "America/New_York", location: "C1.6 Archive Dock",
        address: "17 Test River Road", map_url: "", left_capacity: 1, right_capacity: 1,
        signup_cutoff_at: "2020-09-17T20:00:00.000Z", practice_version: 1, cancelled_at: null,
        cancelled_by: null, schedule_published_at: at, schedule_published_by: id.coach,
        created_at: at, updated_at: at }
    ]
  };
  const signups = {
    request_id: "c16_import_signups_001", source_snapshot_id: "c16_signup_snapshot_001",
    states: [
      { season_id: id.activeSeason, practice_id: id.activePractice, signup_version: 0, signup_sequence: 0 },
      { season_id: id.archivedSeason, practice_id: id.archivedPractice, signup_version: 1, signup_sequence: 1 }
    ],
    signups: [{ season_id: id.archivedSeason, practice_id: id.archivedPractice,
      member_id: id.archivedPaddler, preference: "LEFT", status: "CONFIRMED", queue_at: at,
      queue_sequence: 1, updated_at: at, last_request_id: "c16_legacy_signup_001" }]
  };
  const seating = {
    request_id: "c16_import_seating_001", source_snapshot_id: "c16_seating_snapshot_001",
    states: [{ season_id: id.archivedSeason, practice_id: id.archivedPractice, seat_plan_version: 1,
      published_revision: 1, coach_member_id: id.archivedRole, steerer_member_id: id.archivedRole,
      updated_by: id.coach, updated_at: at }],
    draft_seats: [
      { season_id: id.archivedSeason, practice_id: id.archivedPractice, seat_plan_version: 1,
        side: "LEFT", row_number: 1, member_id: id.archivedPaddler },
      { season_id: id.archivedSeason, practice_id: id.archivedPractice, seat_plan_version: 1,
        side: "RIGHT", row_number: 1, member_id: "" }
    ],
    revisions: [{ season_id: id.archivedSeason, practice_id: id.archivedPractice, revision_number: 1,
      revision_id: "revision_c16_archived_001", source: "MANUAL", seat_plan_version: 1,
      coach_member_id: id.archivedRole, steerer_member_id: id.archivedRole,
      seats: [{ side: "LEFT", row_number: 1, member_id: id.archivedPaddler }],
      names: [{ member_id: id.archivedPaddler, display_name: "C1.6 Archived Paddler" },
        { member_id: id.archivedRole, display_name: "C1.6 Archived Role" }],
      published_by: id.coach, published_at: at, request_id: "c16_legacy_revision_001" }]
  };
  const history = {
    request_id: "c16_import_history_001", source_snapshot_id: "c16_history_snapshot_001",
    seasons: [{ season_id: id.archivedSeason, name: "C1.6 Archived 2020", start_date: "2020-04-01",
      end_date: "2020-09-20", timezone: "America/New_York", archive_year: 2020,
      archived_at: "2020-09-22T12:00:00.000Z" }],
    practices: [{ season_id: id.archivedSeason, practice_id: id.archivedPractice, history_version: 2,
      final_status: "FROZEN", frozen_revision: 1, start_at: "2020-09-17T22:00:00.000Z",
      end_at: "2020-09-18T00:00:00.000Z", timezone: "America/New_York", location: "C1.6 Archive Dock",
      address: "17 Test River Road", map_url: "", coach_display_name: "C1.6 Archived Role",
      steerer_display_name: "C1.6 Archived Role", published_at: at, source: "MANUAL",
      seats: [{ side: "LEFT", row_number: 1, display_name: "C1.6 Archived Paddler" }],
      frozen_at: "2020-09-19T00:00:00.000Z" }],
    corrections: [{ season_id: id.archivedSeason, practice_id: id.archivedPractice,
      correction_id: "correction_c16_archived_001", history_version: 2,
      note: "C1.6 imported archive verification.", created_by: id.coach,
      created_at: "2020-09-22T12:00:00.000Z" }]
  };
  return { id, core, schedule, signups, seating, history };
}

async function c1Post(pathname, payload) {
  return request(pathname, { method: "POST", payload });
}

async function publicPractice(id, requestId) {
  return request(`/internal/c1/public-practice?request_id=${requestId}&season_id=${id.activeSeason}` +
    `&practice_id=${id.activePractice}`);
}

async function seedMigration(data) {
  const rosterProbe = await request(`/internal/c1/public-roster?request_id=c16_seed_probe_001&season_id=${data.id.activeSeason}`);
  if (rosterProbe.response.status === 200) return false;
  expectError(rosterProbe, 404, "SEASON_NOT_PUBLIC");
  for (const [pathname, payload] of [
    ["/internal/c1/import-core", data.core], ["/internal/c1/import-schedule", data.schedule],
    ["/internal/c1/import-signups", data.signups], ["/internal/c1/import-seating", data.seating],
    ["/internal/c1/import-history", data.history]
  ]) expectOk(await c1Post(pathname, payload));
  return true;
}

async function login() {
  const result = expectOk(await c1Post("/internal/c1/coach-login", {
    request_id: `c16_login_${Date.now()}`, coach_code: coachCode
  }));
  assert.ok(result.result?.session_token);
  return result.result.session_token;
}

async function ensureSignupAndSeating(data, sessionToken) {
  let current = expectOk(await publicPractice(data.id, "c16_current_practice_001"));
  const activeIds = new Set(current.signups.filter((row) => row.status !== "CANCELLED").map((row) => row.member_id));
  if (!activeIds.has(data.id.activeA) && !activeIds.has(data.id.activeB)) {
    assert.equal(current.signup_version, 0);
    const base = { season_id: data.id.activeSeason, practice_id: data.id.activePractice,
      practice_version: current.practice.practice_version, signup_version: current.signup_version, preference: "LEFT" };
    const [leftA, leftB] = await Promise.all([
      c1Post("/internal/c1/signup", { ...base, request_id: "c16_signup_race_a_001", member_id: data.id.activeA }),
      c1Post("/internal/c1/signup", { ...base, request_id: "c16_signup_race_b_001", member_id: data.id.activeB })
    ]);
    const success = [leftA, leftB].find((entry) => entry.response.status === 200);
    const conflict = [leftA, leftB].find((entry) => entry.response.status === 409);
    assert.ok(success && conflict, "Exactly one concurrent last-seat signup must commit.");
    expectOk(success);
    expectError(conflict, 409, "VERSION_CONFLICT");
    const winner = success.body.data.result.signup.member_id;
    const loser = winner === data.id.activeA ? data.id.activeB : data.id.activeA;
    current = expectOk(await publicPractice(data.id, "c16_after_race_001"));
    expectOk(await c1Post("/internal/c1/signup", { ...base, request_id: "c16_signup_waitlist_001",
      member_id: loser, signup_version: current.signup_version }));
  }
  current = expectOk(await publicPractice(data.id, "c16_after_signup_001"));
  const active = current.signups.filter((row) => [data.id.activeA, data.id.activeB].includes(row.member_id));
  assert.equal(active.filter((row) => row.status === "CONFIRMED").length, 1);
  assert.equal(active.filter((row) => row.status === "WAITLISTED").length, 1);
  const winner = active.find((row) => row.status === "CONFIRMED").member_id;
  let workspace = expectOk(await c1Post("/internal/c1/get-seating-workspace", {
    request_id: "c16_seating_workspace_001", session_token: sessionToken,
    season_id: data.id.activeSeason, practice_id: data.id.activePractice
  }));
  if (workspace.published_revision === 0) {
    const saved = expectOk(await c1Post("/internal/c1/save-seat-plan-draft", {
      request_id: "c16_save_seating_001", session_token: sessionToken,
      season_id: data.id.activeSeason, practice_id: data.id.activePractice,
      practice_version: workspace.practice.practice_version, signup_version: workspace.signup_version,
      seat_plan_version: workspace.seat_plan_version, coach_member_id: data.id.activeRole,
      steerer_member_id: data.id.activeRole, change_kind: "EDIT", seats: [
        { side: "LEFT", row_number: 1, member_id: winner },
        { side: "RIGHT", row_number: 1, member_id: "" }
      ]
    }));
    workspace = saved.current_view;
    const published = expectOk(await c1Post("/internal/c1/publish-seat-plan", {
      request_id: "c16_publish_seating_001", session_token: sessionToken,
      season_id: data.id.activeSeason, practice_id: data.id.activePractice,
      practice_version: workspace.practice.practice_version, signup_version: workspace.signup_version,
      seat_plan_version: workspace.seat_plan_version, published_revision: workspace.published_revision,
      acknowledge_preference_mismatch: false
    }));
    assert.equal(published.result.published_revision, 1);
  }
  const publicAfter = expectOk(await publicPractice(data.id, "c16_published_practice_001"));
  assert.equal(publicAfter.seat_plan.published_revision, 1);
  assert.equal(publicAfter.seat_plan.seats.filter((seat) => seat.display_name).length, 1);
}

async function verifyMigration(data, sessionToken) {
  const roster = expectOk(await request(
    `/internal/c1/public-roster?request_id=c16_roster_verify_001&season_id=${data.id.activeSeason}`));
  assert.equal(roster.members.length, 123);
  const schedule = expectOk(await request(
    `/internal/c1/public-schedule?request_id=c16_schedule_verify_001&season_id=${data.id.activeSeason}`));
  assert.ok(JSON.stringify(schedule).includes(data.id.activePractice));
  const seasons = expectOk(await request("/internal/c1/public-history-seasons?request_id=c16_history_directory_001"));
  assert.ok(seasons.seasons.some((row) => row.season_id === data.id.archivedSeason));
  const archived = expectOk(await request(`/internal/c1/public-archived-practice?request_id=c16_history_detail_001` +
    `&season_id=${data.id.archivedSeason}&practice_id=${data.id.archivedPractice}`));
  assert.equal(archived.history_version, 2);
  assert.equal(archived.seat_plan.seats[0].display_name, "C1.6 Archived Paddler");
  assert.equal(JSON.stringify(archived).includes("member_c16"), false);
  const management = expectOk(await c1Post("/internal/c1/get-history-management", {
    request_id: "c16_history_management_001", session_token: sessionToken, season_id: data.id.archivedSeason
  }));
  assert.equal(management.archive_status, "ARCHIVED");
  const audit = expectOk(await c1Post("/internal/c1/list-management-audit", {
    request_id: "c16_audit_001", session_token: sessionToken, season_id: data.id.activeSeason, limit: 2
  }));
  assert.equal(audit.events.length, 2);
  assert.ok(audit.next_cursor);
}

async function backupAndVerify(sessionToken) {
  const backup = expectOk(await c1Post("/internal/c1/create-backup-snapshot", {
    request_id: "c16_backup_001", session_token: sessionToken
  })).result;
  const memberTable = backup.manifest.tables.find((table) => table.name === "members");
  assert.ok(memberTable?.chunk_indices.length >= 2,
    "The 125-member fixture must exercise more than one members chunk.");
  const verified = expectOk(await c1Post("/internal/c1/verify-backup-snapshot", {
    request_id: `c16_verify_backup_${Date.now()}`, session_token: sessionToken,
    snapshot_id: backup.snapshot_id, content_digest: backup.manifest.content_digest
  }));
  assert.equal(verified.verified, true);
  const chunks = [];
  for (let index = 0; index < backup.manifest.chunk_count; index += 1) {
    const item = expectOk(await c1Post("/internal/c1/get-backup-chunk", {
      request_id: `c16_backup_chunk_${index}_${Date.now()}`, session_token: sessionToken,
      snapshot_id: backup.snapshot_id, chunk_index: index
    })).chunk;
    assert.equal(sha256(canonicalJson(item.payload)), item.payload_digest);
    chunks.push(item);
  }
  const artifactDirectory = path.resolve("cloudflare/.acceptance-artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const artifactPath = path.join(artifactDirectory, `${backup.snapshot_id}.json`);
  await writeFile(artifactPath, `${JSON.stringify({ manifest: backup.manifest, chunks }, null, 2)}\n`, "utf8");
  return { snapshotId: backup.snapshot_id, chunkCount: chunks.length,
    recordCount: backup.manifest.record_count, artifactPath };
}

async function faultRecovery() {
  const committed = expectOk(await request("/internal/c0/commit", { method: "POST", generation: "C0", payload: {
    request_id: "c16_remote_failure_001", actor_scope: "C1:ACCEPTANCE", action: "remoteFailureRecovery",
    amount: 1, enqueue_job: true, job_due_at_ms: 0, fail_attempts: 7,
    retry_delay_ms: 1000, simulate_failure: false
  } }), "2026-09-19.c0");
  const jobId = `job_${committed.request_key.slice(7)}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = expectOk(await request(
      `/internal/c0/state?request_id=c16_fault_state_${Date.now()}`, { generation: "C0" }), "2026-09-19.c0");
    const job = state.jobs.find((row) => row.job_id === jobId);
    if (job?.status === "COMPLETED") {
      assert.equal(job.attempt_count, 8);
      assert.equal(job.last_error, "");
      return { jobId, attemptCount: job.attempt_count };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("The remote failure-injection job did not recover within 120 seconds.");
}

async function main() {
  const health = await request("/health?request_id=c16_health_001");
  expectOk(health, "2026-09-19.c0");
  const denied = await request(
    "/internal/c1/public-history-seasons?request_id=c16_access_denied_001",
    { accessKey: "c16-intentionally-wrong-access-key" }
  );
  expectError(denied, 403, "C1_ACCESS_DENIED");
  const data = fixture();
  const seeded = verifyOnly ? false : await seedMigration(data);
  const sessionToken = await login();
  if (!verifyOnly) await ensureSignupAndSeating(data, sessionToken);
  await verifyMigration(data, sessionToken);
  const backup = await backupAndVerify(sessionToken);
  const fault = verifyOnly ? null : await faultRecovery();
  const operations = expectOk(await c1Post("/internal/c1/get-operations", {
    request_id: `c16_operations_${Date.now()}`, session_token: sessionToken
  }));
  assert.equal(operations.schema_version, 6);
  assert.ok(operations.counts.history_seasons >= 1);
  assert.ok(operations.counts.outbox_pending >= 2,
    "C1 writes must remain pending while Google synchronization is disconnected.");
  const c0State = expectOk(await request(
    `/internal/c0/state?request_id=c16_shadow_jobs_${Date.now()}`,
    { generation: "C0" }
  ), "2026-09-19.c0");
  assert.equal(c0State.jobs.some((job) => ["history_freeze:", "history_complete:", "history_archive:"]
    .some((prefix) => job.job_id.startsWith(prefix))), false,
  "Shadow writer epoch 0 must not schedule automatic C1 history maintenance.");
  expectOk(await c1Post("/internal/c1/coach-logout", {
    request_id: `c16_logout_${Date.now()}`, session_token: sessionToken
  }));
  const values = timings.map((entry) => entry.milliseconds);
  const summary = {
    mode: verifyOnly ? "verify-only" : "seed-and-exercise",
    seeded, service_version: EXPECTED_SERVICE_VERSION, schema_version: operations.schema_version,
    requests: timings.length, latency_ms: { p50: percentile(values, 0.5), p95: percentile(values, 0.95),
      maximum: Math.max(...values) },
    history_seasons: operations.counts.history_seasons,
    backup: { snapshot_id: backup.snapshotId, chunks: backup.chunkCount,
      records: backup.recordCount, artifact: path.relative(process.cwd(), backup.artifactPath) },
    fault_recovery: fault
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`C1.6 staging acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
