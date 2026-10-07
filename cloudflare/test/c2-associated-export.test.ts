import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { legacyCredentialDigest, sha256Base64Url } from "../src/crypto";
import { TeamState } from "../src/team-state";
import { SHEET_SCOPES, type SheetScope } from "../src/c2-sheet-bridge";
import { SYNC_FIELD_DEFINITIONS, normalizeSyncValue } from "../../shared/c2-sync-rules";
import worker from "../src/index";
import { exportClassificationAnchor, indexExportEvent, selectExportLane } from "../src/c2-export-lanes";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const seasonId = "season_associated_export_001";
const practiceId = "practice_associated_export_001";
const coachId = "coach_associated_export_001";
const members = ["member_associated_export_01", "member_associated_export_02"];
const spreadsheetId = "spreadsheet_associated_export_001";
const at = "2026-09-30T12:00:00.000Z";
const headers = { authorization: "Bearer local-c2-test-key", "content-type": "application/json" };
const environment = (name: string) => ({ ...env, TEAM_ID: `associated-export-${name}`,
  C2_ASSOCIATED_EXPORT_ENABLED: "true", GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/test/exec",
  GOOGLE_BRIDGE_SECRET: "local-bridge-secret" } as unknown as Env);
const memberRecords = members.map((member_id, index) => ({ season_id: seasonId, member_id,
  source_key: `source_associated_${index + 1}`, source_row_number: "",
  source_display_name: index ? "Second" : "First", display_name_override: "", status: "ACTIVE",
  default_preference: index ? "RIGHT" : "LEFT", member_version: 1,
  created_at: at, updated_at: at }));
const practice = { season_id: seasonId, practice_id: practiceId,
  week_id: "week_associated_export_001", template_id: "", generation_key: "generation_associated_001",
  start_at: "2098-05-07T22:00:00.000Z", end_at: "2098-05-08T00:00:00.000Z",
  timezone: "America/New_York", location: "River", address: "Dock 1", map_url: "",
  left_capacity: 1, right_capacity: 1, signup_cutoff_at: "2098-05-07T20:00:00.000Z",
  practice_version: 1, cancelled_at: "", cancelled_by: "", schedule_published_at: at,
  schedule_published_by: coachId, created_at: at, updated_at: at };
const capacity = (left: number, right: number) =>
  ({ ...practice, left_capacity: left, right_capacity: right });

function cells(scope: SheetScope, row: Record<string, unknown>): string[] {
  return SHEET_SCOPES[scope].headers.map((header) => String(row[header] ?? ""));
}
function signup(memberId: string, queue: number, status = "CONFIRMED") {
  return { season_id: seasonId, practice_id: practiceId, member_id: memberId,
    preference: queue === 1 ? "LEFT" : "RIGHT", status, queue_at: at,
    queue_sequence: queue, updated_at: at, last_request_id: `request_signup_${queue}_001` };
}
function signupEvent(version: number, rows: Record<string, unknown>[], seating?: Record<string, unknown>) {
  return { action: "cancelSignup", entity: { season_id: seasonId, practice_id: practiceId,
    snapshot_schema: 2, practice_version: 1, signup_version: version, signup_rows: rows,
    ...(seating ? { seat_plan_version: seating.state &&
      (seating.state as Record<string, unknown>).seat_plan_version,
      published_revision: seating.state && (seating.state as Record<string, unknown>).published_revision,
      seating_snapshot: seating } : {}) } };
}
function linkedSeating() {
  const state = { season_id: seasonId, practice_id: practiceId, seat_plan_version: 1,
    published_revision: 1, coach_member_id: "", steerer_member_id: "",
    updated_by: coachId, updated_at: at };
  const draft_seats = [
    { row_number: 1, side: "LEFT", member_id: members[0] },
    { row_number: 1, side: "RIGHT", member_id: members[1] }
  ];
  const revision = { season_id: seasonId, practice_id: practiceId,
    revision_number: 1, revision_id: "revision_associated_export_01",
    source: "SYSTEM_CANCELSIGNUP", seat_plan_version: 1,
    coach_member_id: "", steerer_member_id: "", seats: draft_seats,
    names: [{ member_id: members[0], display_name: "First" },
      { member_id: members[1], display_name: "Second" }],
    published_by: coachId, published_at: at, request_id: "request_revision_associated_01" };
  return { state, draft_seats, revision };
}
function promotedSeating() {
  const snapshot = linkedSeating();
  snapshot.draft_seats[0].member_id = members[1];
  snapshot.draft_seats[1].member_id = "";
  snapshot.revision.seats = [snapshot.draft_seats[0]];
  snapshot.revision.names = [{ member_id: members[1], display_name: "Second" }];
  return snapshot;
}
function draftOnlyEvent() {
  const snapshot = linkedSeating();
  snapshot.state.published_revision = 0;
  snapshot.draft_seats[1].member_id = "";
  return { action: "saveSeatPlanDraft", entity: {
    season_id: seasonId, practice_id: practiceId, snapshot_schema: 1,
    practice_version: 1, signup_version: 0, seat_plan_version: 1, published_revision: 0,
    seating_snapshot: { state: snapshot.state, draft_seats: snapshot.draft_seats, revision: null } } };
}

async function call(testEnv: Env, path: string, payload: Record<string, unknown>, c1 = false) {
  return worker.fetch(new IncomingRequest(`https://example.test${path}`, { method: "POST",
    headers: c1 ? { ...headers, authorization: "Bearer local-c1-test-key" } : headers,
    body: JSON.stringify(payload) }), testEnv);
}
async function next(testEnv: Env, id: string): Promise<any> {
  return (await call(testEnv, "/internal/c2/export-next-associated",
    { request_id: id, season_id: seasonId })).json();
}
async function rearm(testEnv: Env, outboxId = "out_associated_001") {
  const login = await (await call(testEnv, "/internal/c1/coach-login", {
    request_id: `lane_login_${outboxId}`, coach_code: "local-test-coach-code" }, true)).json() as any;
  const token = login.data.result.session_token;
  try {
    const result = await (await call(testEnv, "/internal/c2/retry-export", {
      request_id: `lane_retry_${outboxId}`, session_token: token, season_id: seasonId, outbox_id: outboxId })).json() as any;
    expect(result).toMatchObject({ data: { result: { rearmed: true, outbox_id: outboxId } } });
    return token;
  } finally {
    await call(testEnv, "/internal/c1/coach-logout", { request_id: `lane_logout_${outboxId}`, session_token: token }, true);
  }
}
async function seed(testEnv: Env, payload: Record<string, unknown>, topic = "SIGNUPS_CHANGED",
    leftCapacity = 1, rightCapacity = 1) {
  const coach = { coach_id: coachId, display_name: "Associated Coach",
    code_salt: "associated_salt_001", code_digest: await legacyCredentialDigest(
      "associated_salt_001", "local-test-coach-code", "local-c1-coach-secret"),
    credential_version: 1, active: true, created_at: at, updated_at: at };
  expect((await call(testEnv, "/internal/c1/import-core", {
    request_id: "associated_core_import_001", source_snapshot_id: "associated_core_snapshot_001",
    settings_version: 1, default_season_id: seasonId, coaches: [coach],
    seasons: [{ season_id: seasonId, name: "Associated Season", start_date: "2098-03-01",
      end_date: "2098-12-31", timezone: "America/New_York",
      season_ends_at: "2099-01-01T05:00:00.000Z", status: "OPEN",
      binding_version: 1, season_version: 1, roster_version: 2,
      created_by: coachId, created_at: at, updated_at: at }], members: memberRecords
  }, true)).status).toBe(200);
  expect((await call(testEnv, "/internal/c2/import-sync-foundation", {
    request_id: "associated_foundation_001", source_snapshot_id: "associated_foundation_snapshot_001",
    bindings: [{ season_id: seasonId, binding_version: 1, form_id: "form_associated_001",
      runtime_spreadsheet_id: spreadsheetId, response_sheet_id: "0",
      response_sheet_name: "Form Responses 1", field_mapping: { display_name_header: "Name" },
      schema_fingerprint: "sha256_v1:associated_schema_001", export_paused: false,
      last_pull_at: null, last_push_at: null, created_at: at, updated_at: at }],
    baselines: [], source_imports: []
  })).status).toBe(200);
  const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec(`INSERT INTO training_weeks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      seasonId, practice.week_id, "2098-05-05", at, "OPENED", 1, 1, coachId, at,
      at, at, at).toArray();
    sql.exec(`INSERT INTO practices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      seasonId, practiceId, practice.week_id, null, practice.generation_key,
      practice.start_at, practice.end_at, practice.timezone, practice.location,
      practice.address, practice.map_url, leftCapacity, rightCapacity, practice.signup_cutoff_at,
      1, null, null, at, coachId, at, at).toArray();
    const event = payload.entity as Record<string, unknown>;
    sql.exec(`INSERT INTO practice_versions(season_id,practice_id,signup_version,seat_plan_version,
      published_revision) VALUES (?,?,?,?,?)`, seasonId, practiceId, Number(event.signup_version),
      Number(event.seat_plan_version ?? 0), Number(event.published_revision ?? 0)).toArray();
    for (const row of (event.signup_rows ?? []) as Array<Record<string, unknown>>) {
      sql.exec(`INSERT INTO signups(season_id,practice_id,member_id,preference,status,
        queue_at,queue_sequence,updated_at,last_request_id) VALUES (?,?,?,?,?,?,?,?,?)`,
      seasonId, practiceId, row.member_id, row.preference, row.status, row.queue_at,
      row.queue_sequence, row.updated_at, row.last_request_id).toArray();
    }
    const seating = event.seating_snapshot as Record<string, unknown> | undefined;
    if (seating) {
      const state = seating.state as Record<string, unknown>;
      sql.exec(`INSERT INTO seat_plan_states(season_id,practice_id,coach_member_id,
        steerer_member_id,updated_by,updated_at) VALUES (?,?,?,?,?,?)`,
      seasonId, practiceId, state.coach_member_id || null, state.steerer_member_id || null,
      state.updated_by, state.updated_at).toArray();
      const revision = seating.revision as Record<string, unknown> | null;
      if (revision) sql.exec(`INSERT INTO seat_plan_revisions(season_id,practice_id,revision_number,
        revision_id,source,seat_plan_version,coach_member_id,steerer_member_id,published_by,
        published_at,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      seasonId, practiceId, revision.revision_number, revision.revision_id, revision.source,
      revision.seat_plan_version, revision.coach_member_id || null, revision.steerer_member_id || null,
      revision.published_by, revision.published_at, revision.request_id).toArray();
    }
    const key = sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    sql.exec(`INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
      VALUES ('out_associated_001',?, ?,?,'PENDING',?,?)`, key, topic,
      JSON.stringify(payload), Date.now() - 1000, at).toArray();
    indexExportEvent(sql, "out_associated_001");
    const addBaselines = (scope: "MEMBER" | "PRACTICE", rowId: string, row: Record<string, unknown>) => {
      const sheet = Object.fromEntries(SHEET_SCOPES[scope].headers.map((header) =>
        [header, String(row[header] ?? "")]));
      for (const group of new Set(SYNC_FIELD_DEFINITIONS[scope].map((field) => field.dependency_group))) {
        const value = Object.fromEntries(SYNC_FIELD_DEFINITIONS[scope]
          .filter((field) => field.dependency_group === group)
          .map((field) => [field.field, normalizeSyncValue(sheet[field.field], field.kind, field.allowed_values)]));
        sql.exec(`INSERT INTO sync_baselines VALUES (?,1,?,?,?,?,?,?,?,?)`,
          seasonId, scope, rowId, group, JSON.stringify(value), "sha256_v1:fixture_digest",
          1, "sha256_v1:fixture_digest", at).toArray();
      }
    };
    addBaselines("PRACTICE", practiceId, capacity(leftCapacity, rightCapacity));
    for (const member of memberRecords) addBaselines("MEMBER", member.member_id, member);
  });
  return stub;
}

class SheetMirror {
  rows = new Map<SheetScope, string[][]>();
  receipts = new Map<string, Record<string, unknown>>();
  writes = 0;
  patchOperationIds: string[] = [];
  patchSizes: number[] = [];
  loseFirstReply = false;
  partialFirstSeatBeforeLoss = false;
  beforeRead: ((scope: SheetScope) => void) | null = null;
  afterPatch: ((requestId: string) => Promise<void | Response>) | null = null;
  constructor(leftCapacity = 1, rightCapacity = 1) {
    for (const scope of Object.keys(SHEET_SCOPES) as SheetScope[]) this.rows.set(scope, []);
    this.rows.set("PRACTICE", [cells("PRACTICE", capacity(leftCapacity, rightCapacity))]);
    this.rows.set("MEMBER", memberRecords.map((row) => cells("MEMBER", row)));
    this.rows.set("COACH", [[coachId]]);
  }
  install() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      const payload = JSON.parse(envelope.payload_json);
      if (envelope.action === "cloudflareReadSheetRecords") {
        const scope = payload.entity_type as SheetScope;
        this.beforeRead?.(scope);
        return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
          protocol_version: envelope.protocol_version, team_id: envelope.team_id,
          season_id: seasonId, entity_type: scope, binding_version: 1,
          writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
          payload_digest: envelope.payload_digest, spreadsheet_id: spreadsheetId,
          tab_name: SHEET_SCOPES[scope].tab, tab_id: String(100 + Object.keys(SHEET_SCOPES).indexOf(scope)),
          read_at_ms: Date.now(), headers: [...SHEET_SCOPES[scope].headers],
          secondary: scope === "SEAT_PLAN_DRAFT" ? {
            tab_name: "SeatPlanCurrent", tab_id: "107",
            headers: [...SHEET_SCOPES.SEAT_PLAN_CURRENT.headers],
            rows: this.rows.get("SEAT_PLAN_CURRENT")!.map((row, index) =>
              ({ row_number: index + 2, cells: [...row] })) } : null,
          rows: this.rows.get(scope)!.map((row, index) => ({ row_number: index + 2, cells: [...row] }))
        } });
      }
      this.writes += 1;
      this.patchOperationIds.push(envelope.operation_id);
      this.patchSizes.push(payload.items.length);
      const scope = payload.entity_type as SheetScope;
      const rowId = (row: string[]) => scope === "SIGNUP" ? `${row[1]}:${row[2]}` :
        scope === "SEAT_PLAN_CURRENT" ? `${row[1]}:${row[2]}:${row[3]}` :
          scope === "SEAT_PLAN_REVISION" ? `${row[1]}:${row[2]}` : row[1];
      let receipt = this.receipts.get(envelope.operation_id);
      if (!receipt) {
        const stored = this.rows.get(scope)!;
        const partial = this.partialFirstSeatBeforeLoss && scope === "SEAT_PLAN_CURRENT";
        const items = partial ? payload.items.slice(0, 1) : payload.items;
        for (const item of items as Array<{ row_id: string; target: string[] }>) {
          const index = stored.findIndex((row) => rowId(row) === item.row_id);
          if (index < 0) stored.push([...item.target]); else stored[index] = [...item.target];
        }
        if (partial) {
          this.partialFirstSeatBeforeLoss = false;
          throw new Error("First seat row committed, but the bridge reply was lost");
        }
        receipt = { status: "verified", protocol_version: envelope.protocol_version,
          team_id: envelope.team_id, season_id: seasonId, binding_version: 1,
          writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
          payload_digest: envelope.payload_digest, spreadsheet_id: payload.spreadsheet_id,
          tab_id: payload.tab_id, entity_type: scope,
          verified_row_ids: payload.items.map((item: { row_id: string }) => item.row_id),
          acknowledged_at: new Date().toISOString() };
        this.receipts.set(envelope.operation_id, receipt);
      }
      if (this.loseFirstReply) { this.loseFirstReply = false; throw new Error("Reply lost after Sheet commit"); }
      const intercepted = await this.afterPatch?.(envelope.request_id);
      if (intercepted) return intercepted;
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: receipt });
    });
  }
}

afterEach(() => vi.restoreAllMocks());

function fixtureBlock(sql: SqlStorage, id: string) {
  sql.exec(`INSERT INTO sync_export_event_blocks
    SELECT season_id,1,outbox_id,practice_id,payload_anchor,'sha256_v1:fixture','SYNC_REFERENCE_NEEDS_REVIEW',
      1,0,1,'PRACTICE',practice_id,?,? FROM sync_export_event_index WHERE outbox_id=?`, at, at, id).toArray();
}
it.each(["successors", "heads"])("finds B after 250 blocked A %s without bypassing any practice head", async (shape) => {
  const testEnv = environment(`sql-heads-${shape}`), mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await largeQueue(stub, 250);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    if (shape === "heads") {
      for (let n = 2; n <= 250; n++) {
        const id = `out_large_${n}`, p = `practice_blocked_head_${n}`;
        const event = signupEvent(1, [{ ...signup(members[0], 1), practice_id: p }]);
        event.entity.practice_id = p;
        sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id=?", id).toArray();
        sql.exec("UPDATE sync_outbox SET payload_json=? WHERE outbox_id=?", JSON.stringify(event), id).toArray();
        indexExportEvent(sql, id);
        fixtureBlock(sql, id);
      }
    }
    fixtureBlock(sql, "out_associated_001");
  });
  await secondPractice(stub, mirror);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(selectExportLane(context.storage.sql, seasonId)).toMatchObject({ coverage: "complete", event: { practice_id: secondPracticeId } });
  });
  mirror.install();
  expect(await next(testEnv, `sql_head_batch_${shape}`)).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
  expect(await next(testEnv, `sql_head_final_${shape}`)).toMatchObject({ data: { status: "EVENT_CONFIRMED" } });
  expect(mirror.writes).toBe(1);
});
it("keeps a future A head ahead of due A successors while independent B can run", async () => {
  const testEnv = environment("future-head"), mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await largeQueue(stub, 250);
  await secondPractice(stub, mirror);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec("UPDATE sync_outbox SET due_at_ms=? WHERE outbox_id='out_associated_001'", Date.now()+60000).toArray();
    expect(selectExportLane(sql, seasonId)).toMatchObject({ event: { practice_id: secondPracticeId }, coverage: "complete" });
    fixtureBlock(sql, "out_associated_002");
    expect(selectExportLane(sql, seasonId)).toMatchObject({ event: null, reason: "WAITING_OR_BLOCKED", coverage: "complete" });
  });
});
it("rejects a damaged block outside the selected head globally", async () => {
  const testEnv = environment("late-block-anchor"), mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await secondPractice(stub, mirror);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const id = sql.exec<{ outbox_id: string }>("SELECT outbox_id FROM sync_export_event_index WHERE practice_id=?", secondPracticeId).one().outbox_id;
    fixtureBlock(sql, id);
    sql.exec("UPDATE sync_export_event_blocks SET payload_anchor='damaged' WHERE outbox_id=?",id).toArray();
    expect(selectExportLane(sql, seasonId)).toMatchObject({ event: null, coverage: "incomplete", reason: "BLOCK_INVALID" });
  });
  const fetchSpy = vi.spyOn(globalThis,"fetch");
  expect(await next(testEnv,"late_block_proof_001")).toMatchObject({ error: { code: "SYNC_EVENT_INDEX_INCOMPLETE" } });
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("matches SQLite classification encoding for ASCII, null and maximum safe sequences", async () => {
  const stub = await seed(environment("anchor-encoding"), signupEvent(1,[signup(members[0],1)]));
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    for (const seq of [1,9007199254740991]) for (const p of [null,practiceId]) {
      const anchor = exportClassificationAnchor("out_ascii_001",seq,seasonId,p?"ASSOCIATED":"BARRIER",p);
      expect(sql.exec<{ anchor:string }>("SELECT json_array(?,CAST(? AS INTEGER),?,?,?) AS anchor","out_ascii_001",seq,seasonId,p?"ASSOCIATED":"BARRIER",p).one().anchor).toBe(anchor);
    }
  });
});
it("rejects a single oversized candidate instead of materializing it", async () => {
  const stub = await seed(environment("single-oversized"),signupEvent(1,[signup(members[0],1)]));
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec("DELETE FROM sync_export_event_index").toArray();
    sql.exec("UPDATE sync_outbox SET payload_json=?",JSON.stringify({...signupEvent(1,[signup(members[0],1)]),padding:"x".repeat(2_000_000)})).toArray();
    indexExportEvent(sql,"out_associated_001");
    expect(selectExportLane(sql,seasonId)).toMatchObject({ event:null,coverage:"incomplete",reason:"SCAN_LIMIT" });
  });
});
it("uses UTF-8 bytes for the single-event prefetch bound", async () => {
  const stub = await seed(environment("unicode-oversized"),signupEvent(1,[signup(members[0],1)]));
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const payload = JSON.stringify({...signupEvent(1,[signup(members[0],1)]),padding:"船".repeat(700_000)});
    expect(payload.length).toBeLessThan(2_000_000);
    sql.exec("DELETE FROM sync_export_event_index").toArray();
    sql.exec("UPDATE sync_outbox SET payload_json=?",payload).toArray();
    indexExportEvent(sql,"out_associated_001");
    expect(selectExportLane(sql,seasonId)).toMatchObject({ event:null,coverage:"incomplete",reason:"SCAN_LIMIT" });
  });
});
it("drains the fixed batch ahead of unrelated damaged pending ownership but rejects its own classification drift", async () => {
  const testEnv = environment("drain-source-anchor"), mirror = new SheetMirror();
  const stub = await seed(testEnv,signupEvent(1,[signup(members[0],1)]));
  await secondPractice(stub,mirror);
  mirror.loseFirstReply=true;
  mirror.install();
  expect(await next(testEnv,"drain_anchor_original_001")).toMatchObject({ error:{code:"BRIDGE_UNAVAILABLE"} });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec("UPDATE sync_outbox SET payload_json='{}' WHERE outbox_id='out_associated_002'").toArray();
    expect(selectExportLane(sql,seasonId)).toMatchObject({ reason:"DRAIN_BATCH",coverage:"complete",event:{outbox_id:"out_associated_001"} });
    sql.exec("UPDATE sync_export_event_index SET event_sequence=1000 WHERE outbox_id='out_associated_001'").toArray();
    expect(selectExportLane(sql,seasonId)).toMatchObject({ reason:"INDEX_INCOMPLETE",coverage:"incomplete",event:null });
  });
  const writes=mirror.writes;
  expect(await next(testEnv,"drain_anchor_original_001")).toMatchObject({ error:{code:"SYNC_EVENT_INDEX_INCOMPLETE"} });
  expect(mirror.writes).toBe(writes);
});

const secondPracticeId = "practice_associated_export_002";
async function largeQueue(stub: ReturnType<Env["TEAM_STATE"]["getByName"]>, count = 205, padding = 0) {
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const key = sql.exec<{ request_key: string }>("SELECT request_key FROM sync_outbox WHERE outbox_id='out_associated_001'").one().request_key;
    for (let number = 2; number <= count; number++) {
      const payload = { ...signupEvent(number, [signup(members[0], 1)]), ...(padding ? { diagnostic_padding: "x".repeat(padding) } : {}) };
      sql.exec("INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at) VALUES (?,?,'SIGNUPS_CHANGED',?,'PENDING',?,?)", `out_large_${number}`, key, JSON.stringify(payload), Date.now() - 1000, at).toArray();
      indexExportEvent(sql, `out_large_${number}`);
    }
    sql.exec("UPDATE practice_versions SET signup_version=? WHERE season_id=? AND practice_id=?", count, seasonId, practiceId).toArray();
  });
}

it.each([0, 15000])("drains a proved prefix of 205 events with padding=%s instead of freezing on row or byte budgets", async (padding) => {
  const testEnv = environment(`large-queue-${padding}`);
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await largeQueue(stub, 205, padding);
  mirror.install();
  for (let number = 1; number <= 3; number++) {
    const outbox = number === 1 ? "out_associated_001" : `out_large_${number}`;
    expect(await next(testEnv, `large_batch_${padding}_${number}`)).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: outbox } });
    expect(await next(testEnv, `large_final_${padding}_${number}`)).toMatchObject({ data: { status: "EVENT_CONFIRMED", outbox_id: outbox, signup_version: number } });
  }
  expect(mirror.writes).toBe(3);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(selectExportLane(context.storage.sql, seasonId)).toMatchObject({ coverage: "complete", event: { outbox_id: "out_large_4" } });
    expect(context.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_outbox WHERE status='PENDING'").one().count).toBe(202);
  });
});

it("keeps late barriers after safe prefixes, early barriers ahead, and blocked successors sealed", async () => {
  const testEnv = environment("large-barrier-proof");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await largeQueue(stub);
  await enqueue(stub, "UNKNOWN_BUSINESS_EVENT", { entity: { season_id: seasonId } }, "out_large_barrier", 205, 0, 0);
  await secondPractice(stub, mirror);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(selectExportLane(context.storage.sql, seasonId)).toMatchObject({ event: { outbox_id: "out_associated_001" }, coverage: "complete" });
  });
  mirror.rows.get("PRACTICE")![0][SHEET_SCOPES.PRACTICE.headers.indexOf("location")] = "A manual conflict";
  mirror.install();
  expect(await next(testEnv, "large_block_A_001")).toMatchObject({ error: { code: "SYNC_REFERENCE_NEEDS_REVIEW" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(selectExportLane(sql, seasonId)).toMatchObject({ event: null, coverage: "complete", reason: "WAITING_OR_BLOCKED" });
    // A barrier at the first persisted sequence can be selected, never bypassed.
    sql.exec("DELETE FROM sync_export_event_blocks").toArray();
    sql.exec("UPDATE sync_export_event_index SET event_sequence=1000 WHERE outbox_id='out_associated_001'").toArray();
    sql.exec("UPDATE sync_export_event_index SET classification_anchor=json_array(outbox_id,event_sequence,season_id,handler_kind,practice_id)").toArray();
    sql.exec("UPDATE sync_export_event_index SET event_sequence=1 WHERE outbox_id='out_large_barrier'").toArray();
    sql.exec("UPDATE sync_export_event_index SET classification_anchor=json_array(outbox_id,event_sequence,season_id,handler_kind,practice_id)").toArray();
    expect(selectExportLane(sql, seasonId)).toMatchObject({ event: { outbox_id: "out_large_barrier", handler_kind: "BARRIER" }, coverage: "complete" });
  });
  expect(await next(testEnv, "large_barrier_stop_001")).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
  expect(mirror.writes).toBe(0);
});

it.each(["missing-index", "unknown-owner", "anchor", "C0-sentinel", "classification", "kind", "sequence", "practice"])("rejects late %s damage beyond the candidate prefix globally", async (damage) => {
  const testEnv = environment(`large-damage-${damage}`);
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await largeQueue(stub);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    if (damage === "missing-index") sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_large_205'").toArray();
    if (damage === "unknown-owner") {
      sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_large_205'").toArray();
      sql.exec("UPDATE sync_outbox SET payload_json='{}' WHERE outbox_id='out_large_205'").toArray();
      indexExportEvent(sql, "out_large_205");
    }
    if (damage === "anchor") sql.exec("UPDATE sync_outbox SET payload_json=? WHERE outbox_id='out_large_205'", JSON.stringify(signupEvent(206, [signup(members[0], 1)]))).toArray();
    if (damage === "C0-sentinel") sql.exec("UPDATE sync_export_event_index SET season_id='@NON_SEASON_C0' WHERE outbox_id='out_large_205'").toArray();
    if (damage === "classification") sql.exec("UPDATE sync_export_event_index SET practice_id=NULL WHERE outbox_id='out_large_205'").toArray();
    if (damage === "kind") sql.exec("UPDATE sync_export_event_index SET handler_kind='BARRIER',practice_id=NULL WHERE outbox_id='out_large_205'").toArray();
    if (damage === "sequence") sql.exec("UPDATE sync_export_event_index SET event_sequence=9000000000000000 WHERE outbox_id='out_large_205'").toArray();
    if (damage === "practice") sql.exec("UPDATE sync_export_event_index SET practice_id=? WHERE outbox_id='out_large_205'", secondPracticeId).toArray();
    expect(selectExportLane(sql, seasonId)).toMatchObject({ coverage: "incomplete", event: null, reason: "INDEX_INCOMPLETE" });
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  expect(await next(testEnv, `large_damage_${damage}_001`)).toMatchObject({ error: { code: "SYNC_EVENT_INDEX_INCOMPLETE" } });
  expect(fetchSpy).not.toHaveBeenCalled();
});
async function secondPractice(stub: ReturnType<Env["TEAM_STATE"]["getByName"]>, mirror: SheetMirror, memberId = members[1]) {
  const second = { ...practice, practice_id: secondPracticeId, generation_key: "generation_associated_002" };
  mirror.rows.get("PRACTICE")!.push(cells("PRACTICE", second));
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const original = sql.exec<Record<string, string | number | null>>("SELECT * FROM practices WHERE practice_id=?", practiceId).one();
    const row = { ...original, practice_id: secondPracticeId, generation_key: second.generation_key };
    sql.exec(`INSERT INTO practices(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, ...Object.values(row)).toArray();
    sql.exec("INSERT INTO practice_versions(season_id,practice_id,signup_version,seat_plan_version,published_revision) VALUES (?,?,1,0,0)", seasonId, secondPracticeId).toArray();
    const sheet = Object.fromEntries(SHEET_SCOPES.PRACTICE.headers.map((header) => [header, String(second[header as keyof typeof second] ?? "")]));
    for (const group of new Set(SYNC_FIELD_DEFINITIONS.PRACTICE.map((field) => field.dependency_group))) {
      const value = Object.fromEntries(SYNC_FIELD_DEFINITIONS.PRACTICE.filter((field) => field.dependency_group === group)
        .map((field) => [field.field, normalizeSyncValue(sheet[field.field], field.kind, field.allowed_values)]));
      sql.exec("INSERT INTO sync_baselines VALUES (?,1,'PRACTICE',?,?,?,?,?,?,?)", seasonId, secondPracticeId, group, JSON.stringify(value), "sha256_v1:fixture_digest", 1, "sha256_v1:fixture_digest", at).toArray();
    }
    const payload = signupEvent(1, [{ ...signup(memberId, 1), practice_id: secondPracticeId }]);
    payload.entity.practice_id = secondPracticeId;
    const registered = { ...signup(memberId, 1), practice_id: secondPracticeId };
    sql.exec("INSERT INTO signups(season_id,practice_id,member_id,preference,status,queue_at,queue_sequence,updated_at,last_request_id) VALUES (?,?,?,?,?,?,?,?,?)",
      seasonId, secondPracticeId, memberId, registered.preference, registered.status, at, 1, at, registered.last_request_id).toArray();
    const key = sql.exec<{ request_key: string }>("SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    sql.exec("INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at) VALUES ('out_associated_002',?,'SIGNUPS_CHANGED',?,'PENDING',?,?)", key, JSON.stringify(payload), Date.now() - 1000, at).toArray();
    indexExportEvent(sql, "out_associated_002");
  });
}

it("blocks A durably while B confirms and A successors retain order and Coach retry", async () => {
  const testEnv = environment("independent-lanes");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await secondPractice(stub, mirror);
  await enqueue(stub, "SIGNUPS_CHANGED", signupEvent(2, [signup(members[0], 1, "CANCELLED")]), "out_associated_A_later", 2, 0, 0);
  mirror.rows.get("PRACTICE")![0][SHEET_SCOPES.PRACTICE.headers.indexOf("location")] = "Manual A edit";
  mirror.install();
  const firstRequest = "lane_A_original_001";
  expect(await next(testEnv, firstRequest)).toMatchObject({ error: { code: "SYNC_REFERENCE_NEEDS_REVIEW" } });
  expect(mirror.writes).toBe(0);
  // The original request is permanently pinned to A, even though it has no batch yet.
  expect(await next(testEnv, firstRequest)).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
  expect(await next(testEnv, "lane_B_batch_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_002" } });
  expect(await next(testEnv, "lane_B_final_001")).toMatchObject({ data: { status: "EVENT_CONFIRMED", outbox_id: "out_associated_002" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(selectExportLane(context.storage.sql, seasonId)).toMatchObject({ event: null, reason: "WAITING_OR_BLOCKED", coverage: "complete" });
    expect(context.storage.sql.exec("SELECT * FROM sync_export_event_blocks WHERE action_required=1").toArray()).toHaveLength(1);
    expect(context.storage.sql.exec<{ status: string }>("SELECT status FROM sync_outbox WHERE outbox_id='out_associated_A_later'").one().status).toBe("PENDING");
  });
  mirror.rows.get("PRACTICE")![0][SHEET_SCOPES.PRACTICE.headers.indexOf("location")] = practice.location;
  await rearm(testEnv);
  expect(await next(testEnv, firstRequest)).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_001" } });
  expect(await next(testEnv, "lane_A_final_001")).toMatchObject({ data: { status: "EVENT_CONFIRMED", signup_version: 1 } });
  expect(await next(testEnv, "lane_A_later_batch_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_A_later" } });
});

it("independently preflights the same shared member in B after A is locally blocked", async () => {
  const testEnv = environment("shared-reference-lanes");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await secondPractice(stub, mirror, members[0]);
  mirror.rows.get("MEMBER")![0][SHEET_SCOPES.MEMBER.headers.indexOf("status")] = "INACTIVE";
  mirror.install();
  expect(await next(testEnv, "shared_member_A_001")).toMatchObject({ error: { code: "SYNC_REFERENCE_NEEDS_REVIEW" } });
  expect(await next(testEnv, "shared_member_B_001")).toMatchObject({ error: { code: "SYNC_REFERENCE_NEEDS_REVIEW" } });
  expect(mirror.writes).toBe(0);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const blocks = context.storage.sql.exec<{ blocked_entity_id: string }>("SELECT blocked_entity_id FROM sync_export_event_blocks").toArray();
    expect(blocks).toEqual([{ blocked_entity_id: members[0] }, { blocked_entity_id: members[0] }]);
    expect(selectExportLane(context.storage.sql, seasonId).event).toBeNull();
  });
});

it.each(["MEMBERS_IMPORTED", "SCHEDULE_CHANGED", "UNKNOWN_BUSINESS_EVENT"])("keeps a %s barrier ahead of a later independent practice", async (topic) => {
  const testEnv = environment(`barrier-${topic}`);
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await enqueue(stub, topic, { entity: { season_id: seasonId } }, "out_associated_barrier", 1, 0, 0);
  await secondPractice(stub, mirror);
  mirror.rows.get("PRACTICE")![0][SHEET_SCOPES.PRACTICE.headers.indexOf("location")] = "Manual A edit";
  mirror.install();
  expect(await next(testEnv, `barrier_A_${topic}`)).toMatchObject({ error: { code: "SYNC_REFERENCE_NEEDS_REVIEW" } });
  expect(await next(testEnv, `barrier_B_${topic}`)).toMatchObject({ data: { status: "IDLE" } });
  expect(mirror.writes).toBe(0);
});

it("stops missing indices, changed anchors, unknown ownership and incomplete scan before Google", async () => {
  const testEnv = environment("incomplete-index");
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec("DELETE FROM sync_export_event_index WHERE outbox_id='out_associated_001'").toArray();
  });
  for (const [index, path] of ["associated", "member", "schedule"].entries()) {
    expect(await (await call(testEnv, `/internal/c2/export-next-${path}`, { request_id: `missing_index_${index}_001`, season_id: seasonId })).json()).toMatchObject({ error: { code: "SYNC_EVENT_INDEX_INCOMPLETE" } });
  }
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    indexExportEvent(sql, "out_associated_001");
    sql.exec("UPDATE sync_outbox SET payload_json=? WHERE outbox_id='out_associated_001'", JSON.stringify({ entity: { season_id: seasonId } })).toArray();
    expect(selectExportLane(sql, seasonId).coverage).toBe("incomplete");
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("captures v13 rowid once at migration and never reorders the persisted index", async () => {
  const testEnv = environment("lane-upgrade");
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await enqueue(stub, "SIGNUPS_CHANGED", signupEvent(2, [signup(members[0], 1)]), "out_associated_later", 2, 0, 0);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    for (const table of ["sync_export_poll_plans", "sync_export_request_selections", "sync_export_event_blocks", "sync_export_event_index"]) sql.exec(`DROP TABLE ${table}`).toArray();
    sql.exec("UPDATE app_meta SET value='13' WHERE key='schema_version'").toArray();
    applySchema(context.storage);
    const before = sql.exec("SELECT * FROM sync_export_event_index ORDER BY event_sequence").toArray();
    expect(before.map((row) => row.outbox_id)).toEqual(["out_associated_001", "out_associated_later"]);
    sql.exec("UPDATE sync_outbox SET rowid=100 WHERE outbox_id='out_associated_001'").toArray();
    sql.exec("UPDATE sync_outbox SET rowid=1 WHERE outbox_id='out_associated_later'").toArray();
    sql.exec("UPDATE sync_outbox SET rowid=2 WHERE outbox_id='out_associated_001'").toArray();
    expect(selectExportLane(sql, seasonId).event?.outbox_id).toBe("out_associated_001");
    applySchema(context.storage);
    expect(sql.exec("SELECT * FROM sync_export_event_index ORDER BY event_sequence").toArray()).toEqual(before);
  });
});

it("accepts indexed C0 counter events while unowned damaged events stop every season", async () => {
  const testEnv = environment("nonseason-proof");
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const key = sql.exec<{ request_key: string }>("SELECT request_key FROM system_requests LIMIT 1").one().request_key;
    sql.exec("INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at) VALUES ('out_c0_proof_001',?,'C0_MOCK_SYNC',?,'PENDING',?,?)", key,
      JSON.stringify({ amount: 1, enqueue_job: true, fail_attempts: 0, job_due_at_ms: 0, retry_delay_ms: 1000 }), Date.now(), at).toArray();
    indexExportEvent(sql, "out_c0_proof_001");
    expect(selectExportLane(sql, seasonId)).toMatchObject({ coverage: "complete", event: { outbox_id: "out_associated_001" } });
    sql.exec("INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at) VALUES ('out_unknown_owner_001',?,'C0_MOCK_SYNC','{}','PENDING',?,?)", key, Date.now(), at).toArray();
    indexExportEvent(sql, "out_unknown_owner_001");
    expect(selectExportLane(sql, seasonId)).toMatchObject({ coverage: "incomplete", event: null });
  });
});

it("recovers the same concurrent request without changing event or allocating a second batch", async () => {
  const testEnv = environment("same-request-race");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  mirror.install();
  const results = await Promise.all([next(testEnv, "concurrent_same_request_001"), next(testEnv, "concurrent_same_request_001")]);
  expect(results.some((result) => result.data?.status === "BATCH_CONFIRMED")).toBe(true);
  for (const result of results) if (result.error) expect(["SYNC_EXPORT_STALE", "SYNC_OUTBOX_BLOCKED"]).toContain(result.error.code);
  expect(await next(testEnv, "concurrent_same_request_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_001" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec("SELECT * FROM sync_export_request_selections").toArray()).toHaveLength(1);
    expect(context.storage.sql.exec("SELECT * FROM sync_batches").toArray()).toHaveLength(1);
  });
});

it("pauses during a real SENT await, drains only the original batch and preserves a later business event", async () => {
  const testEnv = environment("sent-pause-barrier"), mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  const initial = await preflightEvidence(stub);
  const login = await (await call(testEnv, "/internal/c1/coach-login", {
    request_id: "sent_pause_login_001", coach_code: "local-test-coach-code" }, true)).json() as any;
  const token = login.data.result.session_token;
  const control = async (id: string, paused: boolean) => {
    const response = await call(testEnv, "/internal/c2/set-export-pause", {
      request_id: id, session_token: token, season_id: seasonId, paused });
    return { status: response.status, body: await response.json() as any };
  };
  const overview = async (id: string) => (await (await call(testEnv, "/internal/c2/get-sync-overview", {
    request_id: id, session_token: token, season_id: seasonId })).json() as any).data;
  const publicCurrent = async (id: string) => {
    const url = new URL("https://example.test/internal/c1/public-practice");
    url.searchParams.set("request_id", id); url.searchParams.set("season_id", seasonId); url.searchParams.set("practice_id", practiceId);
    const beforeCalls = { reads, writes: mirror.writes };
    const response = await worker.fetch(new IncomingRequest(url, { method: "GET", headers: { authorization: "Bearer local-c1-test-key" } }), testEnv);
    expect(response.status).toBe(200); const body = await response.json() as any; expect(body.ok).toBe(true);
    expect(body.data.signup_version).toBe(2);
    expect(body.data.signups).toHaveLength(1);
    expect(body.data.signups[0]).toMatchObject({ member_id: members[0], preference: "RIGHT", status: "CONFIRMED" });
    expect(body.data.seat_plan).toMatchObject({ status: "UNPUBLISHED", seat_plan_version: 0, published_revision: 0,
      seats: [], coach: null, steerer: null, rows: [{ row_number: 1, left: null, right: null }] });
    expect(body.data).not.toHaveProperty("draft_seats"); expect(body.data.seat_plan).not.toHaveProperty("draft_seats");
    expect({ reads, writes: mirror.writes }).toEqual(beforeCalls);
  };
  let released = false, entered = false, settled = false, reads = 0;
  const release = () => { released = true; };
  // Each waiter owns its own I/O context; only booleans cross the mock/request boundary.
  // Polling never releases the barrier by time: all assertions must finish first.
  const awaitCondition = async (condition: () => boolean) => {
    while (!condition()) await new Promise<void>(resolve => setTimeout(resolve, 1));
  };
  mirror.beforeRead = () => { reads++; };
  // The actual send has committed SENT and the mock Google receipt is already verified.
  // No Durable Object I/O runs inside this callback. Only the test controller releases it.
  mirror.afterPatch = async () => {
    mirror.afterPatch = null;
    entered = true; await awaitCondition(() => released);
  };
  mirror.install();
  const originalId = "sent_pause_original_export_001";
  const sending = next(testEnv, originalId).finally(() => { settled = true; });
  try {
    await awaitCondition(() => entered || settled); expect(entered).toBe(true); expect(settled).toBe(false);
    const sent = await preflightEvidence(stub), batch = sent.batches[0];
    expect(sent.batches).toHaveLength(1); expect(batch.status).toBe("SENT");
    expect(mirror.patchOperationIds).toEqual([batch.batch_id]); expect(mirror.writes).toBe(1);
    expect(mirror.receipts.get(String(batch.batch_id))).toMatchObject({ status: "verified", operation_id: batch.batch_id });
    expect(sent.outbox).toEqual(initial.outbox); expect(sent.baselines).toEqual(initial.baselines);
    expect(sent.physical).toEqual(initial.physical); expect(sent.cursors).toEqual(initial.cursors);
    const originalPin = await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const sql = context.storage.sql;
      expect(sql.exec("SELECT * FROM system_requests WHERE request_id=?", originalId).toArray()).toEqual([]);
      expect(sql.exec("SELECT status,receipt_json FROM sync_batch_items WHERE batch_id=?", batch.batch_id).toArray())
        .toEqual([{ status: "PENDING", receipt_json: null }]);
      const pins = sql.exec("SELECT * FROM sync_export_request_selections").toArray(); expect(pins).toHaveLength(1);
      expect(pins[0].outbox_id).toBe("out_associated_001"); return pins[0];
    });
    const heldGoogle = JSON.stringify([...mirror.rows]), heldReads = reads;
    const paused = await control("sent_pause_request_001", true);
    expect(paused).toMatchObject({ status: 200, body: { data: { result: { status: "PAUSING", unfinished_batch_id: batch.batch_id } } } });
    expect(await overview("sent_pause_overview_001")).toMatchObject({ export_control: {
      status: "PAUSING", pause_requested: true, unfinished_batch: { batch_id: batch.batch_id, status: "SENT" } } });
    const early = await control("sent_pause_early_resume_001", false);
    expect(early).toMatchObject({ status: 409, body: { error: { code: "SYNC_EXPORT_DRAINING" } } });
    // Runtime export pause must permit normal C1 writes, without changing the in-flight snapshot.
    const changed = await (await call(testEnv, "/internal/c1/update-signup", {
      request_id: "sent_pause_business_update_001", season_id: seasonId, practice_id: practiceId,
      member_id: members[0], practice_version: 1, signup_version: 1, preference: "RIGHT" }, true)).json() as any;
    expect(changed).toMatchObject({ ok: true, data: { result: { signup_version: 2, signup: { preference: "RIGHT" } } } });
    const withSuccessor = await preflightEvidence(stub);
    expect(withSuccessor.outbox).toHaveLength(initial.outbox.length + 1);
    expect(withSuccessor.outbox.find(row => row.outbox_id === "out_associated_001")).toEqual(initial.outbox.find(row => row.outbox_id === "out_associated_001"));
    const successor = withSuccessor.outbox.find(row => row.outbox_id !== "out_associated_001")!;
    expect(JSON.parse(String(successor.payload_json)).entity).toMatchObject({ signup_version: 2, signup_rows: [{ preference: "RIGHT" }] });
    expect(successor.status).toBe("PENDING"); expect(Number(successor.due_at_ms)).toBeGreaterThan(Date.now());
    expect(withSuccessor.batches).toEqual(sent.batches); expect(withSuccessor.baselines).toEqual(initial.baselines);
    expect(withSuccessor.physical).toEqual(initial.physical); expect(withSuccessor.cursors).toEqual(initial.cursors);
    await publicCurrent("sent_pause_public_during_001");
    expect(reads).toBe(heldReads); expect(mirror.writes).toBe(1); expect(JSON.stringify([...mirror.rows])).toBe(heldGoogle);
    release();
    const result = await sending;
    expect(result).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_001", batch_id: batch.batch_id } });
    expect(await overview("sent_pause_overview_002")).toMatchObject({ export_control: { status: "PAUSED", pause_requested: true, unfinished_batch: null } });
    const drained = await preflightEvidence(stub);
    expect(drained.batches).toHaveLength(1); expect(drained.batches[0].status).toBe("CONFIRMED");
    expect(drained.batches[0].attempt_count).toBe(sent.batches[0].attempt_count);
    for (const field of ["batch_id", "payload_digest", "first_outbox_id", "last_outbox_id", "binding_version", "writer_epoch"])
      expect(drained.batches[0][field]).toBe(batch[field]);
    expect(drained.outbox).toEqual(withSuccessor.outbox); expect(drained.baselines).toEqual(initial.baselines);
    expect(drained.physical).toEqual(initial.physical); expect(drained.cursors).toEqual(initial.cursors);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const sql = context.storage.sql;
      const items = sql.exec("SELECT status,receipt_json FROM sync_batch_items WHERE batch_id=?", batch.batch_id).toArray();
      expect(items).toHaveLength(1); expect(items[0].status).toBe("VERIFIED");
      expect(JSON.parse(String(items[0].receipt_json))).toMatchObject({ status: "verified", operation_id: batch.batch_id });
      const request = sql.exec("SELECT result_json FROM system_requests WHERE request_id=?", originalId).one();
      expect(JSON.parse(String(request.result_json))).toMatchObject({ status: "BATCH_CONFIRMED", outbox_id: "out_associated_001", batch_id: batch.batch_id });
      expect(sql.exec("SELECT outbox_id FROM sync_export_request_selections").toArray()).toEqual([{ outbox_id: "out_associated_001" }]);
    });
    const pausedReads = reads;
    const fresh = await (await call(testEnv, "/internal/c2/export-next-associated", {
      request_id: "sent_pause_new_target_probe_001", season_id: seasonId, outbox_id: successor.outbox_id })).json() as any;
    // The v14 selector reports the runtime-paused lane as unavailable before preparing.
    expect(fresh).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
    expect(await next(testEnv, "sent_pause_next_stage_probe_001")).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
    expect((await next(testEnv, originalId)).data).toEqual(result.data); // A completed request cannot select its successor.
    expect(await preflightEvidence(stub)).toEqual(drained);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec("SELECT * FROM sync_export_request_selections").toArray()).toEqual([originalPin]);
      expect(context.storage.sql.exec("SELECT request_id FROM system_requests WHERE action='exportNextAssociated'").toArray())
        .toEqual([{ request_id: originalId }]);
    });
    expect(reads).toBe(pausedReads); expect(mirror.writes).toBe(1);
    expect(JSON.stringify([...mirror.rows])).toBe(heldGoogle);
    expect(await control("sent_pause_resume_001", false)).toMatchObject({ status: 200, body: { data: { result: { status: "RUNNING" } } } });
    expect(await next(testEnv, "sent_pause_original_final_001")).toMatchObject({ data: { status: "EVENT_CONFIRMED", outbox_id: "out_associated_001" } });
    const final = await preflightEvidence(stub);
    expect(final.batches).toEqual(drained.batches); expect(final.outbox.find(row => row.outbox_id === successor.outbox_id)).toEqual(successor);
    const confirmedOriginal = final.outbox.find(row => row.outbox_id === "out_associated_001")!;
    expect(confirmedOriginal.status).toBe("CONFIRMED"); expect(confirmedOriginal.payload_json).toBe(sent.outbox[0].payload_json);
    expect(confirmedOriginal.due_at_ms).toBe(sent.outbox[0].due_at_ms);
    expect(final.cursors).toMatchObject([{ signup_version: 1, seat_plan_version: 0, published_revision: 0 }]);
    expect(final.physical).toHaveLength(1); expect(JSON.parse(String(final.physical[0].cells_json))).toEqual(cells("SIGNUP", signup(members[0], 1)));
    expect(final.baselines.filter(row => row.entity_type !== "SIGNUP")).toEqual(initial.baselines);
    const signupBaselines = final.baselines.filter(row => row.entity_type === "SIGNUP");
    expect(signupBaselines).toHaveLength(new Set(SYNC_FIELD_DEFINITIONS.SIGNUP.map(field => field.dependency_group)).size);
    expect(signupBaselines.every(row => row.cloud_version === 1 && row.entity_id === `${practiceId}:${members[0]}`)).toBe(true);
    expect(JSON.parse(String(signupBaselines.find(row => row.dependency_group === "SIGNUP_STATE")!.baseline_json)))
      .toEqual({ preference: "LEFT", status: "CONFIRMED" });
    expect(JSON.parse(String(signupBaselines.find(row => row.dependency_group === "SIGNUP_QUEUE")!.baseline_json)))
      .toEqual({ queue_at: at, queue_sequence: 1 });
    expect(mirror.rows.get("SIGNUP")).toEqual([cells("SIGNUP", signup(members[0], 1))]);
    await publicCurrent("sent_pause_public_after_001");
    expect((await next(testEnv, originalId)).data).toEqual(result.data); expect(mirror.patchOperationIds).toEqual([batch.batch_id]);
    expect((await overview("sent_pause_overview_003")).export_control.status).toBe("RUNNING");
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const sql = context.storage.sql;
      expect(sql.exec("SELECT * FROM sync_export_request_selections WHERE request_key=?", originalPin.request_key).toArray()).toEqual([originalPin]);
      expect(sql.exec("SELECT preference FROM signups WHERE practice_id=? AND member_id=?", practiceId, members[0]).one()).toEqual({ preference: "RIGHT" });
      expect(sql.exec("SELECT signup_version FROM practice_versions WHERE practice_id=?", practiceId).one()).toEqual({ signup_version: 2 });
      expect(sql.exec("SELECT * FROM sync_export_event_blocks").toArray()).toEqual([]);
      expect(sql.exec("SELECT * FROM sync_export_retries").toArray()).toEqual([]);
    });
  } finally {
    release(); await sending;
    await call(testEnv, "/internal/c1/coach-logout", { request_id: "sent_pause_logout_001", session_token: token }, true);
  }
});

it("preserves global ACTION_REQUIRED ahead of batch drain and allows runtime pause recovery after explicit clear", async () => {
  const testEnv = environment("global-before-drain");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await secondPractice(stub, mirror);
  mirror.loseFirstReply = true;
  mirror.install();
  expect(await next(testEnv, "drain_original_request_001")).toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec("INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at,action_required) VALUES (?,1,1,0,'SYNC_REFERENCE_NEEDS_REVIEW',?,1)", seasonId, at).toArray();
    sql.exec("INSERT INTO sync_export_controls(season_id,pause_requested,updated_at) VALUES (?,1,?)", seasonId, at).toArray();
    expect(selectExportLane(sql, seasonId)).toMatchObject({ reason: "GLOBAL_ACTION_REQUIRED", batch_id: null });
  });
  expect(await next(testEnv, "drain_original_request_001")).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
  const login = await (await call(testEnv, "/internal/c1/coach-login", { request_id: "drain_coach_login_001", coach_code: "local-test-coach-code" }, true)).json() as any;
  const token = login.data.result.session_token;
  expect(await (await call(testEnv, "/internal/c2/retry-export", { request_id: "drain_coach_clear_001", session_token: token, season_id: seasonId })).json()).toMatchObject({ data: { result: { rearmed: true } } });
  expect(await next(testEnv, "drain_original_request_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_001" } });
  expect(mirror.patchOperationIds[0]).toBe(mirror.patchOperationIds[1]);
  expect(await next(testEnv, "drain_B_paused_001")).toMatchObject({ error: { code: "SYNC_OUTBOX_BLOCKED" } });
  await call(testEnv, "/internal/c1/coach-logout", { request_id: "drain_coach_logout_001", session_token: token }, true);
});

it("exposes paginated local blocks and includes all four durable lane tables in a verified backup", async () => {
  const testEnv = { ...environment("lane-management-backup"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await secondPractice(stub, mirror, members[0]);
  mirror.rows.get("MEMBER")![0][SHEET_SCOPES.MEMBER.headers.indexOf("status")] = "INACTIVE";
  mirror.install();
  await call(testEnv, "/internal/c2/poll-due-exports", { request_id: "backup_block_A_001" });
  await next(testEnv, "backup_block_B_001");
  const login = await (await call(testEnv, "/internal/c1/coach-login", { request_id: "backup_lane_login_001", coach_code: "local-test-coach-code" }, true)).json() as any;
  const token = login.data.result.session_token;
  const page = await (await call(testEnv, "/internal/c2/list-export-blocks", { request_id: "block_page_001", session_token: token, season_id: seasonId, limit: 1 })).json() as any;
  expect(page.data.items).toHaveLength(1);
  expect(page.data.items[0]).toMatchObject({ outbox_id: "out_associated_001", action_required: true });
  const second = await (await call(testEnv, "/internal/c2/list-export-blocks", { request_id: "block_page_002", session_token: token, season_id: seasonId, limit: 1, cursor: page.data.next_cursor })).json() as any;
  expect(second.data.items[0].outbox_id).toBe("out_associated_002");
  expect(second.data.next_cursor).toBeNull();
  const overview = await (await call(testEnv, "/internal/c2/get-sync-overview", { request_id: "lane_overview_001", session_token: token, season_id: seasonId })).json() as any;
  expect(overview.data.lanes).toMatchObject({ coverage: "complete", runnable_outbox_id: null, local_action_required: 2 });
  expect(overview.data.counts.pending_outbox).toBe(2);
  // Omitted outbox does not silently clear local blocks.
  expect(await (await call(testEnv, "/internal/c2/retry-export", { request_id: "lane_legacy_retry_001", session_token: token, season_id: seasonId })).json()).toMatchObject({ error: { code: "SYNC_EXPORT_ACTION_NOT_REQUIRED" } });
  expect(await (await call(testEnv, "/internal/c2/retry-export", { request_id: "backup_rearm_B_001", session_token: token, season_id: seasonId, outbox_id: "out_associated_002" })).json()).toMatchObject({ data: { result: { rearmed: true } } });
  mirror.rows.get("MEMBER")![0][SHEET_SCOPES.MEMBER.headers.indexOf("status")] = "ACTIVE";
  mirror.loseFirstReply = true;
  expect(await next(testEnv, "backup_partial_B_001")).toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  const backup = await (await call(testEnv, "/internal/c1/create-backup-snapshot", { request_id: "lane_backup_001", session_token: token }, true)).json() as any;
  expect(backup.data.result.manifest.schema_version).toBe(APPLICATION_SCHEMA_VERSION);
  const tables = backup.data.result.manifest.tables as Array<{ name: string; row_count: number; chunk_indices: number[] }>;
  for (const table of ["sync_export_event_index", "sync_export_event_blocks", "sync_export_request_selections", "sync_export_poll_plans"]) {
    const entry = tables.find((row) => row.name === table)!;
    expect(entry.row_count).toBe(table === "sync_export_request_selections" ? 3 : table === "sync_export_poll_plans" ? 1 : 2);
    const chunk = await (await call(testEnv, "/internal/c1/get-backup-chunk", { request_id: `lane_chunk_${table}`, session_token: token, snapshot_id: backup.data.result.snapshot_id, chunk_index: entry.chunk_indices[0] }, true)).json() as any;
    expect(chunk.data.chunk.payload.rows).toHaveLength(entry.row_count);
  }
  expect(tables.find((entry) => entry.name === "sync_batches")?.row_count).toBe(1);
  expect(await (await call(testEnv, "/internal/c1/verify-backup-snapshot", { request_id: "lane_backup_verify_001", session_token: token, snapshot_id: backup.data.result.snapshot_id, content_digest: backup.data.result.manifest.content_digest }, true)).json()).toMatchObject({ data: { verified: true } });
  await call(testEnv, "/internal/c1/coach-logout", { request_id: "backup_lane_logout_001", session_token: token }, true);
});

it("poll replay retains A's local result while a new poll can complete B", async () => {
  const testEnv = { ...environment("poll-local-replay"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await secondPractice(stub, mirror);
  mirror.rows.get("PRACTICE")![0][SHEET_SCOPES.PRACTICE.headers.indexOf("location")] = "A local edit";
  mirror.install();
  const poll = async (id: string) => (await (await call(testEnv, "/internal/c2/poll-due-exports", { request_id: id })).json()) as any;
  const first = await poll("poll_original_local_001");
  expect(first.data.results).toMatchObject([{ status: "LOCAL_ACTION_REQUIRED" }]);
  expect((await poll("poll_original_local_001")).data).toEqual(first.data);
  expect(mirror.writes).toBe(0);
  // Model a crash after the inner block was saved, before the outer result commit.
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const key = sql.exec<{ request_key: string }>("SELECT request_key FROM system_requests WHERE action='pollDueExports'").one().request_key;
    sql.exec("DELETE FROM audit_events WHERE request_key=?", key).toArray();
    sql.exec("DELETE FROM system_requests WHERE request_key=?", key).toArray();
  });
  expect((await poll("poll_original_local_001")).data).toEqual(first.data);
  expect(mirror.writes).toBe(0);
  expect((await poll("poll_new_B_001")).data.results).toMatchObject([{ status: "EVENT_CONFIRMED" }]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec("SELECT * FROM sync_export_retries WHERE action_required=1").toArray()).toEqual([]);
    expect(context.storage.sql.exec("SELECT * FROM sync_export_event_blocks WHERE action_required=1").toArray()).toHaveLength(1);
  });
});

it("returns overview coverage and persisted oldest sequence after rowid reversal and damaged JSON", async () => {
  const testEnv = environment("overview-index-proof");
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await enqueue(stub, "UNKNOWN_BUSINESS_EVENT", { entity: { season_id: seasonId } }, "out_associated_unknown_later", 1, 0, 0);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec("UPDATE sync_outbox SET rowid=100 WHERE outbox_id='out_associated_001'").toArray();
    sql.exec("UPDATE sync_outbox SET rowid=1 WHERE outbox_id='out_associated_unknown_later'").toArray();
  });
  const login = await (await call(testEnv, "/internal/c1/coach-login", { request_id: "overview_proof_login_001", coach_code: "local-test-coach-code" }, true)).json() as any;
  const token = login.data.result.session_token;
  const overview = async (id: string) => (await (await call(testEnv, "/internal/c2/get-sync-overview", { request_id: id, session_token: token, season_id: seasonId })).json()) as any;
  expect((await overview("overview_order_001")).data.export_control.oldest_pending).toMatchObject({ topic: "SIGNUPS_CHANGED" });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec("PRAGMA ignore_check_constraints=ON").toArray();
    sql.exec("UPDATE sync_outbox SET payload_json='{' WHERE outbox_id='out_associated_unknown_later'").toArray();
    sql.exec("PRAGMA ignore_check_constraints=OFF").toArray();
  });
  expect((await overview("overview_damaged_001")).data.lanes).toMatchObject({ coverage: "incomplete", runnable_outbox_id: null });
  await call(testEnv, "/internal/c1/coach-logout", { request_id: "overview_proof_logout_001", session_token: token }, true);
});

it("keeps a partially verified A locally stopped while B completes with independent physical baselines", async () => {
  const testEnv = environment("verified-stage-local-lane");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await secondPractice(stub, mirror);
  mirror.install();
  expect(await next(testEnv, "partial_A_batch_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
  mirror.rows.get("SIGNUP")![0][SHEET_SCOPES.SIGNUP.headers.indexOf("last_request_id")] = "manual_google_audit_001";
  expect(await next(testEnv, "partial_A_final_001")).toMatchObject({ error: { code: "SYNC_ASSOCIATED_NEEDS_REVIEW" } });
  expect(await next(testEnv, "partial_B_batch_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_002" } });
  expect(await next(testEnv, "partial_B_final_001")).toMatchObject({ data: { status: "EVENT_CONFIRMED", outbox_id: "out_associated_002" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec("SELECT * FROM sync_associated_physical_baselines WHERE row_id LIKE ?", `${practiceId}:%`).toArray()).toHaveLength(0);
    expect(sql.exec("SELECT * FROM sync_associated_physical_baselines WHERE row_id LIKE ?", `${secondPracticeId}:%`).toArray()).toHaveLength(1);
    expect(sql.exec("SELECT * FROM sync_export_event_blocks WHERE outbox_id='out_associated_001' AND action_required=1").toArray()).toHaveLength(1);
  });
});

it.each(["audit", "invalid-baseline"])("classifies draft %s using a trusted physical baseline", async (kind) => {
  const testEnv = environment(`draft-physical-${kind}`);
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, draftOnlyEvent(), "SEATING_CHANGED");
  mirror.install();
  await batchesThrough(testEnv, `draft_first_${kind}`, "SEAT_PLAN_DRAFT");
  expect(await next(testEnv, `draft_first_final_${kind}`)).toMatchObject({ data: { status: "EVENT_CONFIRMED" } });
  const payload = draftOnlyEvent();
  payload.entity.seat_plan_version = 2;
  payload.entity.seating_snapshot.state.seat_plan_version = 2;
  await enqueue(stub, "SEATING_CHANGED", payload, "out_draft_next_002", 0, 2, 0);
  if (kind === "audit") mirror.rows.get("SEAT_PLAN_CURRENT")![0][SHEET_SCOPES.SEAT_PLAN_CURRENT.headers.indexOf("updated_at")] = "2099-01-01T00:00:00.000Z";
  else await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_associated_physical_baselines SET cells_json='{}' WHERE scope='SEAT_PLAN_CURRENT'").toArray();
  });
  const writes = mirror.writes;
  expect(await next(testEnv, `draft_second_${kind}`)).toMatchObject({ error: { code: kind === "audit" ? "SYNC_ASSOCIATED_NEEDS_REVIEW" : "SYNC_BASELINE_INCOMPLETE" } });
  expect(mirror.writes).toBe(writes);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec("SELECT * FROM sync_export_event_blocks WHERE action_required=1").toArray()).toHaveLength(kind === "audit" ? 1 : 0);
  });
});

it("an interrupted old poll stops on its original event after another poll completes it", async () => {
  const testEnv = { ...environment("poll-interleaved-completion"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await secondPractice(stub, mirror);
  mirror.loseFirstReply = true;
  mirror.install();
  const poll = async (id: string) => (await (await call(testEnv, "/internal/c2/poll-due-exports", { request_id: id })).json()) as any;
  expect((await poll("poll_interrupted_001")).data.results).toMatchObject([{ status: "RETRY_REQUIRED" }]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const key = sql.exec<{ request_key: string }>("SELECT request_key FROM system_requests WHERE action='pollDueExports'").one().request_key;
    sql.exec("DELETE FROM audit_events WHERE request_key=?", key).toArray();
    sql.exec("DELETE FROM system_requests WHERE request_key=?", key).toArray();
  });
  // An unknown outer response during existing global backoff cannot turn that
  // recoverable network failure into ACTION_REQUIRED or send another operation.
  const beforeBackoff = mirror.writes;
  expect((await poll("poll_interrupted_001")).data.results).toMatchObject([{ status: "ORIGINAL_EVENT_UNAVAILABLE" }]);
  expect(mirror.writes).toBe(beforeBackoff);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ action_required: number; failure_count: number }>("SELECT action_required,failure_count FROM sync_export_retries").one()).toEqual({ action_required: 0, failure_count: 1 });
    const key = sql.exec<{ request_key: string }>("SELECT request_key FROM system_requests WHERE action='pollDueExports'").one().request_key;
    sql.exec("DELETE FROM audit_events WHERE request_key=?", key).toArray();
    sql.exec("DELETE FROM system_requests WHERE request_key=?", key).toArray();
    sql.exec("UPDATE sync_export_retries SET failure_count=0,next_attempt_at_ms=0,last_error=''").toArray();
  });
  expect((await poll("poll_other_completes_A_001")).data.results).toMatchObject([{ status: "EVENT_CONFIRMED" }]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at,action_required)
      VALUES (?,1,2,?,'SERVICE_BUSY',?,0) ON CONFLICT(season_id) DO UPDATE SET failure_count=2,next_attempt_at_ms=excluded.next_attempt_at_ms,last_error='SERVICE_BUSY',updated_at=excluded.updated_at`, seasonId, Date.now() + 600_000, at).toArray();
  });
  const writes = mirror.writes;
  expect((await poll("poll_interrupted_001")).data.results).toMatchObject([{ status: "EVENT_CONFIRMED" }]);
  expect(mirror.writes).toBe(writes);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec("SELECT * FROM sync_export_retries WHERE action_required=1").toArray()).toEqual([]);
    expect(context.storage.sql.exec<{ failure_count: number }>("SELECT failure_count FROM sync_export_retries").one().failure_count).toBe(2);
    expect(context.storage.sql.exec<{ status: string }>("SELECT status FROM sync_outbox WHERE outbox_id='out_associated_002'").one().status).toBe("PENDING");
    expect(context.storage.sql.exec("SELECT * FROM sync_export_poll_plans").toArray()).toHaveLength(2);
  });
});

it.each(["direct", "poll"])("clears an expired retry after successful natural %s recovery", async (mode) => {
  const testEnv = { ...environment(`natural-retry-${mode}`), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  mirror.loseFirstReply = true;
  mirror.install();
  const first = mode === "direct" ? await next(testEnv, "natural_direct_001") : await (await call(testEnv, "/internal/c2/poll-due-exports", { request_id: "natural_poll_001" })).json() as any;
  if (mode === "direct") expect(first).toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  else expect(first.data.results).toMatchObject([{ status: "RETRY_REQUIRED" }]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at,action_required)
      VALUES (?,1,1,?,'BRIDGE_UNAVAILABLE',?,0) ON CONFLICT(season_id) DO UPDATE SET next_attempt_at_ms=excluded.next_attempt_at_ms`, seasonId, Date.now() - 1000, at).toArray();
  });
  if (mode === "direct") {
    expect(await next(testEnv, "natural_direct_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at,action_required) VALUES (?,1,1,0,'BRIDGE_UNAVAILABLE',?,0)", seasonId, at).toArray();
    });
    expect(await next(testEnv, "natural_direct_final_001")).toMatchObject({ data: { status: "EVENT_CONFIRMED" } });
  } else expect(await (await call(testEnv, "/internal/c2/poll-due-exports", { request_id: "natural_poll_recover_002" })).json()).toMatchObject({ data: { results: [{ status: "EVENT_CONFIRMED" }] } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec("SELECT * FROM sync_export_retries").toArray()).toEqual([]);
  });
});

it("locally blocks final extra draft seats and permits an independent practice to continue", async () => {
  const testEnv = environment("final-extra-seat-lane");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, draftOnlyEvent(), "SEATING_CHANGED");
  await secondPractice(stub, mirror);
  mirror.install();
  await batchesThrough(testEnv, "extra_seat_A_batch", "SEAT_PLAN_DRAFT");
  mirror.rows.get("SEAT_PLAN_CURRENT")!.push(cells("SEAT_PLAN_CURRENT", {
    season_id: seasonId, practice_id: practiceId, row_number: 2, side: "LEFT", member_id: "",
    seat_plan_version: 1, updated_by: coachId, updated_at: at
  }));
  expect(await next(testEnv, "extra_seat_A_final_001")).toMatchObject({ error: { code: "SYNC_ASSOCIATED_NEEDS_REVIEW" } });
  expect(await next(testEnv, "extra_seat_B_batch_001")).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_002" } });
});

it.each([true, false])("guards a confirmed batch recovery gap against another season with pin=%s", async (keepPin) => {
  const testEnv = environment(`confirmed-batch-gap-${keepPin}`);
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  mirror.install();
  const id = `confirmed_gap_original_${keepPin}`;
  expect(await next(testEnv, id)).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const key = sql.exec<{ request_key: string }>("SELECT request_key FROM system_requests WHERE request_id=?", id).one().request_key;
    sql.exec("DELETE FROM audit_events WHERE request_key=?", key).toArray();
    sql.exec("DELETE FROM system_requests WHERE request_key=?", key).toArray();
    if (!keepPin) sql.exec("DELETE FROM sync_export_request_selections WHERE request_key=?", key).toArray();
  });
  const writes = mirror.writes;
  expect(await (await call(testEnv, "/internal/c2/export-next-associated", { request_id: id, season_id: "season_wrong_recovery_001" })).json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  expect(await next(testEnv, id)).toMatchObject({ data: { status: "BATCH_CONFIRMED", outbox_id: "out_associated_001" } });
  expect(mirror.writes).toBe(writes);
});

it("preserves a new concurrent failure while an earlier Google batch confirms", async () => {
  const testEnv = environment("concurrent-global-failure");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at,action_required) VALUES (?,1,1,0,'BRIDGE_UNAVAILABLE',?,0)", seasonId, at).toArray();
  });
  let reached = false, released = false, settled = false;
  mirror.afterPatch = async () => {
    reached = true;
    while (!released) await new Promise<void>(resolve => setTimeout(resolve, 1));
  };
  mirror.install();
  const pending = next(testEnv, "concurrent_failure_batch_001").finally(() => { settled = true; });
  try {
    while (!reached && !settled) await new Promise<void>(resolve => setTimeout(resolve, 1));
    expect(reached).toBe(true);
    expect(settled).toBe(false);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE sync_export_retries SET failure_count=2,next_attempt_at_ms=?,last_error='SERVICE_BUSY',updated_at=?", Date.now() + 600_000, "2026-10-01T01:00:00.000Z").toArray();
    });
  } finally { released = true; }
  expect(await pending).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ failure_count: number; last_error: string }>("SELECT failure_count,last_error FROM sync_export_retries").one()).toEqual({ failure_count: 2, last_error: "SERVICE_BUSY" });
    expect(context.storage.sql.exec<{ status: string }>("SELECT status FROM sync_batches").one().status).toBe("CONFIRMED");
  });
});

it.each([[false, false], [true, false], [false, true], [true, true]])(
  "preserves newer global retry ownership after a late failed poll with Coach rearm=%s, nonretryable=%s", async (rearmByCoach, nonretryable) => {
  const testEnv = { ...environment(`late-poll-failure-${rearmByCoach}-${nonretryable}`), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  const login = await (await call(testEnv, "/internal/c1/coach-login", {
    request_id: "late_poll_login_001", coach_code: "local-test-coach-code" }, true)).json() as any;
  const token = login.data.result.session_token;
  let reached = false;
  let released = false;
  mirror.afterPatch = async (requestId) => {
    reached = true;
    while (!released) await new Promise(resolve => setTimeout(resolve, 1));
    if (nonretryable) return Response.json({ ok: false, meta: { request_id: requestId },
      error: { code: "BRIDGE_OPERATION_CONFLICT", message: "Operation conflict", retryable: false } });
    throw new Error("Reply lost after a concurrent administrative decision");
  };
  mirror.install();
  const pending = (async () => (await call(testEnv, "/internal/c2/poll-due-exports", {
    request_id: "late_poll_failure_001" })).json())();
  let newer: unknown;
  try {
    for (let count = 0; count < 200 && !reached; count++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(reached).toBe(true);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(`INSERT INTO sync_export_retries VALUES (?,1,7,0,'SYNC_REFERENCE_NEEDS_REVIEW',?,1)`,
        seasonId, "2026-10-01T01:00:00.000Z").toArray();
    });
    if (rearmByCoach) {
      const result = await (await call(testEnv, "/internal/c2/retry-export", {
        request_id: "late_poll_coach_retry_001", season_id: seasonId, session_token: token })).json() as any;
      expect(result).toMatchObject({ data: { result: { rearmed: true } } });
    }
    newer = await runInDurableObject(stub, async (_instance: TeamState, context) =>
      context.storage.sql.exec("SELECT * FROM sync_export_retries").one());
  } finally {
    released = true;
  }
  expect(await pending).toMatchObject({ data: { results: [{ status: rearmByCoach ? "ORIGINAL_EVENT_UNAVAILABLE" : "ACTION_REQUIRED" }] } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec("SELECT * FROM sync_export_retries").one()).toEqual(newer);
    expect(context.storage.sql.exec<{ status: string }>("SELECT status FROM sync_batches").one().status).toBe("FAILED");
    if (nonretryable) expect(context.storage.sql.exec<{ last_error: string }>("SELECT last_error FROM sync_batches").one().last_error).toBe("Operation conflict");
    expect(context.storage.sql.exec<{ status: string }>("SELECT status FROM sync_outbox WHERE outbox_id='out_associated_001'").one().status).toBe("PENDING");
    expect(selectExportLane(context.storage.sql, seasonId).reason).toBe(rearmByCoach ? "DRAIN_BATCH" : "GLOBAL_ACTION_REQUIRED");
  });
  if (!rearmByCoach) {
    const writes = mirror.writes;
    await call(testEnv, "/internal/c2/poll-due-exports", { request_id: "late_poll_after_halt_001" });
    expect(mirror.writes).toBe(writes);
  }
  await call(testEnv, "/internal/c1/coach-logout", { request_id: "late_poll_logout_001", session_token: token }, true);
});

async function preflightEvidence(stub: ReturnType<Env["TEAM_STATE"]["getByName"]>) {
  return runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    return {
      outbox: sql.exec("SELECT * FROM sync_outbox ORDER BY outbox_id").toArray(),
      baselines: sql.exec("SELECT * FROM sync_baselines ORDER BY entity_type,entity_id,dependency_group").toArray(),
      physical: sql.exec("SELECT * FROM sync_associated_physical_baselines ORDER BY scope,row_id").toArray(),
      cursors: sql.exec("SELECT * FROM sync_associated_cursors ORDER BY practice_id").toArray(),
      batches: sql.exec("SELECT * FROM sync_batches ORDER BY batch_id").toArray()
    };
  });
}

it.each(["PRACTICE", "MEMBER"] as const)(
  "rejects a known %s reference conflict before preparing and resumes the same event after repair", async (scope) => {
    const testEnv = environment(`early-${scope.toLowerCase()}-preflight`);
    const mirror = new SheetMirror();
    const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
    const row = mirror.rows.get(scope)![0];
    const index = (SHEET_SCOPES[scope].headers as readonly string[])
      .indexOf(scope === "PRACTICE" ? "location" : "display_name_override");
    const original = row[index];
    row[index] = "Manual conflicting edit";
    const beforeGoogle = JSON.stringify([...mirror.rows]);
    const before = await preflightEvidence(stub);
    mirror.install();
    expect(await next(testEnv, `associated_early_${scope}_001`)).toMatchObject({
      error: { code: "SYNC_REFERENCE_NEEDS_REVIEW" } });
    expect(mirror.writes).toBe(0);
    expect(JSON.stringify([...mirror.rows])).toBe(beforeGoogle);
    expect(await preflightEvidence(stub)).toEqual(before);

    row[index] = original;
    await rearm(testEnv);
    expect(await next(testEnv, `associated_early_${scope}_002`)).toMatchObject({ data: {
      status: "BATCH_CONFIRMED", entity_type: "SIGNUP" } });
    expect(await next(testEnv, `associated_early_${scope}_003`)).toMatchObject({ data: {
      status: "EVENT_CONFIRMED", outbox_id: "out_associated_001", signup_version: 1 } });
    expect(mirror.writes).toBe(1);
    expect(mirror.rows.get("SIGNUP")).toHaveLength(1);
    expect(mirror.rows.get("SIGNUP")![0]).toEqual(cells("SIGNUP", signup(members[0], 1)));
    const completed = await preflightEvidence(stub);
    expect(completed.outbox[0]).toMatchObject({ outbox_id: "out_associated_001", status: "CONFIRMED" });
    expect(completed.cursors).toMatchObject([{ signup_version: 1, seat_plan_version: 0, published_revision: 0 }]);
    const baseline = completed.baselines.find((row) => row.entity_type === "SIGNUP" &&
      row.dependency_group === "SIGNUP_STATE")!;
    expect(JSON.parse(String(baseline.baseline_json))).toEqual({ preference: "LEFT", status: "CONFIRMED" });
    expect(JSON.parse(String(completed.physical[0].cells_json))).toEqual(mirror.rows.get("SIGNUP")![0]);
  });

it("rejects an unbaselined draft seat before creating a batch", async () => {
  const testEnv = environment("early-draft-preflight");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, draftOnlyEvent(), "SEATING_CHANGED");
  mirror.rows.set("SEAT_PLAN_CURRENT", [cells("SEAT_PLAN_CURRENT", {
    season_id: seasonId, practice_id: practiceId, row_number: 2, side: "LEFT",
    member_id: members[0], seat_plan_version: 1, updated_by: coachId, updated_at: at
  })]);
  const beforeGoogle = JSON.stringify([...mirror.rows]);
  const before = await preflightEvidence(stub);
  mirror.install();
  expect(await next(testEnv, "associated_early_draft_001")).toMatchObject({
    error: { code: "SYNC_ASSOCIATED_NEEDS_REVIEW" } });
  expect(mirror.writes).toBe(0);
  expect(JSON.stringify([...mirror.rows])).toBe(beforeGoogle);
  expect(await preflightEvidence(stub)).toEqual(before);
  mirror.rows.set("SEAT_PLAN_CURRENT", []);
  await batchesThrough(testEnv, "associated_early_draft_resume", "SEAT_PLAN_DRAFT");
  expect(await next(testEnv, "associated_early_draft_final_001")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", outbox_id: "out_associated_001", seat_plan_version: 1 } });
  const completed = await preflightEvidence(stub);
  expect(completed.outbox[0]).toMatchObject({ status: "CONFIRMED" });
  expect(completed.cursors).toMatchObject([{ signup_version: 0, seat_plan_version: 1, published_revision: 0 }]);
  const seats = mirror.rows.get("SEAT_PLAN_CURRENT")!;
  expect(seats.find((row) => row[2] === "1" && row[3] === "LEFT")![4]).toBe(members[0]);
  for (const row of completed.physical) {
    expect(mirror.rows.get(row.scope as SheetScope)).toContainEqual(JSON.parse(String(row.cells_json)));
  }
});

it("rechecks references before sending when Google changes after the early preflight", async () => {
  const testEnv = environment("reference-preflight-race");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  const before = await preflightEvidence(stub);
  let referenceReads = 0;
  const location = SHEET_SCOPES.PRACTICE.headers.indexOf("location");
  mirror.beforeRead = (scope) => {
    if (scope === "PRACTICE" && ++referenceReads === 2) {
      mirror.rows.get("PRACTICE")![0][location] = "Concurrent manual edit";
    }
  };
  mirror.install();
  expect(await next(testEnv, "associated_reference_race_001")).toMatchObject({
    error: { code: "SYNC_REFERENCE_NEEDS_REVIEW" } });
  expect(referenceReads).toBe(2);
  expect(mirror.writes).toBe(0);
  expect(mirror.rows.get("SIGNUP")).toEqual([]);
  const after = await preflightEvidence(stub);
  expect({ ...after, batches: [] }).toEqual(before);
  expect(after.batches).toHaveLength(1);
  expect(after.batches[0]).toMatchObject({ status: "PREPARED", attempt_count: 0 });
  const batchId = after.batches[0].batch_id;
  mirror.beforeRead = null;
  mirror.rows.get("PRACTICE")![0][location] = practice.location;
  expect(await next(testEnv, "associated_reference_race_002")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", batch_id: batchId } });
  expect(await next(testEnv, "associated_reference_race_003")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", outbox_id: "out_associated_001" } });
  expect(mirror.writes).toBe(1);
});

it("rechecks the draft before sending when a new Google seat appears during preparation", async () => {
  const testEnv = environment("draft-preflight-race");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, draftOnlyEvent(), "SEATING_CHANGED");
  const before = await preflightEvidence(stub);
  let seatReads = 0;
  const manualSeat = cells("SEAT_PLAN_CURRENT", { season_id: seasonId, practice_id: practiceId,
    row_number: 2, side: "LEFT", member_id: members[0], seat_plan_version: 1,
    updated_by: coachId, updated_at: at });
  mirror.beforeRead = (scope) => {
    // Early draft inspection, target inspection, then the preserved send-time inspection.
    if (scope === "SEAT_PLAN_CURRENT" && ++seatReads === 3) {
      mirror.rows.get("SEAT_PLAN_CURRENT")!.push(manualSeat);
    }
  };
  mirror.install();
  expect(await next(testEnv, "associated_draft_race_001")).toMatchObject({
    error: { code: "SYNC_ASSOCIATED_NEEDS_REVIEW" } });
  expect(seatReads).toBe(3);
  expect(mirror.writes).toBe(0);
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")).toEqual([manualSeat]);
  const after = await preflightEvidence(stub);
  expect({ ...after, batches: [] }).toEqual(before);
  expect(after.batches).toHaveLength(1);
  expect(after.batches[0]).toMatchObject({ status: "PREPARED", attempt_count: 0 });
  expect(mirror.rows.get("SEAT_PLAN_REVISION")).toEqual([]);
  expect(mirror.rows.get("SEAT_PLAN_DRAFT")).toEqual([]);
});

async function enqueue(stub: ReturnType<Env["TEAM_STATE"]["getByName"]>,
    topic: string, payload: Record<string, unknown>, outboxId: string,
    signupVersion: number, seatVersion: number, publishedRevision: number) {
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec(`UPDATE practice_versions SET signup_version=?,seat_plan_version=?,published_revision=?
      WHERE season_id=? AND practice_id=?`, signupVersion, seatVersion,
      publishedRevision, seasonId, practiceId).toArray();
    const event = payload.entity as Record<string, unknown>;
    const revision = (event.seating_snapshot as Record<string, unknown> | undefined)
      ?.revision as Record<string, unknown> | null | undefined;
    if (revision) sql.exec(`INSERT INTO seat_plan_revisions(season_id,practice_id,revision_number,
      revision_id,source,seat_plan_version,coach_member_id,steerer_member_id,published_by,
      published_at,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    seasonId, practiceId, revision.revision_number, revision.revision_id, revision.source,
    revision.seat_plan_version, revision.coach_member_id || null, revision.steerer_member_id || null,
    revision.published_by, revision.published_at, revision.request_id).toArray();
    const key = sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    sql.exec(`INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
      VALUES (?,?,?,?,'PENDING',?,?)`, outboxId, key, topic,
      JSON.stringify(payload), Date.now() - 1000, at).toArray();
    indexExportEvent(sql, outboxId);
  });
}

async function batchesThrough(testEnv: Env, prefix: string, lastScope: string, limit = 10): Promise<any[]> {
  const batches: any[] = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await next(testEnv, `${prefix}_${index + 1}`);
    expect(result).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
    expect(result.data.row_ids).toBeInstanceOf(Array);
    expect(result.data.row_ids.length).toBeGreaterThanOrEqual(1);
    expect(result.data.row_ids.length).toBeLessThanOrEqual(4);
    batches.push(result.data);
    if (result.data.entity_type === lastScope) return batches;
  }
  throw new Error(`The ${lastScope} stage was not reached within ${limit} batches.`);
}

it("exports successive signup versions against the confirmed prior Google row", async () => {
  const testEnv = environment("rolling-signups");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await enqueue(stub, "SIGNUPS_CHANGED", signupEvent(2, [{ ...signup(members[0], 1),
    preference: "RIGHT", status: "WAITLISTED", updated_at: "2026-09-30T12:05:00.000Z" }]),
  "out_associated_002", 2, 0, 0);
  mirror.install();
  expect(await next(testEnv, "associated_rolling_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SIGNUP" } });
  expect(await next(testEnv, "associated_rolling_002")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", signup_version: 1 } });
  const statusIndex = SHEET_SCOPES.SIGNUP.headers.indexOf("status");
  expect(mirror.rows.get("SIGNUP")![0][statusIndex]).toBe("CONFIRMED");
  expect(await next(testEnv, "associated_rolling_003")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SIGNUP" } });
  expect(mirror.rows.get("SIGNUP")![0][statusIndex]).toBe("WAITLISTED");
  expect(await next(testEnv, "associated_rolling_004")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", signup_version: 2 } });
  expect(mirror.rows.get("SIGNUP")).toHaveLength(1);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ signup_version: number }>("SELECT signup_version FROM sync_associated_cursors")
      .one().signup_version).toBe(2);
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_outbox WHERE status='CONFIRMED'")
      .one().count).toBe(2);
    const status = sql.exec<{ baseline_json: string }>(`SELECT baseline_json FROM sync_baselines
      WHERE entity_type='SIGNUP' AND entity_id=? AND dependency_group='SIGNUP_STATE'`,
      `${practiceId}:${members[0]}`).one();
    expect(JSON.parse(status.baseline_json)).toMatchObject({ preference: "RIGHT", status: "WAITLISTED" });
  });
});

it("exports a waitlisted member's promotion only after the prior signup version is confirmed", async () => {
  const testEnv = environment("waitlist-promotion");
  const mirror = new SheetMirror();
  const first = signup(members[0], 1);
  const waiter = { ...signup(members[1], 2, "WAITLISTED"), preference: "LEFT" };
  const seating = linkedSeating();
  seating.draft_seats[1].member_id = "";
  seating.revision.seats = [seating.draft_seats[0]];
  seating.revision.names = [{ member_id: members[0], display_name: "First" }];
  const stub = await seed(testEnv, signupEvent(1, [first, waiter], seating));
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    sql.exec(`INSERT INTO seat_plan_draft_seats(season_id,practice_id,side,row_number,member_id,
      seat_plan_version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    seasonId, practiceId, "LEFT", 1, members[0], 1, coachId, at).toArray();
    sql.exec(`INSERT INTO seat_plan_revision_seats(season_id,practice_id,revision_number,side,
      row_number,member_id) VALUES (?,?,?,?,?,?)`,
    seasonId, practiceId, 1, "LEFT", 1, members[0]).toArray();
    sql.exec(`INSERT INTO seat_plan_revision_names(season_id,practice_id,revision_number,
      member_id,display_name) VALUES (?,?,?,?,?)`,
    seasonId, practiceId, 1, members[0], "First").toArray();
  });
  mirror.install();

  const initialBatches = await batchesThrough(testEnv, "waitlist_initial", "SEAT_PLAN_DRAFT");
  expect(initialBatches.map((batch) => batch.entity_type)).toEqual([
    "SIGNUP", "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION", "SEAT_PLAN_DRAFT"]);
  expect(await next(testEnv, "waitlist_initial_final_001")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", signup_version: 1 } });
  const signupColumns = SHEET_SCOPES.SIGNUP.headers;
  const status = (memberId: string) => mirror.rows.get("SIGNUP")!.find((row) =>
    row[signupColumns.indexOf("member_id")] === memberId)![signupColumns.indexOf("status")];
  expect(status(members[0])).toBe("CONFIRMED");
  expect(status(members[1])).toBe("WAITLISTED");
  const revisionColumns = SHEET_SCOPES.SEAT_PLAN_REVISION.headers;
  const revisionNumber = revisionColumns.indexOf("revision_number");
  const revisionOne = [...mirror.rows.get("SEAT_PLAN_REVISION")![0]];
  expect(revisionOne[revisionNumber]).toBe("1");

  const cancellation = await call(testEnv, "/internal/c1/cancel-signup", {
    request_id: "waitlist_promotion_cancel_001", season_id: seasonId, practice_id: practiceId,
    member_id: members[0], practice_version: 1, signup_version: 1
  }, true);
  const cancellationResult = await cancellation.json() as any;
  expect(cancellation.status, JSON.stringify(cancellationResult)).toBe(200);
  expect(cancellationResult.data.result).toMatchObject({ signup_version: 2,
    promoted_member_ids: [members[1]], seat_plan_version: 2, published_revision: 2 });
  const emitted = await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    return JSON.parse(sql.exec<{ payload_json: string }>(`SELECT payload_json FROM sync_outbox
      WHERE topic='SIGNUPS_CHANGED' AND status='PENDING'`).one().payload_json).entity;
  }) as any;
  expect(emitted.signup_rows).toMatchObject([
    { member_id: members[0], status: "CANCELLED" },
    { member_id: members[1], status: "CONFIRMED", preference: "LEFT" }
  ]);
  expect(emitted.seating_snapshot.revision).toMatchObject({
    revision_number: 2, source: "SYSTEM_CANCELSIGNUP",
    seats: [{ row_number: 1, side: "LEFT", member_id: members[1] }]
  });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec(`UPDATE sync_outbox SET due_at_ms=?
      WHERE topic='SIGNUPS_CHANGED' AND status='PENDING'`, Date.now() - 1000).toArray();
  });
  expect(await next(testEnv, "waitlist_promotion_batch_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SIGNUP" } });
  expect(status(members[0])).toBe("CANCELLED");
  expect(status(members[1])).toBe("CONFIRMED");
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ signup_version: number }>("SELECT signup_version FROM sync_associated_cursors")
      .one().signup_version).toBe(1);
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox WHERE topic='SIGNUPS_CHANGED' ORDER BY rowid DESC LIMIT 1")
      .one().status).toBe("PENDING");
  });

  const remaining = await batchesThrough(testEnv, "waitlist_promotion_step", "SEAT_PLAN_DRAFT");
  expect(remaining.map((batch) => batch.entity_type)).toEqual([
    "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION", "SEAT_PLAN_DRAFT"]);
  expect(await next(testEnv, "waitlist_promotion_final_001")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", signup_version: 2, seat_plan_version: 2, published_revision: 2 } });
  const seatColumns = SHEET_SCOPES.SEAT_PLAN_CURRENT.headers;
  const left = mirror.rows.get("SEAT_PLAN_CURRENT")!.find((row) =>
    row[seatColumns.indexOf("side")] === "LEFT")!;
  expect(left[seatColumns.indexOf("member_id")]).toBe(members[1]);
  const right = mirror.rows.get("SEAT_PLAN_CURRENT")!.find((row) =>
    row[seatColumns.indexOf("side")] === "RIGHT")!;
  expect(right[seatColumns.indexOf("member_id")]).toBe("");
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")!.every((row) =>
    row[seatColumns.indexOf("seat_plan_version")] === "2")).toBe(true);
  const revisions = mirror.rows.get("SEAT_PLAN_REVISION")!;
  expect(revisions).toHaveLength(2);
  expect(revisions.find((row) => row[revisionNumber] === "1")).toEqual(revisionOne);
  const revisionTwo = revisions.find((row) => row[revisionNumber] === "2")!;
  expect(revisionTwo[revisionColumns.indexOf("source")]).toBe("SYSTEM_CANCELSIGNUP");
  expect(JSON.parse(revisionTwo[revisionColumns.indexOf("seats_json")])).toEqual([
    { side: "LEFT", row_number: 1, member_id: members[1] }
  ]);
  expect(JSON.parse(revisionTwo[revisionColumns.indexOf("names_json")])).toEqual([
    { member_id: members[1], display_name: "Second" }
  ]);
  const stateColumns = SHEET_SCOPES.SEAT_PLAN_DRAFT.headers;
  const state = mirror.rows.get("SEAT_PLAN_DRAFT")!;
  expect(state).toHaveLength(1);
  expect(state[0][stateColumns.indexOf("seat_plan_version")]).toBe("2");
  expect(state[0][stateColumns.indexOf("published_revision")]).toBe("2");
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ signup_version: number; seat_plan_version: number; published_revision: number }>(
      "SELECT signup_version,seat_plan_version,published_revision FROM sync_associated_cursors").one())
      .toEqual({ signup_version: 2, seat_plan_version: 2, published_revision: 2 });
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox WHERE topic='SIGNUPS_CHANGED' ORDER BY rowid DESC LIMIT 1")
      .one().status).toBe("CONFIRMED");
    const baseline = sql.exec<{ entity_id: string; baseline_json: string }>(`SELECT entity_id,baseline_json
      FROM sync_baselines WHERE entity_type='SIGNUP' AND dependency_group='SIGNUP_STATE'
      ORDER BY entity_id`).toArray();
    expect(baseline.map((row) => [row.entity_id, JSON.parse(row.baseline_json).status])).toEqual([
      [`${practiceId}:${members[0]}`, "CANCELLED"],
      [`${practiceId}:${members[1]}`, "CONFIRMED"]
    ]);
    const draftBaseline = sql.exec<{ baseline_json: string }>(`SELECT baseline_json FROM sync_baselines
      WHERE entity_type='SEAT_PLAN_DRAFT' AND entity_id=? AND dependency_group='SEATING_DRAFT'`,
    practiceId).one();
    const draft = JSON.parse(draftBaseline.baseline_json);
    expect(draft.seats).toEqual([
      { side: "LEFT", row_number: 1, member_id: members[1] },
      { side: "RIGHT", row_number: 1, member_id: "" }
    ]);
    const versionBaseline = sql.exec<{ baseline_json: string }>(`SELECT baseline_json FROM sync_baselines
      WHERE entity_type='SEAT_PLAN_DRAFT' AND entity_id=? AND dependency_group='SYSTEM_VERSION'`,
    practiceId).one();
    expect(JSON.parse(versionBaseline.baseline_json)).toMatchObject({
      seat_plan_version: 2, published_revision: 2
    });
    type Physical = { scope: string; row_id: string; cells_json: string; cells_digest: string };
    const physical = sql.exec<Physical>(`SELECT scope,row_id,cells_json,cells_digest
      FROM sync_associated_physical_baselines WHERE season_id=? AND binding_version=1`,
    seasonId).toArray();
    const physicalById = new Map(physical.map((row) => [`${row.scope}:${row.row_id}`, row]));
    expect(physical).toHaveLength(7);
    for (const scope of ["SIGNUP", "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION", "SEAT_PLAN_DRAFT"] as const) {
      for (const cells of mirror.rows.get(scope)!) {
        const rowId = scope === "SIGNUP" ? `${cells[1]}:${cells[2]}` :
          scope === "SEAT_PLAN_CURRENT" ? `${cells[1]}:${cells[2]}:${cells[3]}` :
            scope === "SEAT_PLAN_REVISION" ? `${cells[1]}:${cells[2]}` : cells[1];
        const saved = physicalById.get(`${scope}:${rowId}`);
        expect(saved?.cells_digest).toBe(`sha256_v1:${await sha256Base64Url(JSON.stringify(cells))}`);
        expect(JSON.parse(saved!.cells_json)).toEqual(cells);
      }
    }
  });
});

it("detects a direct Google edit to signup audit cells before the next version", async () => {
  const testEnv = environment("signup-audit-edit");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await enqueue(stub, "SIGNUPS_CHANGED", signupEvent(2, [{ ...signup(members[0], 1),
    preference: "RIGHT", updated_at: "2026-09-30T12:05:00.000Z" }]),
  "out_associated_002", 2, 0, 0);
  mirror.install();
  expect(await next(testEnv, "associated_audit_first_batch_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SIGNUP" } });
  expect(await next(testEnv, "associated_audit_first_final_001")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", signup_version: 1 } });
  const auditIndex = SHEET_SCOPES.SIGNUP.headers.indexOf("last_request_id");
  mirror.rows.get("SIGNUP")![0][auditIndex] = "manual_google_audit_edit";
  expect(await next(testEnv, "associated_audit_second_001")).toMatchObject({
    error: { code: "SYNC_ASSOCIATED_NEEDS_REVIEW" } });
  expect(mirror.writes).toBe(1);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ signup_version: number }>("SELECT signup_version FROM sync_associated_cursors")
      .one().signup_version).toBe(1);
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox WHERE outbox_id='out_associated_002'")
      .one().status).toBe("PENDING");
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_batches")
      .one().count).toBe(1);
  });
});

it("publishes an immutable revision without rewriting a previously confirmed draft", async () => {
  const testEnv = environment("seating-only");
  const mirror = new SheetMirror();
  const draft = linkedSeating();
  draft.state.published_revision = 0;
  draft.draft_seats[1].member_id = "";
  const initial = { action: "saveSeatPlanDraft", entity: {
    season_id: seasonId, practice_id: practiceId, snapshot_schema: 1,
    practice_version: 1, signup_version: 0, seat_plan_version: 1, published_revision: 0,
    seating_snapshot: { state: draft.state, draft_seats: draft.draft_seats, revision: null } } };
  const stub = await seed(testEnv, initial, "SEATING_CHANGED");
  mirror.install();
  const draftBatches = await batchesThrough(testEnv, "associated_draft", "SEAT_PLAN_DRAFT");
  expect(draftBatches[0].entity_type).toBe("SEAT_PLAN_CURRENT");
  expect(await next(testEnv, "associated_draft_final_001")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", seat_plan_version: 1, published_revision: 0 } });
  const revision = linkedSeating().revision;
  revision.seats = [draft.draft_seats[0]];
  revision.names = [{ member_id: members[0], display_name: "First" }];
  const state = { ...draft.state, published_revision: 1 };
  const publication = { action: "publishSeatPlan", entity: {
    season_id: seasonId, practice_id: practiceId, snapshot_schema: 1,
    practice_version: 1, signup_version: 0, seat_plan_version: 1, published_revision: 1,
    seating_snapshot: { state, draft_seats: null, revision } } };
  await enqueue(stub, "SEATING_CHANGED", publication, "out_associated_002", 0, 1, 1);
  const oldCells = mirror.rows.get("SEAT_PLAN_CURRENT")!.map((row) => [...row]);
  expect(await next(testEnv, "associated_revision_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SEAT_PLAN_REVISION" } });
  expect(await next(testEnv, "associated_revision_002")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SEAT_PLAN_DRAFT" } });
  expect(await next(testEnv, "associated_revision_final_001")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", seat_plan_version: 1, published_revision: 1 } });
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")).toEqual(oldCells);
  expect(mirror.rows.get("SEAT_PLAN_REVISION")).toHaveLength(1);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ seat_plan_version: number; published_revision: number }>(
      "SELECT seat_plan_version,published_revision FROM sync_associated_cursors").one())
      .toEqual({ seat_plan_version: 1, published_revision: 1 });
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_outbox WHERE status='CONFIRMED'")
      .one().count).toBe(2);
  });
});

it("replays the same first SeatPlanCurrent batch after a partial write and lost reply", async () => {
  const testEnv = environment("first-seat-lost-reply");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, draftOnlyEvent(), "SEATING_CHANGED");
  mirror.partialFirstSeatBeforeLoss = true;
  mirror.install();
  const first = await next(testEnv, "associated_first_seat_001");
  expect(first).toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")).toHaveLength(1);
  expect(mirror.writes).toBe(1);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_batches").one().status).toBe("FAILED");
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox").one().status).toBe("PENDING");
  });
  expect(await next(testEnv, "associated_first_seat_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SEAT_PLAN_CURRENT",
    row_ids: [`${practiceId}:1:LEFT`, `${practiceId}:1:RIGHT`] } });
  expect(mirror.patchOperationIds[1]).toBe(mirror.patchOperationIds[0]);
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")!.length).toBeGreaterThanOrEqual(1);
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")!.length).toBeLessThanOrEqual(2);
  expect(mirror.writes).toBe(2);
  let completed = false;
  for (let index = 0; index < 4; index += 1) {
    const result = await next(testEnv, `associated_seat_drain_${index + 1}`);
    if (result.data?.status === "EVENT_CONFIRMED") {
      expect(result).toMatchObject({ data: { seat_plan_version: 1 } });
      completed = true;
      break;
    }
    expect(result).toMatchObject({ data: { status: "BATCH_CONFIRMED" } });
  }
  expect(completed).toBe(true);
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")).toHaveLength(2);
  expect(mirror.patchSizes.every((size) => size >= 1 && size <= 4)).toBe(true);
});

it("splits five draft seats into bounded four-row and one-row bridge batches", async () => {
  const testEnv = environment("five-seat-batches");
  const mirror = new SheetMirror(2, 3);
  const state = { ...linkedSeating().state, published_revision: 0 };
  const draftSeats = [
    { row_number: 1, side: "LEFT", member_id: members[0] },
    { row_number: 2, side: "LEFT", member_id: "" },
    { row_number: 1, side: "RIGHT", member_id: "" },
    { row_number: 2, side: "RIGHT", member_id: "" },
    { row_number: 3, side: "RIGHT", member_id: "" }
  ];
  const snapshot = { action: "saveSeatPlanDraft", entity: {
    season_id: seasonId, practice_id: practiceId, snapshot_schema: 1,
    practice_version: 1, signup_version: 0, seat_plan_version: 1, published_revision: 0,
    seating_snapshot: { state, draft_seats: draftSeats, revision: null } } };
  const stub = await seed(testEnv, snapshot, "SEATING_CHANGED", 2, 3);
  mirror.install();
  const first = await next(testEnv, "associated_five_seats_001");
  expect(first).toMatchObject({ data: { status: "BATCH_CONFIRMED", entity_type: "SEAT_PLAN_CURRENT",
    row_ids: [
      `${practiceId}:1:LEFT`, `${practiceId}:2:LEFT`,
      `${practiceId}:1:RIGHT`, `${practiceId}:2:RIGHT` ] } });
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")).toHaveLength(4);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_associated_cursors")
      .one().count).toBe(0);
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='SEAT_PLAN_DRAFT'")
      .one().count).toBe(0);
  });
  expect(await next(testEnv, "associated_five_seats_002")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SEAT_PLAN_CURRENT",
    row_ids: [`${practiceId}:3:RIGHT`] } });
  expect(await next(testEnv, "associated_five_seats_003")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SEAT_PLAN_DRAFT" } });
  expect(await next(testEnv, "associated_five_seats_004")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", seat_plan_version: 1 } });
  expect(mirror.patchSizes).toEqual([4, 1, 1]);
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")).toHaveLength(5);
});

it("stops a first-seat retry when an unowned Google seat appears beside its written row", async () => {
  const testEnv = environment("first-seat-extra-row");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, draftOnlyEvent(), "SEATING_CHANGED");
  mirror.partialFirstSeatBeforeLoss = true;
  mirror.install();
  expect(await next(testEnv, "associated_extra_seat_001")).toMatchObject({
    error: { code: "BRIDGE_UNAVAILABLE" } });
  const written = mirror.rows.get("SEAT_PLAN_CURRENT")![0];
  mirror.rows.get("SEAT_PLAN_CURRENT")!.push([...written.slice(0, 2), "3", "LEFT", "",
    written[5], written[6], written[7]]);
  expect(await next(testEnv, "associated_extra_seat_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SEAT_PLAN_CURRENT",
    row_ids: [`${practiceId}:1:LEFT`, `${practiceId}:1:RIGHT`] } });
  expect(mirror.writes).toBe(2);
  expect(await next(testEnv, "associated_extra_seat_state_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SEAT_PLAN_DRAFT" } });
  expect(await next(testEnv, "associated_extra_seat_final_001")).toMatchObject({
    error: { code: "SYNC_ASSOCIATED_NEEDS_REVIEW" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox").one().status).toBe("PENDING");
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_associated_cursors")
      .one().count).toBe(0);
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='SEAT_PLAN_DRAFT'")
      .one().count).toBe(0);
  });
});

it("replays a lost signup reply and advances B/cursor only after all signup rows and linked seating", async () => {
  const testEnv = environment("linked-retry");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv,
    signupEvent(1, [signup(members[0], 1, "CANCELLED"),
      { ...signup(members[1], 2), preference: "LEFT" }], promotedSeating()));
  mirror.loseFirstReply = true;
  mirror.install();
  expect(await next(testEnv, "associated_run_001")).toMatchObject({ error: { code: "BRIDGE_UNAVAILABLE" } });
  const signupRowsWrittenBeforeRetry = mirror.rows.get("SIGNUP")!.length;
  expect(signupRowsWrittenBeforeRetry).toBeGreaterThanOrEqual(1);
  expect(signupRowsWrittenBeforeRetry).toBeLessThanOrEqual(2);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox").one().status).toBe("PENDING");
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_batches").one().status).toBe("FAILED");
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='SIGNUP'")
      .one().count).toBe(0);
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_associated_cursors")
      .one().count).toBe(0);
  });
  expect(await next(testEnv, "associated_run_001")).toMatchObject({ data: {
    status: "BATCH_CONFIRMED", entity_type: "SIGNUP", row_id: `${practiceId}:${members[0]}` } });
  expect(mirror.rows.get("SIGNUP")).toHaveLength(signupRowsWrittenBeforeRetry);
  const remaining = await batchesThrough(testEnv, "associated_run_step", "SEAT_PLAN_DRAFT");
  expect(remaining.map((batch) => batch.entity_type)).toContain("SEAT_PLAN_REVISION");
  expect(remaining.map((batch) => batch.entity_type)).toContain("SEAT_PLAN_CURRENT");
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox").one().status).toBe("PENDING");
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='SIGNUP'")
      .one().count).toBe(0);
  });
  expect(await next(testEnv, "associated_run_final_001")).toMatchObject({ data: {
    status: "EVENT_CONFIRMED", signup_version: 1, seat_plan_version: 1, published_revision: 1 } });
  expect(mirror.rows.get("SIGNUP")).toHaveLength(2);
  expect(mirror.rows.get("SEAT_PLAN_CURRENT")).toHaveLength(2);
  expect(mirror.rows.get("SEAT_PLAN_REVISION")).toHaveLength(1);
  expect(mirror.rows.get("SEAT_PLAN_DRAFT")).toHaveLength(1);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox").one().status).toBe("CONFIRMED");
    expect(sql.exec<{ signup_version: number; seat_plan_version: number; published_revision: number }>(
      "SELECT signup_version,seat_plan_version,published_revision FROM sync_associated_cursors").one())
      .toEqual({ signup_version: 1, seat_plan_version: 1, published_revision: 1 });
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='SIGNUP'")
      .one().count).toBe(6);
  });
  expect(await next(testEnv, "associated_run_idle_001")).toMatchObject({ data: { status: "IDLE" } });
});

it("bounded poll drains a small associated event through its final confirmation", async () => {
  const testEnv = { ...environment("bounded-poll"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1, "CANCELLED"),
    { ...signup(members[1], 2), preference: "LEFT" }], promotedSeating()));
  mirror.install();
  const response = await call(testEnv, "/internal/c2/poll-due-exports",
    { request_id: "associated_poll_drain_001" });
  const poll = await response.json() as any;
  expect(response.status, JSON.stringify(poll)).toBe(200);
  expect(poll.data.results).toEqual([{ season_id: seasonId, status: "EVENT_CONFIRMED" }]);
  expect(mirror.patchSizes).toEqual([2, 2, 1, 1]);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox").one().status).toBe("CONFIRMED");
    expect(sql.exec<{ signup_version: number; seat_plan_version: number; published_revision: number }>(
      "SELECT signup_version,seat_plan_version,published_revision FROM sync_associated_cursors").one())
      .toEqual({ signup_version: 1, seat_plan_version: 1, published_revision: 1 });
  });
});

it("blocks an old snapshot and a skipped signup version before reaching Google", async () => {
  const oldEnv = environment("old-snapshot");
  const oldStub = await seed(oldEnv, { action: "cancelSignup", entity: {
    season_id: seasonId, practice_id: practiceId, practice_version: 1,
    signup_version: 1, signup_rows: [signup(members[0], 1)] } });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  expect(await next(oldEnv, "associated_old_001")).toMatchObject({ error: { code: "SYNC_OUTBOX_INVALID" } });
  expect(fetchSpy).not.toHaveBeenCalled();
  await runInDurableObject(oldStub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_batches")
      .one().count).toBe(0);
  });
  vi.restoreAllMocks();
  const gapEnv = environment("version-gap");
  await seed(gapEnv, signupEvent(2, [signup(members[0], 1)]));
  const gapFetch = vi.spyOn(globalThis, "fetch");
  expect(await next(gapEnv, "associated_gap_001")).toMatchObject({
    error: { code: "SYNC_ASSOCIATED_VERSION_GAP" } });
  expect(gapFetch).not.toHaveBeenCalled();
});

it("refuses to overwrite a Google signup row with no confirmed B baseline", async () => {
  const testEnv = environment("unowned-google-row");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  mirror.rows.get("SIGNUP")!.push(cells("SIGNUP", signup(members[0], 1)));
  mirror.install();
  expect(await next(testEnv, "associated_unowned_001")).toMatchObject({
    error: { code: "SYNC_BASELINE_INCOMPLETE" } });
  expect(mirror.writes).toBe(0);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_batches")
      .one().count).toBe(0);
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox").one().status).toBe("PENDING");
  });
});

it("does not export a captured signup whose local identity has disappeared", async () => {
  const testEnv = environment("local-identity-gone");
  const stub = await seed(testEnv, signupEvent(1, [signup(members[0], 1)]));
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("DELETE FROM signups WHERE season_id=? AND practice_id=? AND member_id=?",
      seasonId, practiceId, members[0]).toArray();
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  expect(await next(testEnv, "associated_missing_identity_001")).toMatchObject({
    error: { code: "SYNC_ASSOCIATED_STALE" } });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("keeps an already verified signup unconfirmed if Google changes it before linked seating completes", async () => {
  const testEnv = environment("manual-edit");
  const mirror = new SheetMirror();
  const stub = await seed(testEnv,
    signupEvent(1, [signup(members[0], 1)], linkedSeating()));
  mirror.install();
  const scopes = await batchesThrough(testEnv, "associated_manual_step", "SEAT_PLAN_DRAFT");
  expect(scopes.map((batch) => batch.entity_type)).toContain("SEAT_PLAN_CURRENT");
  expect(scopes.map((batch) => batch.entity_type)).toContain("SEAT_PLAN_REVISION");
  const statusIndex = SHEET_SCOPES.SIGNUP.headers.indexOf("status");
  mirror.rows.get("SIGNUP")![0][statusIndex] = "WAITLISTED";
  expect(await next(testEnv, "associated_manual_final_001")).toMatchObject({
    error: { code: "SYNC_ASSOCIATED_NEEDS_REVIEW" } });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    expect(sql.exec<{ status: string }>("SELECT status FROM sync_outbox").one().status).toBe("PENDING");
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_associated_cursors")
      .one().count).toBe(0);
    expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sync_baselines WHERE entity_type='SIGNUP'")
      .one().count).toBe(0);
  });
  mirror.rows.get("SIGNUP")![0][statusIndex] = "CONFIRMED";
  await rearm(testEnv);
  expect(await next(testEnv, "associated_manual_final_002")).toMatchObject({
    data: { status: "EVENT_CONFIRMED" } });
});
