import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { legacyCredentialDigest } from "../src/crypto";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { seatingMode } from "../src/c1-seating-service";
import { TeamState } from "../src/team-state";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const BASE = "https://example.test";
const HEADERS = { authorization: "Bearer local-c1-test-key", "content-type": "application/json" };
const teamEnv = (name: string) => ({ ...env, TEAM_ID: `c14-${name}` } as unknown as Env);

async function call(path: string, payload?: Record<string, unknown>, method = "POST", testEnv: Env = env) {
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
  members: string[];
  signupVersion: number;
  requestSequence: number;
}

async function setup(name: string, leftCapacity = 2, rightCapacity = 2, memberCount = 10): Promise<Fixture> {
  const testEnv = teamEnv(name);
  const at = "2026-09-21T12:00:00.000Z";
  const seasonId = "season_seating_2098";
  const practiceId = "practice_seating_001";
  const members = Array.from({ length: memberCount }, (_, index) => `member_${String(index + 1).padStart(3, "0")}`);
  await ok(await call("/internal/c1/import-core", {
    request_id: `core_${name}_001`, source_snapshot_id: `core_snapshot_${name}_001`,
    settings_version: 1, default_season_id: seasonId,
    coaches: [{ coach_id: "coach_liu_yang", display_name: "刘阳", code_salt: "salt_fixture_001",
      code_digest: await legacyCredentialDigest("salt_fixture_001", "local-test-coach-code", "local-c1-coach-secret"),
      credential_version: 1, active: true, created_at: at, updated_at: at }],
    seasons: [{ season_id: seasonId, name: "Seating 2098", start_date: "2098-03-01", end_date: "2098-12-31",
      timezone: "America/New_York", season_ends_at: "2099-01-01T05:00:00.000Z", status: "OPEN",
      binding_version: 1, season_version: 1, roster_version: 1, created_by: "coach_liu_yang",
      created_at: at, updated_at: at }],
    members: members.map((member_id, index) => ({ season_id: seasonId, member_id,
      source_key: `seat-source-${index + 1}`, source_display_name: `Member ${index + 1}`,
      display_name_override: "", status: "ACTIVE", default_preference: "AMBIENT",
      member_version: 1, created_at: at, updated_at: at }))
  }, "POST", testEnv));
  const login = await ok(await call("/internal/c1/coach-login", {
    request_id: `login_${name}_001`, coach_code: "local-test-coach-code"
  }, "POST", testEnv));
  await ok(await call("/internal/c1/import-schedule", {
    request_id: `schedule_${name}_001`, source_snapshot_id: `schedule_snapshot_${name}_001`, templates: [],
    weeks: [{ season_id: seasonId, week_id: "week_seating_20980505", week_start_date: "2098-05-05",
      scheduled_open_at: "2098-05-01T14:00:00.000Z", status: "OPENED", week_version: 2,
      confirmed_version: 2, confirmed_by: "coach_liu_yang", confirmed_at: at,
      published_at: at, created_at: at, updated_at: at }],
    practices: [{ season_id: seasonId, practice_id: practiceId, week_id: "week_seating_20980505",
      template_id: null, generation_key: "seating:fixture:001", start_at: "2098-05-07T22:00:00.000Z",
      end_at: "2098-05-08T00:00:00.000Z", timezone: "America/New_York",
      location: "River Dock", address: "1 River Road", map_url: "", left_capacity: leftCapacity,
      right_capacity: rightCapacity, signup_cutoff_at: "2098-05-07T20:00:00.000Z", practice_version: 2,
      cancelled_at: null, cancelled_by: null, schedule_published_at: at,
      schedule_published_by: "coach_liu_yang", created_at: at, updated_at: at }]
  }, "POST", testEnv));
  return { testEnv, token: login.result.session_token, seasonId, practiceId, members,
    signupVersion: 0, requestSequence: 0 };
}

async function publicPractice(fixture: Fixture, label: string) {
  return ok(await call(`/internal/c1/public-practice?request_id=view_${label}_001&season_id=${fixture.seasonId}` +
    `&practice_id=${fixture.practiceId}`, undefined, "GET", fixture.testEnv));
}

async function workspace(fixture: Fixture, label: string) {
  return ok(await call("/internal/c1/get-seating-workspace", {
    request_id: `workspace_${label}_001`, session_token: fixture.token,
    season_id: fixture.seasonId, practice_id: fixture.practiceId
  }, "POST", fixture.testEnv));
}

async function signup(fixture: Fixture, memberIndex: number, preference: "LEFT" | "AMBIENT" | "RIGHT",
  action = "signup") {
  fixture.requestSequence += 1;
  const management = action.endsWith("-by-coach");
  const response = await call(`/internal/c1/${action}`, {
    request_id: `signup_${fixture.requestSequence.toString().padStart(4, "0")}_${memberIndex}`,
    ...(management ? { session_token: fixture.token } : {}), season_id: fixture.seasonId,
    practice_id: fixture.practiceId, member_id: fixture.members[memberIndex], practice_version: 2,
    signup_version: fixture.signupVersion, ...(action.includes("cancel") ? {} : { preference })
  }, "POST", fixture.testEnv);
  if (response.status !== 200) return { response };
  const data = await ok(response);
  fixture.signupVersion = data.result.signup_version;
  return { data };
}

async function saveDraft(fixture: Fixture, label: string, seats: Array<{ row_number: number; side: "LEFT" | "RIGHT"; member_id: string }>,
  coachMemberId = "", steererMemberId = "", overrides: Record<string, unknown> = {}) {
  const view = await workspace(fixture, `${label}_before_save`);
  const payload = { request_id: `save_${label}_001`, session_token: fixture.token,
    season_id: fixture.seasonId, practice_id: fixture.practiceId, practice_version: 2,
    signup_version: view.signup_version, seat_plan_version: view.seat_plan_version,
    coach_member_id: coachMemberId, steerer_member_id: steererMemberId,
    seats, change_kind: "EDIT", ...overrides };
  const response = await call("/internal/c1/save-seat-plan-draft", payload, "POST", fixture.testEnv);
  return { response, payload, view };
}

async function publish(fixture: Fixture, label: string, acknowledge = false, overrides: Record<string, unknown> = {}) {
  const view = await workspace(fixture, `${label}_before_publish`);
  const payload = { request_id: `publish_${label}_001`, session_token: fixture.token,
    season_id: fixture.seasonId, practice_id: fixture.practiceId, practice_version: 2,
    signup_version: view.signup_version, seat_plan_version: view.seat_plan_version,
    published_revision: view.published_revision, acknowledge_preference_mismatch: acknowledge, ...overrides };
  const response = await call("/internal/c1/publish-seat-plan", payload, "POST", fixture.testEnv);
  return { response, payload, view };
}

describe("C1.4 seating migration slice", () => {
  it("upgrades schema v4 in place and exposes private empty seating plus a public unpublished plan", async () => {
    const fixture = await setup("schema");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      for (const table of ["seating_migration_snapshots", "seat_plan_revision_names", "seat_plan_revision_seats",
        "seat_plan_revisions", "seat_plan_draft_seats", "seat_plan_states"]) {
        context.storage.sql.exec(`DROP TABLE ${table}`).toArray();
      }
      context.storage.sql.exec("UPDATE app_meta SET value='4' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(context.storage.sql.exec<{ value: string }>("SELECT value FROM app_meta WHERE key='schema_version'").one().value)
        .toBe(String(APPLICATION_SCHEMA_VERSION));
    });
    expect(await workspace(fixture, "schema")).toMatchObject({ mode: "UPCOMING", editable: true,
      seat_plan_version: 0, published_revision: 0, draft: { seats: [] }, published: null });
    expect((await publicPractice(fixture, "schema")).seat_plan).toMatchObject({
      status: "UNPUBLISHED", published_revision: 0, seats: []
    });
  });

  it("keeps a complete Coach draft private and preserves immutable manual revisions", async () => {
    const fixture = await setup("manual");
    await signup(fixture, 0, "LEFT");
    await signup(fixture, 1, "RIGHT");
    const saved = await saveDraft(fixture, "manual_first", [
      { row_number: 1, side: "LEFT", member_id: fixture.members[0] },
      { row_number: 1, side: "RIGHT", member_id: fixture.members[1] }
    ], fixture.members[2], fixture.members[2]);
    expect((await ok(saved.response)).current_view).toMatchObject({ seat_plan_version: 1,
      draft: { coach_member_id: fixture.members[2], steerer_member_id: fixture.members[2] } });
    expect((await publicPractice(fixture, "manual_private")).seat_plan).toMatchObject({ status: "UNPUBLISHED", seats: [] });
    const first = await publish(fixture, "manual_first");
    expect((await ok(first.response)).current_view).toMatchObject({ published_revision: 1 });
    const publicOne = (await publicPractice(fixture, "manual_one")).seat_plan;
    expect(publicOne).toMatchObject({ status: "PUBLISHED", published_revision: 1,
      coach: { display_name: "Member 3" }, steerer: { display_name: "Member 3" } });
    expect(publicOne.coach.member_id).toBeUndefined();
    const changed = await saveDraft(fixture, "manual_second", [
      { row_number: 2, side: "LEFT", member_id: fixture.members[0] },
      { row_number: 2, side: "RIGHT", member_id: fixture.members[1] }
    ]);
    await ok(changed.response);
    expect((await publicPractice(fixture, "manual_still_one")).seat_plan.published_revision).toBe(1);
    const reset = await saveDraft(fixture, "manual_reset", [], "", "", { change_kind: "RESET_TO_PUBLISHED" });
    const resetView = (await ok(reset.response)).current_view;
    expect(resetView.draft).toMatchObject({ coach_member_id: fixture.members[2],
      steerer_member_id: fixture.members[2] });
    expect(resetView.draft.seats.some((seat: any) => seat.row_number === 1 && seat.side === "LEFT" &&
      seat.member_id === fixture.members[0])).toBe(true);
    await ok((await saveDraft(fixture, "manual_second_after_reset", [
      { row_number: 2, side: "LEFT", member_id: fixture.members[0] },
      { row_number: 2, side: "RIGHT", member_id: fixture.members[1] }
    ])).response);
    expect((await ok((await publish(fixture, "manual_second")).response)).current_view.published_revision).toBe(2);
    await runInDurableObject(fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID),
      async (_instance: TeamState, context) => {
        const revisions = context.storage.sql.exec<any>(
          "SELECT revision_number, source FROM seat_plan_revisions ORDER BY revision_number").toArray();
        expect(revisions).toEqual([{ revision_number: 1, source: "MANUAL" }, { revision_number: 2, source: "MANUAL" }]);
        const firstSeats = context.storage.sql.exec<any>(
          "SELECT side, row_number, member_id FROM seat_plan_revision_seats WHERE revision_number=1 ORDER BY side").toArray();
        expect(firstSeats).toHaveLength(2);
        expect(firstSeats.some((seat) => seat.row_number === 1)).toBe(true);
      });
  });

  it("enforces roles, confirmed seats, completeness and explicit preference acknowledgement", async () => {
    const fixture = await setup("validation");
    await signup(fixture, 0, "LEFT");
    expect(await errorCode((await saveDraft(fixture, "role_conflict", [], fixture.members[0])).response))
      .toBe("ROLE_SIGNUP_CONFLICT");
    expect(await errorCode((await saveDraft(fixture, "unconfirmed", [
      { row_number: 1, side: "LEFT", member_id: fixture.members[1] }
    ])).response)).toBe("SEAT_MEMBER_NOT_CONFIRMED");
    await ok((await saveDraft(fixture, "empty", [])).response);
    expect(await errorCode((await publish(fixture, "incomplete")).response)).toBe("SEAT_PLAN_INCOMPLETE");
    await ok((await saveDraft(fixture, "wrong_side", [
      { row_number: 1, side: "RIGHT", member_id: fixture.members[0] }
    ], fixture.members[2], fixture.members[2])).response);
    expect(await errorCode((await publish(fixture, "needs_ack")).response)).toBe("PREFERENCE_ACK_REQUIRED");
    expect((await ok((await publish(fixture, "with_ack", true)).response)).current_view.published_revision).toBe(1);
  });

  it("cancels, promotes and revises matching public and draft seats in one signup transaction", async () => {
    const fixture = await setup("system", 1, 1, 4);
    await signup(fixture, 0, "LEFT");
    await signup(fixture, 1, "RIGHT");
    expect((await signup(fixture, 2, "LEFT")).data.result.signup.status).toBe("WAITLISTED");
    await ok((await saveDraft(fixture, "system", [
      { row_number: 1, side: "LEFT", member_id: fixture.members[0] },
      { row_number: 1, side: "RIGHT", member_id: fixture.members[1] }
    ])).response);
    await ok((await publish(fixture, "system")).response);
    const cancelled = await signup(fixture, 0, "LEFT", "cancel-signup");
    expect(cancelled.data.result).toMatchObject({ promoted_member_ids: [fixture.members[2]],
      seat_plan_version: 2, published_revision: 2 });
    const view = cancelled.data.current_view;
    expect(view.seat_plan.rows[0].left.member_id).toBe(fixture.members[2]);
    const managed = await workspace(fixture, "system_after");
    expect(managed.draft.seats.find((seat: any) => seat.side === "LEFT").member_id).toBe(fixture.members[2]);
    await runInDurableObject(fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID),
      async (_instance: TeamState, context) => {
        const revisions = context.storage.sql.exec<any>(
          "SELECT revision_number, source FROM seat_plan_revisions ORDER BY revision_number").toArray();
        expect(revisions).toEqual([{ revision_number: 1, source: "MANUAL" },
          { revision_number: 2, source: "SYSTEM_CANCELSIGNUP" }]);
      });
  });

  it("does not overwrite a Coach-diverged draft while applying a public system promotion", async () => {
    const fixture = await setup("diverged", 2, 1, 5);
    await signup(fixture, 0, "LEFT");
    await signup(fixture, 1, "LEFT");
    await signup(fixture, 2, "RIGHT");
    await signup(fixture, 3, "LEFT");
    await ok((await saveDraft(fixture, "diverged_public", [
      { row_number: 1, side: "LEFT", member_id: fixture.members[0] },
      { row_number: 2, side: "LEFT", member_id: fixture.members[1] },
      { row_number: 1, side: "RIGHT", member_id: fixture.members[2] }
    ])).response);
    await ok((await publish(fixture, "diverged_public")).response);
    await ok((await saveDraft(fixture, "diverged_private", [
      { row_number: 1, side: "LEFT", member_id: fixture.members[1] },
      { row_number: 2, side: "LEFT", member_id: fixture.members[0] },
      { row_number: 1, side: "RIGHT", member_id: fixture.members[2] }
    ])).response);
    const cancelled = await signup(fixture, 0, "LEFT", "cancel-signup-by-coach");
    expect(cancelled.data.result.promoted_member_ids).toEqual([fixture.members[3]]);
    expect(cancelled.data.current_view.seat_plan.rows[0].left.member_id).toBe(fixture.members[3]);
    const managed = await workspace(fixture, "diverged_after");
    expect(managed.draft.seats.some((seat: any) => seat.member_id === fixture.members[3])).toBe(false);
    expect(managed.unseated_member_ids).toContain(fixture.members[3]);
    expect(managed.draft.seats.find((seat: any) => seat.side === "LEFT" && seat.row_number === 1).member_id)
      .toBe(fixture.members[1]);
  });

  it("removes an incompatible old seat on a preference change without auto-placing the member", async () => {
    const fixture = await setup("preference", 1, 1, 3);
    await signup(fixture, 0, "LEFT");
    await ok((await saveDraft(fixture, "preference", [
      { row_number: 1, side: "LEFT", member_id: fixture.members[0] }
    ])).response);
    await ok((await publish(fixture, "preference")).response);
    const changed = await signup(fixture, 0, "RIGHT", "update-signup");
    expect(changed.data.result.signup.status).toBe("CONFIRMED");
    expect(changed.data.result.published_revision).toBe(2);
    expect(changed.data.current_view.seat_plan.seats).toEqual([]);
    const managed = await workspace(fixture, "preference_after");
    expect(managed.unseated_member_ids).toContain(fixture.members[0]);
    expect(managed.draft.seats).toEqual([]);
  });

  it("supports final correction without changing signups and rejects writes at the exact frozen boundary", async () => {
    const fixture = await setup("final");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    const finalEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE practices SET end_at=? WHERE season_id=? AND practice_id=?",
        finalEnd, fixture.seasonId, fixture.practiceId).toArray();
    });
    const finalView = await workspace(fixture, "final_open");
    expect(finalView).toMatchObject({ mode: "FINAL_CORRECTION", editable: true, signups: [] });
    await ok((await saveDraft(fixture, "final", [
      { row_number: 1, side: "LEFT", member_id: fixture.members[0] }
    ], fixture.members[1], fixture.members[1])).response);
    expect((await ok((await publish(fixture, "final")).response)).current_view.published_revision).toBe(1);
    expect((await publicPractice(fixture, "final")).signups).toEqual([]);
    const exact = Date.parse("2026-09-21T12:00:00.000Z");
    expect(seatingMode({ end_at: new Date(exact - 24 * 60 * 60 * 1000).toISOString() }, exact)).toBe("FROZEN");
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE practices SET end_at=? WHERE season_id=? AND practice_id=?",
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), fixture.seasonId, fixture.practiceId).toArray();
    });
    expect(await workspace(fixture, "frozen")).toMatchObject({ mode: "FROZEN", editable: false });
    expect(await errorCode((await saveDraft(fixture, "frozen", [])).response)).toBe("SEAT_PLAN_FROZEN");
    expect(await errorCode((await publish(fixture, "frozen")).response)).toBe("SEAT_PLAN_FROZEN");
  });

  it("keeps role links active across draft clearing until the published role is replaced", async () => {
    const fixture = await setup("links");
    await ok((await saveDraft(fixture, "links_role", [], fixture.members[0], fixture.members[0])).response);
    await ok((await publish(fixture, "links_role")).response);
    expect(await errorCode((await signup(fixture, 0, "LEFT")).response!)).toBe("ROLE_SIGNUP_CONFLICT");
    await ok((await saveDraft(fixture, "links_clear", [])).response);
    const updateMember = (requestId: string, memberVersion: number) => call("/internal/c1/update-member", {
      request_id: requestId, session_token: fixture.token, season_id: fixture.seasonId,
      member_id: fixture.members[0], member_version: memberVersion, status: "INACTIVE"
    }, "POST", fixture.testEnv);
    expect(await errorCode(await updateMember("links_blocked_001", 1))).toBe("MEMBER_HAS_ACTIVE_LINKS");
    await ok((await publish(fixture, "links_clear")).response);
    expect((await ok(await updateMember("links_allowed_001", 1))).result.member.status).toBe("INACTIVE");
  });

  it("replays immutable saves while returning the newer workspace and rejects changed reuse", async () => {
    const fixture = await setup("replay");
    await signup(fixture, 0, "LEFT");
    const first = await saveDraft(fixture, "replay", [
      { row_number: 1, side: "LEFT", member_id: fixture.members[0] }
    ]);
    const firstData = await ok(first.response);
    await ok((await saveDraft(fixture, "replay_newer", [
      { row_number: 2, side: "LEFT", member_id: fixture.members[0] }
    ])).response);
    const replayed = await ok(await call("/internal/c1/save-seat-plan-draft", first.payload, "POST", fixture.testEnv));
    expect(replayed.result.seat_plan_version).toBe(firstData.result.seat_plan_version);
    expect(replayed.current_view.seat_plan_version).toBe(2);
    expect(await errorCode(await call("/internal/c1/save-seat-plan-draft", {
      ...first.payload, coach_member_id: fixture.members[2]
    }, "POST", fixture.testEnv))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await errorCode(await call("/internal/c1/save-seat-plan-draft", {
      ...first.payload, request_id: "save_replay_stale_001"
    }, "POST", fixture.testEnv))).toBe("VERSION_CONFLICT");
  });

  it("imports versioned drafts and immutable revisions without Google outbox work", async () => {
    const fixture = await setup("import", 1, 1, 5);
    await signup(fixture, 0, "LEFT");
    await signup(fixture, 1, "RIGHT");
    const at = "2026-09-21T12:00:00.000Z";
    const allSeats = [
      { season_id: fixture.seasonId, practice_id: fixture.practiceId, seat_plan_version: 1,
        row_number: 1, side: "LEFT", member_id: fixture.members[0] },
      { season_id: fixture.seasonId, practice_id: fixture.practiceId, seat_plan_version: 1,
        row_number: 1, side: "RIGHT", member_id: fixture.members[1] }
    ];
    const snapshot: any = {
      request_id: "import_seating_001", source_snapshot_id: "snapshot_seating_001",
      states: [{ season_id: fixture.seasonId, practice_id: fixture.practiceId, seat_plan_version: 1,
        published_revision: 1, coach_member_id: fixture.members[2], steerer_member_id: fixture.members[2],
        updated_by: "coach_liu_yang", updated_at: at }],
      draft_seats: allSeats,
      revisions: [{ season_id: fixture.seasonId, practice_id: fixture.practiceId,
        revision_number: 1, revision_id: "seat_revision_import_001", source: "MANUAL", seat_plan_version: 1,
        coach_member_id: fixture.members[2], steerer_member_id: fixture.members[2],
        seats: allSeats.map(({ row_number, side, member_id }) => ({ row_number, side, member_id })),
        names: [{ member_id: fixture.members[0], display_name: "Member 1" },
          { member_id: fixture.members[1], display_name: "Member 2" },
          { member_id: fixture.members[2], display_name: "Member 3" }],
        published_by: "coach_liu_yang", published_at: at, request_id: "legacy_publish_001" }]
    };
    expect((await ok(await call("/internal/c1/import-seating", snapshot, "POST", fixture.testEnv))).result)
      .toMatchObject({ states: 1, draft_seats: 2, revisions: 1 });
    expect(await workspace(fixture, "import")).toMatchObject({ seat_plan_version: 1, published_revision: 1,
      draft: { coach_member_id: fixture.members[2], steerer_member_id: fixture.members[2] } });
    expect((await publicPractice(fixture, "import")).seat_plan).toMatchObject({ status: "PUBLISHED", published_revision: 1 });
    expect((await ok(await call("/internal/c1/import-seating", snapshot, "POST", fixture.testEnv))).result.revisions).toBe(1);
    const drift = { ...snapshot, request_id: "import_seating_002", source_snapshot_id: "snapshot_seating_002",
      states: snapshot.states.map((state: any) => ({ ...state, coach_member_id: fixture.members[3] })) };
    expect(await errorCode(await call("/internal/c1/import-seating", drift, "POST", fixture.testEnv))).toBe("IMPORT_CONFLICT");
    const regression = { ...snapshot, request_id: "import_seating_003", source_snapshot_id: "snapshot_seating_003",
      states: snapshot.states.map((state: any) => ({ ...state, seat_plan_version: 0 })) };
    expect(await errorCode(await call("/internal/c1/import-seating", regression, "POST", fixture.testEnv)))
      .toBe("IMPORT_VERSION_REGRESSION");
    await runInDurableObject(fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID),
      async (_instance: TeamState, context) => {
        expect(context.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sync_outbox WHERE topic='SEATING_CHANGED'").one().count).toBe(0);
      });
  });
});
