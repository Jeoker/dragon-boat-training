import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { localDateTimeToIso } from "../../shared/c1-rules";
import { legacyCredentialDigest } from "../src/crypto";
import { SHEET_SCOPES } from "../src/c2-sheet-bridge";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { TeamState } from "../src/team-state";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const BASE = "https://example.test";
const HEADERS = { authorization: "Bearer local-c1-test-key", "content-type": "application/json" };
const teamEnv = (name: string) => ({ ...env, TEAM_ID: `c12-${name}` } as unknown as Env);

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
  expect(value.ok).toBe(false);
  return value.error.code;
}

async function setupCore(name: string) {
  const testEnv = teamEnv(name);
  const at = "2026-09-21T12:00:00.000Z";
  const imported = await call("/internal/c1/import-core", {
    request_id: `import_core_${name}_001`, source_snapshot_id: `snapshot_core_${name}_001`,
    settings_version: 1, default_season_id: "season_schedule_2027",
    coaches: [{ coach_id: "coach_liu_yang", display_name: "刘阳", code_salt: "salt_fixture_001",
      code_digest: await legacyCredentialDigest("salt_fixture_001", "local-test-coach-code", "local-c1-coach-secret"),
      credential_version: 1, active: true, created_at: at, updated_at: at }],
    seasons: [{ season_id: "season_schedule_2027", name: "Schedule 2027",
      start_date: "2027-03-01", end_date: "2027-12-31", timezone: "America/New_York",
      season_ends_at: "2028-01-01T05:00:00.000Z", status: "OPEN", binding_version: 1,
      season_version: 4, roster_version: 0, created_by: "coach_liu_yang", created_at: at, updated_at: at }],
    members: []
  }, "POST", testEnv);
  expect(imported.status).toBe(200);
  const login = await ok(await call("/internal/c1/coach-login", {
    request_id: `login_${name}_001`, coach_code: "local-test-coach-code"
  }, "POST", testEnv));
  return { testEnv, token: login.result.session_token as string, seasonId: "season_schedule_2027" };
}

const templates = [
  { day_of_week: 3, start_time: "18:00", end_time: "20:00", location: "River Dock",
    address: "1 River Road", map_url: "https://example.test/dock" },
  { day_of_week: 6, start_time: "10:00", end_time: "12:00", location: "Lake Dock",
    address: "2 Lake Road" }
];

async function setupWeek(name: string) {
  const core = await setupCore(name);
  const templateWrite = await ok(await call("/internal/c1/update-schedule-templates", {
    request_id: `templates_${name}_001`, session_token: core.token, season_id: core.seasonId,
    season_version: 4, templates
  }, "POST", core.testEnv));
  const prepared = await ok(await call("/internal/c1/prepare-training-week", {
    request_id: `prepare_${name}_001`, session_token: core.token, season_id: core.seasonId,
    season_version: templateWrite.result.season_version, week_start_date: "2027-05-03"
  }, "POST", core.testEnv));
  return { ...core, week: prepared.result.week, practices: prepared.result.practices };
}

async function publicSchedule(testEnv: Env, seasonId: string, requestId: string) {
  return ok(await call(`/internal/c1/public-schedule?request_id=${requestId}&season_id=${seasonId}`, undefined, "GET", testEnv));
}

describe("C1.2 schedule migration slice", () => {
  it("upgrades schema v2 in place and rejects nonexistent or ambiguous local times", async () => {
    const core = await setupCore("schema");
    const stub = core.testEnv.TEAM_STATE.getByName(core.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      for (const table of ["practice_versions", "practices", "training_weeks", "schedule_templates", "schedule_migration_snapshots"]) {
        context.storage.sql.exec(`DROP TABLE ${table}`).toArray();
      }
      context.storage.sql.exec("UPDATE app_meta SET value='2' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(context.storage.sql.exec<{ value: string }>("SELECT value FROM app_meta WHERE key='schema_version'").one().value)
        .toBe(String(APPLICATION_SCHEMA_VERSION));
      expect(context.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM seasons").one().count).toBe(1);
      expect(context.storage.sql.exec("SELECT * FROM training_weeks").toArray()).toEqual([]);
    });
    expect(() => localDateTimeToIso("2027-03-14", "02:30", "America/New_York")).toThrow("does not exist");
    expect(() => localDateTimeToIso("2027-11-07", "01:30", "America/New_York")).toThrow("ambiguous");
  });

  it("keeps a prepared week private, opens it atomically, and publishes an added practice separately", async () => {
    const fixture = await setupWeek("visibility");
    const hidden = await publicSchedule(fixture.testEnv, fixture.seasonId, "public_hidden_001");
    expect(hidden.weeks).toEqual([]);
    expect(hidden.practices).toEqual([]);

    const workspace = await ok(await call("/internal/c1/schedule-workspace", {
      request_id: "workspace_visibility_001", session_token: fixture.token, season_id: fixture.seasonId
    }, "POST", fixture.testEnv));
    expect(workspace.weeks).toHaveLength(1);
    expect(workspace.practices).toHaveLength(2);

    const confirmPayload = {
      request_id: "confirm_visibility_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: fixture.week.week_version
    };
    const opened = await ok(await call("/internal/c1/confirm-training-week", confirmPayload, "POST", fixture.testEnv));
    expect(opened.result.week.status).toBe("OPENED");
    const replay = await ok(await call("/internal/c1/confirm-training-week", confirmPayload, "POST", fixture.testEnv));
    expect(replay.result).toEqual(opened.result);
    const visible = await publicSchedule(fixture.testEnv, fixture.seasonId, "public_visible_001");
    expect(visible.practices).toHaveLength(2);

    const added = await ok(await call("/internal/c1/create-practice", {
      request_id: "create_extra_visibility_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: opened.result.week.week_version,
      practice_date: "2027-05-07", start_time: "07:00", end_time: "09:00",
      location: "Extra Dock", address: "3 Extra Road", map_url: ""
    }, "POST", fixture.testEnv));
    expect((await publicSchedule(fixture.testEnv, fixture.seasonId, "public_extra_hidden_001")).practices).toHaveLength(2);
    const published = await ok(await call("/internal/c1/publish-additional-practice", {
      request_id: "publish_extra_visibility_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: added.result.week.week_version,
      practice_id: added.result.practice.practice_id, practice_version: added.result.practice.practice_version
    }, "POST", fixture.testEnv));
    expect(published.result.practice.schedule_published_at).toBeTruthy();
    expect((await publicSchedule(fixture.testEnv, fixture.seasonId, "public_extra_visible_001")).practices).toHaveLength(3);
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const stored = context.storage.sql.exec<{ result_json: string }>(
        "SELECT result_json FROM system_requests WHERE action='confirmTrainingWeek'").one().result_json;
      expect(stored).not.toContain("current_view");
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_outbox WHERE topic='SCHEDULE_CHANGED' AND status='PENDING'").one().count)
        .toBe(5);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM practice_versions").one().count).toBe(3);
    });
  });

  it("captures each schedule outbox event before later edits, cancellations, and template replacement", async () => {
    const fixture = await setupWeek("schedule-event-snapshot");
    const opened = await ok(await call("/internal/c1/confirm-training-week", {
      request_id: "confirm_snapshot_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: fixture.week.week_version
    }, "POST", fixture.testEnv));
    const added = await ok(await call("/internal/c1/create-practice", {
      request_id: "create_snapshot_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: opened.result.week.week_version,
      practice_date: "2027-05-07", start_time: "07:00", end_time: "09:00",
      location: "Original Extra Dock", address: "3 River Road", map_url: ""
    }, "POST", fixture.testEnv));
    const practiceId = added.result.practice.practice_id;
    const published = await ok(await call("/internal/c1/publish-additional-practice", {
      request_id: "publish_snapshot_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: added.result.week.week_version,
      practice_id: practiceId, practice_version: added.result.practice.practice_version
    }, "POST", fixture.testEnv));
    expect(published.result.practice.schedule_published_at).toBeTruthy();
    const updatePreview = await ok(await call("/internal/c1/preview-practice-change", {
      request_id: "preview_snapshot_update_001", session_token: fixture.token, season_id: fixture.seasonId,
      practice_id: practiceId, change: "UPDATE", practice_date: "2027-05-07",
      start_time: "08:00", end_time: "10:00", timezone: "America/New_York",
      location: "Moved Extra Dock", address: "4 River Road", map_url: ""
    }, "POST", fixture.testEnv));
    await ok(await call("/internal/c1/update-practice", {
      request_id: "update_snapshot_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, practice_id: practiceId, week_version: updatePreview.week_version,
      practice_version: updatePreview.practice_version, signup_version: updatePreview.signup_version,
      preview_token: updatePreview.preview_token, practice_date: "2027-05-07", start_time: "08:00",
      end_time: "10:00", timezone: "America/New_York", location: "Moved Extra Dock",
      address: "4 River Road", map_url: ""
    }, "POST", fixture.testEnv));
    const cancelPreview = await ok(await call("/internal/c1/preview-practice-change", {
      request_id: "preview_snapshot_cancel_001", session_token: fixture.token,
      season_id: fixture.seasonId, practice_id: practiceId, change: "CANCEL"
    }, "POST", fixture.testEnv));
    await ok(await call("/internal/c1/cancel-practice", {
      request_id: "cancel_snapshot_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, practice_id: practiceId,
      week_version: cancelPreview.week_version, practice_version: cancelPreview.practice_version,
      signup_version: cancelPreview.signup_version, preview_token: cancelPreview.preview_token
    }, "POST", fixture.testEnv));
    await ok(await call("/internal/c1/update-schedule-templates", {
      request_id: "replace_snapshot_templates_001", session_token: fixture.token,
      season_id: fixture.seasonId, season_version: 5, templates: [templates[0]]
    }, "POST", fixture.testEnv));

    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const events = context.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM sync_outbox WHERE topic='SCHEDULE_CHANGED' ORDER BY rowid"
      ).toArray().map((row) => JSON.parse(row.payload_json));
      expect(events.map((event: any) => event.action)).toEqual([
        "updateScheduleTemplates", "prepareTrainingWeek", "confirmTrainingWeek", "createPractice",
        "publishAdditionalPractice", "updatePractice", "cancelPractice", "updateScheduleTemplates"
      ]);
      expect(events.every((event: any) => event.entity.snapshot_schema === 1)).toBe(true);
      expect(events[0].entity.season_version).toBe(5);
      expect(events[0].entity.templates).toHaveLength(2);
      expect(events[0].entity.templates.every((row: any) => row.active === true && row.template_version === 1)).toBe(true);
      expect(events[1].entity.week.status).toBe("DRAFT");
      expect(events[1].entity.practices).toHaveLength(2);
      expect(Object.keys(events[1].entity.practices[0])).toEqual([...SHEET_SCOPES.PRACTICE.headers]);
      expect(events[1].entity.practices.every((row: any) => row.practice_version === 1 &&
        row.schedule_published_at === null)).toBe(true);
      expect(events[2].entity.week.status).toBe("OPENED");
      expect(events[2].entity.practices).toHaveLength(2);
      expect(events[2].entity.practices.every((row: any) => row.practice_version === 2 &&
        row.schedule_published_at !== null)).toBe(true);
      expect(events[3].entity.practices[0].location).toBe("Original Extra Dock");
      expect(events[3].entity.practices[0].schedule_published_at).toBeNull();
      expect(events[4].entity.practices[0].schedule_published_at).toBeTruthy();
      expect(events[4].entity.practices[0].practice_version).toBe(2);
      expect(events[5].entity.practices[0].location).toBe("Moved Extra Dock");
      expect(events[5].entity.practices[0].cancelled_at).toBeNull();
      expect(events[6].entity.practices[0].cancelled_at).toBeTruthy();
      expect(events[6].entity.practices[0].practice_version).toBe(4);
      expect(events[7].entity.season_version).toBe(6);
      expect(events[7].entity.templates.filter((row: any) => row.active === false)).toHaveLength(2);
      expect(events[7].entity.templates.filter((row: any) => row.active === true)).toHaveLength(1);
      expect(events[0].entity.templates.every((row: any) => row.active === true)).toBe(true);
      expect(context.storage.sql.exec<{ location: string; cancelled_at: string }>(
        "SELECT location, cancelled_at FROM practices WHERE season_id=? AND practice_id=?",
        fixture.seasonId, practiceId).one().cancelled_at).toBeTruthy();
    });
  });

  it("replays completed writes before mutable season defaults can change their request identity", async () => {
    const fixture = await setupWeek("state-independent-replay");
    const createPayload = {
      request_id: "create_state_replay_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: fixture.week.week_version,
      practice_date: "2027-05-07", start_time: "07:00", end_time: "09:00",
      location: "Replay Dock", address: "7 Replay Road", map_url: ""
    };
    const created = await ok(await call("/internal/c1/create-practice", createPayload, "POST", fixture.testEnv));
    const confirmPayload = {
      request_id: "confirm_state_replay_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: created.result.week.week_version,
      open_date: "2027-05-01", open_time: "10:00"
    };
    const confirmed = await ok(await call("/internal/c1/confirm-training-week", confirmPayload, "POST", fixture.testEnv));
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE seasons SET timezone='America/Chicago' WHERE season_id=?", fixture.seasonId).toArray();
    });

    const createReplay = await ok(await call("/internal/c1/create-practice", createPayload, "POST", fixture.testEnv));
    const confirmReplay = await ok(await call("/internal/c1/confirm-training-week", confirmPayload, "POST", fixture.testEnv));
    expect(createReplay.result).toEqual(created.result);
    expect(confirmReplay.result).toEqual(confirmed.result);
  });

  it("allows an authenticated manual recovery to publish a due scheduled week", async () => {
    const fixture = await setupWeek("manual-due");
    const scheduled = await ok(await call("/internal/c1/confirm-training-week", {
      request_id: "confirm_manual_due_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: fixture.week.week_version,
      open_at: new Date(Date.now() + 3_600_000).toISOString()
    }, "POST", fixture.testEnv));
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE training_weeks SET scheduled_open_at=? WHERE season_id=? AND week_id=?",
        new Date(Date.now() - 1_000).toISOString(), fixture.seasonId, fixture.week.week_id).toArray();
    });
    const published = await ok(await call("/internal/c1/publish-training-week", {
      request_id: "publish_manual_due_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: scheduled.result.week.week_version
    }, "POST", fixture.testEnv));
    expect(published.result.week.status).toBe("OPENED");
    expect((await publicSchedule(fixture.testEnv, fixture.seasonId, "public_manual_due_001")).practices).toHaveLength(2);
  });

  it("records a new confirmation when an administrator changes a scheduled week to immediate opening", async () => {
    const fixture = await setupWeek("reconfirm-immediate");
    const scheduled = await ok(await call("/internal/c1/confirm-training-week", {
      request_id: "confirm_future_then_now_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: fixture.week.week_version,
      open_at: new Date(Date.now() + 3_600_000).toISOString()
    }, "POST", fixture.testEnv));
    const opened = await ok(await call("/internal/c1/confirm-training-week", {
      request_id: "confirm_future_then_now_002", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: scheduled.result.week.week_version
    }, "POST", fixture.testEnv));

    expect(opened.result.week.status).toBe("OPENED");
    expect(opened.result.week.confirmed_version).toBe(scheduled.result.week.week_version + 1);
    expect(opened.result.week.scheduled_open_at).not.toBe(scheduled.result.week.scheduled_open_at);
    expect(Date.parse(opened.result.week.scheduled_open_at)).toBeLessThanOrEqual(Date.now());
  });

  it("opens a scheduled week from a durable job and records one immutable operation", async () => {
    const fixture = await setupWeek("due");
    const openAt = new Date(Date.now() + 150).toISOString();
    const scheduled = await ok(await call("/internal/c1/confirm-training-week", {
      request_id: "confirm_due_week_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: fixture.week.week_version, open_at: openAt
    }, "POST", fixture.testEnv));
    expect(scheduled.result.week.status).toBe("SCHEDULED");
    expect((await publicSchedule(fixture.testEnv, fixture.seasonId, "public_due_hidden_001")).practices).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runDurableObjectAlarm(stub);
    const visible = await publicSchedule(fixture.testEnv, fixture.seasonId, "public_due_visible_001");
    expect(visible.weeks[0].status).toBe("OPENED");
    expect(visible.weeks[0].confirmed_version).toBe(scheduled.result.week.confirmed_version);
    expect(visible.weeks[0].confirmed_at).toBe(scheduled.result.week.confirmed_at);
    expect(visible.weeks[0].scheduled_open_at).toBe(scheduled.result.week.scheduled_open_at);
    expect(visible.weeks[0].published_at).toBeTruthy();
    expect(visible.practices).toHaveLength(2);
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const scheduleEvents = context.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM sync_outbox WHERE topic='SCHEDULE_CHANGED' ORDER BY rowid"
      ).toArray().map((row) => JSON.parse(row.payload_json));
      const confirmation = scheduleEvents.find((event: any) => event.action === "confirmTrainingWeek").entity;
      const opening = scheduleEvents.find((event: any) => event.action === "publishTrainingWeek").entity;
      expect(confirmation.week.status).toBe("SCHEDULED");
      expect(confirmation.practices).toEqual([]);
      expect(opening.week.status).toBe("OPENED");
      expect(opening.practices).toHaveLength(2);
      expect(opening.practices.every((row: any) => row.schedule_published_at !== null)).toBe(true);
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM system_requests WHERE action='publishTrainingWeek'").one().count).toBe(1);
      expect(context.storage.sql.exec<{ status: string }>(
        "SELECT status FROM scheduled_jobs WHERE job_type='OPEN_TRAINING_WEEK'").one().status).toBe("COMPLETED");
    });
  });

  it("invalidates a scheduled opening after an edit and lets the stale job finish as a no-op", async () => {
    const fixture = await setupWeek("invalidate");
    const scheduled = await ok(await call("/internal/c1/confirm-training-week", {
      request_id: "confirm_invalidate_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: fixture.week.week_version,
      open_at: new Date(Date.now() + 3_600_000).toISOString()
    }, "POST", fixture.testEnv));
    const practice = scheduled.result.practices[0];
    const preview = await ok(await call("/internal/c1/preview-practice-change", {
      request_id: "preview_invalidate_001", session_token: fixture.token, season_id: fixture.seasonId,
      practice_id: practice.practice_id, change: "UPDATE", practice_date: "2027-05-12",
      start_time: "18:30", end_time: "20:30", timezone: "America/New_York",
      location: "Changed Dock", address: "4 Changed Road", map_url: ""
    }, "POST", fixture.testEnv));
    const updated = await ok(await call("/internal/c1/update-practice", {
      request_id: "update_invalidate_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: preview.week_id, practice_id: practice.practice_id, week_version: preview.week_version,
      practice_version: preview.practice_version, signup_version: preview.signup_version,
      preview_token: preview.preview_token, practice_date: "2027-05-12", start_time: "18:30",
      end_time: "20:30", timezone: "America/New_York", location: "Changed Dock",
      address: "4 Changed Road", map_url: ""
    }, "POST", fixture.testEnv));
    expect(updated.result.week.status).toBe("DRAFT");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE scheduled_jobs SET due_at_ms=0 WHERE job_type='OPEN_TRAINING_WEEK'").toArray();
    });
    await runDurableObjectAlarm(stub);
    expect((await publicSchedule(fixture.testEnv, fixture.seasonId, "public_invalidated_001")).practices).toEqual([]);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ status: string }>(
        "SELECT status FROM scheduled_jobs WHERE job_type='OPEN_TRAINING_WEEK'").one().status).toBe("COMPLETED");
    });
  });

  it("uses payload-bound previews, permits cross-week rescheduling, and hides cancellation tombstones", async () => {
    const fixture = await setupWeek("preview");
    const opened = await ok(await call("/internal/c1/confirm-training-week", {
      request_id: "confirm_preview_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: fixture.week.week_id, week_version: fixture.week.week_version
    }, "POST", fixture.testEnv));
    const practice = opened.result.practices[0];
    const preview = await ok(await call("/internal/c1/preview-practice-change", {
      request_id: "preview_update_001", session_token: fixture.token, season_id: fixture.seasonId,
      practice_id: practice.practice_id, change: "UPDATE", practice_date: "2027-05-19",
      start_time: "18:00", end_time: "20:00", timezone: "America/New_York",
      location: "Later Dock", address: "5 Later Road", map_url: ""
    }, "POST", fixture.testEnv));
    expect(preview.week_id).toBe(fixture.week.week_id);
    expect(await errorCode(await call("/internal/c1/update-practice", {
      request_id: "update_tampered_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: preview.week_id, practice_id: practice.practice_id, week_version: preview.week_version,
      practice_version: preview.practice_version, signup_version: preview.signup_version,
      preview_token: preview.preview_token, practice_date: "2027-05-19", start_time: "18:00",
      end_time: "20:00", timezone: "America/New_York", location: "Tampered Dock",
      address: "5 Later Road", map_url: ""
    }, "POST", fixture.testEnv))).toBe("PREVIEW_STALE");
    const changed = await ok(await call("/internal/c1/update-practice", {
      request_id: "update_preview_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: preview.week_id, practice_id: practice.practice_id, week_version: preview.week_version,
      practice_version: preview.practice_version, signup_version: preview.signup_version,
      preview_token: preview.preview_token, practice_date: "2027-05-19", start_time: "18:00",
      end_time: "20:00", timezone: "America/New_York", location: "Later Dock",
      address: "5 Later Road", map_url: ""
    }, "POST", fixture.testEnv));
    expect(changed.result.practice.week_id).toBe(fixture.week.week_id);
    const cancelPreview = await ok(await call("/internal/c1/preview-practice-change", {
      request_id: "preview_cancel_001", session_token: fixture.token, season_id: fixture.seasonId,
      practice_id: practice.practice_id, change: "CANCEL"
    }, "POST", fixture.testEnv));
    const cancelled = await ok(await call("/internal/c1/cancel-practice", {
      request_id: "cancel_preview_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: cancelPreview.week_id, practice_id: practice.practice_id,
      week_version: cancelPreview.week_version, practice_version: cancelPreview.practice_version,
      signup_version: cancelPreview.signup_version, preview_token: cancelPreview.preview_token
    }, "POST", fixture.testEnv));
    expect(cancelled.result.practice.cancelled).toBe(true);
    const publicView = await publicSchedule(fixture.testEnv, fixture.seasonId, "public_cancelled_001");
    expect(publicView.practices.some((row: any) => row.practice_id === practice.practice_id)).toBe(false);
    const workspace = await ok(await call("/internal/c1/schedule-workspace", {
      request_id: "workspace_cancelled_001", session_token: fixture.token, season_id: fixture.seasonId
    }, "POST", fixture.testEnv));
    expect(workspace.practices.find((row: any) => row.practice_id === practice.practice_id).cancelled).toBe(true);
    const remaining = opened.result.practices[1];
    const remainingPreview = await ok(await call("/internal/c1/preview-practice-change", {
      request_id: "preview_cancel_remaining_001", session_token: fixture.token, season_id: fixture.seasonId,
      practice_id: remaining.practice_id, change: "CANCEL"
    }, "POST", fixture.testEnv));
    await ok(await call("/internal/c1/cancel-practice", {
      request_id: "cancel_remaining_001", session_token: fixture.token, season_id: fixture.seasonId,
      week_id: remainingPreview.week_id, practice_id: remaining.practice_id,
      week_version: remainingPreview.week_version, practice_version: remainingPreview.practice_version,
      signup_version: remainingPreview.signup_version, preview_token: remainingPreview.preview_token
    }, "POST", fixture.testEnv));
    const emptyPublicWeek = await publicSchedule(fixture.testEnv, fixture.seasonId, "public_empty_week_001");
    expect(emptyPublicWeek.practices).toEqual([]);
    expect(emptyPublicWeek.weeks).toEqual([]);
  });

  it("imports stable schedule identities without arming shadow timers and rejects drift", async () => {
    const core = await setupCore("import");
    const at = "2026-09-21T12:00:00.000Z";
    const schedule: any = {
      request_id: "import_schedule_001", source_snapshot_id: "snapshot_schedule_001",
      templates: [{ season_id: core.seasonId, template_id: "template_import_001", ...templates[0],
        timezone: "America/New_York", active: true, template_version: 1, created_at: at, updated_at: at }],
      weeks: [{ season_id: core.seasonId, week_id: "week_import_20270503", week_start_date: "2027-05-03",
        scheduled_open_at: "2027-05-01T14:00:00.000Z", status: "SCHEDULED", week_version: 2,
        confirmed_version: 2, confirmed_by: "coach_liu_yang", confirmed_at: at,
        published_at: null, created_at: at, updated_at: at }],
      practices: [{ season_id: core.seasonId, practice_id: "practice_import_001",
        week_id: "week_import_20270503", template_id: "template_import_001",
        generation_key: "schedule:import:001", start_at: "2027-05-05T22:00:00.000Z",
        end_at: "2027-05-06T00:00:00.000Z", timezone: "America/New_York",
        location: "River Dock", address: "1 River Road", map_url: "", left_capacity: 10,
        right_capacity: 10, signup_cutoff_at: "2027-05-05T20:00:00.000Z", practice_version: 2,
        cancelled_at: null, cancelled_by: null, schedule_published_at: null,
        schedule_published_by: null, created_at: at, updated_at: at }]
    };
    const imported = await ok(await call("/internal/c1/import-schedule", schedule, "POST", core.testEnv));
    expect(imported.result.practices).toBe(1);
    const stub = core.testEnv.TEAM_STATE.getByName(core.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE seasons SET timezone='America/Chicago' WHERE season_id=?", core.seasonId).toArray();
    });
    expect((await ok(await call("/internal/c1/import-schedule", schedule, "POST", core.testEnv))).result).toEqual(imported.result);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec("UPDATE seasons SET timezone='America/New_York' WHERE season_id=?", core.seasonId).toArray();
    });
    const same = structuredClone(schedule); same.request_id = "import_schedule_same_002";
    expect((await ok(await call("/internal/c1/import-schedule", same, "POST", core.testEnv))).result.practices).toBe(1);
    const drift = structuredClone(schedule); drift.request_id = "import_schedule_drift_003";
    drift.practices[0].location = "Different";
    expect(await errorCode(await call("/internal/c1/import-schedule", drift, "POST", core.testEnv)))
      .toBe("IMPORT_SNAPSHOT_CONFLICT");
    const regression = structuredClone(schedule); regression.request_id = "import_schedule_regress_004";
    regression.source_snapshot_id = "snapshot_schedule_002"; regression.practices[0].practice_version = 1;
    expect(await errorCode(await call("/internal/c1/import-schedule", regression, "POST", core.testEnv)))
      .toBe("IMPORT_VERSION_REGRESSION");
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM scheduled_jobs WHERE job_type='OPEN_TRAINING_WEEK'").one().count).toBe(0);
    });
  });
});
