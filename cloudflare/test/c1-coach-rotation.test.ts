import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { legacyCredentialDigest, sha256Base64Url } from "../src/crypto";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const oldCode = "fictional-rotation-old-code", secondCode = "fictional-rotation-other-code";
const newCode = "FICTIONAL-ROTATION-NEW-CODE-2026", secret = "local-c1-coach-secret";
async function setup(name: string) {
  const testEnv = { ...env, TEAM_ID: `rotation-${name}` } as unknown as Env;
  const coach = "coach_rotation_001", other = "coach_rotation_002", season = "season_rotation_001", at = "2020-09-01T12:00:00.000Z";
  const call = async (route: string, input: unknown, c2 = false, authorized = true) => {
    const response = await worker.fetch(new IncomingRequest(`https://fixture.test/internal/c${c2 ? 2 : 1}/${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer local-c${c2 ? 2 : 1}-test-key` } : {}) },
      body: JSON.stringify(input)
    }), testEnv);
    return { status: response.status, body: await response.json() as any };
  };
  const ok = (reply: Awaited<ReturnType<typeof call>>) => { expect(reply.status, JSON.stringify(reply.body)).toBe(200); return reply.body.data; };
  ok(await call("import-core", { request_id: `rotation_import_${name}`, source_snapshot_id: `rotation_source_${name}`, settings_version: 1,
    default_season_id: null, coaches: await Promise.all([[coach, oldCode], [other, secondCode]].map(async ([coach_id, code]) => ({
      coach_id, display_name: coach_id, code_salt: `salt_${coach_id}`, code_digest: await legacyCredentialDigest(`salt_${coach_id}`, code, secret),
      credential_version: 1, active: true, created_at: at, updated_at: at
    }))), seasons: [{ season_id: season, name: "Ended fixture", start_date: "2020-09-01", end_date: "2020-09-20",
      timezone: "America/New_York", season_ends_at: "2020-09-21T04:00:00.000Z", status: "COMPLETED", binding_version: 1,
      season_version: 1, roster_version: 1, created_by: coach, created_at: at, updated_at: at }],
    members: [{ season_id: season, member_id: "member_rotation_001", source_key: "fixture:2", source_display_name: "Fictional paddler",
      display_name_override: "", status: "ACTIVE", default_preference: "LEFT", member_version: 1, created_at: at, updated_at: at }] }));
  let sequence = 0;
  const login = async (code = oldCode) => call("coach-login", { request_id: `rotation_login_${name}_${++sequence}`, coach_code: code });
  const token = ok(await login()).result.session_token;
  const secondToken = ok(await login()).result.session_token;
  const otherToken = ok(await login(secondCode)).result.session_token;
  ok(await call("import-sync-foundation", { request_id: `rotation_bind_${name}`, source_snapshot_id: `rotation_binding_${name}`,
    bindings: [{ season_id: season, binding_version: 1, form_id: "form_rotation_fixture", runtime_spreadsheet_id: "sheet_rotation_fixture",
      response_sheet_id: "31", response_sheet_name: "Responses", field_mapping: { display_name_header: "Name" }, schema_fingerprint: "sha256_v1:fixture",
      export_paused: true, last_pull_at: null, last_push_at: null, created_at: at, updated_at: at }], baselines: [], source_imports: [] }, true));
  ok(await call("pin-source-authority", { request_id: `rotation_pin_${name}`, session_token: token, season_id: season }, true));
  const stub = testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
  const sql = <T>(fn: (ctx: DurableObjectState) => T | Promise<T>) => runInDurableObject(stub, (_instance, ctx) => fn(ctx));
  const all = () => sql(ctx => Object.fromEntries(ctx.storage.sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name"
  ).toArray().map(({ name }) => [name, ctx.storage.sql.exec(`SELECT * FROM "${name}" ORDER BY rowid`).toArray()])));
  const command = { request_id: `rotation_request_${name}`, session_token: token, expected_credential_version: 1, new_code: newCode };
  const prepare = async (input = command) => ok(await call("prepare-coach-code-rotation", input));
  const rotate = async (input = command) => call("rotate-coach-code", { ...input, expected_payload_digest: (await prepare(input)).payload_digest });
  const bootstrap = (session_token: string) => call("coach-bootstrap", { request_id: `rotation_bootstrap_${name}_${++sequence}`, session_token });
  const receipt = (session_token: string, digest: string, overrides: Record<string, unknown> = {}) => call("get-coach-rotation-receipt", {
    request_id: `rotation_receipt_${name}_${++sequence}`, session_token, rotation_request_id: command.request_id,
    expected_credential_version: 1, new_code: newCode, expected_payload_digest: digest, ...overrides
  });
  return { call, ok, login, token, secondToken, otherToken, coach, other, sql, all, command, prepare, rotate, bootstrap, receipt };
}

describe("dedicated Coach self credential rotation through authenticated HTTP and real SQLite", () => {
  it("does not repair history jobs or refresh an expired usage snapshot as a side effect of rotation", async () => {
    const f = await setup("no_tail_maintenance"), prepared = await f.prepare();
    // The object is already awake. Create observable maintenance work only after its constructor baseline.
    await f.sql(ctx => {
      ctx.storage.sql.exec("INSERT INTO settings(setting_key,value_json,settings_version,updated_at) VALUES ('history_maintenance_enabled','true',0,?) " +
        "ON CONFLICT(setting_key) DO UPDATE SET value_json='true'", new Date().toISOString()).toArray();
      ctx.storage.sql.exec("DELETE FROM scheduled_jobs").toArray();
      ctx.storage.sql.exec("DELETE FROM usage_snapshots").toArray();
    });
    const before = await f.all();
    f.ok(await f.call("rotate-coach-code", { ...f.command, expected_payload_digest: prepared.payload_digest }));
    const after = await f.all();
    expect(after.scheduled_jobs).toEqual(before.scheduled_jobs);
    expect(after.usage_snapshots).toEqual(before.usage_snapshots);
    expect(after.settings).toEqual(before.settings);
    const newToken = f.ok(await f.login(newCode)).result.session_token;
    expect((await f.all()).usage_snapshots).toEqual(before.usage_snapshots);
    f.ok(await f.call("create-season", { request_id: "rotation_followup_business_write", session_token: newToken,
      name: "Ordinary business write", start_date: "2027-04-20", end_date: "2027-08-31", timezone: "America/New_York" }));
    const business = await f.all();
    expect(business.scheduled_jobs.some((row: any) => row.job_type === "ARCHIVE_SEASON_HISTORY")).toBe(true);
    expect(business.usage_snapshots).not.toEqual(before.usage_snapshots);
  });
  it("changes only the current credential, revokes all old sessions, preserves a real old pin and returns a stable authenticated receipt", async () => {
    const f = await setup("complete"), before = await f.all();
    expect(f.ok(await f.bootstrap(f.token)).coach.credential_version).toBe(1);
    const prepared = await f.prepare();
    const beforeWrite = await f.all();
    expect(beforeWrite).toEqual(before); // prepare/bootstrap are read-only
    const rotated = f.ok(await f.call("rotate-coach-code", { ...f.command, expected_payload_digest: prepared.payload_digest }));
    expect(rotated).toMatchObject({ operation: { action: "rotateCoachCode", request_id: f.command.request_id },
      result: { coach_id: f.coach, previous_credential_version: 1, credential_version: 2 } });
    const after = await f.all();
    for (const [table, rows] of Object.entries(before)) if (!["coaches", "coach_sessions", "system_requests", "audit_events"].includes(table))
      expect(after[table], table).toEqual(rows);
    const coaches = after.coaches as any[];
    expect(coaches.find(row => row.coach_id === f.other)).toEqual((before.coaches as any[]).find(row => row.coach_id === f.other));
    const current = coaches.find(row => row.coach_id === f.coach), previous = (before.coaches as any[]).find(row => row.coach_id === f.coach);
    expect(current.code_salt).not.toBe(previous.code_salt); expect(current.code_digest).not.toBe(previous.code_digest);
    expect(current.code_digest).toBe(await legacyCredentialDigest(current.code_salt, newCode, secret));
    expect((after.coach_sessions as any[]).filter(row => row.coach_id === f.coach).every(row => row.revoked_at !== null)).toBe(true);
    for (const token of [f.token, f.secondToken]) expect((await f.bootstrap(token)).status).toBeGreaterThanOrEqual(400);
    expect((await f.login()).body.error.code).toBe("COACH_CODE_INVALID");
    expect((await f.bootstrap(f.otherToken)).status).toBe(200);
    const newToken = f.ok(await f.login(newCode)).result.session_token;
    expect(f.ok(await f.bootstrap(newToken)).coach.credential_version).toBe(2);
    expect(f.ok(await f.receipt(newToken, prepared.payload_digest))).toEqual(rotated);
    expect(f.ok(await f.receipt(newToken, prepared.payload_digest))).toEqual(rotated);
    const final = await f.all(), persistent = JSON.stringify(final);
    for (const code of [oldCode, secondCode, newCode]) expect(persistent).not.toContain(code);
    expect(persistent).not.toContain(await sha256Base64Url(newCode));
    const requests = (final.system_requests as any[]).filter(row => row.action === "rotateCoachCode");
    const audits = (final.audit_events as any[]).filter(row => row.action === "rotateCoachCode");
    expect(requests).toHaveLength(1); expect(audits).toHaveLength(1);
    for (const rows of [requests, audits]) {
      const text = JSON.stringify(rows);
      for (const privateValue of [current.code_salt, current.code_digest, f.token, newToken]) expect(text).not.toContain(privateValue);
    }
    expect(final.source_authority_pins).toEqual(before.source_authority_pins);
  });

  it("authenticates before replay or receipt lookup and never rotates twice after a lost reply", async () => {
    const f = await setup("replay"), digest = (await f.prepare()).payload_digest;
    const command = { ...f.command, expected_payload_digest: digest };
    const original = f.ok(await f.call("rotate-coach-code", command));
    const before = await f.all();
    for (const token of [f.token, f.secondToken, "", "forged-session-token"]) {
      expect((await f.call("rotate-coach-code", { ...command, session_token: token })).status).toBeGreaterThanOrEqual(400);
      expect((await f.receipt(token, digest)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await f.call("rotate-coach-code", command, false, false)).status).toBe(403);
    expect((await f.receipt(f.otherToken, digest)).status).toBeGreaterThanOrEqual(400);
    const newToken = f.ok(await f.login(newCode)).result.session_token;
    expect(f.ok(await f.receipt(newToken, digest))).toEqual(original);
    expect((await f.receipt(newToken, digest, { new_code: "ANOTHER-FICTIONAL-NEW-CODE" })).status).toBeGreaterThanOrEqual(400);
    expect((await f.receipt(newToken, digest, { expected_payload_digest: "sha256_v1:" + "a".repeat(43) })).status).toBeGreaterThanOrEqual(400);
    expect((await f.call("rotate-coach-code", { ...command, session_token: newToken })).status).toBeGreaterThanOrEqual(400);
    const after = await f.all();
    expect(after.coaches).toEqual(before.coaches);
    expect((after.system_requests as any[]).filter(row => row.action === "rotateCoachCode")).toHaveLength(1);
    expect((after.audit_events as any[]).filter(row => row.action === "rotateCoachCode")).toHaveLength(1);
  });

  it.each([oldCode, secondCode, "short", "  WHITESPACE-CREDENTIAL  ", "CONTROL-CREDENTIAL\n", "NONASCII-秘密-CREDENTIAL", "X".repeat(129)])(
    "rejects conflicting or unloginable Code %s without changing persistent state", async code => {
      const f = await setup(`code_${code.length}_${code.charCodeAt(0)}`), before = await f.all();
      const prepared = await f.call("prepare-coach-code-rotation", { ...f.command, new_code: code });
      if (prepared.status === 200) expect((await f.call("rotate-coach-code", { ...f.command, new_code: code,
        expected_payload_digest: prepared.body.data.payload_digest })).status).toBeGreaterThanOrEqual(400);
      else expect(prepared.status).toBeGreaterThanOrEqual(400);
      expect(await f.all()).toEqual(before);
    });

  it.each(["revoked", "disabled"])("refuses a %s current Coach even with a previously prepared digest", async mode => {
    const f = await setup(mode), digest = (await f.prepare()).payload_digest;
    if (mode === "revoked") f.ok(await f.call("coach-logout", { request_id: "rotation_logout_guard", session_token: f.token }));
    else await f.sql(ctx => ctx.storage.sql.exec("UPDATE coaches SET active=0 WHERE coach_id=?", f.coach).toArray());
    const before = await f.all();
    expect((await f.call("rotate-coach-code", { ...f.command, expected_payload_digest: digest })).status).toBeGreaterThanOrEqual(400);
    expect(await f.all()).toEqual(before);
  });

  it("binds prepared fingerprints to actor, original request, Code and expected version", async () => {
    const f = await setup("binding"), digest = (await f.prepare()).payload_digest;
    for (const delta of [{ new_code: "DIFFERENT-FICTIONAL-CREDENTIAL" }, { request_id: "rotation_replaced_request" },
      { session_token: f.otherToken }, { expected_credential_version: 2 }]) {
      const before = await f.all();
      expect((await f.call("rotate-coach-code", { ...f.command, ...delta, expected_payload_digest: digest })).status).toBeGreaterThanOrEqual(400);
      expect(await f.all()).toEqual(before);
    }
    const before = await f.all();
    expect((await f.call("rotate-coach-code", { ...f.command, coach_id: f.other, expected_payload_digest: digest })).status).toBe(400);
    expect(await f.all()).toEqual(before);
  });

  it("requires current permission for the original receipt after subsequent logout or credential advancement", async () => {
    const f = await setup("receipt_current"), digest = (await f.prepare()).payload_digest;
    f.ok(await f.call("rotate-coach-code", { ...f.command, expected_payload_digest: digest }));
    const token = f.ok(await f.login(newCode)).result.session_token;
    f.ok(await f.call("coach-logout", { request_id: "rotation_receipt_logout", session_token: token }));
    const before = await f.all();
    expect((await f.receipt(token, digest)).status).toBeGreaterThanOrEqual(400);
    expect(await f.all()).toEqual(before);
    const latestToken = f.ok(await f.login(newCode)).result.session_token;
    const next = { ...f.command, request_id: "rotation_receipt_next", session_token: latestToken,
      expected_credential_version: 2, new_code: "NEXT-FICTIONAL-ROTATION-CREDENTIAL" };
    f.ok(await f.rotate(next));
    const finalToken = f.ok(await f.login(next.new_code)).result.session_token;
    const final = await f.all();
    expect((await f.receipt(finalToken, digest)).status).toBeGreaterThanOrEqual(400);
    expect(await f.all()).toEqual(final);
  });

  it("uses one version CAS across two current sessions and distinct concurrent requests", async () => {
    const f = await setup("cas"), a = f.command, b = { ...a, request_id: "rotation_concurrent_b", session_token: f.secondToken, new_code: "SECOND-CONCURRENT-FICTIONAL-CODE" };
    const [pa, pb] = await Promise.all([f.prepare(a), f.prepare(b)]);
    const replies = await Promise.all([f.call("rotate-coach-code", { ...a, expected_payload_digest: pa.payload_digest }),
      f.call("rotate-coach-code", { ...b, expected_payload_digest: pb.payload_digest })]);
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1);
    const stored = await f.all();
    expect((stored.coaches as any[]).find(row => row.coach_id === f.coach).credential_version).toBe(2);
    expect((stored.system_requests as any[]).filter(row => row.action === "rotateCoachCode")).toHaveLength(1);
    expect((await f.login(replies[0].status === 200 ? newCode : b.new_code)).status).toBe(200);
  });

  it("does not let two actors concurrently adopt the same new Code and make login ambiguous", async () => {
    const f = await setup("census"), a = f.command, b = { ...a, request_id: "rotation_other_same_code", session_token: f.otherToken };
    const [pa, pb] = await Promise.all([f.prepare(a), f.prepare(b)]);
    const replies = await Promise.all([f.call("rotate-coach-code", { ...a, expected_payload_digest: pa.payload_digest }),
      f.call("rotate-coach-code", { ...b, expected_payload_digest: pb.payload_digest })]);
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1);
    const login = f.ok(await f.login(newCode));
    expect(login.result.coach_id).toBe(replies[0].status === 200 ? f.coach : f.other);
    expect((await f.all()).coaches.filter((row: any) => row.credential_version === 2)).toHaveLength(1);
  });
});
