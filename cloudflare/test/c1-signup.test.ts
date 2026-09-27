import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { legacyCredentialDigest } from "../src/crypto";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { TeamState } from "../src/team-state";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const BASE = "https://example.test";
const HEADERS = { authorization: "Bearer local-c1-test-key", "content-type": "application/json" };
const teamEnv = (name: string) => ({ ...env, TEAM_ID: `c13-${name}` } as unknown as Env);

async function call(path: string, payload?: Record<string, unknown>, method = payload ? "POST" : "GET", testEnv: Env = env) {
  return worker.fetch(new IncomingRequest(`${BASE}${path}`, {
    method, headers: HEADERS, ...(payload ? { body: JSON.stringify(payload) } : {})
  }), testEnv);
}

async function json(response: Response): Promise<any> { return response.json(); }

async function ok(response: Response): Promise<any> {
  const value = await json(response);
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(value.ok, JSON.stringify(value)).toBe(true);
  return value.data;
}

async function errorCode(response: Response): Promise<string> {
  const value = await json(response);
  expect(value.ok, JSON.stringify(value)).toBe(false);
  return value.error.code;
}

interface Fixture {
  testEnv: Env;
  token: string;
  seasonId: string;
  practiceId: string;
  practiceVersion: number;
  signupVersion: number;
  members: string[];
  requestSequence: number;
}

async function setup(name: string, memberCount = 30, leftCapacity = 10, rightCapacity = 10): Promise<Fixture> {
  const testEnv = teamEnv(name);
  const at = "2026-09-21T12:00:00.000Z";
  const seasonId = "season_signup_2098";
  const practiceId = "practice_signup_001";
  const members = Array.from({ length: memberCount }, (_, index) => `member_${String(index + 1).padStart(3, "0")}`);
  await ok(await call("/internal/c1/import-core", {
    request_id: `core_${name}_001`, source_snapshot_id: `core_snapshot_${name}_001`,
    settings_version: 1, default_season_id: seasonId,
    coaches: [{ coach_id: "coach_liu_yang", display_name: "刘阳", code_salt: "salt_fixture_001",
      code_digest: await legacyCredentialDigest("salt_fixture_001", "local-test-coach-code", "local-c1-coach-secret"),
      credential_version: 1, active: true, created_at: at, updated_at: at }],
    seasons: [{ season_id: seasonId, name: "Signup 2098", start_date: "2098-03-01", end_date: "2098-12-31",
      timezone: "America/New_York", season_ends_at: "2099-01-01T05:00:00.000Z", status: "OPEN",
      binding_version: 1, season_version: 1, roster_version: 1, created_by: "coach_liu_yang",
      created_at: at, updated_at: at }],
    members: members.map((member_id, index) => ({ season_id: seasonId, member_id,
      source_key: `source-${index + 1}`, source_display_name: `Member ${index + 1}`,
      display_name_override: "", status: "ACTIVE", default_preference: "AMBIENT",
      member_version: 1, created_at: at, updated_at: at }))
  }, "POST", testEnv));
  const login = await ok(await call("/internal/c1/coach-login", {
    request_id: `login_${name}_001`, coach_code: "local-test-coach-code"
  }, "POST", testEnv));
  await ok(await call("/internal/c1/import-schedule", {
    request_id: `schedule_${name}_001`, source_snapshot_id: `schedule_snapshot_${name}_001`, templates: [],
    weeks: [{ season_id: seasonId, week_id: "week_signup_20980505", week_start_date: "2098-05-05",
      scheduled_open_at: "2098-05-01T14:00:00.000Z", status: "OPENED", week_version: 2,
      confirmed_version: 2, confirmed_by: "coach_liu_yang", confirmed_at: at,
      published_at: at, created_at: at, updated_at: at }],
    practices: [{ season_id: seasonId, practice_id: practiceId, week_id: "week_signup_20980505",
      template_id: null, generation_key: "signup:fixture:001", start_at: "2098-05-07T22:00:00.000Z",
      end_at: "2098-05-08T00:00:00.000Z", timezone: "America/New_York",
      location: "River Dock", address: "1 River Road", map_url: "", left_capacity: leftCapacity,
      right_capacity: rightCapacity, signup_cutoff_at: "2098-05-07T20:00:00.000Z", practice_version: 2,
      cancelled_at: null, cancelled_by: null, schedule_published_at: at,
      schedule_published_by: "coach_liu_yang", created_at: at, updated_at: at }]
  }, "POST", testEnv));
  return { testEnv, token: login.result.session_token, seasonId, practiceId,
    practiceVersion: 2, signupVersion: 0, members, requestSequence: 0 };
}

async function practice(fixture: Fixture, label: string) {
  return ok(await call(`/internal/c1/public-practice?request_id=view_${label}_001&season_id=${fixture.seasonId}` +
    `&practice_id=${fixture.practiceId}`, undefined, "GET", fixture.testEnv));
}

async function mutate(fixture: Fixture, path: string, memberIndex: number, preference?: "LEFT" | "AMBIENT" | "RIGHT",
  overrides: Record<string, unknown> = {}) {
  fixture.requestSequence += 1;
  const management = path.endsWith("-by-coach");
  const payload: Record<string, unknown> = {
    request_id: `signup_${fixture.requestSequence.toString().padStart(4, "0")}_${memberIndex.toString().padStart(3, "0")}`,
    season_id: fixture.seasonId, practice_id: fixture.practiceId, member_id: fixture.members[memberIndex],
    practice_version: fixture.practiceVersion, signup_version: fixture.signupVersion,
    ...(preference ? { preference } : {}), ...(management ? { session_token: fixture.token } : {}), ...overrides
  };
  const response = await call(`/internal/c1/${path}`, payload, "POST", fixture.testEnv);
  if (response.status === 200) {
    const data = await ok(response);
    fixture.signupVersion = data.result.signup_version;
    return { data, payload };
  }
  return { response, payload };
}

async function fill(fixture: Fixture, start: number, count: number, preference: "LEFT" | "AMBIENT" | "RIGHT") {
  const results = [];
  for (let index = start; index < start + count; index += 1) {
    const result = await mutate(fixture, "signup", index, preference);
    expect(result.data?.result.signup.status).toBe("CONFIRMED");
    results.push(result.data.result.signup);
  }
  return results;
}

describe("C1.3 signup and waitlist migration slice", () => {
  it("captures promotions, cancellation and re-signup before later edits can replace them", async () => {
    const fixture = await setup("captured-transitions", 3, 1, 1);
    await mutate(fixture, "signup", 0, "LEFT");
    await mutate(fixture, "signup", 1, "LEFT");
    const moved = await mutate(fixture, "update-signup", 0, "RIGHT");
    expect(moved.data.result.promoted_member_ids).toEqual([fixture.members[1]]);
    await mutate(fixture, "cancel-signup", 0);
    await mutate(fixture, "signup", 0, "RIGHT");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const events = context.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM sync_outbox WHERE topic='SIGNUPS_CHANGED' ORDER BY rowid").toArray()
        .map((row) => JSON.parse(row.payload_json).entity);
      expect(events).toHaveLength(5);
      expect(events.every((event: any) => event.snapshot_schema === 1)).toBe(true);
      expect(events.map((event: any) => event.signup_version)).toEqual([1, 2, 3, 4, 5]);
      expect(events.every((event: any) => event.practice_version === 2)).toBe(true);
      expect(events[0].signup_rows).toMatchObject([{ member_id: fixture.members[0],
        preference: "LEFT", status: "CONFIRMED", queue_sequence: 1 }]);
      expect(events[1].signup_rows).toMatchObject([{ member_id: fixture.members[1],
        preference: "LEFT", status: "WAITLISTED", queue_sequence: 2 }]);
      expect(events[2].signup_rows).toMatchObject([
        { member_id: fixture.members[0], preference: "RIGHT", status: "CONFIRMED", queue_sequence: 1 },
        { member_id: fixture.members[1], preference: "LEFT", status: "CONFIRMED", queue_sequence: 2 }
      ]);
      expect(events[2].signup_rows.map((row: any) => row.last_request_id))
        .toEqual([moved.payload.request_id, moved.payload.request_id]);
      expect(Object.keys(events[2].signup_rows[0]).sort()).toEqual([
        "last_request_id", "member_id", "practice_id", "preference", "queue_at",
        "queue_sequence", "season_id", "status", "updated_at"
      ]);
      expect(events[3].signup_rows).toMatchObject([{ member_id: fixture.members[0],
        status: "CANCELLED", queue_sequence: 1 }]);
      expect(events[4].signup_rows).toMatchObject([{ member_id: fixture.members[0],
        status: "CONFIRMED", queue_sequence: 3 }]);
      const current = context.storage.sql.exec<{ member_id: string; preference: string }>(
        "SELECT member_id,preference FROM signups WHERE season_id=? AND practice_id=? AND member_id=?",
        fixture.seasonId, fixture.practiceId, fixture.members[0]).one();
      expect(current.preference).toBe("RIGHT");
      expect(events[0].signup_rows[0].preference).toBe("LEFT");
    });
  });

  it("upgrades schema v3 in place and exposes an empty public practice view", async () => {
    const fixture = await setup("schema", 2);
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("DROP TABLE signup_migration_snapshots").toArray();
      context.storage.sql.exec("DROP TABLE signup_rate_limits").toArray();
      context.storage.sql.exec("DROP TABLE signups").toArray();
      context.storage.sql.exec("ALTER TABLE practice_versions DROP COLUMN signup_sequence").toArray();
      context.storage.sql.exec("UPDATE app_meta SET value='3' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(context.storage.sql.exec<{ value: string }>("SELECT value FROM app_meta WHERE key='schema_version'").one().value)
        .toBe(String(APPLICATION_SCHEMA_VERSION));
      expect(context.storage.sql.exec("SELECT * FROM signups").toArray()).toEqual([]);
      expect(context.storage.sql.exec("SELECT signup_sequence FROM practice_versions").one().signup_sequence).toBe(0);
    });
    const view = await practice(fixture, "schema");
    expect(view).toMatchObject({ signup_version: 0, signup_open: true, management_signup_open: true,
      counts: { confirmed: 0, waitlisted: 0 }, signups: [],
      seat_plan: { status: "UNPUBLISHED", published_revision: 0, seats: [] } });
  });

  it("never exceeds the last seat and returns a current view with deterministic promotion", async () => {
    const fixture = await setup("capacity", 22);
    await fill(fixture, 0, 20, "AMBIENT");
    const firstWaiter = await mutate(fixture, "signup", 20, "AMBIENT");
    const secondWaiter = await mutate(fixture, "signup", 21, "AMBIENT");
    expect(firstWaiter.data.result.signup.status).toBe("WAITLISTED");
    expect(secondWaiter.data.result.signup.status).toBe("WAITLISTED");
    const cancelled = await mutate(fixture, "cancel-signup", 0);
    expect(cancelled.data.result.promoted_member_ids).toEqual([fixture.members[20]]);
    expect(cancelled.data.current_view).toMatchObject({ counts: { confirmed: 20, waitlisted: 1 } });
    expect(cancelled.data.current_view.signups.find((row: any) => row.member_id === fixture.members[20]).status)
      .toBe("CONFIRMED");
    const preview = await ok(await call("/internal/c1/preview-practice-change", {
      request_id: "preview_capacity_001", session_token: fixture.token, season_id: fixture.seasonId,
      practice_id: fixture.practiceId, change: "CANCEL"
    }, "POST", fixture.testEnv));
    expect(preview).toMatchObject({ confirmed_count: 20, waitlisted_count: 1,
      signup_version: fixture.signupVersion });
  });

  it("uses Ambient flexibility while preserving the earliest feasible waiter", async () => {
    const fixture = await setup("sides", 23);
    await fill(fixture, 0, 10, "LEFT");
    await fill(fixture, 10, 10, "RIGHT");
    const ambient = await mutate(fixture, "signup", 20, "AMBIENT");
    const left = await mutate(fixture, "signup", 21, "LEFT");
    const right = await mutate(fixture, "signup", 22, "RIGHT");
    expect([ambient.data.result.signup.status, left.data.result.signup.status, right.data.result.signup.status])
      .toEqual(["WAITLISTED", "WAITLISTED", "WAITLISTED"]);
    expect((await mutate(fixture, "cancel-signup", 0)).data.result.promoted_member_ids).toEqual([fixture.members[20]]);
    expect((await mutate(fixture, "cancel-signup", 10)).data.result.promoted_member_ids).toEqual([fixture.members[21]]);
    const view = await practice(fixture, "sides");
    expect(view.signups.find((row: any) => row.member_id === fixture.members[22]).status).toBe("WAITLISTED");
  });

  it("preserves queue identity on a side change without reclaiming an occupied former side", async () => {
    const fixture = await setup("preference", 21);
    const original = await fill(fixture, 0, 10, "LEFT");
    await fill(fixture, 10, 10, "RIGHT");
    const waiter = await mutate(fixture, "signup", 20, "LEFT");
    const changed = await mutate(fixture, "update-signup", 0, "RIGHT");
    expect(changed.data.result.signup).toMatchObject({ status: "WAITLISTED", preference: "RIGHT",
      queue_at: original[0].queue_at, queue_sequence: original[0].queue_sequence });
    expect(changed.data.result.promoted_member_ids).toEqual([fixture.members[20]]);
    const returned = await mutate(fixture, "update-signup", 0, "LEFT");
    expect(returned.data.result.signup.status).toBe("WAITLISTED");
    expect(returned.data.result.promoted_member_ids).toEqual([]);
    expect((await mutate(fixture, "cancel-signup", 20)).data.result.promoted_member_ids).toEqual([fixture.members[0]]);
    expect(waiter.data.result.signup.queue_sequence).toBeGreaterThan(original[0].queue_sequence);
  });

  it("gives a cancelled re-registration a new queue and preserves immutable request replay", async () => {
    const fixture = await setup("rejoin", 3);
    const first = await mutate(fixture, "signup", 0, "AMBIENT");
    const firstPayload = first.payload;
    await mutate(fixture, "signup", 1, "AMBIENT");
    await mutate(fixture, "cancel-signup", 0);
    const rejoined = await mutate(fixture, "signup", 0, "LEFT");
    expect(rejoined.data.result.signup.queue_sequence).toBe(3);
    expect(rejoined.data.result.signup.queue_at.localeCompare(first.data.result.signup.queue_at)).toBeGreaterThanOrEqual(0);
    const replay = await ok(await call("/internal/c1/signup", firstPayload, "POST", fixture.testEnv));
    expect(replay.result.signup.queue_sequence).toBe(1);
    expect(replay.current_view.signup_version).toBe(fixture.signupVersion);
    expect(await errorCode(await call("/internal/c1/signup", { ...firstPayload, preference: "RIGHT" }, "POST", fixture.testEnv)))
      .toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects a stale last-seat contender and lets a refreshed retry join the waitlist", async () => {
    const fixture = await setup("race", 2, 1, 1);
    const staleVersion = fixture.signupVersion;
    await mutate(fixture, "signup", 0, "LEFT");
    const stale = await mutate(fixture, "signup", 1, "LEFT", { signup_version: staleVersion });
    expect(await errorCode(stale.response!)).toBe("VERSION_CONFLICT");
    const refreshed = await mutate(fixture, "signup", 1, "LEFT");
    expect(refreshed.data.result.signup.status).toBe("WAITLISTED");
  });

  it("lets a Coach act after the public cutoff but stops everyone at training end", async () => {
    const fixture = await setup("cutoff", 2);
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE practices SET signup_cutoff_at='2020-01-01T00:00:00.000Z'").toArray();
    });
    expect(await errorCode((await mutate(fixture, "signup", 0, "LEFT")).response!)).toBe("SIGNUP_CLOSED");
    const managed = await mutate(fixture, "signup-by-coach", 0, "LEFT");
    expect(managed.data.result.signup.status).toBe("CONFIRMED");
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE practices SET end_at='2020-01-01T00:00:00.000Z'").toArray();
    });
    expect(await errorCode((await mutate(fixture, "cancel-signup-by-coach", 0)).response!)).toBe("PRACTICE_ENDED");
  });

  it("binds schedule previews to the current signup version", async () => {
    const fixture = await setup("preview", 2);
    await mutate(fixture, "signup", 0, "LEFT");
    const preview = await ok(await call("/internal/c1/preview-practice-change", {
      request_id: "preview_signup_version_001", session_token: fixture.token, season_id: fixture.seasonId,
      practice_id: fixture.practiceId, change: "CANCEL"
    }, "POST", fixture.testEnv));
    await mutate(fixture, "signup", 1, "RIGHT");
    expect(await errorCode(await call("/internal/c1/cancel-practice", {
      request_id: "cancel_stale_signup_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: "week_signup_20980505", practice_id: fixture.practiceId,
      week_version: preview.week_version, practice_version: preview.practice_version,
      signup_version: preview.signup_version, preview_token: preview.preview_token
    }, "POST", fixture.testEnv))).toBe("PREVIEW_STALE");
    expect((await practice(fixture, "preview_still_public")).signups).toHaveLength(2);
  });

  it("rejects cross-season, unpublished and cancelled training mutations", async () => {
    const fixture = await setup("visibility", 2);
    expect(await errorCode((await mutate(fixture, "signup", 0, "LEFT",
      { season_id: "season_other_2098" })).response!)).toBe("PRACTICE_NOT_PUBLIC");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE practices SET schedule_published_at=NULL, schedule_published_by=NULL WHERE season_id=? AND practice_id=?",
        fixture.seasonId, fixture.practiceId).toArray();
    });
    expect(await errorCode((await mutate(fixture, "signup", 0, "LEFT")).response!)).toBe("PRACTICE_NOT_PUBLIC");
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE practices SET schedule_published_at=?, schedule_published_by='coach_liu_yang', cancelled_at=?, cancelled_by='coach_liu_yang' WHERE season_id=? AND practice_id=?",
        "2026-09-21T12:00:00.000Z", "2026-09-21T13:00:00.000Z", fixture.seasonId, fixture.practiceId).toArray();
    });
    expect(await errorCode((await mutate(fixture, "signup", 0, "LEFT")).response!)).toBe("PRACTICE_NOT_PUBLIC");
    expect(await errorCode(await call(`/internal/c1/public-practice?request_id=cancelled_view_001&season_id=${fixture.seasonId}` +
      `&practice_id=${fixture.practiceId}`, undefined, "GET", fixture.testEnv))).toBe("PRACTICE_NOT_PUBLIC");
  });

  it("blocks member deactivation until active training links are removed", async () => {
    const fixture = await setup("inactive", 2);
    await mutate(fixture, "signup", 0, "LEFT");
    const at = "2026-09-21T12:00:00.000Z";
    expect(await errorCode(await call("/internal/c1/import-core", {
      request_id: "inactive_import_001", source_snapshot_id: "inactive_import_snapshot_001",
      settings_version: 1, default_season_id: fixture.seasonId,
      coaches: [{ coach_id: "coach_liu_yang", display_name: "刘阳", code_salt: "salt_fixture_001",
        code_digest: await legacyCredentialDigest("salt_fixture_001", "local-test-coach-code", "local-c1-coach-secret"),
        credential_version: 1, active: true, created_at: at, updated_at: at }],
      seasons: [{ season_id: fixture.seasonId, name: "Signup 2098", start_date: "2098-03-01", end_date: "2098-12-31",
        timezone: "America/New_York", season_ends_at: "2099-01-01T05:00:00.000Z", status: "OPEN",
        binding_version: 1, season_version: 1, roster_version: 1, created_by: "coach_liu_yang",
        created_at: at, updated_at: at }],
      members: [{ season_id: fixture.seasonId, member_id: fixture.members[0], source_key: "source-1",
        source_display_name: "Member 1", display_name_override: "", status: "INACTIVE",
        default_preference: "AMBIENT", member_version: 2, created_at: at,
        updated_at: "2026-09-21T13:00:00.000Z" }]
    }, "POST", fixture.testEnv))).toBe("IMPORT_CONFLICT");
    const update = (request_id: string, member_version: number, status: string) => call("/internal/c1/update-member", {
      request_id, session_token: fixture.token, season_id: fixture.seasonId,
      member_id: fixture.members[0], member_version, status
    }, "POST", fixture.testEnv);
    expect(await errorCode(await update("inactive_blocked_001", 1, "INACTIVE"))).toBe("MEMBER_HAS_ACTIVE_LINKS");
    await mutate(fixture, "cancel-signup-by-coach", 0);
    const disabled = await ok(await update("inactive_allowed_001", 1, "INACTIVE"));
    expect(disabled.result.member.status).toBe("INACTIVE");
    expect(await errorCode((await mutate(fixture, "signup", 0, "RIGHT")).response!)).toBe("MEMBER_INACTIVE");
  });

  it("imports a versioned signup snapshot without producing Google outbox work and rejects drift", async () => {
    const fixture = await setup("import", 3, 1, 1);
    const at = "2026-09-21T12:00:00.000Z";
    const snapshot: any = {
      request_id: "import_signups_001", source_snapshot_id: "snapshot_signups_001",
      states: [{ season_id: fixture.seasonId, practice_id: fixture.practiceId,
        signup_version: 1, signup_sequence: 3 }],
      signups: [
        { season_id: fixture.seasonId, practice_id: fixture.practiceId, member_id: fixture.members[0],
          preference: "LEFT", status: "CONFIRMED", queue_at: at, queue_sequence: 1,
          updated_at: at, last_request_id: "legacy_signup_001" },
        { season_id: fixture.seasonId, practice_id: fixture.practiceId, member_id: fixture.members[1],
          preference: "RIGHT", status: "CONFIRMED", queue_at: at, queue_sequence: 2,
          updated_at: at, last_request_id: "legacy_signup_002" },
        { season_id: fixture.seasonId, practice_id: fixture.practiceId, member_id: fixture.members[2],
          preference: "AMBIENT", status: "WAITLISTED", queue_at: at, queue_sequence: 3,
          updated_at: at, last_request_id: "legacy_signup_003" }
      ]
    };
    const imported = await ok(await call("/internal/c1/import-signups", snapshot, "POST", fixture.testEnv));
    expect(imported.result).toMatchObject({ states: 1, signups: 3 });
    expect((await practice(fixture, "import")).counts).toMatchObject({ confirmed: 2, waitlisted: 1 });
    expect((await ok(await call("/internal/c1/import-signups", snapshot, "POST", fixture.testEnv))).result).toEqual(imported.result);
    const drift = { ...snapshot, request_id: "import_signups_002", source_snapshot_id: "snapshot_signups_002",
      signups: snapshot.signups.map((row: any, index: number) => index === 0 ? { ...row, preference: "AMBIENT" } : row) };
    expect(await errorCode(await call("/internal/c1/import-signups", drift, "POST", fixture.testEnv))).toBe("IMPORT_CONFLICT");
    const regression = { ...snapshot, request_id: "import_signups_003", source_snapshot_id: "snapshot_signups_003",
      states: [{ ...snapshot.states[0], signup_version: 0 }] };
    expect(await errorCode(await call("/internal/c1/import-signups", regression, "POST", fixture.testEnv)))
      .toBe("IMPORT_VERSION_REGRESSION");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_outbox WHERE topic='SIGNUPS_CHANGED'").one().count).toBe(0);
    });
  });

  it("orders imported offset timestamps by the actual instant for waitlist display and promotion", async () => {
    const fixture = await setup("offset-order", 4, 1, 1);
    const at = "2026-09-21T12:00:00.000Z";
    await ok(await call("/internal/c1/import-signups", {
      request_id: "import_offset_signups_001", source_snapshot_id: "snapshot_offset_signups_001",
      states: [{ season_id: fixture.seasonId, practice_id: fixture.practiceId,
        signup_version: 1, signup_sequence: 4 }],
      signups: [
        { season_id: fixture.seasonId, practice_id: fixture.practiceId, member_id: fixture.members[0],
          preference: "LEFT", status: "CONFIRMED", queue_at: at, queue_sequence: 1,
          updated_at: at, last_request_id: "legacy_offset_001" },
        { season_id: fixture.seasonId, practice_id: fixture.practiceId, member_id: fixture.members[1],
          preference: "RIGHT", status: "CONFIRMED", queue_at: at, queue_sequence: 2,
          updated_at: at, last_request_id: "legacy_offset_002" },
        { season_id: fixture.seasonId, practice_id: fixture.practiceId, member_id: fixture.members[2],
          preference: "LEFT", status: "WAITLISTED", queue_at: "2098-05-07T10:00:00.000-05:00",
          queue_sequence: 3, updated_at: "2098-05-07T15:00:00.000Z", last_request_id: "legacy_offset_003" },
        { season_id: fixture.seasonId, practice_id: fixture.practiceId, member_id: fixture.members[3],
          preference: "AMBIENT", status: "WAITLISTED", queue_at: "2098-05-07T14:30:00.000Z",
          queue_sequence: 4, updated_at: "2098-05-07T14:30:00.000Z", last_request_id: "legacy_offset_004" }
      ]
    }, "POST", fixture.testEnv));
    fixture.signupVersion = 1;
    const before = await practice(fixture, "offset_before");
    expect(before.signups.filter((row: any) => row.status === "WAITLISTED")
      .map((row: any) => [row.member_id, row.waitlist_position])).toEqual([
      [fixture.members[3], 1], [fixture.members[2], 2]
    ]);
    const cancelled = await mutate(fixture, "cancel-signup-by-coach", 0);
    expect(cancelled.data.result.promoted_member_ids).toEqual([fixture.members[3]]);
  });

  it("rate-limits repeated public changes without charging an idempotent replay", async () => {
    const fixture = await setup("rate", 1);
    const first = await mutate(fixture, "signup", 0, "AMBIENT");
    await ok(await call("/internal/c1/signup", first.payload, "POST", fixture.testEnv));
    for (let index = 0; index < 11; index += 1) {
      const unchanged = await mutate(fixture, "update-signup", 0, "AMBIENT");
      expect(unchanged.data.result.signup_version).toBe(1);
    }
    expect(await errorCode((await mutate(fixture, "update-signup", 0, "AMBIENT")).response!))
      .toBe("SIGNUP_RATE_LIMITED");
  });
});
