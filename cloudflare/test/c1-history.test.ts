import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { legacyCredentialDigest, sha256Base64Url } from "../src/crypto";
import { canonicalJson } from "../../shared/c1-rules";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { TeamState } from "../src/team-state";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const BASE = "https://example.test";
const HEADERS = { authorization: "Bearer local-c1-test-key", "content-type": "application/json" };
const teamEnv = (name: string, writerEpoch = "1") => ({ ...env, TEAM_ID: `c15-${name}`,
  WRITER_EPOCH: writerEpoch } as unknown as Env);

async function call(path: string, payload?: Record<string, unknown>, method = "POST", testEnv: Env = env) {
  return worker.fetch(new IncomingRequest(`${BASE}${path}`, {
    method, headers: HEADERS, ...(payload ? { body: JSON.stringify(payload) } : {})
  }), testEnv);
}

async function body(response: Response): Promise<any> { return response.json(); }

async function ok(response: Response): Promise<any> {
  const value = await body(response);
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(value.ok, JSON.stringify(value)).toBe(true);
  return value.data;
}

async function errorCode(response: Response): Promise<string> {
  const value = await body(response);
  expect(value.ok, JSON.stringify(value)).toBe(false);
  return value.error.code;
}

async function runAlarm(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (instance: TeamState) => instance.alarm());
}

async function setup(name: string, writerEpoch = "1") {
  const testEnv = teamEnv(name, writerEpoch);
  const seasonId = `season_history_${name}`;
  const practiceIds = [`practice_history_${name}_formal`, `practice_history_${name}_empty`,
    `practice_history_${name}_cancelled`];
  const members = ["member_history_001", "member_history_002", "member_history_003"];
  const at = "2020-09-01T12:00:00.000Z";
  await ok(await call("/internal/c1/import-core", {
    request_id: `core_history_${name}_001`, source_snapshot_id: `core_history_snapshot_${name}_001`,
    settings_version: 1, default_season_id: writerEpoch === "0" ? null : seasonId,
    coaches: [{ coach_id: "coach_history_liu", display_name: "刘阳", code_salt: "history_salt_001",
      code_digest: await legacyCredentialDigest("history_salt_001", "local-test-coach-code", "local-c1-coach-secret"),
      credential_version: 1, active: true, created_at: at, updated_at: at }],
    seasons: [{ season_id: seasonId, name: `History ${name}`, start_date: "2020-09-01", end_date: "2020-09-20",
      timezone: "America/New_York", season_ends_at: "2020-09-21T04:00:00.000Z",
      status: writerEpoch === "0" ? "ARCHIVED" : "OPEN", binding_version: 1, season_version: 1,
      roster_version: 1, created_by: "coach_history_liu", created_at: at, updated_at: at }],
    members: members.map((member_id, index) => ({ season_id: seasonId, member_id,
      source_key: `history-source-${name}-${index}`, source_display_name: `History Member ${index + 1}`,
      display_name_override: "", status: "ACTIVE", default_preference: "AMBIENT",
      member_version: 1, created_at: at, updated_at: at }))
  }, "POST", testEnv));
  const login = await ok(await call("/internal/c1/coach-login", {
    request_id: `login_history_${name}_001`, coach_code: "local-test-coach-code"
  }, "POST", testEnv));
  await ok(await call("/internal/c1/import-schedule", {
    request_id: `schedule_history_${name}_001`, source_snapshot_id: `schedule_history_snapshot_${name}_001`,
    templates: [], weeks: [{ season_id: seasonId, week_id: `week_history_${name}_001`,
      week_start_date: "2020-09-14", scheduled_open_at: at, status: "OPENED", week_version: 1,
      confirmed_version: 1, confirmed_by: "coach_history_liu", confirmed_at: at,
      published_at: at, created_at: at, updated_at: at }],
    practices: [
      { practice_id: practiceIds[0], start_at: "2020-09-17T22:00:00.000Z", end_at: "2020-09-18T00:00:00.000Z",
        cancelled_at: null, cancelled_by: null },
      { practice_id: practiceIds[1], start_at: "2020-09-18T22:00:00.000Z", end_at: "2020-09-19T00:00:00.000Z",
        cancelled_at: null, cancelled_by: null },
      { practice_id: practiceIds[2], start_at: "2020-09-19T14:00:00.000Z", end_at: "2020-09-19T16:00:00.000Z",
        cancelled_at: "2020-09-10T12:00:00.000Z", cancelled_by: "coach_history_liu" }
    ].map((practice, index) => ({ season_id: seasonId, ...practice, week_id: `week_history_${name}_001`,
      template_id: null, generation_key: `history:${name}:${index}`, timezone: "America/New_York",
      location: `Dock ${index + 1}`, address: `${index + 1} River Road`, map_url: "", left_capacity: 1,
      right_capacity: 1, signup_cutoff_at: new Date(Date.parse(practice.start_at) - 7_200_000).toISOString(), practice_version: 1,
      schedule_published_at: at, schedule_published_by: "coach_history_liu", created_at: at, updated_at: at }))
  }, "POST", testEnv));
  await ok(await call("/internal/c1/import-seating", {
    request_id: `seating_history_${name}_001`, source_snapshot_id: `seating_history_snapshot_${name}_001`,
    states: [{ season_id: seasonId, practice_id: practiceIds[0], seat_plan_version: 1,
      published_revision: 1, coach_member_id: members[2], steerer_member_id: members[2],
      updated_by: "coach_history_liu", updated_at: at }],
    draft_seats: [
      { season_id: seasonId, practice_id: practiceIds[0], seat_plan_version: 1,
        side: "LEFT", row_number: 1, member_id: members[0] },
      { season_id: seasonId, practice_id: practiceIds[0], seat_plan_version: 1,
        side: "RIGHT", row_number: 1, member_id: "" }
    ],
    revisions: [{ season_id: seasonId, practice_id: practiceIds[0], revision_number: 1,
      revision_id: `revision_history_${name}_001`, source: "MANUAL", seat_plan_version: 1,
      coach_member_id: members[2], steerer_member_id: members[2],
      seats: [{ side: "LEFT", row_number: 1, member_id: members[0] }],
      names: [{ member_id: members[0], display_name: "History Member 1" },
        { member_id: members[2], display_name: "History Member 3" }],
      published_by: "coach_history_liu", published_at: at, request_id: `legacy_history_${name}_001` }]
  }, "POST", testEnv));
  if (writerEpoch !== "0") {
    await runInDurableObject(testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID), async (instance: TeamState, context) => {
      context.storage.sql.exec(
        `INSERT INTO settings(setting_key, value_json, settings_version, updated_at)
         VALUES ('history_maintenance_enabled', 'true', 0, ?)
         ON CONFLICT(setting_key) DO UPDATE SET value_json='true', updated_at=excluded.updated_at`, at).toArray();
      await instance.repairScheduledWork();
    });
  }
  return { testEnv, seasonId, practiceIds, members, token: login.result.session_token as string };
}

describe("C1.5 frozen history and operations slice", () => {
  it("upgrades schema v5 in place and adds history, backup, usage and indexed audit storage", async () => {
    const fixture = await setup("schema", "0");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      for (const table of ["backup_snapshot_chunks", "backup_snapshots", "usage_snapshots",
        "history_migration_snapshots", "season_history", "history_corrections", "practice_history"]) {
        context.storage.sql.exec(`DROP TABLE ${table}`).toArray();
      }
      context.storage.sql.exec("DROP INDEX audit_events_season_idx").toArray();
      context.storage.sql.exec("ALTER TABLE audit_events DROP COLUMN season_id").toArray();
      context.storage.sql.exec("UPDATE app_meta SET value='5' WHERE key='schema_version'").toArray();
      applySchema(context.storage);
      expect(context.storage.sql.exec<{ value: string }>(
        "SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe(String(APPLICATION_SCHEMA_VERSION));
      expect(context.storage.sql.exec<{ name: string }>("PRAGMA table_info(audit_events)").toArray()
        .some((column) => column.name === "season_id")).toBe(true);
      expect(context.storage.sql.exec("SELECT * FROM practice_history").toArray()).toEqual([]);
    });
  });

  it("freezes due practices, excludes cancellation, archives the season and keeps revision names immutable", async () => {
    const fixture = await setup("automatic");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE scheduled_jobs SET attempt_count=6 WHERE job_type='FREEZE_PRACTICE_HISTORY' AND payload_json LIKE ?",
        `%${fixture.practiceIds[0]}%`).toArray();
    });
    await runAlarm(stub);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      for (const [index, year] of [2019, 2018].entries()) {
        const seasonId = `season_history_extra_${year}`;
        const date = `${year}-08-31`;
        context.storage.sql.exec(
          `INSERT INTO seasons VALUES (?, ?, ?, ?, 'America/New_York', ?, 'ARCHIVED', 1, 1, 1,
             'coach_history_liu', ?, ?)`, seasonId, `Extra ${year}`, `${year}-04-01`, date,
          `${year}-09-01T04:00:00.000Z`, `${year}-09-02T00:00:00.000Z`, `${year}-09-02T00:00:00.000Z`).toArray();
        context.storage.sql.exec(
          "INSERT INTO season_history VALUES (?, ?, 0, 0, ?, ?)", seasonId, year,
          JSON.stringify({ season_id: seasonId, name: `Extra ${year}`, start_date: `${year}-04-01`,
            end_date: date, timezone: "America/New_York", archive_year: year }),
          `${year}-09-02T00:00:00.000Z`).toArray();
      }
    });
    const directory = await ok(await call(
      "/internal/c1/public-history-seasons?request_id=history_directory_001&limit=2", undefined, "GET", fixture.testEnv));
    expect(directory).toMatchObject({ total_count: 3 });
    expect(directory.next_cursor).not.toBe("");
    const directoryNext = await ok(await call(
      `/internal/c1/public-history-seasons?request_id=history_directory_002&limit=2&cursor=${encodeURIComponent(directory.next_cursor)}`,
      undefined, "GET", fixture.testEnv));
    const directoryRows = [...directory.seasons, ...directoryNext.seasons];
    expect(new Set(directoryRows.map((row: any) => row.season_id)).size).toBe(3);
    expect(directoryRows.find((row: any) => row.season_id === fixture.seasonId)).toMatchObject({
      practice_count: 2, published_practice_count: 1
    });
    const firstPage = await ok(await call(
      `/internal/c1/public-season-history?request_id=history_season_001&season_id=${fixture.seasonId}&limit=1`,
      undefined, "GET", fixture.testEnv));
    expect(firstPage.practices).toHaveLength(1);
    expect(firstPage.next_cursor).not.toBe("");
    const secondPage = await ok(await call(
      `/internal/c1/public-season-history?request_id=history_season_002&season_id=${fixture.seasonId}` +
      `&limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`, undefined, "GET", fixture.testEnv));
    expect(new Set([...firstPage.practices, ...secondPage.practices].map((row: any) => row.practice_id)))
      .toEqual(new Set(fixture.practiceIds.slice(0, 2)));
    expect(JSON.stringify([...firstPage.practices, ...secondPage.practices])).not.toContain(fixture.practiceIds[2]);

    const formal = await ok(await call(
      `/internal/c1/public-archived-practice?request_id=history_practice_001&season_id=${fixture.seasonId}` +
      `&practice_id=${fixture.practiceIds[0]}`, undefined, "GET", fixture.testEnv));
    expect(formal).toMatchObject({ final_status: "FROZEN", history_version: 1,
      seat_plan: { published_revision: 1, coach: { display_name: "History Member 3" },
        seats: [{ display_name: "History Member 1" }] } });
    expect(JSON.stringify(formal)).not.toContain("member_history_");
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        "UPDATE members SET display_name_override='Renamed Later' WHERE season_id=? AND member_id=?",
        fixture.seasonId, fixture.members[0]).toArray();
      const job = context.storage.sql.exec<{ attempt_count: number }>(
        "SELECT attempt_count FROM scheduled_jobs WHERE job_type='FREEZE_PRACTICE_HISTORY' AND payload_json LIKE ?",
        `%${fixture.practiceIds[0]}%`).one();
      expect(Number(job.attempt_count)).toBe(7);
    });
    const stable = await ok(await call(
      `/internal/c1/public-archived-practice?request_id=history_practice_002&season_id=${fixture.seasonId}` +
      `&practice_id=${fixture.practiceIds[0]}`, undefined, "GET", fixture.testEnv));
    expect(stable.seat_plan.seats[0].display_name).toBe("History Member 1");
    const unpublished = await ok(await call(
      `/internal/c1/public-archived-practice?request_id=history_practice_003&season_id=${fixture.seasonId}` +
      `&practice_id=${fixture.practiceIds[1]}`, undefined, "GET", fixture.testEnv));
    expect(unpublished).toMatchObject({ final_status: "UNPUBLISHED", seat_plan: { seats: [] } });
  });

  it("appends immutable corrections and paginates season-scoped audit without duplicates", async () => {
    const fixture = await setup("correction");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runAlarm(stub);
    const input = { request_id: "history_correction_001", session_token: fixture.token,
      season_id: fixture.seasonId, practice_id: fixture.practiceIds[0], history_version: 1,
      note: "Weather shortened the final practice." };
    const written = await ok(await call("/internal/c1/append-history-correction", input, "POST", fixture.testEnv));
    expect(written.result.history_version).toBe(2);
    expect((await ok(await call("/internal/c1/append-history-correction", input, "POST", fixture.testEnv))).result)
      .toEqual(written.result);
    expect(await errorCode(await call("/internal/c1/append-history-correction", {
      ...input, request_id: "history_correction_stale_001"
    }, "POST", fixture.testEnv))).toBe("VERSION_CONFLICT");
    expect(await errorCode(await call("/internal/c1/append-history-correction", {
      ...input, request_id: "history_correction_multiline_001", history_version: 2, note: "line one\nline two"
    }, "POST", fixture.testEnv))).toBe("INVALID_REQUEST");
    const detail = await ok(await call(
      `/internal/c1/public-archived-practice?request_id=history_corrected_001&season_id=${fixture.seasonId}` +
      `&practice_id=${fixture.practiceIds[0]}`, undefined, "GET", fixture.testEnv));
    expect(detail).toMatchObject({ history_version: 2,
      corrections: [{ note: "Weather shortened the final practice.", history_version: 2 }] });

    const first = await ok(await call("/internal/c1/list-management-audit", {
      request_id: "history_audit_001", session_token: fixture.token, season_id: fixture.seasonId, limit: 2
    }, "POST", fixture.testEnv));
    expect(first.events).toHaveLength(2);
    expect(first.next_cursor).not.toBe("");
    const second = await ok(await call("/internal/c1/list-management-audit", {
      request_id: "history_audit_002", session_token: fixture.token, season_id: fixture.seasonId,
      limit: 100, cursor: first.next_cursor
    }, "POST", fixture.testEnv));
    const ids = [...first.events, ...second.events].map((event: any) => event.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(3);
  });

  it("recovers a failed freeze after more than six attempts and archives only after the snapshot is complete", async () => {
    const fixture = await setup("recovery");
    const stub = fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      context.storage.sql.exec(
        `DELETE FROM seat_plan_revision_names WHERE season_id=? AND practice_id=? AND member_id=?`,
        fixture.seasonId, fixture.practiceIds[0], fixture.members[0]).toArray();
      context.storage.sql.exec(
        "UPDATE scheduled_jobs SET attempt_count=6 WHERE job_type='FREEZE_PRACTICE_HISTORY' AND payload_json LIKE ?",
        `%${fixture.practiceIds[0]}%`).toArray();
      context.storage.sql.exec(
        `UPDATE scheduled_jobs SET status='COMPLETED', completed_at=?, due_at_ms=?
          WHERE job_type='COMPLETE_SEASON' AND payload_json LIKE ?`,
        new Date().toISOString(), Date.now() - 2, `%${fixture.seasonId}%`).toArray();
      context.storage.sql.exec(
        "UPDATE scheduled_jobs SET due_at_ms=? WHERE job_type='ARCHIVE_SEASON_HISTORY' AND payload_json LIKE ?",
        Date.now() - 1, `%${fixture.seasonId}%`).toArray();
    });
    await runAlarm(stub);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      const failed = context.storage.sql.exec<{ status: string; attempt_count: number; last_error: string }>(
        "SELECT status, attempt_count, last_error FROM scheduled_jobs WHERE job_type='FREEZE_PRACTICE_HISTORY' AND payload_json LIKE ?",
        `%${fixture.practiceIds[0]}%`).one();
      expect(failed).toMatchObject({ status: "PENDING", attempt_count: 7 });
      expect(failed.last_error).toContain("participant name is missing");
      expect(context.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM season_history WHERE season_id=?", fixture.seasonId).one().count).toBe(0);
      expect(context.storage.sql.exec<{ status: string }>(
        "SELECT status FROM seasons WHERE season_id=?", fixture.seasonId).one().status).toBe("OPEN");
      context.storage.sql.exec(
        `INSERT INTO seat_plan_revision_names VALUES (?, ?, 1, ?, 'History Member 1')`,
        fixture.seasonId, fixture.practiceIds[0], fixture.members[0]).toArray();
      const now = Date.now();
      context.storage.sql.exec(
        `UPDATE scheduled_jobs SET status='PENDING', completed_at=NULL, due_at_ms=?
          WHERE job_type='COMPLETE_SEASON' AND payload_json LIKE ?`,
        now - 3, `%${fixture.seasonId}%`).toArray();
      context.storage.sql.exec(
        "UPDATE scheduled_jobs SET due_at_ms=? WHERE job_type='FREEZE_PRACTICE_HISTORY' AND payload_json LIKE ?",
        now - 2, `%${fixture.practiceIds[0]}%`).toArray();
      context.storage.sql.exec(
        "UPDATE scheduled_jobs SET due_at_ms=? WHERE job_type='ARCHIVE_SEASON_HISTORY' AND payload_json LIKE ?",
        now - 1, `%${fixture.seasonId}%`).toArray();
    });
    await runAlarm(stub);
    const directory = await ok(await call(
      "/internal/c1/public-history-seasons?request_id=history_recovered_001", undefined, "GET", fixture.testEnv));
    expect(directory.seasons).toMatchObject([{ season_id: fixture.seasonId, practice_count: 2 }]);
    await runInDurableObject(stub, async (_instance: TeamState, context) => {
      expect(context.storage.sql.exec<{ attempt_count: number }>(
        "SELECT attempt_count FROM scheduled_jobs WHERE job_type='FREEZE_PRACTICE_HISTORY' AND payload_json LIKE ?",
        `%${fixture.practiceIds[0]}%`).one().attempt_count).toBe(8);
    });
  });

  it("creates protected chunked backups, verifies their manifest and reports application usage", async () => {
    const fixture = await setup("backup");
    await runAlarm(fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID));
    const created = await ok(await call("/internal/c1/create-backup-snapshot", {
      request_id: "history_backup_001", session_token: fixture.token
    }, "POST", fixture.testEnv));
    const manifest = created.result.manifest;
    expect(manifest).toMatchObject({ schema_version: APPLICATION_SCHEMA_VERSION,
      format: "sqlite-json-chunks-v1" });
    expect(manifest.chunk_count).toBeGreaterThan(0);
    const chunk = await ok(await call("/internal/c1/get-backup-chunk", {
      request_id: "history_backup_chunk_001", session_token: fixture.token,
      snapshot_id: created.result.snapshot_id, chunk_index: 0
    }, "POST", fixture.testEnv));
    expect(chunk.chunk).toMatchObject({ chunk_index: 0, row_offset: 0 });
    expect((await ok(await call("/internal/c1/verify-backup-snapshot", {
      request_id: "history_backup_verify_001", session_token: fixture.token,
      snapshot_id: created.result.snapshot_id, content_digest: manifest.content_digest
    }, "POST", fixture.testEnv))).verified).toBe(true);
    expect((await ok(await call("/internal/c1/verify-backup-snapshot", {
      request_id: "history_backup_verify_002", session_token: fixture.token,
      snapshot_id: created.result.snapshot_id, content_digest: "sha256_v1:not-the-manifest"
    }, "POST", fixture.testEnv))).verified).toBe(false);
    const operations = await ok(await call("/internal/c1/get-operations", {
      request_id: "history_operations_001", session_token: fixture.token
    }, "POST", fixture.testEnv));
    expect(operations).toMatchObject({ schema_version: APPLICATION_SCHEMA_VERSION,
      counts: { history_practices: 2, history_seasons: 1 } });
    expect(operations.database_size_bytes).toBeGreaterThan(0);
    expect(operations.usage.length).toBeGreaterThan(0);
    await runInDurableObject(fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID),
      async (_instance: TeamState, context) => {
        const changedPayload = canonicalJson({ table: "tampered", row_offset: 0, rows: [] });
        context.storage.sql.exec(
          "UPDATE backup_snapshot_chunks SET payload_json=?, payload_digest=? WHERE snapshot_id=? AND chunk_index=0",
          changedPayload, `sha256_v1:${await sha256Base64Url(changedPayload)}`, created.result.snapshot_id).toArray();
      });
    expect(await errorCode(await call("/internal/c1/verify-backup-snapshot", {
      request_id: "history_backup_verify_tampered_001", session_token: fixture.token,
      snapshot_id: created.result.snapshot_id, content_digest: manifest.content_digest
    }, "POST", fixture.testEnv))).toBe("BACKUP_INTEGRITY_ERROR");
  });

  it("imports an immutable archived history shadow without scheduling authority work", async () => {
    const fixture = await setup("imported", "0");
    const archivedAt = "2020-09-22T12:00:00.000Z";
    const snapshot = {
      request_id: "history_import_001", source_snapshot_id: "history_import_snapshot_001",
      seasons: [{ season_id: fixture.seasonId, name: "History imported", start_date: "2020-09-01",
        end_date: "2020-09-20", timezone: "America/New_York", archive_year: 2020, archived_at: archivedAt }],
      practices: [{ season_id: fixture.seasonId, practice_id: fixture.practiceIds[0], history_version: 2,
        final_status: "FROZEN", frozen_revision: 1, start_at: "2020-09-17T22:00:00.000Z",
        end_at: "2020-09-18T00:00:00.000Z", timezone: "America/New_York", location: "Dock 1",
        address: "1 River Road", map_url: "", coach_display_name: "History Member 3",
        steerer_display_name: "History Member 3", published_at: "2020-09-01T12:00:00.000Z",
        source: "MANUAL", seats: [{ side: "LEFT", row_number: 1, display_name: "History Member 1" }],
        frozen_at: "2020-09-19T00:00:00.000Z" }],
      corrections: [{ season_id: fixture.seasonId, practice_id: fixture.practiceIds[0],
        correction_id: "correction_imported_001", history_version: 2, note: "Imported correction.",
        created_by: "coach_history_liu", created_at: archivedAt }]
    };
    expect((await ok(await call("/internal/c1/import-history", snapshot, "POST", fixture.testEnv))).result)
      .toMatchObject({ seasons: 1, practices: 1, corrections: 1 });
    expect((await call("/internal/c1/import-history", snapshot, "POST", fixture.testEnv)).status).toBe(200);
    const detail = await ok(await call(
      `/internal/c1/public-archived-practice?request_id=history_import_read_001&season_id=${fixture.seasonId}` +
      `&practice_id=${fixture.practiceIds[0]}`, undefined, "GET", fixture.testEnv));
    expect(detail).toMatchObject({ history_version: 2, corrections: [{ note: "Imported correction." }] });
    expect(await errorCode(await call("/internal/c1/import-history", {
      ...snapshot, request_id: "history_import_drift_001", source_snapshot_id: "history_import_snapshot_002",
      practices: snapshot.practices.map((practice) => ({ ...practice, location: "Changed Dock" }))
    }, "POST", fixture.testEnv))).toBe("IMPORT_CONFLICT");
    await runInDurableObject(fixture.testEnv.TEAM_STATE.getByName(fixture.testEnv.TEAM_ID),
      async (_instance: TeamState, context) => {
        expect(context.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM scheduled_jobs WHERE job_type LIKE '%HISTORY%' OR job_type LIKE '%SEASON%'"
        ).one().count).toBe(0);
      });
  });
});
