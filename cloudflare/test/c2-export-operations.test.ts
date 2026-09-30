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

it("halts a permanent unsupported event until a Coach explicitly retries it", async () => {
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
    status: "ACTION_REQUIRED", error_code: "SYNC_OUTBOX_BLOCKED" }]);
  const overview = await post(environment, "/internal/c2/get-sync-overview", {
    request_id: "ops_retry_overview_001", session_token: token, season_id: seasonId
  });
  expect(overview.body.data.counts.pending_outbox).toBe(1);
  expect(overview.body.data.export_control.retry.failure_count).toBe(8);
  expect(overview.body.data.export_control.retry.action_required).toBe(true);
  expect(overview.body.data.export_control.status).toBe("ACTION_REQUIRED");
  expect(overview.body.data.export_control.retry.next_attempt_at).toBeNull();
  expect(overview.body.data.export_control.integrity_hints).toContain("EXPORT_ACTION_REQUIRED");
  expect(overview.body.data.export_control.integrity_hints).not.toContain("EXPORT_RETRYING");
  const premature = await post(environment, "/internal/c2/poll-due-exports", {
    request_id: "ops_export_poll_002"
  });
  expect(premature.body.data.polled).toBe(0);
  expect((await post(environment, "/internal/c2/set-export-pause", {
    request_id: "ops_halted_pause_001", session_token: token, season_id: seasonId, paused: true
  })).body.data.result.status).toBe("PAUSED");
  const resumedButHalted = await post(environment, "/internal/c2/set-export-pause", {
    request_id: "ops_halted_resume_001", session_token: token, season_id: seasonId, paused: false
  });
  expect(resumedButHalted.body.data.result).toMatchObject({ status: "ACTION_REQUIRED",
    next_batch_requires_fresh_comparison: true });
  expect((await post(environment, "/internal/c2/get-sync-overview", {
    request_id: "ops_halted_overview_002", session_token: token, season_id: seasonId
  })).body.data.export_control.status).toBe("ACTION_REQUIRED");
  const unauthorized = await post(environment, "/internal/c2/retry-export", {
    request_id: "ops_retry_denied_001", session_token: "x".repeat(40), season_id: seasonId
  });
  expect(unauthorized.status).toBe(401);
  const retry = await post(environment, "/internal/c2/retry-export", {
    request_id: "ops_retry_manual_001", session_token: token, season_id: seasonId
  });
  expect(retry.status).toBe(200);
  expect(retry.body.data.result).toMatchObject({ rearmed: true,
    previous_error: "SYNC_OUTBOX_BLOCKED", unfinished_batch_id: null,
    next_batch_requires_fresh_comparison: true });
  expect((await post(environment, "/internal/c2/retry-export", {
    request_id: "ops_retry_manual_001", session_token: token, season_id: seasonId
  })).body.data).toEqual(retry.body.data);
  const retryAgain = await post(environment, "/internal/c2/poll-due-exports", {
    request_id: "ops_export_poll_manual_001"
  });
  expect(retryAgain.body.data.results).toEqual([{ season_id: seasonId,
    status: "ACTION_REQUIRED", error_code: "SYNC_OUTBOX_BLOCKED" }]);
  expect((await post(environment, "/internal/c2/poll-due-exports", {
    request_id: "ops_export_poll_manual_002"
  })).body.data.polled).toBe(0);
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
    status: "ACTION_REQUIRED", error_code: "SYNC_OUTBOX_BLOCKED" });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ binding_version: number; failure_count: number; action_required: number }>(
      "SELECT binding_version,failure_count,action_required FROM sync_export_retries WHERE season_id=?", seasonId).one())
      .toMatchObject({ binding_version: 2, failure_count: 1, action_required: 1 });
  });
});

it("re-arms an existing failed batch without promising a fresh target comparison", async () => {
  const environment = testEnv("batch-rearm");
  const token = await setup(environment);
  const stub = environment.TEAM_STATE.getByName(environment.TEAM_ID);
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    context.storage.sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,
      direction,status,payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
      VALUES ('batch_ops_failed',?,1,0,'CLOUDFLARE_TO_GOOGLE','FAILED',
      'sha256_v1:ops_digest','out_ops_001','out_ops_001',?,?)`, seasonId, at, at).toArray();
    context.storage.sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,
      failure_count,next_attempt_at_ms,last_error,updated_at,action_required)
      VALUES (?,1,1,0,'SHEET_PATCH_CONFLICT',?,1)`, seasonId, at).toArray();
  });
  const halted = await post(environment, "/internal/c2/set-export-pause", {
    request_id: "ops_batch_halted_001", session_token: token, season_id: seasonId, paused: false
  });
  expect(halted.body.data.result).toMatchObject({ status: "ACTION_REQUIRED",
    unfinished_batch_id: "batch_ops_failed", next_batch_requires_fresh_comparison: false });
  const result = await post(environment, "/internal/c2/retry-export", {
    request_id: "ops_batch_rearm_001", session_token: token, season_id: seasonId
  });
  expect(result.status).toBe(200);
  expect(result.body.data.result).toMatchObject({ rearmed: true,
    unfinished_batch_id: "batch_ops_failed", next_batch_requires_fresh_comparison: false });
  const resume = await post(environment, "/internal/c2/set-export-pause", {
    request_id: "ops_batch_resume_001", session_token: token, season_id: seasonId, paused: false
  });
  expect(resume.body.data.result).toMatchObject({ status: "RUNNING",
    unfinished_batch_id: "batch_ops_failed", next_batch_requires_fresh_comparison: false });
  await runInDurableObject(stub, async (_instance: TeamState, context) => {
    expect(context.storage.sql.exec<{ status: string }>(
      "SELECT status FROM sync_batches WHERE batch_id='batch_ops_failed'").one().status).toBe("FAILED");
  });
});

it("upgrades a populated v10 database through v12 without changing its binding or outbox", async () => {
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

it("adds the action-required flag to existing v11 retry state without losing its history", async () => {
  const environment = testEnv("upgrade-retry");
  await setup(environment);
  await runInDurableObject(environment.TEAM_STATE.getByName(environment.TEAM_ID),
    async (_instance: TeamState, context) => {
      const sql = context.storage.sql;
      sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,failure_count,
        next_attempt_at_ms,last_error,updated_at)
        VALUES (?,1,7,123456789,'SERVICE_BUSY',?)`, seasonId, at).toArray();
      sql.exec(`CREATE TABLE sync_export_retries_v11 (
        season_id TEXT PRIMARY KEY,
        binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at_ms >= 0),
        last_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
        FOREIGN KEY (season_id) REFERENCES sync_bindings(season_id)
      )`).toArray();
      sql.exec(`INSERT INTO sync_export_retries_v11
        SELECT season_id,binding_version,failure_count,next_attempt_at_ms,last_error,updated_at
        FROM sync_export_retries`).toArray();
      sql.exec("DROP TABLE sync_export_retries").toArray();
      sql.exec("ALTER TABLE sync_export_retries_v11 RENAME TO sync_export_retries").toArray();
      sql.exec("UPDATE app_meta SET value='11' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(sql.exec<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='schema_version'").one().value)
        .toBe(String(APPLICATION_SCHEMA_VERSION));
      expect(sql.exec<{
        binding_version: number; failure_count: number; next_attempt_at_ms: number;
        last_error: string; action_required: number;
      }>("SELECT * FROM sync_export_retries WHERE season_id=?", seasonId).one())
        .toMatchObject({ binding_version: 1, failure_count: 7,
          next_attempt_at_ms: 123456789, last_error: "SERVICE_BUSY", action_required: 0 });
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
});

it("captures paused and action-required export controls in a verified private backup", async () => {
  const environment = testEnv("backup-controls");
  const token = await setup(environment);
  expect((await post(environment, "/internal/c2/set-export-pause", {
    request_id: "ops_backup_pause_001", session_token: token,
    season_id: seasonId, paused: true
  })).status).toBe(200);
  await runInDurableObject(environment.TEAM_STATE.getByName(environment.TEAM_ID),
    async (_instance: TeamState, context) => {
      context.storage.sql.exec(`INSERT INTO sync_export_retries(season_id,binding_version,
        failure_count,next_attempt_at_ms,last_error,updated_at,action_required)
        VALUES (?,1,3,0,'SYNC_REFERENCE_NEEDS_REVIEW',?,1)`, seasonId, at).toArray();
    });
  const created = await post(environment, "/internal/c1/create-backup-snapshot", {
    request_id: "ops_backup_create_001", session_token: token
  }, true);
  expect(created.status).toBe(200);
  const manifest = created.body.data.result.manifest;
  expect(manifest.schema_version).toBe(APPLICATION_SCHEMA_VERSION);
  const tables = Object.fromEntries(manifest.tables.map((table: any) => [table.name, table]));
  for (const table of ["sync_export_controls", "sync_export_retries"])
    expect(tables[table]).toMatchObject({ row_count: 1 });
  for (const table of ["sync_export_controls", "sync_export_retries"]) {
    const chunk = await post(environment, "/internal/c1/get-backup-chunk", {
      request_id: `ops_backup_chunk_${table}`, session_token: token,
      snapshot_id: created.body.data.result.snapshot_id,
      chunk_index: tables[table].chunk_indices[0]
    }, true);
    expect(chunk.status).toBe(200);
    expect(chunk.body.data.chunk.payload).toMatchObject({ table, rows: [{ season_id: seasonId }] });
    if (table === "sync_export_controls")
      expect(chunk.body.data.chunk.payload.rows[0].pause_requested).toBe(1);
    else expect(chunk.body.data.chunk.payload.rows[0]).toMatchObject({
      failure_count: 3, last_error: "SYNC_REFERENCE_NEEDS_REVIEW", action_required: 1 });
  }
  const verified = await post(environment, "/internal/c1/verify-backup-snapshot", {
    request_id: "ops_backup_verify_001", session_token: token,
    snapshot_id: created.body.data.result.snapshot_id,
    content_digest: manifest.content_digest
  }, true);
  expect(verified.body.data.verified).toBe(true);
});
