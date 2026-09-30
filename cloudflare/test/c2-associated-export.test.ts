import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { legacyCredentialDigest } from "../src/crypto";
import { TeamState } from "../src/team-state";
import { SHEET_SCOPES, type SheetScope } from "../src/c2-sheet-bridge";
import { SYNC_FIELD_DEFINITIONS, normalizeSyncValue } from "../../shared/c2-sync-rules";
import worker from "../src/index";

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
  start_at: "2026-10-07T22:00:00.000Z", end_at: "2026-10-08T00:00:00.000Z",
  timezone: "America/New_York", location: "River", address: "Dock 1", map_url: "",
  left_capacity: 1, right_capacity: 1, signup_cutoff_at: "2026-10-07T20:00:00.000Z",
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
async function seed(testEnv: Env, payload: Record<string, unknown>, topic = "SIGNUPS_CHANGED",
    leftCapacity = 1, rightCapacity = 1) {
  const coach = { coach_id: coachId, display_name: "Associated Coach",
    code_salt: "associated_salt_001", code_digest: await legacyCredentialDigest(
      "associated_salt_001", "local-test-coach-code", "local-c1-coach-secret"),
    credential_version: 1, active: true, created_at: at, updated_at: at };
  expect((await call(testEnv, "/internal/c1/import-core", {
    request_id: "associated_core_import_001", source_snapshot_id: "associated_core_snapshot_001",
    settings_version: 1, default_season_id: seasonId, coaches: [coach],
    seasons: [{ season_id: seasonId, name: "Associated Season", start_date: "2026-04-01",
      end_date: "2026-12-31", timezone: "America/New_York",
      season_ends_at: "2027-01-01T05:00:00.000Z", status: "OPEN",
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
      seasonId, practice.week_id, "2026-10-05", at, "OPENED", 1, 1, coachId, at,
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
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: receipt });
    });
  }
}

afterEach(() => vi.restoreAllMocks());

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
  expect(await next(testEnv, "associated_manual_final_002")).toMatchObject({
    data: { status: "EVENT_CONFIRMED" } });
});
