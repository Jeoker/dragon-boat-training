import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { C1_ACTIONS, C1_CONTRACT_VERSION } from "../../shared/c1-actions";
import { canonicalJson, seasonEndsAt } from "../../shared/c1-rules";
import { legacyCredentialDigest } from "../src/crypto";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { TeamState } from "../src/team-state";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const BASE = "https://example.test";
const TEST_HEADERS = { authorization: "Bearer local-c1-test-key", "content-type": "application/json" };
const teamEnv = (name: string) => ({ ...env, TEAM_ID: `c1-${name}` } as unknown as Env);

async function call(path: string, body?: Record<string, unknown>, method = body ? "POST" : "GET", testEnv: Env = env) {
  return worker.fetch(new IncomingRequest(`${BASE}${path}`, {
    method, headers: TEST_HEADERS, ...(body ? { body: JSON.stringify(body) } : {})
  }), testEnv);
}

async function body(response: Response): Promise<any> {
  return response.json();
}

async function snapshot(requestId = "import_core_001", overrides: Record<string, unknown> = {}) {
  const at = "2026-09-20T12:00:00.000Z";
  return {
    request_id: requestId,
    source_snapshot_id: "snapshot_core_001",
    settings_version: 3,
    default_season_id: "season_open_2026",
    coaches: [{
      coach_id: "coach_liu_yang", display_name: "刘阳", code_salt: "salt_fixture_001",
      code_digest: await legacyCredentialDigest("salt_fixture_001", "local-test-coach-code", "local-c1-coach-secret"),
      credential_version: 1, active: true, created_at: at, updated_at: at
    }],
    seasons: [
      { season_id: "season_open_2026", name: "Open 2026", start_date: "2026-04-20", end_date: "2026-08-31",
        timezone: "America/New_York", season_ends_at: "2026-09-01T04:00:00.000Z", status: "OPEN",
        binding_version: 1, season_version: 4, roster_version: 2,
        created_by: "coach_liu_yang", created_at: at, updated_at: at },
      { season_id: "season_other_2026", name: "Other 2026", start_date: "2026-09-01", end_date: "2026-12-31",
        timezone: "America/New_York", season_ends_at: "2027-01-01T05:00:00.000Z", status: "OPEN",
        binding_version: 1, season_version: 2, roster_version: 1,
        created_by: "coach_liu_yang", created_at: at, updated_at: at }
    ],
    members: [
      { season_id: "season_open_2026", member_id: "member_alice_01", source_key: "tab1:2",
        source_display_name: "Alice", display_name_override: "", status: "ACTIVE", default_preference: "LEFT",
        member_version: 1, created_at: at, updated_at: at },
      { season_id: "season_open_2026", member_id: "member_hidden_01", source_key: "tab1:3",
        source_display_name: "Hidden", display_name_override: "", status: "INACTIVE", default_preference: "AMBIENT",
        member_version: 1, created_at: at, updated_at: at },
      { season_id: "season_other_2026", member_id: "member_other_01", source_key: "tab2:2",
        source_display_name: "Other", display_name_override: "", status: "ACTIVE", default_preference: "RIGHT",
        member_version: 1, created_at: at, updated_at: at }
    ],
    ...overrides
  };
}

async function importAndLogin(prefix: string) {
  const testEnv = teamEnv(prefix);
  const imported = await call("/internal/c1/import-core", await snapshot(`import_${prefix}_001`, {
    source_snapshot_id: `snapshot_${prefix}_001`
  }), "POST", testEnv);
  expect(imported.status).toBe(200);
  const login = await call("/internal/c1/coach-login", { request_id: `login_${prefix}_001`, coach_code: "local-test-coach-code" }, "POST", testEnv);
  expect(login.status).toBe(200);
  return { token: (await body(login)).data.result.session_token as string, testEnv };
}

describe("C1 contract and core business slice", () => {
  it("defines executable action schemas and correct DST-aware season boundaries", () => {
    expect(Object.keys(C1_ACTIONS)).toHaveLength(27);
    expect(seasonEndsAt("2026-03-07", "America/New_York")).toBe("2026-03-08T05:00:00.000Z");
    expect(seasonEndsAt("2026-03-08", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it("upgrades a v1 database in place without losing C0 data", async () => {
    const stub = env.TEAM_STATE.getByName("c1-schema-upgrade");
    await stub.fetch(`${BASE}/internal/c0/state`);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("INSERT INTO c0_counters(counter_name, value) VALUES ('preserved', 7)").toArray();
      for (const table of ["migration_snapshots", "members", "seasons", "settings", "coach_sessions", "coaches"]) {
        context.storage.sql.exec(`DROP TABLE ${table}`).toArray();
      }
      context.storage.sql.exec("UPDATE app_meta SET value = '1' WHERE key = 'schema_version'").toArray();
      applySchema(context.storage);
      expect(context.storage.sql.exec<{ value: number }>("SELECT value FROM c0_counters WHERE counter_name='preserved'").one().value).toBe(7);
      expect(context.storage.sql.exec<{ value: string }>("SELECT value FROM app_meta WHERE key='schema_version'").one().value)
        .toBe(String(APPLICATION_SCHEMA_VERSION));
      expect(context.storage.sql.exec("SELECT * FROM seasons").toArray()).toEqual([]);
    });
  });

  it("protects and hides every C1 route outside the isolated environment", async () => {
    const denied = await worker.fetch(new IncomingRequest(`${BASE}/internal/c1/public-roster?request_id=denied_c1_001&season_id=season_open_2026`), env);
    expect(denied.status).toBe(403);
    await expect(body(denied)).resolves.toMatchObject({ error: { code: "C1_ACCESS_DENIED" },
      meta: { contract_version: C1_CONTRACT_VERSION } });
    for (const path of Object.keys(C1_ACTIONS)) {
      const hidden = await call(path, path.endsWith("public-roster") ? undefined : { request_id: "hidden_c1_001" },
        path.endsWith("public-roster") ? "GET" : "POST", { ...env, ENVIRONMENT: "production" } as Env);
      expect(hidden.status, path).toBe(404);
    }
  });

  it("imports one immutable core snapshot and rejects drift or version regression", async () => {
    const testEnv = teamEnv("import-rules");
    const original = await snapshot("import_rules_001", { source_snapshot_id: "snapshot_rules_001" });
    const first = await call("/internal/c1/import-core", original, "POST", testEnv);
    expect(first.status).toBe(200);
    expect(await body(first)).toMatchObject({ ok: true, data: { result: { coaches: 1, seasons: 2, members: 3 } },
      meta: { contract_version: C1_CONTRACT_VERSION, request_id: "import_rules_001" } });
    expect((await call("/internal/c1/import-core", original, "POST", testEnv)).status).toBe(200);
    const sameSnapshotNewRequest = structuredClone(original);
    sameSnapshotNewRequest.request_id = "import_rules_same_002";
    expect((await call("/internal/c1/import-core", sameSnapshotNewRequest, "POST", testEnv)).status).toBe(200);
    const changedSameRequest = structuredClone(original);
    changedSameRequest.seasons[0].name = "Changed";
    expect((await body(await call("/internal/c1/import-core", changedSameRequest, "POST", testEnv))).error.code).toBe("IDEMPOTENCY_CONFLICT");
    const changedSnapshot = structuredClone(changedSameRequest);
    changedSnapshot.request_id = "import_rules_002";
    expect((await body(await call("/internal/c1/import-core", changedSnapshot, "POST", testEnv))).error.code).toBe("IMPORT_SNAPSHOT_CONFLICT");
    const regression = await snapshot("import_rules_003", { source_snapshot_id: "snapshot_rules_002" });
    regression.seasons[0].season_version = 3;
    expect((await body(await call("/internal/c1/import-core", regression, "POST", testEnv))).error.code).toBe("IMPORT_VERSION_REGRESSION");
    const sourceCollision = await snapshot("import_rules_004", { source_snapshot_id: "snapshot_rules_003" });
    sourceCollision.members = [{ ...sourceCollision.members[0], member_id: "member_collision_01" }];
    expect((await body(await call("/internal/c1/import-core", sourceCollision, "POST", testEnv))).error.code).toBe("IMPORT_CONFLICT");
    const sourceReassignment = await snapshot("import_rules_005", { source_snapshot_id: "snapshot_rules_004" });
    sourceReassignment.members[0].member_version += 1;
    sourceReassignment.members[0].source_key = "source_reassigned_001";
    expect((await body(await call("/internal/c1/import-core", sourceReassignment, "POST", testEnv))).error.code)
      .toBe("IMPORT_CONFLICT");
    const invalidOverride = await snapshot("import_rules_006", { source_snapshot_id: "snapshot_rules_005" });
    invalidOverride.members[0].display_name_override = null as unknown as string;
    expect((await body(await call("/internal/c1/import-core", invalidOverride, "POST", testEnv))).error.code)
      .toBe("INVALID_REQUEST");
  });

  it("uses migrated Coach Codes, generation-bound sessions and one shared management permission", async () => {
    const { token, testEnv } = await importAndLogin("auth");
    const bootstrap = await call("/internal/c1/coach-bootstrap", {
      request_id: "bootstrap_auth_001", session_token: token
    }, "POST", testEnv);
    expect(await body(bootstrap)).toMatchObject({ ok: true, data: { coach: { display_name: "刘阳" },
      default_season_id: "season_open_2026", seasons: [{ season_id: "season_other_2026" }, { season_id: "season_open_2026" }] } });
    const invalid = await call("/internal/c1/coach-bootstrap", {
      request_id: "bootstrap_auth_002", session_token: `${token.slice(0, -1)}x`
    }, "POST", testEnv);
    expect((await body(invalid)).error.code).toBe("SESSION_INVALID");
    const logout = { request_id: "logout_auth_001", session_token: token };
    expect((await call("/internal/c1/coach-logout", logout, "POST", testEnv)).status).toBe(200);
    expect((await call("/internal/c1/coach-logout", logout, "POST", testEnv)).status).toBe(200);
    expect((await body(await call("/internal/c1/coach-bootstrap", {
      request_id: "bootstrap_auth_003", session_token: token
    }, "POST", testEnv))).error.code).toBe("SESSION_REVOKED");
  });

  it("revokes old sessions when an imported Coach credential advances", async () => {
    const { token, testEnv } = await importAndLogin("credential_rotation");
    const rotated = await snapshot("rotate_credential_001", { source_snapshot_id: "snapshot_credential_rotation_002" });
    rotated.coaches[0].credential_version = 2;
    rotated.coaches[0].code_digest = await legacyCredentialDigest(
      rotated.coaches[0].code_salt, "pen002", "local-c1-coach-secret"
    );
    expect((await call("/internal/c1/import-core", rotated, "POST", testEnv)).status).toBe(200);
    expect((await body(await call("/internal/c1/coach-bootstrap", {
      request_id: "bootstrap_rotated_001", session_token: token
    }, "POST", testEnv))).error.code).toBe("SESSION_INVALID");
    expect((await body(await call("/internal/c1/coach-login", {
      request_id: "login_rotated_old_001", coach_code: "local-test-coach-code"
    }, "POST", testEnv))).error.code).toBe("COACH_CODE_INVALID");
    expect((await call("/internal/c1/coach-login", {
      request_id: "login_rotated_new_001", coach_code: "pen002"
    }, "POST", testEnv)).status).toBe(200);
  });

  it("isolates public rosters and excludes inactive members and private source fields", async () => {
    const { testEnv } = await importAndLogin("roster");
    const first = await body(await call("/internal/c1/public-roster?request_id=roster_read_001&season_id=season_open_2026", undefined, "GET", testEnv));
    expect(first.data.members).toEqual([{ member_id: "member_alice_01", display_name: "Alice",
      default_preference: "LEFT", member_version: 1 }]);
    expect(JSON.stringify(first)).not.toContain("tab1:");
    const other = await body(await call("/internal/c1/public-roster?request_id=roster_read_002&season_id=season_other_2026", undefined, "GET", testEnv));
    expect(other.data.members.map((member: any) => member.member_id)).toEqual(["member_other_01"]);
  });

  it("creates seasons and updates members atomically with immutable results and a pending outbox", async () => {
    const { token, testEnv } = await importAndLogin("mutations");
    const createInput = { request_id: "create_season_001", session_token: token, name: "2027 Season",
      start_date: "2027-04-20", end_date: "2027-08-31", timezone: "America/New_York" };
    const created = await body(await call("/internal/c1/create-season", createInput, "POST", testEnv));
    expect(created.data.result.season).toMatchObject({ status: "DRAFT", season_version: 1,
      season_ends_at: "2027-09-01T04:00:00.000Z" });
    expect((await body(await call("/internal/c1/create-season", createInput, "POST", testEnv))).data).toEqual(created.data);
    expect((await body(await call("/internal/c1/create-season", { ...createInput, name: "Different" }, "POST", testEnv))).error.code)
      .toBe("IDEMPOTENCY_CONFLICT");

    const update = { request_id: "update_member_001", session_token: token, season_id: "season_open_2026",
      member_id: "member_alice_01", member_version: 1, display_name_override: "Alice Updated", default_preference: "RIGHT" };
    const updated = await body(await call("/internal/c1/update-member", update, "POST", testEnv));
    expect(updated.data.result).toMatchObject({ roster_version: 3,
      member: { display_name: "Alice Updated", member_version: 2, default_preference: "RIGHT" } });
    expect((await body(await call("/internal/c1/update-member", { ...update, request_id: "update_member_002" }, "POST", testEnv))).error.code)
      .toBe("VERSION_CONFLICT");
    expect((await body(await call("/internal/c1/update-member", { ...update, request_id: "update_member_003",
      season_id: "season_other_2026" }, "POST", testEnv))).error.code).toBe("MEMBER_NOT_FOUND");

    const stub = env.TEAM_STATE.getByName(testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const rows = context.storage.sql.exec<{ topic: string; status: string }>(
        "SELECT topic, status FROM sync_outbox WHERE topic='CORE_CHANGED' ORDER BY created_at"
      ).toArray();
      expect(rows).toEqual([{ topic: "CORE_CHANGED", status: "PENDING" }, { topic: "CORE_CHANGED", status: "PENDING" }]);
    });
  });

  it("rejects method and runtime-type mismatches before business mutation", async () => {
    const wrongMethod = await call("/internal/c1/create-season?request_id=wrong_method_001", undefined, "GET");
    expect(wrongMethod.status).toBe(405);
    const invalid = await call("/internal/c1/import-core", {
      ...(await snapshot("invalid_types_001", { source_snapshot_id: "snapshot_invalid_001" })), settings_version: "3"
    });
    expect((await body(invalid))).toMatchObject({ error: { code: "INVALID_REQUEST", retryable: false },
      meta: { request_id: "invalid_types_001", contract_version: C1_CONTRACT_VERSION } });
  });
});
