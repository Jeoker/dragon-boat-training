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
  });
  return stub;
}

afterEach(() => vi.restoreAllMocks());

it("exports a multi-member event one verified target at a time and survives a lost reply", async () => {
  const environment = testEnv("lost-reply");
  const stub = await seed(environment);
  const sheetRows: string[][] = [];
  const verified = new Map<string, Record<string, unknown>>();
  let loseReply = true;
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
        headers: [...SHEET_SCOPES.MEMBER.headers], secondary: null,
        rows: sheetRows.map((cells, index) => ({ row_number: index + 2, cells }))
      }
    });
    patchCalls += 1;
    let receipt = verified.get(envelope.operation_id);
    if (!receipt) {
      for (const item of payload.items) sheetRows.push(item.target);
      receipt = { status: "verified", protocol_version: envelope.protocol_version,
        team_id: envelope.team_id, season_id: seasonId, binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest, spreadsheet_id: payload.spreadsheet_id,
        tab_id: payload.tab_id,
        verified_member_ids: payload.items.map((item: { member_id: string }) => item.member_id),
        acknowledged_at: new Date().toISOString() };
      verified.set(envelope.operation_id, receipt);
    }
    if (loseReply) { loseReply = false; throw new Error("Lost after Google committed"); }
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
  expect(await exportNext("export_run_002")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", member_id: memberIds[0] } });
  expect(sheetRows).toHaveLength(1);
  expect(await exportNext("export_run_003")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", member_id: memberIds[1] } });
  expect(await exportNext("export_run_004")).toMatchObject({ data: { status: "IDLE" } });
  expect(sheetRows).toHaveLength(2);
  expect(patchCalls).toBe(3);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_export_test_001'").one().status).toBe("CONFIRMED");
    expect(context.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='MEMBER'").one().count).toBe(12);
  });
});

it("keeps member export disabled in production", async () => {
  const environment = { ...testEnv("production"), ENVIRONMENT: "production" } as Env;
  const result = await call(environment, "/internal/c2/export-next-member",
    { request_id: "export_disabled_001", season_id: seasonId });
  expect(result.status).toBe(404);
});

it("does not overtake an earlier unsupported season event", async () => {
  const environment = testEnv("ordered-events");
  const stub = await seed(environment);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_outbox SET topic='SCHEDULE_CHANGED' WHERE outbox_id='out_export_test_001'").toArray();
    const requestKey = context.storage.sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    context.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
       VALUES ('out_export_later_002',?,'CORE_CHANGED',?,'PENDING',?,?)`, requestKey,
      JSON.stringify({ action: "updateMember", entity: { season_id: seasonId, member_id: memberIds[0] } }),
      Date.now() - 1000, new Date().toISOString()).toArray();
  });
  const result = await call(environment, "/internal/c2/export-next-member",
    { request_id: "export_ordered_001", season_id: seasonId });
  expect(await result.json()).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
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
    context.storage.sql.exec("DELETE FROM sync_outbox WHERE outbox_id='out_export_test_001'").toArray();
    const requestKey = context.storage.sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    context.storage.sql.exec(
      `INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
       VALUES ('out_export_update_001',?,'CORE_CHANGED',?,'PENDING',?,?)`, requestKey,
      JSON.stringify({ action: "updateMember", entity: { season_id: seasonId, member_id: memberIds[0] } }),
      Date.now() - 1000, at).toArray();
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
