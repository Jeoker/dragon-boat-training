import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { legacyCredentialDigest } from "../src/crypto";
import { TeamState } from "../src/team-state";
import { SHEET_SCOPES } from "../src/c2-sheet-bridge";
import { SYNC_FIELD_DEFINITIONS, normalizeSyncValue } from "../../shared/c2-sync-rules";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const seasonId = "season_schedule_export_2026";
const at = "2026-09-01T12:00:00.000Z";
const spreadsheetId = "spreadsheet_schedule_test_001";
const coachId = "coach_schedule_test_01";
const template = { season_id: seasonId, template_id: "template_schedule_test_01",
  day_of_week: 3, start_time: "18:00", end_time: "20:00", timezone: "America/New_York",
  location: "River", address: "Dock 1", map_url: "", active: true, template_version: 1,
  created_at: at, updated_at: at };
const week = { season_id: seasonId, week_id: "week_schedule_test_001",
  week_start_date: "2026-09-07", scheduled_open_at: "2026-09-07T12:00:00.000Z",
  status: "SCHEDULED", week_version: 1,
  confirmed_version: 1, confirmed_by: coachId, confirmed_at: at,
  published_at: null, created_at: at, updated_at: at };
const practice = { season_id: seasonId, practice_id: "practice_schedule_test_01",
  week_id: week.week_id, template_id: template.template_id, generation_key: "generation_schedule_001",
  start_at: "2026-09-09T22:00:00.000Z", end_at: "2026-09-10T00:00:00.000Z",
  timezone: "America/New_York", location: "River", address: "Dock 1", map_url: "",
  left_capacity: 10, right_capacity: 10, signup_cutoff_at: "2026-09-09T20:00:00.000Z",
  practice_version: 1, cancelled_at: null, cancelled_by: null, schedule_published_at: null,
  schedule_published_by: null, created_at: at, updated_at: at };
const secondPractice = { ...practice, practice_id: "practice_schedule_test_02",
  generation_key: "generation_schedule_002",
  start_at: "2026-09-10T22:00:00.000Z", end_at: "2026-09-11T00:00:00.000Z",
  signup_cutoff_at: "2026-09-10T20:00:00.000Z" };
const seasonRecord = { season_id: seasonId, name: "Schedule Season", start_date: "2026-04-01",
  end_date: "2026-12-31", timezone: "America/New_York",
  season_ends_at: "2027-01-01T05:00:00.000Z", status: "OPEN",
  form_id: "form_schedule_test_001", runtime_spreadsheet_id: spreadsheetId,
  response_sheet_id: "0", binding_version: 1, season_version: 1, roster_version: 0,
  updated_at: at };
const rows = { COACH: [[coachId]], SCHEDULE_TEMPLATE: [] as string[][], TRAINING_WEEK: [] as string[][],
  PRACTICE: [] as string[][], SEASON: [SHEET_SCOPES.SEASON.headers.map((header) =>
    String((seasonRecord as Record<string, unknown>)[header] ?? ""))] };

const testEnv = (suffix: string) => ({ ...env, TEAM_ID: `schedule-export-${suffix}`,
  C2_SCHEDULE_EXPORT_ENABLED: "true", GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/test/exec",
  GOOGLE_BRIDGE_SECRET: "local-bridge-secret" } as unknown as Env);
const headers = { authorization: "Bearer local-c2-test-key", "content-type": "application/json" };

async function call(environment: Env, path: string, value: Record<string, unknown>, c1 = false) {
  return worker.fetch(new IncomingRequest(`https://example.test${path}`, { method: "POST",
    headers: c1 ? { ...headers, authorization: "Bearer local-c1-test-key" } : headers,
    body: JSON.stringify(value) }), environment);
}

async function seed(environment: Env): Promise<ReturnType<typeof environment.TEAM_STATE.getByName>> {
  const coach = { coach_id: coachId, display_name: "Schedule Coach",
    code_salt: "schedule_salt_001", code_digest: await legacyCredentialDigest(
      "schedule_salt_001", "local-test-coach-code", "local-c1-coach-secret"),
    credential_version: 1, active: true, created_at: at, updated_at: at };
  expect((await call(environment, "/internal/c1/import-core", {
    request_id: "schedule_core_import_001", source_snapshot_id: "schedule_core_snapshot_001",
    settings_version: 1, default_season_id: seasonId, coaches: [coach],
    seasons: [{ season_id: seasonId, name: "Schedule Season", start_date: "2026-04-01",
      end_date: "2026-12-31", timezone: "America/New_York",
      season_ends_at: "2027-01-01T05:00:00.000Z", status: "OPEN",
      binding_version: 1, season_version: 2, roster_version: 0,
      created_by: coachId, created_at: at, updated_at: at }], members: []
  }, true)).status).toBe(200);
  expect((await call(environment, "/internal/c2/import-sync-foundation", {
    request_id: "schedule_foundation_001", source_snapshot_id: "schedule_foundation_snapshot_001",
    bindings: [{ season_id: seasonId, binding_version: 1, form_id: "form_schedule_test_001",
      runtime_spreadsheet_id: spreadsheetId, response_sheet_id: "0",
      response_sheet_name: "Form Responses 1", field_mapping: { display_name_header: "Name" },
      schema_fingerprint: "sha256_v1:schedule_schema_001", export_paused: false,
      last_pull_at: null, last_push_at: null, created_at: at, updated_at: at }],
    baselines: [], source_imports: []
  })).status).toBe(200);
  const stub = environment.TEAM_STATE.getByName(environment.TEAM_ID);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec(`INSERT INTO schedule_templates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      seasonId, template.template_id, template.day_of_week, template.start_time,
      template.end_time, template.timezone, template.location, template.address,
      template.map_url, 1, template.template_version, at, at).toArray();
    sql.exec(`INSERT INTO training_weeks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      seasonId, week.week_id, week.week_start_date, week.scheduled_open_at, week.status, week.week_version,
      week.confirmed_version, week.confirmed_by, week.confirmed_at, null, at, at).toArray();
    sql.exec(`INSERT INTO practices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      seasonId, practice.practice_id, week.week_id, template.template_id,
      practice.generation_key, practice.start_at, practice.end_at, practice.timezone,
      practice.location, practice.address, practice.map_url, 10, 10, practice.signup_cutoff_at,
      1, null, null, null, null, at, at).toArray();
    sql.exec(`INSERT INTO practices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      seasonId, secondPractice.practice_id, week.week_id, template.template_id,
      secondPractice.generation_key, secondPractice.start_at, secondPractice.end_at,
      secondPractice.timezone, secondPractice.location, secondPractice.address,
      secondPractice.map_url, 10, 10, secondPractice.signup_cutoff_at,
      1, null, null, null, null, at, at).toArray();
    const requestKey = sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    sql.exec(`INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
      VALUES ('out_schedule_test_001',?,'SCHEDULE_CHANGED',?,'PENDING',?,?)`,
      requestKey, JSON.stringify({ action: "prepareTrainingWeek", entity: {
        season_id: seasonId, snapshot_schema: 1, season_version: 2,
        templates: [template], week, practices: [practice, secondPractice] } }), Date.now() - 1000, at).toArray();
    for (const group of new Set(SYNC_FIELD_DEFINITIONS.SEASON.map((field) => field.dependency_group))) {
      const baseline = Object.fromEntries(SYNC_FIELD_DEFINITIONS.SEASON
        .filter((field) => field.dependency_group === group)
        .map((field) => [field.field,
          normalizeSyncValue((seasonRecord as Record<string, unknown>)[field.field],
            field.kind, field.allowed_values)]));
      sql.exec(`INSERT INTO sync_baselines VALUES (?,1,'SEASON',?,?,?,?,?,?,?)`,
        seasonId, seasonId, group, JSON.stringify(baseline), "sha256_v1:fixture_digest",
        1, "sha256_v1:fixture_digest", at).toArray();
    }
  });
  return stub;
}

afterEach(() => {
  vi.restoreAllMocks();
  rows.SCHEDULE_TEMPLATE = [];
  rows.TRAINING_WEEK = [];
  rows.PRACTICE = [];
  rows.COACH = [[coachId]];
  rows.SEASON = [SHEET_SCOPES.SEASON.headers.map((header) =>
    String((seasonRecord as Record<string, unknown>)[header] ?? ""))];
});

it("keeps retryable Google failures in durable backoff after many attempts", async () => {
  const environment = { ...testEnv("poll-retry"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const stub = await seed(environment);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json({ ok: false, meta: { request_id: request.request_id },
      error: { code: "SERVICE_BUSY", message: "Temporary Google quota", retryable: true } });
  });
  const poll = async (request_id: string) => (await call(environment,
    "/internal/c2/poll-due-exports", { request_id })).json() as Promise<any>;
  const first = await poll("schedule_poll_retry_001");
  expect(first.data.results).toEqual([{ season_id: seasonId,
    status: "RETRY_REQUIRED", error_code: "SERVICE_BUSY" }]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec(
      "UPDATE sync_export_retries SET failure_count=7,next_attempt_at_ms=0 WHERE season_id=?",
      seasonId).toArray();
  });
  const eighth = await poll("schedule_poll_retry_008");
  expect(eighth.data.results).toEqual([{ season_id: seasonId,
    status: "RETRY_REQUIRED", error_code: "SERVICE_BUSY" }]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ failure_count: number; action_required: number; next_attempt_at_ms: number }>(
      "SELECT failure_count,action_required,next_attempt_at_ms FROM sync_export_retries WHERE season_id=?",
      seasonId).one()).toMatchObject({ failure_count: 8, action_required: 0 });
    expect(context.storage.sql.exec<{ next_attempt_at_ms: number }>(
      "SELECT next_attempt_at_ms FROM sync_export_retries WHERE season_id=?", seasonId).one()
      .next_attempt_at_ms).toBeGreaterThan(Date.now());
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_test_001'").one().status)
      .toBe("PENDING");
  });
  expect((await poll("schedule_poll_retry_cooling")).data.polled).toBe(0);
});

it("halts a Google reference conflict until a Coach re-arms the corrected season", async () => {
  const environment = { ...testEnv("poll-conflict"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const stub = await seed(environment);
  mockSheetBridge("SERVICE_BUSY");
  const poll = async (request_id: string) => (await call(environment,
    "/internal/c2/poll-due-exports", { request_id })).json() as Promise<any>;
  const dueNow = () => runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec(
      "UPDATE sync_export_retries SET next_attempt_at_ms=0 WHERE season_id=?", seasonId).toArray();
  });
  expect((await poll("schedule_conflict_poll_001")).data.results[0].status).toBe("RETRY_REQUIRED");
  await dueNow();
  expect((await poll("schedule_conflict_poll_002")).data.results[0].status).toBe("BATCH_CONFIRMED");
  await dueNow();
  expect((await poll("schedule_conflict_poll_003")).data.results[0].status).toBe("BATCH_CONFIRMED");
  const locationIndex = SHEET_SCOPES.SCHEDULE_TEMPLATE.headers.indexOf("location");
  rows.SCHEDULE_TEMPLATE[0][locationIndex] = "Manual Google edit";
  await dueNow();
  expect((await poll("schedule_conflict_poll_004")).data.results).toEqual([{
    season_id: seasonId, status: "ACTION_REQUIRED", error_code: "SYNC_REFERENCE_NEEDS_REVIEW" }]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ action_required: number }>(
      "SELECT action_required FROM sync_export_retries WHERE season_id=?", seasonId).one()
      .action_required).toBe(1);
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_test_001'").one().status)
      .toBe("PENDING");
  });
  expect((await poll("schedule_conflict_poll_005")).data.polled).toBe(0);
  rows.SCHEDULE_TEMPLATE[0][locationIndex] = "River";
  const login = await call(environment, "/internal/c1/coach-login", {
    request_id: "schedule_conflict_login_001", coach_code: "local-test-coach-code"
  }, true);
  const token = (await login.json() as any).data.result.session_token;
  const retry = await call(environment, "/internal/c2/retry-export", {
    request_id: "schedule_conflict_rearm_001", session_token: token, season_id: seasonId
  });
  expect((await retry.json() as any).data.result).toMatchObject({
    previous_error: "SYNC_REFERENCE_NEEDS_REVIEW", unfinished_batch_id: null,
    next_batch_requires_fresh_comparison: true });
  expect((await poll("schedule_conflict_poll_006")).data.results[0].status).toBe("BATCH_CONFIRMED");
});

function mockSheetBridge(firstPatchFault: "LOST_REPLY" | "SERVICE_BUSY" | null) {
  const receipts = new Map<string, Record<string, unknown>>();
  let injectFault = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    if (envelope.action === "cloudflareReadSheetRecords") {
      const scope = payload.entity_type as keyof typeof rows;
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: scope, binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest,
        spreadsheet_id: scope === "SEASON" || scope === "COACH" ?
          "system_schedule_test_001" : spreadsheetId,
        tab_name: SHEET_SCOPES[scope].tab,
        tab_id: scope === "COACH" ? "99" : scope === "SEASON" ? "100" :
          scope === "SCHEDULE_TEMPLATE" ? "101" :
          scope === "TRAINING_WEEK" ? "102" : "103", read_at_ms: Date.now(),
        headers: [...SHEET_SCOPES[scope].headers], secondary: null,
        rows: rows[scope].map((cells, index) => ({ row_number: index + 2, cells: [...cells] }))
      } });
    }
    if (injectFault && firstPatchFault === "SERVICE_BUSY") {
      injectFault = false;
      return Response.json({ ok: false, meta: { request_id: envelope.request_id },
        error: { code: "SERVICE_BUSY", message: "Temporary Google quota", retryable: true } });
    }
    const scope = envelope.action === "cloudflarePatchSeasonSheet" ? "SEASON" :
      payload.entity_type as keyof typeof rows;
    let receipt = receipts.get(envelope.operation_id);
    if (!receipt) {
      const idKey = scope === "SEASON" ? "season_id" : scope === "SCHEDULE_TEMPLATE" ? "template_id" :
        scope === "TRAINING_WEEK" ? "week_id" : "practice_id";
      for (const item of payload.items) {
        const index = rows[scope].findIndex((cells) => cells[scope === "SEASON" ? 0 : 1] === item[idKey]);
        if (index < 0) rows[scope].push([...item.target]);
        else rows[scope][index] = [...item.target];
      }
      receipt = { status: "verified", protocol_version: envelope.protocol_version,
        team_id: envelope.team_id, season_id: seasonId, binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest, spreadsheet_id: payload.spreadsheet_id,
        tab_id: payload.tab_id, ...(scope === "SEASON" ? { verified_season_ids: [seasonId] } :
          { entity_type: scope, verified_row_ids: payload.items.map((item: Record<string, string>) => item[idKey]) }),
        acknowledged_at: new Date().toISOString() };
      receipts.set(envelope.operation_id, receipt);
    }
    if (injectFault && firstPatchFault === "LOST_REPLY") {
      injectFault = false;
      throw new Error("Google wrote but reply was lost");
    }
    return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: receipt });
  });
}

it("keeps a short retry between batches, then clears it after the final event", async () => {
  const environment = { ...testEnv("poll-clean-final"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const stub = await seed(environment);
  mockSheetBridge(null);
  const poll = async (requestId: string) => (await call(environment,
    "/internal/c2/poll-due-exports", { request_id: requestId })).json() as Promise<any>;
  for (let index = 0; index < 4; index += 1) {
    expect((await poll(`schedule_clean_batch_${index}`)).data.results).toEqual([{
      season_id: seasonId, status: "BATCH_CONFIRMED" }]);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const sql = context.storage.sql;
      expect(sql.exec<{ next_attempt_at_ms: number }>(
        "SELECT next_attempt_at_ms FROM sync_export_retries WHERE season_id=?", seasonId)
        .one().next_attempt_at_ms).toBeGreaterThan(Date.now());
      sql.exec("UPDATE sync_export_retries SET next_attempt_at_ms=0 WHERE season_id=?", seasonId).toArray();
    });
  }
  expect((await poll("schedule_clean_complete")).data.results).toEqual([{
    season_id: seasonId, status: "EVENT_CONFIRMED" }]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_export_retries WHERE season_id=?", seasonId).one().count).toBe(0);
    expect(sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_test_001'").one().status)
      .toBe("CONFIRMED");
  });
  expect((await poll("schedule_clean_idle")).data.polled).toBe(0);
});

it.each([
  ["due", -1000, true],
  ["future", 600_000, false]
] as const)("only retains a success retry for a %s next event", async (kind, dueOffset, expectRetry) => {
  const environment = { ...testEnv(`poll-next-${kind}`), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const stub = await seed(environment);
  mockSheetBridge(null);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec(`INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
      SELECT ?,request_key,topic,payload_json,'PENDING',?,created_at
      FROM sync_outbox WHERE outbox_id='out_schedule_test_001'`,
    `out_schedule_next_${kind}`, Date.now() + dueOffset).toArray();
    if (kind === "future") {
      // A newer event reaching its due time must not bypass the older one.
      sql.exec(`INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
        SELECT 'out_schedule_later_due',request_key,'MEMBERS_IMPORTED',payload_json,'PENDING',?,created_at
        FROM sync_outbox WHERE outbox_id='out_schedule_test_001'`, Date.now() - 1000).toArray();
    }
  });
  const poll = async (requestId: string) => (await call(environment,
    "/internal/c2/poll-due-exports", { request_id: requestId })).json() as Promise<any>;
  for (let index = 0; index < 4; index += 1) {
    expect((await poll(`schedule_next_${kind}_batch_${index}`)).data.results[0].status)
      .toBe("BATCH_CONFIRMED");
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE sync_export_retries SET next_attempt_at_ms=0 WHERE season_id=?",
        seasonId).toArray();
    });
  }
  expect((await poll(`schedule_next_${kind}_complete`)).data.results[0].status)
    .toBe("EVENT_CONFIRMED");
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const retry = sql.exec<{ next_attempt_at_ms: number }>(
      "SELECT next_attempt_at_ms FROM sync_export_retries WHERE season_id=?", seasonId).toArray();
    expect(retry).toHaveLength(expectRetry ? 1 : 0);
    if (expectRetry) expect(retry[0].next_attempt_at_ms).toBeGreaterThan(Date.now());
    expect(sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id=?", `out_schedule_next_${kind}`)
      .one().status).toBe("PENDING");
  });
  if (!expectRetry) {
    expect((await poll("schedule_next_future_waiting")).data.polled).toBe(0);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ status: string }>(
        "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_later_due'")
        .one().status).toBe("PENDING");
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_export_retries WHERE season_id=?", seasonId)
        .one().count).toBe(0);
    });
  }
});

it("confirms a three-tab schedule event only after its season version, replaying a lost reply", async () => {
  const environment = testEnv("lost-reply");
  const stub = await seed(environment);
  mockSheetBridge("LOST_REPLY");
  const next = async (request_id: string) => (await call(environment,
    "/internal/c2/export-next-schedule", { request_id, season_id: seasonId })).json() as Promise<any>;
  expect(await next("schedule_export_run_001"))
    .toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  expect(rows.SCHEDULE_TEMPLATE).toHaveLength(1);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_test_001'").one().status).toBe("PENDING");
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_batches").one().status).toBe("FAILED");
  });
  expect(await next("schedule_export_run_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SCHEDULE_TEMPLATE" } });
  expect(rows.SCHEDULE_TEMPLATE).toHaveLength(1);
  expect(await next("schedule_export_run_002")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "TRAINING_WEEK" } });
  const templateLocation = SHEET_SCOPES.SCHEDULE_TEMPLATE.headers.indexOf("location");
  rows.SCHEDULE_TEMPLATE[0][templateLocation] = "Human moved the dock";
  expect(await next("schedule_export_reference_review_003")).toMatchObject({ error: {
    code: "SYNC_REFERENCE_NEEDS_REVIEW" } });
  rows.SCHEDULE_TEMPLATE[0][templateLocation] = "River";
  expect(await next("schedule_export_run_003")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "PRACTICE", row_id: practice.practice_id } });
  expect(await next("schedule_export_run_004")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "PRACTICE", row_id: secondPractice.practice_id } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_test_001'").one().status).toBe("PENDING");
  });
  const locationIndex = SHEET_SCOPES.PRACTICE.headers.indexOf("location");
  rows.PRACTICE[0][locationIndex] = "Manual Google edit";
  expect(await next("schedule_export_review_005")).toMatchObject({ error: {
    code: "SYNC_SCHEDULE_NEEDS_REVIEW" } });
  rows.PRACTICE[0][locationIndex] = "River";
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE seasons SET name='Unexported name' WHERE season_id=?",
      seasonId).toArray();
  });
  expect(await next("schedule_export_season_review_005")).toMatchObject({ error: {
    code: "SYNC_SEASON_NEEDS_REVIEW" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE seasons SET name='Schedule Season' WHERE season_id=?",
      seasonId).toArray();
  });
  expect(await next("schedule_export_run_005")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", season_version: 2 } });
  expect(rows.SEASON[0][SHEET_SCOPES.SEASON.headers.indexOf("season_version")]).toBe("2");
  expect(rows.COACH).toHaveLength(1);
  expect(await next("schedule_export_run_006")).toMatchObject({ data: { status: "IDLE" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_test_001'").one().status).toBe("CONFIRMED");
    expect(sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_batches WHERE status='CONFIRMED'").one().count).toBe(5);
    expect(sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type IN ('SCHEDULE_TEMPLATE','TRAINING_WEEK','PRACTICE')")
      .one().count).toBeGreaterThan(10);
  });
});

it("keeps a quota failure pending and retries the same schedule batch without duplicate rows", async () => {
  const environment = testEnv("quota-retry");
  const stub = await seed(environment);
  mockSheetBridge("SERVICE_BUSY");
  const next = async (request_id: string) => (await call(environment,
    "/internal/c2/export-next-schedule", { request_id, season_id: seasonId })).json() as Promise<any>;
  expect(await next("schedule_quota_batch_001")).toMatchObject({ error: {
    code: "SERVICE_BUSY", retryable: true } });
  expect(rows.SCHEDULE_TEMPLATE).toHaveLength(0);
  let originalBatchId = "";
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const batch = sql.exec<{ batch_id: string; status: string; attempt_count: number }>(
      "SELECT batch_id,status,attempt_count FROM sync_batches").one();
    expect(batch).toMatchObject({ status: "FAILED", attempt_count: 1 });
    originalBatchId = batch.batch_id;
    expect(sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_test_001'").one().status).toBe("PENDING");
    expect(sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='SCHEDULE_TEMPLATE'").one().count).toBe(0);
  });
  expect(await next("schedule_quota_batch_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SCHEDULE_TEMPLATE", batch_id: originalBatchId } });
  expect(rows.SCHEDULE_TEMPLATE).toHaveLength(1);
  for (const [index, entity_type] of ["TRAINING_WEEK", "PRACTICE", "PRACTICE"].entries()) {
    expect(await next(`schedule_quota_resume_${index}`)).toMatchObject({ data: {
      status: "BATCH_CONFIRMED", entity_type } });
  }
  expect(await next("schedule_quota_complete")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", season_version: 2 } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_schedule_test_001'").one().status).toBe("CONFIRMED");
    expect(sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_batches WHERE status<>'CONFIRMED'").one().count).toBe(0);
    expect(sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_batch_items WHERE status<>'VERIFIED'").one().count).toBe(0);
  });
  expect(rows.SCHEDULE_TEMPLATE).toHaveLength(1);
  expect(rows.TRAINING_WEEK).toHaveLength(1);
  expect(rows.PRACTICE).toHaveLength(2);
});

it("keeps the schedule exporter disabled in production", async () => {
  const environment = { ...testEnv("production"), ENVIRONMENT: "production" } as Env;
  const response = await call(environment, "/internal/c2/export-next-schedule",
    { request_id: "schedule_export_disabled_001", season_id: seasonId });
  expect(response.status).toBe(404);
});

it("refuses a legacy schedule event without a captured snapshot before contacting Google", async () => {
  const environment = testEnv("uncaptured");
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec(`UPDATE sync_outbox SET payload_json=?
      WHERE outbox_id='out_schedule_test_001'`, JSON.stringify({ action: "prepareTrainingWeek",
      entity: { season_id: seasonId, week_id: week.week_id } })).toArray();
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const response = await call(environment, "/internal/c2/export-next-schedule",
    { request_id: "schedule_export_uncaptured_001", season_id: seasonId });
  expect(await response.json()).toMatchObject({ error: { code: "SYNC_OUTBOX_INVALID" } });
  expect(fetchSpy).not.toHaveBeenCalled();
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_batches").one().count).toBe(0);
  });
});
