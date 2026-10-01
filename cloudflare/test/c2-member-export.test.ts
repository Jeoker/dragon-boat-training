import { indexExportEvent } from "../src/c2-export-lanes";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { legacyCredentialDigest } from "../src/crypto";
import { TeamState } from "../src/team-state";
import { SHEET_SCOPES } from "../src/c2-sheet-bridge";
import { SYNC_FIELD_DEFINITIONS, normalizeSyncValue } from "../../shared/c2-sync-rules";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const seasonId = "season_export_test_2026";
const memberIds = ["member_export_alice_01", "member_export_bob_002"];
const testEnv = (suffix: string) => ({ ...env, TEAM_ID: `member-export-${suffix}`,
  C2_MEMBER_EXPORT_ENABLED: "true", GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/test/exec",
  GOOGLE_BRIDGE_SECRET: "local-bridge-secret" } as unknown as Env);
const headers = { authorization: "Bearer local-c2-test-key", "content-type": "application/json" };
const seasonCells = () => SHEET_SCOPES.SEASON.headers.map((header) => ({
  season_id: seasonId, name: "Export Season", start_date: "2026-04-01", end_date: "2026-12-31",
  timezone: "America/New_York", season_ends_at: "2027-01-01T05:00:00.000Z", status: "OPEN",
  form_id: "form_export_test_001", runtime_spreadsheet_id: "spreadsheet_export_test_001",
  response_sheet_id: "0", binding_version: "1", season_version: "1", roster_version: "0",
  updated_at: "2026-09-01T12:00:00.000Z"
} as Record<string, string>)[header] ?? "");

async function call(testEnvironment: Env, path: string, value: Record<string, unknown>, c1 = false) {
  return worker.fetch(new IncomingRequest(`https://example.test${path}`, {
    method: "POST", headers: c1 ? { ...headers, authorization: "Bearer local-c1-test-key" } : headers,
    body: JSON.stringify(value)
  }), testEnvironment);
}

async function seed(testEnvironment: Env) {
  const at = "2026-09-01T12:00:00.000Z";
  const coach = { coach_id: "coach_export_test_01", display_name: "Export Coach",
    code_salt: "export_salt_001", code_digest: await legacyCredentialDigest(
      "export_salt_001", "local-test-coach-code", "local-c1-coach-secret"),
    credential_version: 1, active: true, created_at: at, updated_at: at };
  const members = memberIds.map((memberId, index) => ({
    season_id: seasonId, member_id: memberId, source_key: `source_export_${index + 1}`,
    source_display_name: index ? "Bob" : "Alice", display_name_override: "", status: "ACTIVE",
    default_preference: index ? "RIGHT" : "LEFT", member_version: 1,
    created_at: at, updated_at: at
  }));
  expect((await call(testEnvironment, "/internal/c1/import-core", {
    request_id: "export_core_import_001", source_snapshot_id: "export_core_snapshot_001",
    settings_version: 1, default_season_id: seasonId, coaches: [coach],
    seasons: [{ season_id: seasonId, name: "Export Season", start_date: "2026-04-01",
      end_date: "2026-12-31", timezone: "America/New_York", season_ends_at: "2027-01-01T05:00:00.000Z",
      status: "OPEN", binding_version: 1, season_version: 1, roster_version: 2,
      created_by: coach.coach_id, created_at: at, updated_at: at }], members
  }, true)).status).toBe(200);
  expect((await call(testEnvironment, "/internal/c2/import-sync-foundation", {
    request_id: "export_foundation_001", source_snapshot_id: "export_foundation_snapshot_001",
    bindings: [{ season_id: seasonId, binding_version: 1, form_id: "form_export_test_001",
      runtime_spreadsheet_id: "spreadsheet_export_test_001", response_sheet_id: "0",
      response_sheet_name: "Form Responses 1", field_mapping: { display_name_header: "Name" },
      schema_fingerprint: "sha256_v1:export_schema_001", export_paused: false,
      last_pull_at: null, last_push_at: null, created_at: at, updated_at: at }],
    baselines: [], source_imports: []
  })).status).toBe(200);
  const stub = testEnvironment.TEAM_STATE.getByName(testEnvironment.TEAM_ID);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const requestKey = context.storage.sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    context.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
       VALUES ('out_export_test_001',?,'MEMBERS_IMPORTED',?,'PENDING',?,?)`,
      requestKey,
      JSON.stringify({ action: "pullFormResponses", entity: { season_id: seasonId, member_ids: memberIds } }),
      Date.now() - 1000, at).toArray();
    indexExportEvent(context.storage.sql, "out_export_test_001");
    const record = Object.fromEntries(SHEET_SCOPES.SEASON.headers.map((name, index) =>
      [name, seasonCells()[index]]));
    for (const group of new Set(SYNC_FIELD_DEFINITIONS.SEASON.map((field) => field.dependency_group))) {
      const baseline = Object.fromEntries(SYNC_FIELD_DEFINITIONS.SEASON
        .filter((field) => field.dependency_group === group)
        .map((field) => [field.field, normalizeSyncValue(record[field.field], field.kind, field.allowed_values)]));
      context.storage.sql.exec(
        `INSERT INTO sync_baselines VALUES (?,1,'SEASON',?,?,?,?,?,?,?)`,
        seasonId, seasonId, group, JSON.stringify(baseline), "sha256_v1:fixture_digest",
        1, "sha256_v1:fixture_digest", at).toArray();
    }
  });
  return stub;
}

afterEach(() => vi.restoreAllMocks());

it("exports a multi-member event one verified target at a time and survives a lost reply", async () => {
  const environment = testEnv("lost-reply");
  const stub = await seed(environment);
  const sheetRows: string[][] = [];
  let seasonRow = seasonCells();
  const verified = new Map<string, Record<string, unknown>>();
  let loseReply = true;
  let loseSeasonReply = true;
  let patchCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    if (envelope.action === "cloudflareReadSheetRecords") {
      const season = payload.entity_type === "SEASON";
      return Response.json({
      ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: payload.entity_type, binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest,
        spreadsheet_id: season ? "system_export_test_001" : "spreadsheet_export_test_001",
        tab_name: season ? "Seasons" : "Members", tab_id: season ? "100" : "101", read_at_ms: Date.now(),
        headers: [...SHEET_SCOPES[season ? "SEASON" : "MEMBER"].headers], secondary: null,
        rows: season ? [{ row_number: 2, cells: seasonRow }] :
          sheetRows.map((cells, index) => ({ row_number: index + 2, cells }))
      }
    });
    }
    patchCalls += 1;
    let receipt = verified.get(envelope.operation_id);
    if (!receipt) {
      for (const item of payload.items) {
        if (envelope.action === "cloudflarePatchSeasonSheet") seasonRow = item.target;
        else sheetRows.push(item.target);
      }
      receipt = { status: "verified", protocol_version: envelope.protocol_version,
        team_id: envelope.team_id, season_id: seasonId, binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest, spreadsheet_id: payload.spreadsheet_id,
        tab_id: payload.tab_id,
        [envelope.action === "cloudflarePatchSeasonSheet" ? "verified_season_ids" : "verified_member_ids"]:
          payload.items.map((item: { member_id?: string; season_id?: string }) => item.member_id ?? item.season_id),
        acknowledged_at: new Date().toISOString() };
      verified.set(envelope.operation_id, receipt);
    }
    if (loseReply) { loseReply = false; throw new Error("Lost after Google committed"); }
    if (envelope.action === "cloudflarePatchSeasonSheet" && loseSeasonReply) {
      loseSeasonReply = false;
      throw new Error("Lost after the season row was committed");
    }
    return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: receipt });
  });
  const exportNext = async (id: string) => (await call(environment, "/internal/c2/export-next-member",
    { request_id: id, season_id: seasonId })).json() as Promise<any>;
  expect(await exportNext("export_run_001")).toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  expect(sheetRows).toHaveLength(1);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().status).toBe("PENDING");
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_batches").one().status).toBe("FAILED");
  });
  const firstConfirmed = await exportNext("export_run_001");
  expect(firstConfirmed).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", member_id: memberIds[0] } });
  expect(sheetRows).toHaveLength(1);
  expect((await exportNext("export_run_001")).data).toEqual(firstConfirmed.data);
  expect(sheetRows).toHaveLength(1);
  expect(await exportNext("export_run_003")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", member_id: memberIds[1] } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().status).toBe("PENDING");
  });
  const seasonNameIndex = SHEET_SCOPES.SEASON.headers.indexOf("name");
  seasonRow[seasonNameIndex] = "Manual Google edit";
  expect(await exportNext("export_run_review_004")).toMatchObject({ error: {
    code: "SYNC_SEASON_NEEDS_REVIEW" } });
  seasonRow[seasonNameIndex] = "Export Season";
  expect(await exportNext("export_run_004")).toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().status).toBe("PENDING");
  });
  expect(await exportNext("export_run_004")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", roster_version: 2 } });
  expect(await exportNext("export_run_005")).toMatchObject({ data: { status: "IDLE" } });
  expect(sheetRows).toHaveLength(2);
  expect(seasonRow[SHEET_SCOPES.SEASON.headers.indexOf("roster_version")]).toBe("2");
  expect(patchCalls).toBe(5);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().status).toBe("CONFIRMED");
    expect(context.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='MEMBER'").one().count).toBe(12);
    expect(context.storage.sql.exec<{ roster_version: number }>(
      "SELECT CAST(json_extract(baseline_json,'$.roster_version') AS INTEGER) AS roster_version FROM sync_baselines WHERE entity_type='SEASON' AND dependency_group='SYSTEM_VERSION'").one().roster_version).toBe(2);
  });
  expect(await exportNext("export_run_004")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", outbox_id: "out_export_test_001" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const requestKey = context.storage.sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    context.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
       VALUES ('out_export_later_003',?,'CORE_CHANGED',?,'PENDING',?,?)`, requestKey,
      JSON.stringify({ action: "updateMember", entity: { season_id: seasonId, member_id: memberIds[0] } }),
      Date.now() - 1000, new Date().toISOString()).toArray();
    indexExportEvent(context.storage.sql, "out_export_later_003");
  });
  expect(await exportNext("export_run_005")).toMatchObject({ data: { status: "IDLE" } });
  expect(patchCalls).toBe(5);
});

it("drains a Google-committed batch while paused without preparing the next event", async () => {
  const environment = { ...testEnv("paused-lost-reply"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec("UPDATE sync_outbox SET payload_json=? WHERE outbox_id='out_export_test_001'",
      JSON.stringify({ action: "pullFormResponses", entity: { season_id: seasonId,
        member_ids: [memberIds[0]], roster_version: 1 } })).toArray();
    const sequence = sql.exec<{ event_sequence: number }>("SELECT event_sequence FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").one().event_sequence;
    sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").toArray();
    indexExportEvent(sql, "out_export_test_001");
    sql.exec("UPDATE sync_export_event_index SET event_sequence=? WHERE outbox_id='out_export_test_001'", sequence).toArray();
    sql.exec("UPDATE sync_export_event_index SET classification_anchor=json_array(outbox_id,event_sequence,season_id,handler_kind,practice_id)").toArray();
    const requestKey = sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    sql.exec(`INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
      VALUES ('out_export_after_pause_002',?,'MEMBERS_IMPORTED',?,'PENDING',?,?)`, requestKey,
    JSON.stringify({ action: "pullFormResponses", entity: { season_id: seasonId,
      member_ids: [memberIds[1]], roster_version: 2 } }), Date.now() - 1000,
    "2026-09-02T12:00:00.000Z").toArray();
    indexExportEvent(sql, 'out_export_after_pause_002');
  });
  const login = await call(environment, "/internal/c1/coach-login", {
    request_id: "paused_export_login_001", coach_code: "local-test-coach-code"
  }, true);
  expect(login.status).toBe(200);
  const token = (await login.json() as any).data.result.session_token as string;
  const coachAction = async (path: string, requestId: string, extra: Record<string, unknown> = {}) =>
    (await call(environment, path, { request_id: requestId, session_token: token,
      season_id: seasonId, ...extra })).json() as Promise<any>;
  const poll = async (requestId: string) =>
    (await call(environment, "/internal/c2/poll-due-exports", { request_id: requestId }))
      .json() as Promise<any>;
  const exportNext = async (requestId: string) =>
    (await call(environment, "/internal/c2/export-next-member", {
      request_id: requestId, season_id: seasonId })).json() as Promise<any>;
  const dueNow = () => runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_export_retries SET next_attempt_at_ms=0 WHERE season_id=?",
      seasonId).toArray();
  });
  const queue = () => runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    return {
      outbox: sql.exec<{ outbox_id: string; status: string }>(
        "SELECT outbox_id,status FROM sync_outbox WHERE topic='MEMBERS_IMPORTED' ORDER BY rowid").toArray(),
      batches: sql.exec<{ batch_id: string; first_outbox_id: string; status: string;
        attempt_count: number }>(
        "SELECT batch_id,first_outbox_id,status,attempt_count FROM sync_batches ORDER BY rowid").toArray(),
      memberBaselines: sql.exec<{ entity_id: string; count: number }>(
        "SELECT entity_id,COUNT(*) AS count FROM sync_baselines WHERE entity_type='MEMBER' GROUP BY entity_id ORDER BY entity_id").toArray(),
      rosterVersion: sql.exec<{ roster_version: number }>(
        "SELECT CAST(json_extract(baseline_json,'$.roster_version') AS INTEGER) AS roster_version FROM sync_baselines WHERE entity_type='SEASON' AND dependency_group='SYSTEM_VERSION'").one().roster_version,
      retry: sql.exec<{ failure_count: number; action_required: number; last_error: string }>(
        "SELECT failure_count,action_required,last_error FROM sync_export_retries WHERE season_id=?",
        seasonId).toArray(),
      conflicts: sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_conflicts WHERE season_id=?", seasonId).one().count
    };
  });
  let seasonRow = seasonCells();
  const memberRows: string[][] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const committedPayloads = new Map<string, { digest: string; json: string }>();
  const patchAttempts: Array<{ operationId: string; batchId: string; scope: string }> = [];
  const readScopes: string[] = [];
  let loseFirstReply = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    const isSeason = payload.entity_type === "SEASON" ||
      envelope.action === "cloudflarePatchSeasonSheet";
    if (envelope.action === "cloudflareReadSheetRecords") {
      readScopes.push(String(payload.entity_type));
      return Response.json({
        ok: true, meta: { request_id: envelope.request_id }, data: {
          protocol_version: envelope.protocol_version, team_id: envelope.team_id,
          season_id: seasonId, entity_type: payload.entity_type, binding_version: 1,
          writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
          payload_digest: envelope.payload_digest,
          spreadsheet_id: isSeason ? "system_export_test_001" : "spreadsheet_export_test_001",
          tab_name: isSeason ? "Seasons" : "Members", tab_id: isSeason ? "100" : "101",
          read_at_ms: Date.now(), headers: [...SHEET_SCOPES[isSeason ? "SEASON" : "MEMBER"].headers],
          secondary: null, rows: (isSeason ? [seasonRow] : memberRows).map((cells, index) =>
            ({ row_number: index + 2, cells }))
        }
      });
    }
    const item = payload.items[0];
    patchAttempts.push({ operationId: envelope.operation_id, batchId: payload.batch_id,
      scope: isSeason ? "SEASON" : "MEMBER" });
    let receipt = receipts.get(envelope.operation_id);
    if (!receipt) {
      committedPayloads.set(envelope.operation_id, {
        digest: envelope.payload_digest, json: envelope.payload_json });
      if (isSeason) {
        expect(item.expected).toEqual(seasonRow);
        seasonRow = item.target;
      } else {
        const index = memberRows.findIndex((row) => row[1] === item.member_id);
        expect(item.expected).toEqual(index < 0 ? null : memberRows[index]);
        if (index < 0) memberRows.push(item.target);
        else memberRows[index] = item.target;
      }
      receipt = { status: "verified", protocol_version: envelope.protocol_version,
        team_id: envelope.team_id, season_id: seasonId, binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest, spreadsheet_id: payload.spreadsheet_id,
        tab_id: payload.tab_id,
        [isSeason ? "verified_season_ids" : "verified_member_ids"]:
          [isSeason ? seasonId : item.member_id], acknowledged_at: new Date().toISOString() };
      receipts.set(envelope.operation_id, receipt);
    } else {
      expect({ digest: envelope.payload_digest, json: envelope.payload_json })
        .toEqual(committedPayloads.get(envelope.operation_id));
    }
    if (loseFirstReply) {
      loseFirstReply = false;
      throw new Error("Google committed the member row, but its reply was lost");
    }
    return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: receipt });
  });

  expect(await exportNext("paused_export_initial_001"))
    .toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  expect(memberRows.map((row) => row[1])).toEqual([memberIds[0]]);
  const beforePause = await queue();
  expect(beforePause.batches).toHaveLength(1);
  expect(beforePause.batches[0]).toMatchObject({ first_outbox_id: "out_export_test_001",
    status: "FAILED", attempt_count: 1 });
  expect(beforePause.memberBaselines).toEqual([]);
  expect(beforePause.rosterVersion).toBe(0);
  expect(beforePause.outbox.map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
  expect(beforePause.conflicts).toBe(0);
  expect(readScopes).toEqual(["MEMBER"]);

  const pause = await coachAction("/internal/c2/set-export-pause", "paused_export_pause_001",
    { paused: true });
  expect(pause.data.result).toMatchObject({ status: "PAUSING",
    unfinished_batch_id: beforePause.batches[0].batch_id });
  expect(await coachAction("/internal/c2/set-export-pause", "paused_export_resume_early_001",
    { paused: false })).toMatchObject({ error: { code: "SYNC_EXPORT_DRAINING" } });
  expect((await coachAction("/internal/c2/get-sync-overview", "paused_export_overview_001"))
    .data.export_control.status).toBe("PAUSING");

  const drain = await poll("paused_export_poll_drain_001");
  expect(drain.data.results).toEqual([{ season_id: seasonId, status: "BATCH_CONFIRMED" }]);
  expect(patchAttempts.slice(0, 2).map((attempt) => attempt.operationId))
    .toEqual([patchAttempts[0].operationId, patchAttempts[0].operationId]);
  expect(patchAttempts.slice(0, 2).map((attempt) => attempt.batchId))
    .toEqual([beforePause.batches[0].batch_id, beforePause.batches[0].batch_id]);
  expect(readScopes).toEqual(["MEMBER"]);
  expect(memberRows.map((row) => row[1])).toEqual([memberIds[0]]);
  const drained = await queue();
  expect(drained.batches).toHaveLength(1);
  expect(drained.batches[0]).toMatchObject({ status: "CONFIRMED", attempt_count: 2 });
  expect(drained.memberBaselines).toEqual([{ entity_id: memberIds[0], count: 6 }]);
  expect(drained.rosterVersion).toBe(0);
  expect(drained.outbox.map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
  expect(drained.retry).toEqual([{ failure_count: 0, action_required: 0, last_error: "" }]);
  expect(drained.conflicts).toBe(0);
  expect((await coachAction("/internal/c2/get-sync-overview", "paused_export_overview_002"))
    .data.export_control.status).toBe("PAUSED");
  await dueNow();
  expect((await poll("paused_export_poll_while_paused_002")).data.polled).toBe(0);
  expect((await queue()).batches).toHaveLength(1);
  expect(patchAttempts).toHaveLength(2);
  expect(readScopes).toEqual(["MEMBER"]);

  expect(await coachAction("/internal/c2/set-export-pause", "paused_export_resume_002",
    { paused: false })).toMatchObject({ data: { result: {
      status: "RUNNING", next_batch_requires_fresh_comparison: true } } });
  expect((await poll("paused_export_poll_after_resume_003")).data.results)
    .toEqual([{ season_id: seasonId, status: "EVENT_CONFIRMED" }]);
  expect(readScopes).toEqual(["MEMBER", "SEASON"]);
  expect(seasonRow[SHEET_SCOPES.SEASON.headers.indexOf("roster_version")]).toBe("1");
  expect((await queue()).outbox.map((row) => row.status)).toEqual(["CONFIRMED", "PENDING"]);
  await dueNow();
  expect((await poll("paused_export_poll_next_event_004")).data.results)
    .toEqual([{ season_id: seasonId, status: "BATCH_CONFIRMED" }]);
  expect(readScopes).toEqual(["MEMBER", "SEASON", "MEMBER"]);
  expect(memberRows.map((row) => row[1])).toEqual(memberIds);
  await dueNow();
  expect((await poll("paused_export_poll_next_season_005")).data.results)
    .toEqual([{ season_id: seasonId, status: "EVENT_CONFIRMED" }]);
  const complete = await queue();
  expect(complete.outbox.map((row) => row.status)).toEqual(["CONFIRMED", "CONFIRMED"]);
  expect(complete.batches.map((batch) => batch.status)).toEqual([
    "CONFIRMED", "CONFIRMED", "CONFIRMED", "CONFIRMED"]);
  expect(complete.memberBaselines).toEqual(memberIds.map((entity_id) => ({ entity_id, count: 6 })));
  expect(complete.rosterVersion).toBe(2);
  expect(complete.retry).toEqual([]);
  expect(complete.conflicts).toBe(0);
});

it("keeps member export disabled in production", async () => {
  const environment = { ...testEnv("production"), ENVIRONMENT: "production" } as Env;
  const result = await call(environment, "/internal/c2/export-next-member",
    { request_id: "export_disabled_001", season_id: seasonId });
  expect(result.status).toBe(404);
});

it("does not resend a superseded batch through its original request ID", async () => {
  const environment = testEnv("superseded-request");
  const stub = await seed(environment);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    if (envelope.action === "cloudflareReadSheetRecords") {
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: "MEMBER", binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest,
        spreadsheet_id: "spreadsheet_export_test_001", tab_name: "Members", tab_id: "101",
        read_at_ms: Date.now(), headers: [...SHEET_SCOPES.MEMBER.headers], secondary: null, rows: []
      } });
    }
    expect(payload.items).toHaveLength(1);
    throw new Error("The bridge became unavailable after preparation");
  });
  const input = { request_id: "export_superseded_001", season_id: seasonId };
  expect(await (await call(environment, "/internal/c2/export-next-member", input)).json())
    .toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_batches SET status='SUPERSEDED' WHERE status='FAILED'").toArray();
  });
  fetchSpy.mockClear();
  expect(await (await call(environment, "/internal/c2/export-next-member", input)).json())
    .toMatchObject({ error: { code: "SYNC_BATCH_INVALID" } });
  expect(fetchSpy).not.toHaveBeenCalled();
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string; attempt_count: number }>(
      "SELECT status,attempt_count FROM sync_batches").one()).toMatchObject({
      status: "SUPERSEDED", attempt_count: 1
    });
  });
});

it("does not resend a prepared member patch after its outbox event stops pending", async () => {
  const environment = testEnv("outbox-stopped-before-retry");
  const stub = await seed(environment);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    if (envelope.action === "cloudflareReadSheetRecords") {
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: "MEMBER", binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest,
        spreadsheet_id: "spreadsheet_export_test_001", tab_name: "Members", tab_id: "101",
        read_at_ms: Date.now(), headers: [...SHEET_SCOPES.MEMBER.headers], secondary: null, rows: []
      } });
    }
    expect(payload.items).toHaveLength(1);
    throw new Error("The bridge became unavailable after preparation");
  });
  const input = { request_id: "export_outbox_changed_001", season_id: seasonId };
  expect(await (await call(environment, "/internal/c2/export-next-member", input)).json())
    .toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_outbox SET status='FAILED' WHERE outbox_id='out_export_test_001'").toArray();
  });
  fetchSpy.mockClear();
  expect(await (await call(environment, "/internal/c2/export-next-member", input)).json())
    .toMatchObject({ error: { code: "SYNC_EXPORT_STALE" } });
  expect(fetchSpy).not.toHaveBeenCalled();
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>("SELECT status FROM sync_batches").one().status)
      .toBe("FAILED");
    expect(context.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='MEMBER'").one().count).toBe(0);
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().status).toBe("FAILED");
  });
});

it("advances captured roster versions in order when another member joins before export", async () => {
  const environment = testEnv("rolling-roster");
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_outbox SET payload_json=? WHERE outbox_id='out_export_test_001'",
      JSON.stringify({ action: "pullFormResponses", entity: { season_id: seasonId,
        member_ids: [memberIds[0]], roster_version: 1 } })).toArray();
    const sequence = context.storage.sql.exec<{ event_sequence: number }>("SELECT event_sequence FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").one().event_sequence;
    context.storage.sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").toArray();
    indexExportEvent(context.storage.sql, "out_export_test_001");
    context.storage.sql.exec("UPDATE sync_export_event_index SET event_sequence=? WHERE outbox_id='out_export_test_001'", sequence).toArray();
    context.storage.sql.exec("UPDATE sync_export_event_index SET classification_anchor=json_array(outbox_id,event_sequence,season_id,handler_kind,practice_id)").toArray();
    const requestKey = context.storage.sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    context.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
       VALUES ('out_export_rolling_002',?,'MEMBERS_IMPORTED',?,'PENDING',?,?)`, requestKey,
      JSON.stringify({ action: "pullFormResponses", entity: { season_id: seasonId,
        member_ids: [memberIds[1]], roster_version: 2 } }), Date.now() - 1000,
      "2026-09-02T12:00:00.000Z").toArray();
    indexExportEvent(context.storage.sql, "out_export_rolling_002");
  });
  let seasonRow = seasonCells();
  const memberRows: string[][] = [];
  const seasonVersions: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    const season = payload.entity_type === "SEASON" || envelope.action === "cloudflarePatchSeasonSheet";
    const spreadsheetId = season ? "system_export_test_001" : "spreadsheet_export_test_001";
    const tabId = season ? "100" : "101";
    if (envelope.action === "cloudflareReadSheetRecords") return Response.json({
      ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: payload.entity_type, binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest, spreadsheet_id: spreadsheetId,
        tab_name: season ? "Seasons" : "Members", tab_id: tabId, read_at_ms: Date.now(),
        headers: [...SHEET_SCOPES[season ? "SEASON" : "MEMBER"].headers], secondary: null,
        rows: (season ? [seasonRow] : memberRows).map((cells, index) =>
          ({ row_number: index + 2, cells }))
      }
    });
    const item = payload.items[0];
    if (season) {
      seasonRow = item.target;
      seasonVersions.push(seasonRow[SHEET_SCOPES.SEASON.headers.indexOf("roster_version")]);
    } else memberRows.push(item.target);
    return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
      status: "verified", protocol_version: envelope.protocol_version, team_id: envelope.team_id,
      season_id: seasonId, binding_version: 1, writer_epoch: envelope.writer_epoch,
      operation_id: envelope.operation_id, payload_digest: envelope.payload_digest,
      spreadsheet_id: payload.spreadsheet_id, tab_id: payload.tab_id,
      [season ? "verified_season_ids" : "verified_member_ids"]:
        [season ? seasonId : item.member_id], acknowledged_at: new Date().toISOString()
    } });
  });
  const next = async (request_id: string) => (await call(environment, "/internal/c2/export-next-member",
    { request_id, season_id: seasonId })).json() as Promise<any>;
  expect(await next("rolling_export_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED",
    member_id: memberIds[0] } });
  expect(await next("rolling_export_002")).toMatchObject({ data: { status: "EVENT_CONFIRMED",
    roster_version: 1 } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const rows = context.storage.sql.exec<{ outbox_id: string; status: string }>(
      "SELECT outbox_id,status FROM sync_outbox WHERE topic='MEMBERS_IMPORTED' ORDER BY rowid").toArray();
    expect(rows.map((row) => row.status)).toEqual(["CONFIRMED", "PENDING"]);
  });
  expect(await next("rolling_export_003")).toMatchObject({ data: { status: "BATCH_CONFIRMED",
    member_id: memberIds[1] } });
  expect(await next("rolling_export_004")).toMatchObject({ data: { status: "EVENT_CONFIRMED",
    roster_version: 2 } });
  expect(seasonVersions).toEqual(["1", "2"]);
  expect(memberRows).toHaveLength(2);
});

it("does not overtake an earlier unsupported season event", async () => {
  const environment = testEnv("ordered-events");
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_outbox SET topic='SCHEDULE_CHANGED' WHERE outbox_id='out_export_test_001'").toArray();
    const sequence = context.storage.sql.exec<{ event_sequence: number }>("SELECT event_sequence FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").one().event_sequence;
    context.storage.sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").toArray();
    indexExportEvent(context.storage.sql, "out_export_test_001");
    context.storage.sql.exec("UPDATE sync_export_event_index SET event_sequence=? WHERE outbox_id='out_export_test_001'", sequence).toArray();
    context.storage.sql.exec("UPDATE sync_export_event_index SET classification_anchor=json_array(outbox_id,event_sequence,season_id,handler_kind,practice_id)").toArray();
    const requestKey = context.storage.sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    context.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
       VALUES ('out_export_later_002',?,'CORE_CHANGED',?,'PENDING',?,?)`, requestKey,
      JSON.stringify({ action: "updateMember", entity: { season_id: seasonId, member_id: memberIds[0] } }),
      Date.now() - 1000, new Date().toISOString()).toArray();
    indexExportEvent(context.storage.sql, "out_export_later_002");
  });
  const result = await call(environment, "/internal/c2/export-next-member",
    { request_id: "export_ordered_001", season_id: seasonId });
  expect(await result.json()).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
});

it("does not count a prior binding's verified member rows toward the current export", async () => {
  const environment = testEnv("old-binding-receipts");
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,direction,status,
        payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at,completed_at)
      VALUES ('batch_old_binding_001',?,1,0,'CLOUDFLARE_TO_GOOGLE','CONFIRMED',
        'old_digest','out_export_test_001','out_export_test_001',?,?,?)`, seasonId,
    "2026-09-01T12:00:00.000Z", "2026-09-01T12:00:00.000Z", "2026-09-01T12:00:00.000Z").toArray();
    for (const [index, memberId] of memberIds.entries()) {
      sql.exec(`INSERT INTO sync_batch_items(batch_id,item_index,entity_type,entity_id,dependency_group,
        expected_sheet_digest,target_json,target_digest,status,updated_at)
        VALUES ('batch_old_binding_001',?,'MEMBER',?,'ROW','old_digest','{}','old_digest','VERIFIED',?)`,
      index, memberId, "2026-09-01T12:00:00.000Z").toArray();
    }
    sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id=?", seasonId).toArray();
    sql.exec("UPDATE sync_bindings SET binding_version=2 WHERE season_id=?", seasonId).toArray();
    sql.exec(`INSERT INTO sync_baselines(season_id,binding_version,entity_type,entity_id,dependency_group,
      baseline_json,baseline_digest,cloud_version,sheet_digest,updated_at)
      SELECT season_id,2,entity_type,entity_id,dependency_group,baseline_json,baseline_digest,
        cloud_version,sheet_digest,updated_at FROM sync_baselines WHERE season_id=? AND binding_version=1`,
    seasonId).toArray();
    sql.exec("UPDATE sync_outbox SET payload_json=? WHERE outbox_id='out_export_test_001'",
      JSON.stringify({ action: "pullFormResponses", entity: { season_id: seasonId,
        member_ids: memberIds, roster_version: 2 } })).toArray();
    const sequence = sql.exec<{ event_sequence: number }>("SELECT event_sequence FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").one().event_sequence;
    sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").toArray();
    indexExportEvent(sql, "out_export_test_001");
    sql.exec("UPDATE sync_export_event_index SET event_sequence=? WHERE outbox_id='out_export_test_001'", sequence).toArray();
    sql.exec("UPDATE sync_export_event_index SET classification_anchor=json_array(outbox_id,event_sequence,season_id,handler_kind,practice_id)").toArray();
  });
  const readScopes: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    if (envelope.action === "cloudflareReadSheetRecords") {
      readScopes.push(payload.entity_type);
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: payload.entity_type, binding_version: 2,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest, spreadsheet_id: "spreadsheet_export_test_001",
        tab_name: "Members", tab_id: "101", read_at_ms: Date.now(),
        headers: [...SHEET_SCOPES.MEMBER.headers], secondary: null, rows: []
      } });
    }
    return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
      status: "verified", protocol_version: envelope.protocol_version, team_id: envelope.team_id,
      season_id: seasonId, binding_version: 2, writer_epoch: envelope.writer_epoch,
      operation_id: envelope.operation_id, payload_digest: envelope.payload_digest,
      spreadsheet_id: payload.spreadsheet_id, tab_id: payload.tab_id,
      verified_member_ids: [payload.items[0].member_id], acknowledged_at: new Date().toISOString()
    } });
  });
  const response = await call(environment, "/internal/c2/export-next-member",
    { request_id: "export_after_binding_001", season_id: seasonId });
  expect(await response.json()).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", member_id: memberIds[0] } });
  expect(readScopes).toEqual(["MEMBER"]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const current = context.storage.sql.exec<{ binding_version: number }>(
      `SELECT b.binding_version FROM sync_batches b JOIN sync_batch_items i ON i.batch_id=b.batch_id
       WHERE i.entity_type='MEMBER' AND i.entity_id=? AND b.status='CONFIRMED'
       ORDER BY b.binding_version DESC LIMIT 1`, memberIds[0]).one();
    expect(current.binding_version).toBe(2);
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().status).toBe("PENDING");
  });
});

it("stops on an unfinished old-binding batch instead of silently discarding a possible partial write", async () => {
  const environment = testEnv("old-binding-partial");
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,direction,status,
      payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
      VALUES ('batch_old_partial_001',?,1,0,'CLOUDFLARE_TO_GOOGLE','PARTIAL',
        'old_digest','out_export_test_001','out_export_test_001',?,?)`, seasonId,
    "2026-09-01T12:00:00.000Z", "2026-09-01T12:00:00.000Z").toArray();
    sql.exec(`INSERT INTO sync_batch_items(batch_id,item_index,entity_type,entity_id,dependency_group,
      expected_sheet_digest,target_json,target_digest,status,updated_at)
      VALUES ('batch_old_partial_001',0,'MEMBER',?,'ROW','old_digest',?,'old_digest','PENDING',?)`,
    memberIds[0], JSON.stringify({ member_id: memberIds[0] }), "2026-09-01T12:00:00.000Z").toArray();
    sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id=?", seasonId).toArray();
    sql.exec("UPDATE sync_bindings SET binding_version=2 WHERE season_id=?", seasonId).toArray();
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const response = await call(environment, "/internal/c2/export-next-member",
    { request_id: "export_old_partial_001", season_id: seasonId });
  expect(await response.json()).toMatchObject({ error: { code: "SYNC_BINDING_STALE" } });
  expect(fetchSpy).not.toHaveBeenCalled();
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_batches WHERE batch_id='batch_old_partial_001'").one().status).toBe("PARTIAL");
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().status).toBe("PENDING");
  });
});

it("does not partially export a legacy event when a later roster version cannot be reconstructed", async () => {
  const environment = testEnv("uncaptured-roster");
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const requestKey = context.storage.sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    context.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
       VALUES ('out_export_uncaptured_002',?,'MEMBERS_IMPORTED',?,'PENDING',?,?)`, requestKey,
      JSON.stringify({ action: "pullFormResponses", entity: { season_id: seasonId,
        member_ids: [memberIds[0]] } }), Date.now() - 1000, "2026-09-02T12:00:00.000Z").toArray();
    indexExportEvent(context.storage.sql, "out_export_uncaptured_002");
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const response = await call(environment, "/internal/c2/export-next-member",
    { request_id: "export_uncaptured_001", season_id: seasonId });
  expect(await response.json()).toMatchObject({ error: { code: "SYNC_ROSTER_VERSION_UNCAPTURED" } });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("rejects a member event without member targets instead of confirming its season", async () => {
  const environment = testEnv("empty-targets");
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_outbox SET payload_json=? WHERE outbox_id='out_export_test_001'",
      JSON.stringify({ action: "pullFormResponses", entity: { season_id: seasonId,
        member_ids: [], roster_version: 2 } })).toArray();
    const sequence = context.storage.sql.exec<{ event_sequence: number }>("SELECT event_sequence FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").one().event_sequence;
    context.storage.sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").toArray();
    indexExportEvent(context.storage.sql, "out_export_test_001");
    context.storage.sql.exec("UPDATE sync_export_event_index SET event_sequence=? WHERE outbox_id='out_export_test_001'", sequence).toArray();
    context.storage.sql.exec("UPDATE sync_export_event_index SET classification_anchor=json_array(outbox_id,event_sequence,season_id,handler_kind,practice_id)").toArray();
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const response = await call(environment, "/internal/c2/export-next-member",
    { request_id: "export_empty_targets_001", season_id: seasonId });
  expect(await response.json()).toMatchObject({ error: { code: "SYNC_OUTBOX_INVALID" } });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("a late duplicate receipt cannot regress a newer confirmed baseline", async () => {
  const environment = testEnv("late-receipt");
  const stub = await seed(environment);
  let attempts = 0;
  let savedReceipt: Record<string, unknown> | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    if (envelope.action === "cloudflareReadSheetRecords") return Response.json({
      ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: "MEMBER", binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest, spreadsheet_id: "spreadsheet_export_test_001",
        tab_name: "Members", tab_id: "101", read_at_ms: Date.now(),
        headers: [...SHEET_SCOPES.MEMBER.headers], secondary: null, rows: []
      }
    });
    attempts += 1;
    savedReceipt ??= { status: "verified", protocol_version: envelope.protocol_version,
      team_id: envelope.team_id, season_id: seasonId, binding_version: 1,
      writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
      payload_digest: envelope.payload_digest, spreadsheet_id: payload.spreadsheet_id,
      tab_id: payload.tab_id, verified_member_ids: [memberIds[0]],
      acknowledged_at: new Date().toISOString() };
    if (attempts === 1) await new Promise((resolve) => setTimeout(resolve, 100));
    return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: savedReceipt });
  });
  const exportNext = async (id: string) => (await call(environment, "/internal/c2/export-next-member",
    { request_id: id, season_id: seasonId })).json() as Promise<any>;
  const delayed = exportNext("export_late_first_001");
  for (let index = 0; index < 20 && attempts < 1; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(attempts).toBe(1);
  expect(await exportNext("export_late_second_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", member_id: memberIds[0] } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec(
      "UPDATE sync_baselines SET cloud_version=2 WHERE entity_id=?", memberIds[0]).toArray();
  });
  expect(await delayed).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ cloud_version: number }>(
      "SELECT cloud_version FROM sync_baselines WHERE entity_id=? LIMIT 1", memberIds[0]).one().cloud_version).toBe(2);
  });
  expect(attempts).toBe(2);
});

it("refuses a manual Google edit before patching an existing member", async () => {
  const environment = testEnv("existing-row");
  const stub = await seed(environment);
  const sheetHeaders = [...SHEET_SCOPES.MEMBER.headers];
  const at = "2026-09-01T12:00:00.000Z";
  const original = [seasonId, memberIds[0], "source_export_1", "2", "Alice", "",
    "ACTIVE", "LEFT", "1", at, at];
  let google = [...original];
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_export_test_001'").toArray();
    context.storage.sql.exec("DELETE FROM sync_outbox WHERE outbox_id='out_export_test_001'").toArray();
    const requestKey = context.storage.sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    context.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
       VALUES ('out_export_update_001',?,'CORE_CHANGED',?,'PENDING',?,?)`, requestKey,
      JSON.stringify({ action: "updateMember", entity: { season_id: seasonId, member_id: memberIds[0] } }),
      Date.now() - 1000, at).toArray();
    indexExportEvent(context.storage.sql, "out_export_update_001");
    const record = Object.fromEntries(sheetHeaders.map((name, index) => [name, original[index]]));
    const groups = [...new Set(SYNC_FIELD_DEFINITIONS.MEMBER.map((field) => field.dependency_group))];
    for (const group of groups) {
      const baseline = Object.fromEntries(SYNC_FIELD_DEFINITIONS.MEMBER
        .filter((field) => field.dependency_group === group)
        .map((field) => [field.field, normalizeSyncValue(record[field.field], field.kind, field.allowed_values)]));
      context.storage.sql.exec(
        `INSERT INTO sync_baselines VALUES (?,1,'MEMBER',?,?,?,?,?,?,?)`,
        seasonId, memberIds[0], group, JSON.stringify(baseline), "sha256_v1:fixture_digest",
        1, "sha256_v1:fixture_digest", at).toArray();
    }
    context.storage.sql.exec(
      "UPDATE members SET display_name_override='A. Smith',member_version=2,updated_at=? WHERE member_id=?",
      "2026-09-02T12:00:00.000Z", memberIds[0]).toArray();
  });
  let patchCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    if (envelope.action === "cloudflareReadSheetRecords") return Response.json({
      ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: "MEMBER", binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest, spreadsheet_id: "spreadsheet_export_test_001",
        tab_name: "Members", tab_id: "101", read_at_ms: Date.now(),
        headers: sheetHeaders, secondary: null, rows: [{ row_number: 2, cells: google }]
      }
    });
    patchCalls += 1;
    const item = payload.items[0];
    expect(item.expected).toEqual(original);
    expect(item.target[3]).toBe("2");
    expect(item.target[5]).toBe("A. Smith");
    expect(item.target[8]).toBe("2");
    google = item.target;
    return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
      status: "verified", protocol_version: envelope.protocol_version, team_id: envelope.team_id,
      season_id: seasonId, binding_version: 1, writer_epoch: envelope.writer_epoch,
      operation_id: envelope.operation_id, payload_digest: envelope.payload_digest,
      spreadsheet_id: payload.spreadsheet_id, tab_id: payload.tab_id,
      verified_member_ids: [memberIds[0]], acknowledged_at: new Date().toISOString()
    } });
  });
  const exportNext = async (id: string) => (await call(environment, "/internal/c2/export-next-member",
    { request_id: id, season_id: seasonId })).json() as Promise<any>;
  google[7] = "RIGHT";
  expect(await exportNext("export_existing_review_001")).toMatchObject({ error: {
    code: "SYNC_MEMBER_NEEDS_REVIEW" } });
  expect(patchCalls).toBe(0);
  google[7] = "LEFT";
  expect(await exportNext("export_existing_retry_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", member_id: memberIds[0] } });
  expect(patchCalls).toBe(1);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const baseline = context.storage.sql.exec<{ cloud_version: number; baseline_json: string }>(
      "SELECT cloud_version,baseline_json FROM sync_baselines WHERE entity_id=? AND dependency_group='MEMBER_NAME'",
      memberIds[0]).one();
    expect(baseline.cloud_version).toBe(2);
    expect(JSON.parse(baseline.baseline_json)).toEqual({ display_name_override: "A. Smith" });
  });
});
it("pins an unknown initial direct member read before any batch and never switches to a later member event", async () => {
  const environment = testEnv("direct-read-pin");
  const stub = await seed(environment);
  let firstReadFault = true;
  const memberRows: string[][] = [];
  let seasonRow = seasonCells();
  let writes = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.payload_json);
    const season = payload.entity_type === "SEASON" || envelope.action === "cloudflarePatchSeasonSheet";
    const common = { protocol_version: envelope.protocol_version, team_id: envelope.team_id, season_id: seasonId,
      binding_version: 1, writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id, payload_digest: envelope.payload_digest,
      spreadsheet_id: season ? "system_member_export_001" : "spreadsheet_export_test_001", tab_id: season ? "100" : "101" };
    if (envelope.action === "cloudflareReadSheetRecords") {
      if (firstReadFault) { firstReadFault = false; throw new Error("Unknown initial Google read result"); }
      const scope = season ? "SEASON" : "MEMBER";
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: { ...common, entity_type: scope,
        tab_name: SHEET_SCOPES[scope].tab, headers: [...SHEET_SCOPES[scope].headers], read_at_ms: Date.now(), secondary: null,
        rows: (season ? [seasonRow] : memberRows).map((cells, index) => ({ row_number: index + 2, cells: [...cells] })) } });
    }
    writes++;
    if (season) seasonRow = [...payload.items[0].target];
    else for (const item of payload.items) {
      const index = memberRows.findIndex(row => row[1] === item.member_id);
      if (index < 0) memberRows.push([...item.target]); else memberRows[index] = [...item.target];
    }
    return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: { ...common,
      spreadsheet_id: payload.spreadsheet_id, tab_id: payload.tab_id, status: "verified", acknowledged_at: new Date().toISOString(),
      ...(season ? { verified_season_ids: [seasonId] } : { verified_member_ids: payload.items.map((item: { member_id: string }) => item.member_id) }) } });
  });
  const next = async (id: string, season = seasonId) => (await call(environment, "/internal/c2/export-next-member", { request_id: id, season_id: season })).json() as Promise<any>;
  expect(await next("direct_member_unknown_001")).toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  expect(await next("direct_member_other_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
  expect(await next("direct_member_other_002")).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
  expect(await next("direct_member_other_final")).toMatchObject({ data: { status: "EVENT_CONFIRMED" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const key = sql.exec<{ request_key: string }>("SELECT request_key FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().request_key;
    sql.exec("UPDATE members SET display_name_override='Updated Name',member_version=2 WHERE season_id=? AND member_id=?", seasonId, memberIds[0]).toArray();
    sql.exec("INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at) VALUES ('out_direct_member_later',?,'CORE_CHANGED',?,'PENDING',?,?)", key,
      JSON.stringify({ action: "updateMember", entity: { season_id: seasonId, member_id: memberIds[0], roster_version: 2 } }), Date.now() - 1000, new Date().toISOString()).toArray();
    indexExportEvent(sql, "out_direct_member_later");
  });
  const before = writes;
  expect(await next("direct_member_unknown_001")).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
  expect(await next("direct_member_unknown_001", "season_changed_pin_001")).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  expect(writes).toBe(before);
  expect(await next("direct_member_new_later_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_direct_member_later" } });
  expect(writes).toBe(before + 1);
});
