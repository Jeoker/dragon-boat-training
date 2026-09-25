import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { C2_ACTIONS, C2_CONTRACT_VERSION } from "../../shared/c2-actions";
import { compareSyncRecord, formResponseSourceId, normalizeSyncValue } from "../../shared/c2-sync-rules";
import { legacyCredentialDigest } from "../src/crypto";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { TeamState } from "../src/team-state";
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
    for (const path of Object.keys(C2_ACTIONS)) {
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
    expect(await json(overview)).toMatchObject({ data: { schema_version: 7,
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
