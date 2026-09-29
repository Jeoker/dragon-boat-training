import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { legacyCredentialDigest } from "../src/crypto";
import { TeamState } from "../src/team-state";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const seasonId = "season_export_ops_2026";
const coachId = "coach_export_ops_01";
const at = "2026-09-01T12:00:00.000Z";
const c1Headers = { authorization: "Bearer local-c1-test-key", "content-type": "application/json" };
const c2Headers = { authorization: "Bearer local-c2-test-key", "content-type": "application/json" };
const testEnv = (name: string) => ({ ...env, TEAM_ID: `export-ops-${name}`,
  C2_MEMBER_EXPORT_ENABLED: "true" } as unknown as Env);

async function post(environment: Env, path: string, body: Record<string, unknown>, c1 = false) {
  const response = await worker.fetch(new IncomingRequest(`https://example.test${path}`, {
    method: "POST", headers: c1 ? c1Headers : c2Headers, body: JSON.stringify(body)
  }), environment);
  return { status: response.status, body: await response.json() as any };
}

async function setup(environment: Env): Promise<string> {
  const coach = { coach_id: coachId, display_name: "Export Coach", code_salt: "ops_salt_001",
    code_digest: await legacyCredentialDigest("ops_salt_001", "local-test-coach-code",
      "local-c1-coach-secret"), credential_version: 1, active: true,
    created_at: at, updated_at: at };
  expect((await post(environment, "/internal/c1/import-core", {
    request_id: "ops_core_import_001", source_snapshot_id: "ops_core_snapshot_001",
    settings_version: 1, default_season_id: seasonId, coaches: [coach],
    seasons: [{ season_id: seasonId, name: "Export Ops", start_date: "2026-04-01",
      end_date: "2026-12-31", timezone: "America/New_York",
      season_ends_at: "2027-01-01T05:00:00.000Z", status: "OPEN",
      binding_version: 1, season_version: 1, roster_version: 0,
      created_by: coachId, created_at: at, updated_at: at }], members: []
  }, true)).status).toBe(200);
  expect((await post(environment, "/internal/c2/import-sync-foundation", {
    request_id: "ops_foundation_001", source_snapshot_id: "ops_foundation_snapshot_001",
    bindings: [{ season_id: seasonId, binding_version: 1, form_id: "form_export_ops_001",
      runtime_spreadsheet_id: "spreadsheet_export_ops_001", response_sheet_id: "0",
      response_sheet_name: "Form Responses 1", field_mapping: { display_name_header: "Name" },
      schema_fingerprint: "sha256_v1:export_ops_schema", export_paused: false,
      last_pull_at: null, last_push_at: null, created_at: at, updated_at: at }],
    baselines: [], source_imports: []
  })).status).toBe(200);
  const login = await post(environment, "/internal/c1/coach-login", {
    request_id: "ops_coach_login_001", coach_code: "local-test-coach-code"
  }, true);
  expect(login.status).toBe(200);
  return login.body.data.result.session_token as string;
}

it("pauses new batches, drains an in-flight batch, and resumes only after confirmation", async () => {
  const environment = testEnv("pause");
  const token = await setup(environment);
  const base = { session_token: token, season_id: seasonId };
  const pause = await post(environment, "/internal/c2/set-export-pause", {
    ...base, request_id: "ops_pause_001", paused: true
  });
  expect(pause.status).toBe(200);
  expect(pause.body.data.result.status).toBe("PAUSED");
  const replay = await post(environment, "/internal/c2/set-export-pause", {
    ...base, request_id: "ops_pause_001", paused: true
  });
  expect(replay.body.data).toEqual(pause.body.data);
  const blocked = await post(environment, "/internal/c2/export-next-member", {
    request_id: "ops_export_blocked_001", season_id: seasonId
  });
  expect(blocked.body.error.code).toBe("SYNC_EXPORT_PAUSED");
  const stub = environment.TEAM_STATE.getByName(environment.TEAM_ID);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,
      direction,status,payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
      VALUES ('batch_ops_inflight',?,1,0,'CLOUDFLARE_TO_GOOGLE','SENT',
      'sha256_v1:ops_digest','out_ops_001','out_ops_001',?,?)`, seasonId, at, at).toArray();
  });
  const overview = await post(environment, "/internal/c2/get-sync-overview", {
    ...base, request_id: "ops_overview_001"
  });
  expect(overview.body.data.export_control.status).toBe("PAUSING");
  expect(overview.body.data.export_control.unfinished_batch.batch_id).toBe("batch_ops_inflight");
  const premature = await post(environment, "/internal/c2/set-export-pause", {
    ...base, request_id: "ops_resume_early_001", paused: false
  });
  expect(premature.body.error.code).toBe("SYNC_EXPORT_DRAINING");
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec("UPDATE sync_batches SET status='CONFIRMED' WHERE batch_id='batch_ops_inflight'").toArray();
  });
  const resume = await post(environment, "/internal/c2/set-export-pause", {
    ...base, request_id: "ops_resume_001", paused: false
  });
  expect(resume.body.data.result).toMatchObject({ status: "RUNNING",
    next_batch_requires_fresh_comparison: true });
  const running = await post(environment, "/internal/c2/get-sync-overview", {
    ...base, request_id: "ops_overview_002"
  });
  expect(running.body.data.export_control.status).toBe("RUNNING");
});

it("pages conflict summaries and protects full B/C/G evidence", async () => {
  const environment = testEnv("conflicts");
  const token = await setup(environment);
  await runInDurableObject(environment.TEAM_STATE.getByName(environment.TEAM_ID),
    async (_instance: TeamState, context) => {
      for (let index = 1; index <= 3; index += 1) {
        context.storage.sql.exec(`INSERT INTO sync_conflicts(conflict_id,season_id,binding_version,
          entity_type,entity_id,dependency_group,baseline_json,cloud_json,google_json,
          cloud_version,google_digest,status,created_at,finding_outcome,reason,fingerprint)
          VALUES (?, ?, 1,'MEMBER',?,'MEMBER_NAME','{}','{"display_name":"Cloud"}',
          '{"display_name":"Google"}',1,'sha256_v1:fixture','OPEN',?,
          'CONFLICT','Name conflict',?)`, `sheet_conflict_0${index}`, seasonId,
          `member_conflict_0${index}`, at, `fingerprint_0${index}`).toArray();
      }
    });
  const base = { session_token: token, season_id: seasonId };
  const first = await post(environment, "/internal/c2/list-sync-conflicts", {
    ...base, request_id: "ops_conflicts_page_001", limit: 2
  });
  expect(first.status).toBe(200);
  expect(first.body.data.items).toHaveLength(2);
  expect(first.body.data.items[0]).not.toHaveProperty("google_json");
  const second = await post(environment, "/internal/c2/list-sync-conflicts", {
    ...base, request_id: "ops_conflicts_page_002", limit: 2,
    cursor: first.body.data.next_cursor
  });
  expect(second.body.data.items).toHaveLength(1);
  expect(second.body.data.next_cursor).toBeNull();
  const detail = await post(environment, "/internal/c2/get-sync-conflict", {
    ...base, request_id: "ops_conflict_detail_001",
    conflict_id: first.body.data.items[0].conflict_id
  });
  expect(detail.body.data).toMatchObject({ baseline: {}, cloudflare: { display_name: "Cloud" },
    google: { display_name: "Google" } });
  expect((await post(environment, "/internal/c2/list-sync-conflicts", {
    request_id: "ops_conflicts_denied_001", session_token: "x".repeat(40),
    season_id: seasonId
  })).status).toBe(401);
});

it("keeps an unsupported outbox event durably queued beyond platform retry limits", async () => {
  const environment = { ...testEnv("retry"), C2_EXPORT_POLL_ENABLED: "true" } as Env;
  const token = await setup(environment);
  const stub = environment.TEAM_STATE.getByName(environment.TEAM_ID);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    const sql = context.storage.sql;
    const key = sql.exec<{ request_key: string }>(
      "SELECT request_key FROM system_requests WHERE action='importSyncFoundation'").one().request_key;
    sql.exec(`INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at)
      VALUES ('out_ops_unsupported',?,'SIGNUPS_CHANGED',?,'PENDING',?,?)`, key,
    JSON.stringify({ action: "changeSignup", entity: { season_id: seasonId } }),
    Date.now() - 1_000, at).toArray();
    sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at)
      VALUES (?,1,7,0,'SYNC_OUTBOX_BLOCKED',?)`, seasonId, at).toArray();
  });
  const poll = await post(environment, "/internal/c2/poll-due-exports", {
    request_id: "ops_export_poll_001"
  });
  expect(poll.status, JSON.stringify(poll.body)).toBe(200);
  expect(poll.body.data.results).toEqual([{ season_id: seasonId,
    status: "RETRY_REQUIRED", error_code: "SYNC_OUTBOX_BLOCKED" }]);
  const overview = await post(environment, "/internal/c2/get-sync-overview", {
    request_id: "ops_retry_overview_001", session_token: token, season_id: seasonId
  });
  expect(overview.body.data.counts.pending_outbox).toBe(1);
  expect(overview.body.data.export_control.retry.failure_count).toBe(8);
  expect(overview.body.data.export_control.retry.next_attempt_at).toBeTruthy();
  const premature = await post(environment, "/internal/c2/poll-due-exports", {
    request_id: "ops_export_poll_002"
  });
  expect(premature.body.data.polled).toBe(0);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_outbox WHERE outbox_id='out_ops_unsupported'").one().status).toBe("PENDING");
    context.storage.sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id=?", seasonId).toArray();
    context.storage.sql.exec("UPDATE sync_bindings SET binding_version=2 WHERE season_id=?", seasonId).toArray();
  });
  const rebound = await post(environment, "/internal/c2/poll-due-exports", {
    request_id: "ops_export_poll_rebound_001"
  });
  expect(rebound.body.data.results[0]).toMatchObject({ season_id: seasonId,
    status: "RETRY_REQUIRED", error_code: "SYNC_OUTBOX_BLOCKED" });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ binding_version: number; failure_count: number }>(
      "SELECT binding_version,failure_count FROM sync_export_retries WHERE season_id=?", seasonId).one())
      .toMatchObject({ binding_version: 2, failure_count: 1 });
  });
});

it("upgrades a populated v10 database to v11 without changing its binding or outbox", async () => {
  const environment = testEnv("upgrade");
  await setup(environment);
  await runInDurableObject(environment.TEAM_STATE.getByName(environment.TEAM_ID),
    async (_instance: TeamState, context) => {
      const sql = context.storage.sql;
      const before = sql.exec("SELECT * FROM sync_bindings WHERE season_id=?", seasonId).one();
      sql.exec("DROP TABLE sync_export_retries").toArray();
      sql.exec("DROP TABLE sync_export_controls").toArray();
      sql.exec("UPDATE app_meta SET value='10' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(sql.exec<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='schema_version'").one().value)
        .toBe(String(APPLICATION_SCHEMA_VERSION));
      expect(sql.exec("SELECT * FROM sync_bindings WHERE season_id=?", seasonId).one()).toEqual(before);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
        ('sync_export_controls','sync_export_retries')`).toArray()).toHaveLength(2);
    });
});
