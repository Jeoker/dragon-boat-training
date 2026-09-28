import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C2_SYNC_ACTIONS, C2_CONTRACT_VERSION } from "../../shared/c2-actions";
import { SYNC_FIELD_DEFINITIONS, compareSyncRecord, formResponseSourceId,
  normalizeSyncValue } from "../../shared/c2-sync-rules";
import { legacyCredentialDigest } from "../src/crypto";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { TeamState } from "../src/team-state";
import { C2SyncService } from "../src/c2-sync-service";
import { SHEET_SCOPES } from "../src/c2-sheet-bridge";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const BASE = "https://example.test";
const C1_HEADERS = { authorization: "Bearer local-c1-test-key", "content-type": "application/json" };
const C2_HEADERS = { authorization: "Bearer local-c2-test-key", "content-type": "application/json" };
const teamEnv = (name: string) => ({ ...env, TEAM_ID: `c2-${name}` } as unknown as Env);

async function call(path: string, payload: Record<string, unknown>, testEnv: Env, generation: "C1" | "C2" = "C2") {
  return worker.fetch(new IncomingRequest(`${BASE}${path}`, {
    method: "POST", headers: generation === "C1" ? C1_HEADERS : C2_HEADERS, body: JSON.stringify(payload)
  }), testEnv);
}

async function json(response: Response): Promise<any> { return response.json(); }

async function coreSnapshot(requestId: string) {
  const at = "2026-09-21T12:00:00.000Z";
  return {
    request_id: requestId, source_snapshot_id: `core_${requestId}`, settings_version: 1,
    default_season_id: "season_c2_open_2026",
    coaches: [{ coach_id: "coach_c2_acceptance", display_name: "C2 Coach", code_salt: "c2_salt_fixture_001",
      code_digest: await legacyCredentialDigest("c2_salt_fixture_001", "local-test-coach-code", "local-c1-coach-secret"),
      credential_version: 1, active: true, created_at: at, updated_at: at }],
    seasons: [{ season_id: "season_c2_open_2026", name: "C2 Open 2026", start_date: "2026-04-01",
      end_date: "2026-08-31", timezone: "America/New_York", season_ends_at: "2026-09-01T04:00:00.000Z",
      status: "OPEN", binding_version: 1, season_version: 2, roster_version: 1,
      created_by: "coach_c2_acceptance", created_at: at, updated_at: at },
    { season_id: "season_c2_other_2026", name: "C2 Other 2026", start_date: "2026-09-01",
      end_date: "2026-09-30", timezone: "America/New_York", season_ends_at: "2026-10-01T04:00:00.000Z",
      status: "DRAFT", binding_version: 1, season_version: 1, roster_version: 0,
      created_by: "coach_c2_acceptance", created_at: at, updated_at: at }],
    members: [
      { season_id: "season_c2_open_2026", member_id: "member_c2_alice_01", source_key: "legacy-tab:2",
        source_display_name: "Alice", display_name_override: "", status: "ACTIVE", default_preference: "LEFT",
        member_version: 1, created_at: at, updated_at: at },
      { season_id: "season_c2_open_2026", member_id: "member_c2_bob_002", source_key: "legacy-tab:3",
        source_display_name: "Bob", display_name_override: "", status: "ACTIVE", default_preference: "RIGHT",
        member_version: 1, created_at: at, updated_at: at }
    ]
  };
}

function foundation(requestId = "c2_foundation_import_001", snapshotId = "c2_foundation_snapshot_001") {
  const at = "2026-09-21T13:00:00.000Z";
  const seasonId = "season_c2_open_2026";
  const formId = "form_c2_fixture_001";
  return {
    request_id: requestId, source_snapshot_id: snapshotId,
    bindings: [{ season_id: seasonId, binding_version: 1, form_id: formId,
      runtime_spreadsheet_id: "spreadsheet_c2_fixture_001", response_sheet_id: "0",
      response_sheet_name: "Form Responses 1", field_mapping: { display_name_header: "Name" },
      schema_fingerprint: "sha256_v1:c2-schema_fixture_001", export_paused: false,
      last_pull_at: null as string | null, last_push_at: null as string | null,
      created_at: at, updated_at: at }],
    baselines: [{ season_id: seasonId, binding_version: 1, entity_type: "MEMBER",
      entity_id: "member_c2_alice_01", dependency_group: "MEMBER_NAME",
      baseline: { display_name_override: "" }, cloud_version: 1,
      sheet_digest: "sha256_v1:c2_sheet_fixture_001", updated_at: at }],
    source_imports: [
      { stable_source_id: formResponseSourceId(seasonId, formId, "response_c2_0001"), season_id: seasonId,
        binding_version: 1, source_type: "FORM_RESPONSE", source_external_id: "response_c2_0001",
        source_digest: "sha256_v1:c2_response_fixture_001", source_version: 1,
        member_id: "member_c2_alice_01", status: "IMPORTED", imported_at: at, updated_at: at },
      { stable_source_id: `LEGACY_ROW:${seasonId}:0:3`, season_id: seasonId,
        binding_version: 1, source_type: "LEGACY_ROW", source_external_id: "0:3",
        source_digest: "sha256_v1:c2_legacy_fixture_001", source_version: 1,
        member_id: null, status: "REVIEW_REQUIRED", imported_at: null, updated_at: at }
    ]
  };
}

async function seed(testEnv: Env, suffix: string) {
  expect((await call("/internal/c1/import-core", await coreSnapshot(`core_import_${suffix}`), testEnv, "C1")).status).toBe(200);
}

describe("C2.1 sync foundation", () => {
  it("compares independent fields while blocking dependency-group conflicts and unsafe Sheet changes", () => {
    const baseline = { season_id: "season_01", member_id: "member_01", source_key: "source_01",
      source_display_name: "Alice", display_name_override: "", default_preference: "LEFT",
      status: "ACTIVE", member_version: 1 };
    const independent = compareSyncRecord({ entity_type: "MEMBER", baseline,
      cloudflare: { ...baseline, display_name_override: "A. Smith", member_version: 2 },
      google: { ...baseline, default_preference: "right" } });
    expect(independent.outcome).toBe("READY");
    expect(independent.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ dependency_group: "MEMBER_NAME", outcome: "EXPORT" }),
      expect.objectContaining({ dependency_group: "MEMBER_DEFAULT_PREFERENCE", outcome: "IMPORT" }),
      expect.objectContaining({ dependency_group: "SYSTEM_VERSION", outcome: "EXPORT" })
    ]));

    const signup = { season_id: "season_01", practice_id: "practice_01", member_id: "member_01",
      preference: "LEFT", status: "CONFIRMED", queue_at: "2026-05-01T12:00:00.000Z",
      queue_sequence: 1, signup_version: 1 };
    const conflict = compareSyncRecord({ entity_type: "SIGNUP", baseline: signup,
      cloudflare: { ...signup, preference: "RIGHT", signup_version: 2 },
      google: { ...signup, status: "WAITLISTED" } });
    expect(conflict.outcome).toBe("NEEDS_ATTENTION");
    expect(conflict.groups).toContainEqual(expect.objectContaining({ dependency_group: "SIGNUP_STATE", outcome: "CONFLICT" }));

    const preferenceOnly = compareSyncRecord({ entity_type: "SIGNUP", baseline: signup,
      cloudflare: signup, google: { ...signup, preference: "RIGHT" } });
    expect(preferenceOnly.groups).toContainEqual(expect.objectContaining({
      dependency_group: "SIGNUP_STATE", outcome: "IMPORT_WITH_VALIDATION" }));
    const statusOnly = compareSyncRecord({ entity_type: "SIGNUP", baseline: signup,
      cloudflare: signup, google: { ...signup, status: "CANCELLED" } });
    expect(statusOnly.groups).toContainEqual(expect.objectContaining({
      dependency_group: "SIGNUP_STATE", outcome: "REVIEW_REQUIRED" }));

    const protectedQueue = compareSyncRecord({ entity_type: "SIGNUP", baseline: signup,
      cloudflare: signup, google: { ...signup, queue_sequence: 2 } });
    expect(protectedQueue.groups).toContainEqual(expect.objectContaining({ dependency_group: "SIGNUP_QUEUE", outcome: "REJECTED" }));
    const deleted = compareSyncRecord({ entity_type: "MEMBER", baseline, cloudflare: baseline, google: null });
    expect(deleted).toMatchObject({ outcome: "NEEDS_ATTENTION",
      groups: [{ dependency_group: "ROW_IDENTITY", outcome: "REVIEW_REQUIRED" }] });
  });

  it("normalizes converged values and refuses changed unmapped fields", () => {
    const baseline = { season_id: "season_01", member_id: "member_01", source_key: "source_01",
      source_display_name: "Alice", display_name_override: "", default_preference: "LEFT",
      status: "ACTIVE", member_version: 1 };
    const converged = compareSyncRecord({ entity_type: "MEMBER", baseline,
      cloudflare: { ...baseline, default_preference: "RIGHT" },
      google: { ...baseline, default_preference: " right " } });
    expect(converged.groups).toContainEqual(expect.objectContaining({
      dependency_group: "MEMBER_DEFAULT_PREFERENCE", outcome: "ADVANCE_BASELINE" }));
    const unmapped = compareSyncRecord({ entity_type: "MEMBER", baseline, cloudflare: baseline,
      google: { ...baseline, unknown_admin_column: "changed" } });
    expect(unmapped.groups).toContainEqual(expect.objectContaining({
      dependency_group: "UNMAPPED_FIELDS", outcome: "REVIEW_REQUIRED", fields: ["unknown_admin_column"] }));
    const cloudUnmapped = compareSyncRecord({ entity_type: "MEMBER", baseline,
      cloudflare: { ...baseline, unknown_server_field: "changed" }, google: baseline });
    expect(cloudUnmapped.groups).toContainEqual(expect.objectContaining({
      dependency_group: "UNMAPPED_FIELDS", outcome: "REVIEW_REQUIRED", fields: ["unknown_server_field"] }));
    expect(() => normalizeSyncValue("2026-02-30", "DATE")).toThrow("real ISO date");
    expect(() => normalizeSyncValue("2026-02-30T12:00:00-05:00", "INSTANT")).toThrow("real ISO instant");
    expect(() => normalizeSyncValue("2026-02-28", "INSTANT")).toThrow("time zone");
    expect(() => normalizeSyncValue("9007199254740993", "INTEGER")).toThrow("non-negative integer");
    expect(() => normalizeSyncValue("null", "JSON")).toThrow("JSON object or array");
    expect(() => normalizeSyncValue('"name"', "JSON")).toThrow("JSON object or array");
    const invalidStatus = compareSyncRecord({ entity_type: "MEMBER", baseline,
      cloudflare: baseline, google: { ...baseline, status: "SUSPENDED" } });
    expect(invalidStatus.groups).toContainEqual(expect.objectContaining({
      dependency_group: "MEMBER_STATUS", outcome: "REVIEW_REQUIRED" }));
    expect(() => formResponseSourceId("short", "form_fixture_001", "response_fixture_001"))
      .toThrow("season_id is not a stable identifier");
  });

  it("upgrades schema v6 in place and creates the complete sync foundation", async () => {
    const testEnv = teamEnv("schema-upgrade");
    await seed(testEnv, "schema_001");
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      for (const table of ["sync_batch_items", "sync_batches", "sync_conflicts", "source_imports",
        "sync_baselines", "sync_migration_snapshots", "sync_bindings"]) {
        context.storage.sql.exec(`DROP TABLE ${table}`).toArray();
      }
      context.storage.sql.exec("UPDATE app_meta SET value='6' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(context.storage.sql.exec<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe(String(APPLICATION_SCHEMA_VERSION));
      expect(context.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM members").one().count).toBe(2);
      for (const table of ["sync_bindings", "sync_baselines", "source_imports", "sync_conflicts",
        "sync_batches", "sync_batch_items", "sync_migration_snapshots"]) {
        expect(context.storage.sql.exec(`SELECT * FROM ${table}`).toArray(), table).toEqual([]);
      }
    });
  });

  it("keeps C2 routes isolated behind their own key and hidden in production", async () => {
    const request = new IncomingRequest(`${BASE}/internal/c2/import-sync-foundation`, {
      method: "POST", headers: C1_HEADERS, body: JSON.stringify(foundation())
    });
    const denied = await worker.fetch(request, env);
    expect(denied.status).toBe(403);
    expect(await json(denied)).toMatchObject({ error: { code: "C2_ACCESS_DENIED" },
      meta: { contract_version: C2_CONTRACT_VERSION } });
    for (const path of Object.keys(C2_SYNC_ACTIONS)) {
      const hidden = await call(path, { request_id: "hidden_c2_route_001" },
        { ...env, ENVIRONMENT: "production" } as Env);
      expect(hidden.status, path).toBe(404);
    }
  });

  it("imports binding, baseline and stable source identities idempotently without creating outbox", async () => {
    const testEnv = teamEnv("foundation-import");
    await seed(testEnv, "foundation_001");
    const input = foundation();
    const first = await call("/internal/c2/import-sync-foundation", input, testEnv);
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ ok: true, data: { result: {
      bindings: 1, baselines: 1, source_imports: 2 } }, meta: { contract_version: C2_CONTRACT_VERSION } });
    expect((await call("/internal/c2/import-sync-foundation", input, testEnv)).status).toBe(200);
    const newRequest = structuredClone(input);
    newRequest.request_id = "c2_foundation_replay_002";
    expect((await call("/internal/c2/import-sync-foundation", newRequest, testEnv)).status).toBe(200);

    const login = await call("/internal/c1/coach-login", {
      request_id: "c2_overview_login_001", coach_code: "local-test-coach-code"
    }, testEnv, "C1");
    const token = (await json(login)).data.result.session_token;
    const overview = await call("/internal/c2/get-sync-overview", {
      request_id: "c2_overview_read_001", session_token: token, season_id: "season_c2_open_2026"
    }, testEnv);
    expect(overview.status).toBe(200);
    expect(await json(overview)).toMatchObject({ data: { schema_version: APPLICATION_SCHEMA_VERSION,
      binding: { binding_version: 1, export_paused: false },
      counts: { baselines: 1, imported_sources: 1, sources_needing_review: 1,
        open_conflicts: 0, pending_batches: 0, pending_outbox: 0 } } });
  });

  it("keeps stable Form and legacy source identities across a binding version change", async () => {
    const testEnv = teamEnv("binding-upgrade-sources");
    await seed(testEnv, "binding_upgrade_001");
    const first = foundation("c2_binding_upgrade_001", "c2_binding_snapshot_001");
    expect((await call("/internal/c2/import-sync-foundation", first, testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id='season_c2_open_2026'").toArray();
    });
    const login = await call("/internal/c1/coach-login", {
      request_id: "c2_binding_upgrade_login", coach_code: "local-test-coach-code"
    }, testEnv, "C1");
    const token = (await json(login)).data.result.session_token;
    const staleOverview = await call("/internal/c2/get-sync-overview", {
      request_id: "c2_binding_upgrade_stale_overview", session_token: token,
      season_id: "season_c2_open_2026"
    }, testEnv);
    expect(await json(staleOverview)).toMatchObject({ data: { binding_current: false,
      counts: { baselines: 0, imported_sources: 1, sources_needing_review: 1 } } });
    const upgraded = foundation("c2_binding_upgrade_002", "c2_binding_snapshot_002");
    upgraded.bindings[0].binding_version = 2;
    upgraded.bindings[0].field_mapping.display_name_header = "Full Name";
    upgraded.bindings[0].schema_fingerprint = "sha256_v1:c2_schema_fixture_002";
    upgraded.bindings[0].updated_at = "2026-09-22T13:00:00.000Z";
    upgraded.baselines = [];
    upgraded.source_imports = [structuredClone(first.source_imports[0])];
    upgraded.source_imports[0].binding_version = 2;
    expect((await call("/internal/c2/import-sync-foundation", upgraded, testEnv)).status).toBe(200);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const sources = context.storage.sql.exec<{ binding_version: number; stable_source_id: string }>(
        "SELECT binding_version, stable_source_id FROM source_imports ORDER BY stable_source_id").toArray();
      expect(sources).toHaveLength(2);
      expect(sources.find((row) => row.stable_source_id === first.source_imports[0].stable_source_id)
        ?.binding_version).toBe(2);
    });
    const overview = await call("/internal/c2/get-sync-overview", {
      request_id: "c2_binding_upgrade_overview", session_token: token,
      season_id: "season_c2_open_2026"
    }, testEnv);
    expect(await json(overview)).toMatchObject({ data: { binding: { binding_version: 2 }, binding_current: true,
      counts: { baselines: 0, imported_sources: 1, sources_needing_review: 1 } } });
    const stale = foundation("c2_binding_upgrade_003", "c2_binding_snapshot_003");
    stale.bindings = [];
    stale.baselines = [];
    stale.source_imports = [structuredClone(first.source_imports[0])];
    expect(await json(await call("/internal/c2/import-sync-foundation", stale, testEnv)))
      .toMatchObject({ error: { code: "SYNC_BINDING_NOT_FOUND" } });
  });

  it("blocks both binding import paths while a prior export is unfinished", async () => {
    const testEnv = teamEnv("unfinished-binding-export");
    await seed(testEnv, "unfinished_binding_export");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "foundation_unfinished_001", "snapshot_unfinished_001"), testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,
        direction,status,payload_digest,created_at,updated_at)
        VALUES ('batch_unfinished_rebind_001','season_c2_open_2026',1,0,
          'CLOUDFLARE_TO_GOOGLE','PARTIAL','old_digest',?,?)`,
      "2026-09-21T13:30:00.000Z", "2026-09-21T13:30:00.000Z").toArray();
    });
    const core = await coreSnapshot("core_rebind_blocked_001");
    core.seasons[0].binding_version = 2;
    core.seasons[0].season_version = 3;
    expect(await json(await call("/internal/c1/import-core", core, testEnv, "C1")))
      .toMatchObject({ error: { code: "IMPORT_CONFLICT" } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ binding_version: number }>(
        "SELECT binding_version FROM seasons WHERE season_id='season_c2_open_2026'").one().binding_version)
        .toBe(1);
      // Simulate an already advanced core snapshot to check the second import boundary independently.
      context.storage.sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id='season_c2_open_2026'").toArray();
    });
    const next = foundation("foundation_rebind_blocked_002", "snapshot_rebind_blocked_002");
    next.bindings[0].binding_version = 2;
    next.bindings[0].updated_at = "2026-09-22T13:00:00.000Z";
    next.baselines = [];
    next.source_imports = [];
    expect(await json(await call("/internal/c2/import-sync-foundation", next, testEnv)))
      .toMatchObject({ error: { code: "IMPORT_CONFLICT" } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ binding_version: number }>(
        "SELECT binding_version FROM sync_bindings WHERE season_id='season_c2_open_2026'").one().binding_version)
        .toBe(1);
      context.storage.sql.exec(
        "UPDATE sync_batches SET status='CONFIRMED' WHERE batch_id='batch_unfinished_rebind_001'").toArray();
      context.storage.sql.exec("UPDATE seasons SET binding_version=1 WHERE season_id='season_c2_open_2026'").toArray();
    });
    expect((await call("/internal/c1/import-core", core, testEnv, "C1")).status).toBe(200);
    expect((await call("/internal/c2/import-sync-foundation", next, testEnv)).status).toBe(200);
  });

  it("updates same-version operational binding metadata without changing its mapping", async () => {
    const testEnv = teamEnv("binding-metadata");
    await seed(testEnv, "binding_metadata_001");
    const original = foundation("c2_metadata_001", "c2_metadata_snapshot_001");
    expect((await call("/internal/c2/import-sync-foundation", original, testEnv)).status).toBe(200);
    const refreshed = foundation("c2_metadata_002", "c2_metadata_snapshot_002");
    refreshed.baselines = [];
    refreshed.source_imports = [];
    refreshed.bindings[0].response_sheet_name = "Renamed responses";
    refreshed.bindings[0].export_paused = true;
    refreshed.bindings[0].last_pull_at = "2026-09-22T12:00:00.000Z";
    refreshed.bindings[0].updated_at = "2026-09-22T13:00:00.000Z";
    expect((await call("/internal/c2/import-sync-foundation", refreshed, testEnv)).status).toBe(200);
    const changedMapping = structuredClone(refreshed);
    changedMapping.request_id = "c2_metadata_003";
    changedMapping.source_snapshot_id = "c2_metadata_snapshot_003";
    changedMapping.bindings[0].field_mapping.display_name_header = "Changed Name";
    changedMapping.bindings[0].updated_at = "2026-09-23T13:00:00.000Z";
    expect(await json(await call("/internal/c2/import-sync-foundation", changedMapping, testEnv)))
      .toMatchObject({ error: { code: "IMPORT_CONFLICT" } });
    const stalePull = structuredClone(refreshed);
    stalePull.request_id = "c2_metadata_004";
    stalePull.source_snapshot_id = "c2_metadata_snapshot_004";
    stalePull.bindings[0].last_pull_at = "2026-09-21T12:00:00.000Z";
    stalePull.bindings[0].updated_at = "2026-09-23T13:00:00.000Z";
    expect(await json(await call("/internal/c2/import-sync-foundation", stalePull, testEnv)))
      .toMatchObject({ error: { code: "IMPORT_VERSION_REGRESSION" } });
  });

  it("rejects binding drift, malformed baselines and stable source reassignment", async () => {
    const testEnv = teamEnv("foundation-conflicts");
    await seed(testEnv, "conflict_001");
    const invalidTab = foundation("c2_conflict_tab_000", "c2_conflict_snapshot_000");
    invalidTab.bindings[0].response_sheet_id = "response_tab_name";
    expect(await json(await call("/internal/c2/import-sync-foundation", invalidTab, testEnv)))
      .toMatchObject({ error: { code: "INVALID_REQUEST" } });
    const original = foundation("c2_conflict_import_001", "c2_conflict_snapshot_001");
    expect((await call("/internal/c2/import-sync-foundation", original, testEnv)).status).toBe(200);

    const staleBinding = foundation("c2_conflict_binding_002", "c2_conflict_snapshot_002");
    staleBinding.bindings[0].binding_version = 2;
    expect(await json(await call("/internal/c2/import-sync-foundation", staleBinding, testEnv)))
      .toMatchObject({ error: { code: "SYNC_BINDING_STALE" } });

    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id='season_c2_open_2026'").toArray();
    });
    const changedFiles = foundation("c2_conflict_binding_006", "c2_conflict_snapshot_006");
    changedFiles.bindings[0].binding_version = 2;
    changedFiles.bindings[0].form_id = "form_c2_changed_002";
    changedFiles.baselines = [];
    changedFiles.source_imports = [];
    expect(await json(await call("/internal/c2/import-sync-foundation", changedFiles, testEnv)))
      .toMatchObject({ error: { code: "SYNC_BINDING_IDENTITY_CONFLICT" } });

    const staleDependent = foundation("c2_conflict_binding_008", "c2_conflict_snapshot_008");
    staleDependent.bindings = [];
    staleDependent.source_imports = [];
    expect(await json(await call("/internal/c2/import-sync-foundation", staleDependent, testEnv)))
      .toMatchObject({ error: { code: "SYNC_BINDING_NOT_FOUND" } });

    const reusedForm = foundation("c2_conflict_binding_007", "c2_conflict_snapshot_007");
    reusedForm.bindings[0] = { ...reusedForm.bindings[0], season_id: "season_c2_other_2026",
      runtime_spreadsheet_id: "spreadsheet_c2_fixture_002", response_sheet_id: "2" };
    reusedForm.baselines = [];
    reusedForm.source_imports = [];
    expect(await json(await call("/internal/c2/import-sync-foundation", reusedForm, testEnv)))
      .toMatchObject({ error: { code: "SYNC_BINDING_IDENTITY_CONFLICT" } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE seasons SET binding_version=1 WHERE season_id='season_c2_open_2026'").toArray();
    });

    const badBaseline: any = foundation("c2_conflict_baseline_003", "c2_conflict_snapshot_003");
    badBaseline.bindings = [];
    badBaseline.source_imports = [];
    badBaseline.baselines[0].baseline = { display_name_override: "", default_preference: "LEFT" };
    expect(await json(await call("/internal/c2/import-sync-foundation", badBaseline, testEnv)))
      .toMatchObject({ error: { code: "SYNC_MAPPING_INVALID" } });

    const badStatus: any = foundation("c2_conflict_status_012", "c2_conflict_snapshot_012");
    badStatus.bindings = [];
    badStatus.source_imports = [];
    badStatus.baselines[0].dependency_group = "MEMBER_STATUS";
    badStatus.baselines[0].baseline = { status: "SUSPENDED" };
    expect(await json(await call("/internal/c2/import-sync-foundation", badStatus, testEnv)))
      .toMatchObject({ error: { code: "SYNC_MAPPING_INVALID" } });

    const wrongIdentity: any = foundation("c2_conflict_identity_010", "c2_conflict_snapshot_010");
    wrongIdentity.bindings = [];
    wrongIdentity.source_imports = [];
    wrongIdentity.baselines[0].dependency_group = "IDENTITY";
    wrongIdentity.baselines[0].baseline = { season_id: "season_c2_open_2026",
      member_id: "member_c2_bob_002", source_key: "legacy-tab:2" };
    expect(await json(await call("/internal/c2/import-sync-foundation", wrongIdentity, testEnv)))
      .toMatchObject({ error: { code: "SYNC_MAPPING_INVALID" } });

    const reassigned = foundation("c2_conflict_source_004", "c2_conflict_snapshot_004");
    reassigned.bindings = [];
    reassigned.baselines = [];
    reassigned.source_imports = [structuredClone(original.source_imports[0])];
    reassigned.source_imports[0].source_version = 2;
    reassigned.source_imports[0].member_id = "member_c2_bob_002";
    expect(await json(await call("/internal/c2/import-sync-foundation", reassigned, testEnv)))
      .toMatchObject({ error: { code: "SOURCE_IDENTITY_CONFLICT" } });

    const wrongLegacyIdentity = foundation("c2_conflict_source_009", "c2_conflict_snapshot_009");
    wrongLegacyIdentity.bindings = [];
    wrongLegacyIdentity.baselines = [];
    wrongLegacyIdentity.source_imports = [structuredClone(original.source_imports[1])];
    wrongLegacyIdentity.source_imports[0].stable_source_id =
      "LEGACY_ROW:season_c2_open_2026:wrong-tab:3";
    expect(await json(await call("/internal/c2/import-sync-foundation", wrongLegacyIdentity, testEnv)))
      .toMatchObject({ error: { code: "SOURCE_IDENTITY_INVALID" } });

    const invalidFormResponse = foundation("c2_conflict_source_011", "c2_conflict_snapshot_011");
    invalidFormResponse.bindings = [];
    invalidFormResponse.baselines = [];
    invalidFormResponse.source_imports = [structuredClone(original.source_imports[0])];
    invalidFormResponse.source_imports[0].source_external_id = "short";
    expect(await json(await call("/internal/c2/import-sync-foundation", invalidFormResponse, testEnv)))
      .toMatchObject({ error: { code: "SOURCE_IDENTITY_INVALID" } });

    const drift = structuredClone(original);
    drift.request_id = "c2_conflict_snapshot_005";
    drift.bindings[0].response_sheet_name = "Changed name";
    expect(await json(await call("/internal/c2/import-sync-foundation", drift, testEnv)))
      .toMatchObject({ error: { code: "IMPORT_SNAPSHOT_CONFLICT" } });
  });
});

describe("C2.3 protected Sheet difference inspection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("imports real template/week baselines and reads their Google tabs without business writes", async () => {
    const testEnv = teamEnv("schedule-sheet-inspection");
    await seed(testEnv, "schedule_inspection_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "c2_schedule_inspect_binding_001", "c2_schedule_inspect_snapshot_001"), testEnv)).status).toBe(200);
    const seasonId = "season_c2_open_2026";
    const at = "2026-09-21T13:00:00.000Z";
    const template = { season_id: seasonId, template_id: "template_c2_sched_001",
      day_of_week: 3, start_time: "18:00", end_time: "20:00", timezone: "America/New_York",
      location: "River", address: "Dock 1", map_url: "", active: true,
      template_version: 1, created_at: at, updated_at: at };
    const week = { season_id: seasonId, week_id: "week_c2_sched_001",
      week_start_date: "2026-09-21", scheduled_open_at: null, status: "DRAFT",
      week_version: 1, confirmed_version: null, confirmed_by: null,
      confirmed_at: null, published_at: null, created_at: at, updated_at: at };
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(`INSERT INTO schedule_templates VALUES (
        ?, ?, 3, '18:00', '20:00', 'America/New_York', 'River', 'Dock 1', '', 1, 1, ?, ?)`,
      seasonId, template.template_id, at, at).toArray();
      context.storage.sql.exec(`INSERT INTO training_weeks VALUES (
        ?, ?, '2026-09-21', NULL, 'DRAFT', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      seasonId, week.week_id, at, at).toArray();
    });
    const baselineRows = ([scope, record, id]: ["SCHEDULE_TEMPLATE" | "TRAINING_WEEK",
      Record<string, unknown>, string]) => {
      const groups = new Map<string, Record<string, unknown>>();
      for (const field of SYNC_FIELD_DEFINITIONS[scope]) {
        const group = groups.get(field.dependency_group) ?? {};
        group[field.field] = normalizeSyncValue(record[field.field], field.kind, field.allowed_values);
        groups.set(field.dependency_group, group);
      }
      return [...groups].map(([dependency_group, baseline]) => ({
        season_id: seasonId, binding_version: 1, entity_type: scope,
        entity_id: id, dependency_group, baseline, cloud_version: 1,
        sheet_digest: "sha256_v1:schedule_fixture_001", updated_at: at
      }));
    };
    const rows = [
      ...baselineRows(["SCHEDULE_TEMPLATE", template, template.template_id]),
      ...baselineRows(["TRAINING_WEEK", week, week.week_id])
    ];
    const imported = await call("/internal/c2/import-sync-foundation", {
      request_id: "c2_schedule_baselines_001", source_snapshot_id: "c2_schedule_baselines_snapshot_001",
      bindings: [], source_imports: [], baselines: rows
    }, testEnv);
    expect(imported.status).toBe(200);
    const invalid = structuredClone(rows.find((row) => row.entity_type === "TRAINING_WEEK" &&
      row.dependency_group === "IDENTITY")!);
    invalid.baseline.week_start_date = "2026-09-28";
    expect(await json(await call("/internal/c2/import-sync-foundation", {
      request_id: "c2_schedule_identity_bad_001", source_snapshot_id: "c2_schedule_identity_bad_snapshot_001",
      bindings: [], source_imports: [], baselines: [invalid]
    }, testEnv))).toMatchObject({ error: { code: "SYNC_MAPPING_INVALID" } });
    const unknown = { ...rows[0], entity_id: "template_missing_001" };
    expect(await json(await call("/internal/c2/import-sync-foundation", {
      request_id: "c2_schedule_reference_bad_001", source_snapshot_id: "c2_schedule_reference_bad_snapshot_001",
      bindings: [], source_imports: [], baselines: [unknown]
    }, testEnv))).toMatchObject({ error: { code: "IMPORT_REFERENCE_MISSING" } });
    const login = await call("/internal/c1/coach-login", {
      request_id: "c2_schedule_read_login_001", coach_code: "local-test-coach-code"
    }, testEnv, "C1");
    const token = (await json(login)).data.result.session_token;
    const google = { SCHEDULE_TEMPLATE: { ...template }, TRAINING_WEEK: { ...week } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      const payload = JSON.parse(envelope.payload_json);
      const scope = payload.entity_type as "SCHEDULE_TEMPLATE" | "TRAINING_WEEK";
      const record: Record<string, unknown> = google[scope];
      const headers = SHEET_SCOPES[scope].headers;
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: seasonId, entity_type: scope, binding_version: 1,
        writer_epoch: envelope.writer_epoch, operation_id: envelope.operation_id,
        payload_digest: envelope.payload_digest,
        spreadsheet_id: "spreadsheet_c2_fixture_001", tab_name: SHEET_SCOPES[scope].tab,
        tab_id: scope === "SCHEDULE_TEMPLATE" ? "102" : "103", read_at_ms: Date.now(),
        headers, rows: [{ row_number: 2, cells: headers.map((header) => String(record[header] ?? "")) }],
        secondary: null
      } });
    });
    const inspect = async (scope: "SCHEDULE_TEMPLATE" | "TRAINING_WEEK", id: string) =>
      json(await call("/internal/c2/check-sheet-differences", {
        request_id: id, session_token: token, season_id: seasonId, entity_type: scope
      }, testEnv));
    expect(await inspect("SCHEDULE_TEMPLATE", "c2_template_same_001"))
      .toMatchObject({ data: { status: "OK", rows_read: 1, findings_count: 0 } });
    expect(await inspect("TRAINING_WEEK", "c2_week_same_001"))
      .toMatchObject({ data: { status: "OK", rows_read: 1, findings_count: 0 } });
    google.SCHEDULE_TEMPLATE.start_time = "19:00";
    expect(await inspect("SCHEDULE_TEMPLATE", "c2_template_edited_001"))
      .toMatchObject({ data: { findings: [expect.objectContaining({
        dependency_group: "TEMPLATE_SCHEDULE", outcome: "REVIEW_REQUIRED" })] } });
    google.TRAINING_WEEK.status = "SCHEDULED";
    expect(await inspect("TRAINING_WEEK", "c2_week_edited_001"))
      .toMatchObject({ data: { findings: [expect.objectContaining({
        dependency_group: "WEEK_LIFECYCLE", outcome: "REVIEW_REQUIRED" })] } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_batches").one().count).toBe(0);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_conflicts WHERE status='OPEN' AND entity_type IN ('SCHEDULE_TEMPLATE','TRAINING_WEEK')")
        .one().count).toBe(2);
    });
  });

  it("reads a scoped tab and classifies without mutating the roster or outbox", async () => {
    const testEnv = teamEnv("sheet-read-only");
    await seed(testEnv, "sheet_read_only_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "c2_sheet_foundation_001", "c2_sheet_snapshot_001"), testEnv)).status).toBe(200);
    const login = await call("/internal/c1/coach-login", {
      request_id: "c2_sheet_login_001", coach_code: "local-test-coach-code"
    }, testEnv, "C1");
    const token = (await json(login)).data.result.session_token;
    let headers: string[] = [...SHEET_SCOPES.MEMBER.headers];
    const alice = { season_id: "season_c2_open_2026", member_id: "member_c2_alice_01",
      source_key: "legacy-tab:2", source_display_name: "Alice", display_name_override: "A. Smith",
      status: "ACTIVE", default_preference: "LEFT", member_version: "1" };
    const bob = { ...alice, member_id: "member_c2_bob_002", source_key: "legacy-tab:3",
      source_display_name: "Bob", display_name_override: "" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      const request = JSON.parse(envelope.payload_json);
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: request.season_id, entity_type: request.entity_type,
        binding_version: 1, writer_epoch: envelope.writer_epoch,
        operation_id: envelope.operation_id, payload_digest: envelope.payload_digest,
        spreadsheet_id: "spreadsheet_c2_fixture_001", tab_name: "Members", tab_id: "101",
        read_at_ms: Date.now(), headers,
        rows: [alice, bob].map((row, index) => ({ row_number: index + 2,
          cells: headers.map((header) => String(row[header as keyof typeof row] ?? "")) })),
        secondary: null
      } });
    });
    expect((await call("/internal/c2/check-sheet-differences", {
      request_id: "c2_sheet_denied_001", session_token: "x".repeat(40),
      season_id: "season_c2_open_2026", entity_type: "MEMBER"
    }, testEnv)).status).toBe(401);
    const response = await call("/internal/c2/check-sheet-differences", {
      request_id: "c2_sheet_check_001", session_token: token,
      season_id: "season_c2_open_2026", entity_type: "MEMBER"
    }, testEnv);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ data: { status: "OK", rows_read: 2,
      findings: expect.arrayContaining([expect.objectContaining({ entity_id: "member_c2_alice_01",
        dependency_group: "MEMBER_NAME", outcome: "IMPORT" })]) } });
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ display_name_override: string }>(
        "SELECT display_name_override FROM members WHERE member_id='member_c2_alice_01'").one()
        .display_name_override).toBe("");
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_batches").one().count).toBe(0);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_conflicts WHERE status='OPEN'").one().count).toBe(2);
      context.storage.sql.exec(
        "UPDATE members SET display_name_override='C. Smith' WHERE member_id='member_c2_alice_01'").toArray();
    });
    const check = async (requestId: string) => json(await call("/internal/c2/check-sheet-differences", {
      request_id: requestId, session_token: token,
      season_id: "season_c2_open_2026", entity_type: "MEMBER"
    }, testEnv));
    expect(await check("c2_sheet_conflict_001")).toMatchObject({ data: {
      conflict_records: { created: 1, open: 3 },
      findings: expect.arrayContaining([expect.objectContaining({
        dependency_group: "MEMBER_NAME", outcome: "CONFLICT" })])
    } });
    expect(await check("c2_sheet_conflict_repeat_001")).toMatchObject({ data: {
      conflict_records: { created: 0, superseded: 0, open: 3 }
    } });
    headers = [...SHEET_SCOPES.MEMBER.headers, "unregistered_note"];
    expect(await check("c2_sheet_structure_invalid_001")).toMatchObject({ data: {
      status: "STRUCTURE_INVALID", conflict_records: { superseded: 0 }
    } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ status: string }>(
        "SELECT status FROM sync_conflicts WHERE dependency_group='MEMBER_NAME'").one().status).toBe("OPEN");
    });
    headers = [...SHEET_SCOPES.MEMBER.headers];
    alice.display_name_override = "";
    expect(await check("c2_sheet_conflict_cleared_001")).toMatchObject({ data: {
      conflict_records: { created: 0, superseded: 2, open: 2 }
    } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const nameConflict = context.storage.sql.exec<{ status: string; finding_outcome: string;
        cloud_version: number }>(
        "SELECT status, finding_outcome, cloud_version FROM sync_conflicts WHERE dependency_group='MEMBER_NAME'").one();
      expect(nameConflict).toMatchObject({ status: "SUPERSEDED", finding_outcome: "CONFLICT",
        cloud_version: 1 });
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_outbox").one().count).toBe(0);
    });
  });
});

describe("C2.2 Form source import", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps scheduled Form polling disabled until isolated Google acceptance", async () => {
    const testEnv = teamEnv("form-poll-disabled");
    const response = await call("/internal/c2/poll-active-forms", {
      request_id: "c2_poll_disabled_001"
    }, testEnv);
    expect(await json(response)).toMatchObject({ error: { code: "FORM_POLL_DISABLED" } });
    const production = { ...testEnv, ENVIRONMENT: "production" } as Env;
    expect((await call("/internal/c2/poll-active-forms", {
      request_id: "c2_poll_disabled_002"
    }, production)).status).toBe(404);
  });

  it("finishes an expired season scan and then stops scheduled Google reads", async () => {
    const testEnv = teamEnv("form-poll-active-only");
    await seed(testEnv, "form_poll_active_only_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "c2_poll_active_only_001", "c2_poll_active_snapshot_001"), testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    const poll = (requestId: string) => runInDurableObject(stub, async (_instance: TeamState, context) =>
      new C2SyncService(context, { ...testEnv, C2_FORM_POLL_ENABLED: "true" } as unknown as Env)
        .handle("/internal/c2/poll-active-forms", { request_id: requestId }));
    expect(await poll("c2_poll_expired_001")).toMatchObject({ polled: 1,
      results: [{ season_id: "season_c2_open_2026", status: "RETRY_REQUIRED" }] });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const now = Date.now();
      context.storage.sql.exec(
        "INSERT INTO form_import_cursors VALUES (?, 1, ?, NULL, NULL, 0, '', ?, ?)",
        "season_c2_open_2026", now, now, new Date(now).toISOString()).toArray();
    });
    expect(await poll("c2_poll_finalized_001")).toMatchObject({ polled: 0, results: [] });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE form_import_cursors SET last_read_at_ms=0 WHERE season_id='season_c2_open_2026'").toArray();
    });
    expect(await poll("c2_poll_final_scan_needed_001")).toMatchObject({ polled: 1 });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE seasons SET season_ends_at='2099-01-01T05:00:00.000Z' WHERE season_id='season_c2_open_2026'").toArray();
    });
    expect(await poll("c2_poll_open_001")).toMatchObject({ polled: 1,
      results: [{ season_id: "season_c2_open_2026", status: "RETRY_REQUIRED" }] });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE seasons SET status='COMPLETED' WHERE season_id='season_c2_open_2026'").toArray();
    });
    expect(await poll("c2_poll_completed_before_end_001")).toMatchObject({ polled: 1 });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE seasons SET season_ends_at='2026-09-01T04:00:00.000Z' WHERE season_id='season_c2_open_2026'").toArray();
      context.storage.sql.exec(
        "UPDATE form_import_cursors SET window_start_ms=1 WHERE season_id='season_c2_open_2026'").toArray();
    });
    expect(await poll("c2_poll_unfinished_page_001")).toMatchObject({ polled: 1 });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE form_import_cursors SET window_start_ms=NULL, last_read_at_ms=? WHERE season_id='season_c2_open_2026'",
        Date.now()).toArray();
    });
    expect(await poll("c2_poll_completed_001")).toMatchObject({ polled: 0, results: [] });
  });

  it("upgrades a v7 shadow state in place without losing its binding or sources", async () => {
    const testEnv = teamEnv("form-schema-upgrade");
    await seed(testEnv, "form_schema_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "c2_form_schema_001", "c2_form_schema_snapshot_001"), testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      for (const table of ["form_source_observations", "form_import_receipts", "form_import_cursors"]) {
        context.storage.sql.exec(`DROP TABLE ${table}`).toArray();
      }
      for (const column of ["fingerprint", "row_number", "reason", "finding_outcome"]) {
        context.storage.sql.exec(`ALTER TABLE sync_conflicts DROP COLUMN ${column}`).toArray();
      }
      context.storage.sql.exec("UPDATE app_meta SET value='7' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(context.storage.sql.exec<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe(String(APPLICATION_SCHEMA_VERSION));
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_bindings").one().count).toBe(1);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM source_imports").one().count).toBe(2);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM form_import_cursors").one().count).toBe(0);
    });
  });

  it("upgrades a populated v8 conflict through the current schema without losing its evidence", async () => {
    const testEnv = teamEnv("sheet-schema-upgrade");
    await seed(testEnv, "sheet_schema_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "c2_sheet_schema_001", "c2_sheet_schema_snapshot_001"), testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      for (const column of ["fingerprint", "row_number", "reason", "finding_outcome"]) {
        context.storage.sql.exec(`ALTER TABLE sync_conflicts DROP COLUMN ${column}`).toArray();
      }
      context.storage.sql.exec(`INSERT INTO sync_conflicts VALUES (
        'conflict_c2_old_001', 'season_c2_open_2026', 1, 'MEMBER', 'member_c2_alice_01',
        'MEMBER_NAME', '{}', '{}', '{"display_name_override":"old"}', 1,
        'sha256_v1:old', 'OPEN', '2026-09-21T13:00:00.000Z', NULL, NULL
      )`).toArray();
      context.storage.sql.exec("UPDATE app_meta SET value='8' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      const row = context.storage.sql.exec<{ status: string; google_json: string;
        finding_outcome: string; fingerprint: string }>(
        "SELECT status, google_json, finding_outcome, fingerprint FROM sync_conflicts WHERE conflict_id='conflict_c2_old_001'").one();
      expect(row).toMatchObject({ status: "OPEN", google_json: '{"display_name_override":"old"}',
        finding_outcome: "CONFLICT", fingerprint: "" });
      expect(context.storage.sql.exec<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe(String(APPLICATION_SCHEMA_VERSION));
    });
  });

  it("widens populated v9 sync entity constraints without losing rows, receipts or indexes", async () => {
    const testEnv = teamEnv("schedule-schema-upgrade");
    await seed(testEnv, "schedule_schema_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "c2_schedule_schema_001", "c2_schedule_schema_snapshot_001"), testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const sql = context.storage.sql;
      const at = "2026-09-21T13:00:00.000Z";
      sql.exec(`INSERT INTO sync_conflicts (
        conflict_id, season_id, binding_version, entity_type, entity_id, dependency_group,
        baseline_json, cloud_json, google_json, cloud_version, google_digest, status,
        created_at, finding_outcome, reason, fingerprint
      ) VALUES ('conflict_schedule_upgrade', 'season_c2_open_2026', 1, 'MEMBER',
        'member_c2_alice_01', 'MEMBER_NAME', '{}', '{}', '{}', 1, 'sha256_v1:old',
        'OPEN', ?, 'REVIEW_REQUIRED', 'Retain this finding', 'sha256_v1:finding')`, at).toArray();
      sql.exec(`INSERT INTO sync_batches (
        batch_id, season_id, binding_version, writer_epoch, direction, status,
        payload_digest, first_outbox_id, last_outbox_id, created_at, updated_at
      ) VALUES ('batch_schedule_upgrade', 'season_c2_open_2026', 1, 0,
        'CLOUDFLARE_TO_GOOGLE', 'CONFIRMED', 'sha256_v1:batch', NULL, NULL, ?, ?)`, at, at).toArray();
      sql.exec(`INSERT INTO sync_batch_items (
        batch_id, item_index, entity_type, entity_id, dependency_group,
        expected_sheet_digest, target_json, target_digest, status, receipt_json, updated_at
      ) VALUES ('batch_schedule_upgrade', 0, 'MEMBER', 'member_c2_alice_01', 'ROW',
        'sha256_v1:expected', '{}', 'sha256_v1:target', 'VERIFIED', '{"status":"verified"}', ?)`, at).toArray();
      const tables = ["sync_baselines", "sync_conflicts", "sync_batch_items"];
      const prior = Object.fromEntries(tables.map((table) => [table,
        sql.exec(`SELECT * FROM ${table}`).toArray()]));
      // Reconstruct the historical v9 CHECK clauses on this populated fixture.
      for (const table of tables) {
        const ddl = sql.exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).one().sql;
        const historical = ddl.replace(table, `${table}_v9`)
          .replace("'SCHEDULE_TEMPLATE', 'TRAINING_WEEK', ", "");
        expect(historical).not.toBe(ddl);
        sql.exec(historical).toArray();
        sql.exec(`INSERT INTO ${table}_v9 SELECT * FROM ${table}`).toArray();
        sql.exec(`DROP TABLE ${table}`).toArray();
        sql.exec(`ALTER TABLE ${table}_v9 RENAME TO ${table}`).toArray();
      }
      sql.exec(`CREATE INDEX sync_baselines_entity_idx
        ON sync_baselines(season_id, entity_type, entity_id, dependency_group)`).toArray();
      sql.exec(`CREATE INDEX sync_conflicts_open_idx
        ON sync_conflicts(season_id, status, created_at, conflict_id)`).toArray();
      expect(() => sql.exec(`INSERT INTO sync_baselines VALUES (
        'season_c2_open_2026', 1, 'SCHEDULE_TEMPLATE', 'template_old_01', 'IDENTITY',
        '{}', 'sha256_v1:x', 1, 'sha256_v1:x', ?)`, at).toArray()).toThrow();
      sql.exec("UPDATE app_meta SET value='9' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(sql.exec<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe("10");
      for (const table of tables) expect(sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual(prior[table]);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
      for (const index of ["sync_baselines_entity_idx", "sync_conflicts_open_idx"]) {
        expect(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name=?",
          index).toArray()).toHaveLength(1);
      }
      sql.exec(`INSERT INTO sync_baselines VALUES (
        'season_c2_open_2026', 1, 'SCHEDULE_TEMPLATE', 'template_new_01', 'IDENTITY',
        '{}', 'sha256_v1:new', 1, 'sha256_v1:new', ?)`, at).toArray();
      sql.exec(`INSERT INTO sync_conflicts (
        conflict_id, season_id, binding_version, entity_type, entity_id, dependency_group,
        baseline_json, cloud_json, google_json, cloud_version, google_digest, status, created_at
      ) VALUES ('conflict_week_new', 'season_c2_open_2026', 1, 'TRAINING_WEEK',
        'week_new_001', 'WEEK_SCHEDULE', '{}', '{}', '{}', 1, 'sha256_v1:new', 'OPEN', ?)`, at).toArray();
      sql.exec(`INSERT INTO sync_batch_items (
        batch_id, item_index, entity_type, entity_id, dependency_group,
        expected_sheet_digest, target_json, target_digest, status, updated_at
      ) VALUES ('batch_schedule_upgrade', 1, 'TRAINING_WEEK', 'week_new_001', 'ROW',
        'sha256_v1:expected', '{}', 'sha256_v1:target', 'PENDING', ?)`, at).toArray();
      applySchema(context.storage);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });

  it("reviews the initial historical scan when legacy members have no stable Form link", async () => {
    const testEnv = { ...teamEnv("form-initial-review"),
      GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/local-fixture/exec",
      GOOGLE_BRIDGE_SECRET: "local-test-bridge-secret" } as Env;
    await seed(testEnv, "form_initial_review_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "c2_initial_review_001", "c2_initial_review_snapshot_001"), testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE seasons SET end_date='2026-12-31', season_ends_at='2027-01-01T05:00:00.000Z' WHERE season_id='season_c2_open_2026'").toArray();
    });
    const submittedAt = new Date(Date.now() - 60_000).toISOString();
    const answers = [
      { response_id: "response_c2_0998", submitted_at: submittedAt, display_name: "A former name" },
      { response_id: "response_c2_0999", submitted_at: submittedAt, display_name: "Another former name" }
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      const request = JSON.parse(envelope.payload_json);
      const ordered = answers.filter((answer) => {
        const at = Date.parse(answer.submitted_at);
        return at > request.after_at_ms || at === request.after_at_ms && answer.response_id > request.after_id;
      });
      const page = ordered.slice(0, request.limit);
      const last = page.at(-1);
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: request.season_id, form_id: "form_c2_fixture_001",
        binding_version: 1, writer_epoch: envelope.writer_epoch,
        operation_id: envelope.operation_id, payload_digest: envelope.payload_digest,
        window_start_ms: request.window_start_ms, after_at_ms: request.after_at_ms,
        after_id: request.after_id, read_at_ms: Date.now(), has_more: ordered.length > request.limit,
        next_after_at_ms: last ? Date.parse(last.submitted_at) : request.after_at_ms,
        next_after_id: last ? last.response_id : request.after_id,
        responses: page
      } });
    });
    const first = await call("/internal/c2/pull-form-responses", {
      request_id: "c2_initial_review_pull_001", season_id: "season_c2_open_2026", limit: 1
    }, testEnv);
    expect(await json(first)).toMatchObject({ data: { result: { created: 0, reviewed: 1, has_more: true } } });
    const second = await call("/internal/c2/pull-form-responses", {
      request_id: "c2_initial_review_pull_002", season_id: "season_c2_open_2026", limit: 1
    }, testEnv);
    expect(await json(second)).toMatchObject({ data: { result: { created: 0, reviewed: 1, has_more: false } } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM members WHERE season_id='season_c2_open_2026'").one().count).toBe(2);
      expect(context.storage.sql.exec<{ review_reason: string }>(
        "SELECT review_reason FROM form_source_observations WHERE stable_source_id LIKE '%response_c2_0998'").one().review_reason)
        .toBe("HISTORICAL_UNMAPPED");
    });
  });

  it("commits a Form response once when two pull requests race across the Google read", async () => {
    const testEnv = { ...teamEnv("form-concurrent-pull"),
      GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/local-fixture/exec",
      GOOGLE_BRIDGE_SECRET: "local-test-bridge-secret" } as Env;
    await seed(testEnv, "form_concurrent_pull_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(
      "c2_concurrent_binding_001", "c2_concurrent_snapshot_001"), testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    const previous = Date.now() - 60_000;
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE seasons SET season_ends_at='2099-01-01T05:00:00.000Z' WHERE season_id='season_c2_open_2026'").toArray();
      context.storage.sql.exec(
        "INSERT INTO form_import_cursors VALUES (?, 1, ?, NULL, NULL, 0, '', ?, ?)",
        "season_c2_open_2026", previous, previous, new Date(previous).toISOString()).toArray();
    });
    let bridgeReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bridgeReads += 1;
      const envelope = JSON.parse(String(init?.body));
      const request = JSON.parse(envelope.payload_json);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const submittedAt = new Date(previous + 1_000).toISOString();
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: request.season_id, form_id: "form_c2_fixture_001",
        binding_version: 1, writer_epoch: envelope.writer_epoch,
        operation_id: envelope.operation_id, payload_digest: envelope.payload_digest,
        window_start_ms: request.window_start_ms, after_at_ms: request.after_at_ms,
        after_id: request.after_id, read_at_ms: Date.now(), has_more: false,
        next_after_at_ms: previous + 1_000, next_after_id: "response_c2_race_001",
        responses: [{ response_id: "response_c2_race_001", submitted_at: submittedAt,
          display_name: "C2 Race Member" }]
      } });
    });
    const requests = ["c2_concurrent_pull_001", "c2_concurrent_pull_002"];
    const responses = await Promise.all(requests.map((requestId) => call(
      "/internal/c2/pull-form-responses", { request_id: requestId,
        season_id: "season_c2_open_2026", limit: 100 }, testEnv)));
    const results = await Promise.all(responses.map(json));
    expect(bridgeReads).toBe(2);
    expect(results.some((row) => row.error?.code === "FORM_IMPORT_STALE")).toBe(true);
    expect(results.filter((row) => row.ok).reduce((count, row) => count + row.data.result.created, 0)).toBe(1);
    expect(results.filter((row) => !row.ok).every((row) => row.error.code === "FORM_IMPORT_STALE")).toBe(true);
    const failedIndex = results.findIndex((row) => row.error?.code === "FORM_IMPORT_STALE");
    const retried = await json(await call("/internal/c2/pull-form-responses", {
      request_id: requests[failedIndex], season_id: "season_c2_open_2026", limit: 100
    }, testEnv));
    expect(retried).toMatchObject({ data: { result: { created: 0, unchanged: 1 } } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM members WHERE season_id='season_c2_open_2026'").one().count).toBe(3);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM source_imports WHERE source_external_id='response_c2_race_001'").one().count).toBe(1);
    });
  });

  it("commits equal-time pages, deduplicates overlap and reviews an ambiguous legacy name", async () => {
    const testEnv = { ...teamEnv("form-import"),
      GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/local-fixture/exec",
      GOOGLE_BRIDGE_SECRET: "local-test-bridge-secret" } as Env;
    await seed(testEnv, "form_import_001");
    expect((await call("/internal/c2/import-sync-foundation", foundation(), testEnv)).status).toBe(200);
    const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE seasons SET end_date='2026-12-31', season_ends_at='2027-01-01T05:00:00.000Z' WHERE season_id='season_c2_open_2026'").toArray();
      const priorRead = Date.parse("2026-06-02T12:00:00.000Z");
      context.storage.sql.exec(
        "INSERT INTO form_import_cursors VALUES (?, 1, ?, NULL, NULL, 0, '', ?, ?)",
        "season_c2_open_2026", priorRead, priorRead, "2026-06-02T12:00:00.000Z").toArray();
    });
    const submittedAt = new Date(Date.now() - 60_000).toISOString();
    const responses = [
      { response_id: "response_c2_0999", submitted_at: "2026-06-01T12:00:00.000Z", display_name: "Old name changed" },
      { response_id: "response_c2_1002", submitted_at: submittedAt, display_name: "Dana" },
      { response_id: "response_c2_1001", submitted_at: submittedAt, display_name: "Chris" },
      { response_id: "response_c2_1003", submitted_at: submittedAt, display_name: "Bob" }
    ];
    let rejectNext = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      if (rejectNext) { rejectNext = false; return Response.json({ ok: true, data: {} }); }
      const request = JSON.parse(envelope.payload_json);
      const ordered = responses.filter((row) => {
        const at = Date.parse(row.submitted_at);
        return at >= request.window_start_ms &&
          (at > request.after_at_ms || at === request.after_at_ms && row.response_id > request.after_id);
      }).sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at) ||
        left.response_id.localeCompare(right.response_id));
      const page = ordered.slice(0, request.limit);
      const last = page.at(-1);
      return Response.json({ ok: true, meta: { request_id: envelope.request_id }, data: {
        protocol_version: envelope.protocol_version, team_id: envelope.team_id,
        season_id: request.season_id, form_id: "form_c2_fixture_001",
        binding_version: 1, writer_epoch: envelope.writer_epoch,
        operation_id: envelope.operation_id, payload_digest: envelope.payload_digest,
        window_start_ms: request.window_start_ms, after_at_ms: request.after_at_ms,
        after_id: request.after_id, read_at_ms: Date.now(), has_more: ordered.length > request.limit,
        next_after_at_ms: last ? Date.parse(last.submitted_at) : request.after_at_ms,
        next_after_id: last ? last.response_id : request.after_id,
        responses: page
      } });
    });
    const pull = (requestId: string, limit = 2) => call("/internal/c2/pull-form-responses", {
      request_id: requestId, season_id: "season_c2_open_2026", limit
    }, testEnv);
    const failed = await pull("c2_form_pull_001");
    expect(await json(failed)).toMatchObject({ error: { code: "BRIDGE_INVALID_RESPONSE" } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ watermark_ms: number }>(
        "SELECT watermark_ms FROM form_import_cursors").one().watermark_ms)
        .toBe(Date.parse("2026-06-02T12:00:00.000Z"));
    });
    const first = await pull("c2_form_pull_001");
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ data: { result: {
      created: 1, reviewed: 1, has_more: true } } });
    expect((await pull("c2_form_pull_001")).status).toBe(200);
    const second = await pull("c2_form_pull_002");
    expect(await json(second)).toMatchObject({ data: { result: {
      created: 1, reviewed: 1, has_more: false } } });
    const overlap = await pull("c2_form_pull_003");
    expect(await json(overlap)).toMatchObject({ data: { result: {
      created: 0, reviewed: 0, unchanged: 2, has_more: true } } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM members WHERE season_id='season_c2_open_2026'").one().count).toBe(4);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM form_import_receipts").one().count).toBe(3);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_outbox WHERE topic='MEMBERS_IMPORTED'").one().count).toBe(2);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM source_imports WHERE source_external_id='response_c2_1003' AND status='REVIEW_REQUIRED'").one().count).toBe(1);
      expect(context.storage.sql.exec<{ review_reason: string }>(
        "SELECT review_reason FROM form_source_observations WHERE stable_source_id LIKE '%response_c2_0999'").one().review_reason)
        .toBe("HISTORICAL_UNMAPPED");
    });
    const login = await call("/internal/c1/coach-login", {
      request_id: "c2_form_resolve_login", coach_code: "local-test-coach-code"
    }, testEnv, "C1");
    const token = (await json(login)).data.result.session_token;
    const reviews = async (requestId: string, cursor?: string) => json(await call(
      "/internal/c2/list-form-reviews", {
        request_id: requestId, session_token: token, season_id: "season_c2_open_2026",
        limit: 1, ...(cursor ? { cursor } : {})
      }, testEnv));
    const reviewFirst = await reviews("c2_form_reviews_001");
    expect(reviewFirst).toMatchObject({ data: { items: [{ response_id: "response_c2_0999",
      review_reason: "HISTORICAL_UNMAPPED", source_version: 1 }], next_cursor: "response_c2_0999" } });
    const reviewSecond = await reviews("c2_form_reviews_002", reviewFirst.data.next_cursor);
    expect(reviewSecond).toMatchObject({ data: { items: [{ response_id: "response_c2_1003",
      review_reason: "LEGACY_NAME_MATCH", source_version: 1 }], next_cursor: null } });
    expect((await call("/internal/c2/list-form-reviews", {
      request_id: "c2_form_reviews_denied", session_token: "x".repeat(40),
      season_id: "season_c2_open_2026"
    }, testEnv)).status).toBe(401);
    const resolveInput = {
      request_id: "c2_form_resolve_001", session_token: token,
      season_id: "season_c2_open_2026", response_id: "response_c2_1003",
      member_id: "member_c2_bob_002", source_version: 1
    };
    expect((await call("/internal/c2/resolve-form-source", resolveInput, testEnv)).status).toBe(200);
    expect((await call("/internal/c2/resolve-form-source", resolveInput, testEnv)).status).toBe(200);
    const afterResolve = await reviews("c2_form_reviews_003");
    expect(afterResolve).toMatchObject({ data: { items: [{ response_id: "response_c2_0999" }],
      next_cursor: null } });
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const mapped = context.storage.sql.exec<{ status: string; member_id: string; source_version: number }>(
        "SELECT status, member_id, source_version FROM source_imports WHERE source_external_id='response_c2_1003'").one();
      expect(mapped).toMatchObject({ status: "IMPORTED", member_id: "member_c2_bob_002", source_version: 2 });
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM members WHERE season_id='season_c2_open_2026'").one().count).toBe(4);
    });
  });
});
