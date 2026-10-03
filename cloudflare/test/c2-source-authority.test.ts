import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { C2SourceAuthority } from "../src/c2-source-authority";
import { C1HistoryService } from "../src/c1-history-service";
import { legacyCredentialDigest, sha256Base64Url } from "../src/crypto";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { sourceAuthorityText } from "../../shared/c2-source-authority-contract";
import { formResponseSourceId } from "../../shared/c2-sync-rules";
import { bindSourceAuthorityContext, createAuthorizedSourceOperation } from "../../backend/source-journal/authority-context";
import { type PrivateSourceOperationRecord } from "../../backend/source-journal/operation";
import { buildLocalSourcePlan } from "../../shared/c2-source-capture-projection";
import { SourceServerAuthorityClient } from "../../backend/source-journal/server-authority-client";
import { PrivateSourceTargetRegistry } from "../../backend/source-journal/target-registry";
import { createPrivateSourceRuntime } from "../../backend/source-journal/private-runtime";
import { PrivateSourceReview } from "../../backend/source-journal/private-review";
import { PrivateSourceJournal } from "../../backend/source-journal/service";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
async function setup(name: string) {
  const testEnv = { ...env, TEAM_ID: `authority-${name}` } as unknown as Env;
  const sid = "season_authority_001", coach = "coach_authority_001", form = "form_authority_001", at = "2020-09-01T12:00:00.000Z";
  const call = async (path: string, payload: Record<string, unknown>, c2 = false) => {
    const response = await worker.fetch(new IncomingRequest(`https://example.test${path}`, { method: "POST",
      headers: { authorization: `Bearer local-c${c2 ? 2 : 1}-test-key`, "content-type": "application/json" }, body: JSON.stringify(payload) }), testEnv);
    const data: any = await response.json(); expect(response.status, JSON.stringify(data)).toBe(200); return data.data;
  };
  const members = ["form", "legacy", "unmapped", "inactive"].map(label => ({ season_id: sid, member_id: `member_authority_${label}`,
    source_key: `source-${label}`, source_display_name: "PRIVATE_NAME_SENTINEL", display_name_override: "PRIVATE_OVERRIDE_SENTINEL",
    status: ["legacy", "inactive"].includes(label) ? "INACTIVE" : "ACTIVE", default_preference: "AMBIENT", member_version: 1, created_at: at, updated_at: at }));
  await call("/internal/c1/import-core", { request_id: `core_authority_${name}`, source_snapshot_id: `snapshot_authority_${name}`,
    settings_version: 1, default_season_id: null,
    coaches: [{ coach_id: coach, display_name: "PRIVATE_COACH_SENTINEL", code_salt: "authority_local_salt",
      code_digest: await legacyCredentialDigest("authority_local_salt", "local-test-coach-code", "local-c1-coach-secret"),
      credential_version: 1, active: true, created_at: at, updated_at: at }],
    seasons: [{ season_id: sid, name: "PRIVATE_SEASON_SENTINEL", start_date: "2020-09-01", end_date: "2020-09-20", timezone: "America/New_York",
      season_ends_at: "2020-09-21T04:00:00.000Z", status: "COMPLETED", binding_version: 1, season_version: 1, roster_version: 1,
      created_by: coach, created_at: at, updated_at: at }], members });
  const sources = [
    { source_type: "FORM_RESPONSE", source_external_id: "response_authority_001", member_id: members[0].member_id, status: "IMPORTED" },
    { source_type: "FORM_RESPONSE", source_external_id: "response_authority_002", member_id: null, status: "REVIEW_REQUIRED" },
    { source_type: "LEGACY_ROW", source_external_id: "0:2", member_id: members[1].member_id, status: "IMPORTED" },
    { source_type: "LEGACY_ROW", source_external_id: "0:3", member_id: null, status: "REVIEW_REQUIRED" },
  ].map(row => ({ ...row, stable_source_id: row.source_type === "FORM_RESPONSE" ? formResponseSourceId(sid, form, row.source_external_id) :
    `LEGACY_ROW:${sid}:${row.source_external_id}`, season_id: sid, binding_version: 1, source_digest: "sha256_v1:fictional_source_digest",
    source_version: 1, imported_at: row.status === "IMPORTED" ? at : null, updated_at: at }));
  await call("/internal/c2/import-sync-foundation", { request_id: `binding_authority_${name}`, source_snapshot_id: `binding_snapshot_${name}`,
    bindings: [{ season_id: sid, binding_version: 1, form_id: form, runtime_spreadsheet_id: "spreadsheet_authority_001", response_sheet_id: "0",
      response_sheet_name: "Responses", field_mapping: { display_name_header: "Name" }, schema_fingerprint: "sha256_v1:fictional_schema",
      export_paused: true, last_pull_at: null, last_push_at: null, created_at: at, updated_at: at }], baselines: [], source_imports: sources }, true);
  const login = await call("/internal/c1/coach-login", { request_id: `login_authority_${name}`, coach_code: "local-test-coach-code" });
  const token = login.result.session_token;
  return { testEnv, sid, coach, form, token, call, stub: testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID),
    command: { request_id: `source_authority_${name}`, session_token: token, season_id: sid } };
}
const inSql = <T>(item: Awaited<ReturnType<typeof setup>>, fn: (ctx: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(item.stub, (_instance, ctx) => fn(ctx));
const count = (ctx: DurableObjectState) => ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM source_authority_pins").one().n;

describe("C2.6 authenticated source authority pin", () => {
  it("real HTTP Coach sessions govern durable private mapping review and stop replay after revocation", async () => {
    const f = await setup("http_private_review");
    const client = new SourceServerAuthorityClient({ origin: "https://example.test", team_id: env.TEAM_ID,
      backend_instance: env.BACKEND_INSTANCE, backend_generation: env.BACKEND_GENERATION, writer_epoch: Number(env.WRITER_EPOCH) },
      async () => ({ transport_key: "local-c2-test-key", session_token: f.token }), sha256Base64Url,
      async (url, init) => worker.fetch(new IncomingRequest(url, { method: init.method, headers: init.headers, body: init.body }), f.testEnv));
    const records = new Map<string, any>(); let rows: string[] | null = null, sourceReads = 0, journalWrites = 0;
    const store = { async read(key: string) { return structuredClone(records.get(key) ?? null); },
      async compareAndSet(key: string, revision: number | null, value: any) {
        if ((records.get(key)?.revision ?? null) !== revision) return false;
        records.set(key, structuredClone(value)); return true;
      } };
    const operation = await createAuthorizedSourceOperation(() => client.pin(f.command.request_id, f.sid),
      async source_operation_id => ({ source_operation_id, attempt_id: "private_review_attempt", api_user_permission_id: "fictional_owner",
        owner_permission_id: "fictional_owner", journal_spreadsheet_id: "fictional_private_journal", journal_sheet_id: 13579 }), () => ({
        hash: sha256Base64Url, store, async readSource(context) {
          sourceReads++; const at = new Date().toISOString(), source = context.source;
          const input = { format: "c2-source-input-v1", observed_start_at: at, observed_end_at: at,
            form_schema: { formId: source.form_id, linkedSheetId: source.spreadsheet_id, info: { title: "Fictional" }, items: [] },
            form_responses: [{ responseId: "response_authority_001", createTime: "2020-09-01T12:00:00Z",
              lastSubmittedTime: "2020-09-01T12:00:00Z", answers: {} }],
            sheet_schema: { spreadsheetId: source.spreadsheet_id, sheetId: source.sheet_id, title: context.response_tab_title,
              locale: "en_US", timeZone: "America/New_York", rowCount: 2, columnCount: 1, headerRowIndex: 0, headers: [{}] },
            sheet_rows: [{ row_index: 1, cells: [{}] }], known_sources: context.known_sources, declared_mappings: [] };
          return { plan: buildLocalSourcePlan(JSON.stringify(input), source), observation: { format: "c2-source-observation-v1",
            state: "TWO_READS_MATCHED_NOT_ATOMIC", observed_start_at: at, observed_end_at: at, passes: 2,
            source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, response_tab_link_evidence: "SERVER_BINDING_DECLARATION_ONLY" } };
        }, journal: context => new PrivateSourceJournal(context, { async assertPrivate() {}, async read() { return rows && [...rows]; },
          async create(_context, value) { if (rows) throw Error("already exists"); journalWrites++; rows = [...value]; } }, sha256Base64Url),
      }));
    await operation.capture(); await operation.stage(); const review = new PrivateSourceReview(operation, store, sha256Base64Url);
    const view = await review.view(), command = JSON.stringify({ request_id: "http_mapping_review_001",
      local_snapshot_id: view.result.anchor.local_snapshot_id, row_index: 1, response_id: "response_authority_001",
      expected_sheet_digest: view.result.sheet_records[0].content_digest, expected_form_digest: view.result.form_records[0].content_digest,
      decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" });
    const first = await review.append(command);
    expect(first.ledger_version).toBe(1); expect(first.annual_export_authorized).toBe(false);
    expect(JSON.parse(first.result.evidence_text).actor_id).toBe(f.coach);
    const ledger = [...records.values()].find(row => row.format === "c2-private-source-review-ledger-v1");
    expect((await new PrivateSourceReview(operation, store, sha256Base64Url).append(command)).result.evidence_text).toBe(first.result.evidence_text);
    await inSql(f, ctx => { ctx.storage.sql.exec("UPDATE coach_sessions SET revoked_at=?", new Date().toISOString()); });
    await expect(review.view()).rejects.toMatchObject({ code: "SOURCE_PRIVATE_REVIEW_UNCONFIRMED" });
    await expect(review.append(command)).rejects.toMatchObject({ code: "SOURCE_PRIVATE_REVIEW_UNCONFIRMED" });
    expect([...records.values()].find(row => row.format === "c2-private-source-review-ledger-v1")).toEqual(ledger);
    expect(sourceReads).toBe(1); expect(journalWrites).toBe(1);
  });
  it("protected HTTP metadata pins replay through the private HTTPS client without Google or business jobs", async () => {
    const f = await setup("http_client");
    const jobsBefore = await inSql(f, ctx => ctx.storage.sql.exec("SELECT * FROM scheduled_jobs ORDER BY job_id").toArray());
    // The test stub name isolates storage; its configured DO env stays the base Wrangler env.
    const client = new SourceServerAuthorityClient({ origin: "https://example.test", team_id: env.TEAM_ID,
      backend_instance: f.testEnv.BACKEND_INSTANCE, backend_generation: f.testEnv.BACKEND_GENERATION, writer_epoch: Number(f.testEnv.WRITER_EPOCH) },
      async () => ({ transport_key: "local-c2-test-key", session_token: f.token }), sha256Base64Url,
      async (url, init) => {
        expect(init.redirect).toBe("error");
        // workerd's Request supports manual/follow only. This direct test port
        // performs no network fetch or redirect; preserve the private Node port's guard.
        return worker.fetch(new IncomingRequest(url, { method: init.method, headers: init.headers, body: init.body }), f.testEnv);
      });
    const pin = await client.pin(f.command.request_id, f.sid);
    expect(pin.actor_id).toBe(f.coach); expect(pin.known_sources).toHaveLength(6);
    expect(await client.pin(f.command.request_id, f.sid)).toEqual(pin);
    expect(sourceAuthorityText(pin)).not.toMatch(/PRIVATE_|session_token|code_salt|code_digest/);
    expect(await inSql(f, ctx => ctx.storage.sql.exec("SELECT * FROM scheduled_jobs ORDER BY job_id").toArray())).toEqual(jobsBefore);
    await inSql(f, ctx => { ctx.storage.sql.exec("UPDATE coach_sessions SET revoked_at=?", new Date().toISOString()); });
    await expect(client.pin(f.command.request_id, f.sid)).rejects.toMatchObject({ code: "SOURCE_SERVER_AUTHORITY_UNCONFIRMED" });
    expect(await inSql(f, count)).toBe(1);
  });
  it("HTTP pin requires both gates and rejects production, wrong methods and client authority fields", async () => {
    const f = await setup("http_gates");
    const call = async (input: unknown, key = "local-c2-test-key", method = "POST", testEnv = f.testEnv) => {
      const response = await worker.fetch(new IncomingRequest("https://example.test/internal/c2/pin-source-authority", {
        method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
      }), testEnv);
      return { status: response.status, body: await response.json() as any };
    };
    expect((await call(f.command, "wrong-key")).body.error.code).toBe("C2_ACCESS_DENIED");
    expect((await call({ ...f.command, session_token: "forged.token" })).body.error.code).toBe("SESSION_INVALID");
    expect((await call(f.command, undefined, "GET")).status).toBe(405);
    expect((await call(f.command, undefined, "POST", { ...f.testEnv, ENVIRONMENT: "production" } as unknown as Env)).status).toBe(404);
    const invalid = await call({ ...f.command, known_sources: [], actor_id: "browser_actor", journal_target: "browser_target" });
    expect(invalid.body.error.code).toBe("SOURCE_AUTHORITY_COMMAND_INVALID");
    expect(JSON.stringify(invalid.body)).not.toMatch(/browser_actor|browser_target|session_token|PRIVATE_/);
    expect(await inSql(f, count)).toBe(0);
  });
  it("actual HTTP sessions drive the full checkpointed runtime and stop a source page after logout", async () => {
    for (const revoked of [false, true]) {
      const f = await setup(`http_runtime_${revoked}`);
      const client = new SourceServerAuthorityClient({ origin: "https://example.test", team_id: env.TEAM_ID,
        backend_instance: env.BACKEND_INSTANCE, backend_generation: env.BACKEND_GENERATION, writer_epoch: Number(env.WRITER_EPOCH) },
        async () => ({ transport_key: "local-c2-test-key", session_token: f.token }), sha256Base64Url,
        async (url, init) => worker.fetch(new IncomingRequest(url, { method: init.method, headers: init.headers, body: init.body }), f.testEnv));
      const records = new Map<string, any>();
      const store = { async read(key: string) { return structuredClone(records.get(key) ?? null); },
        async compareAndSet(key: string, revision: number | null, value: any) {
          if ((records.get(key)?.revision ?? null) !== revision) return false;
          records.set(key, structuredClone(value)); return true;
        } };
      const pin = await client.pin(f.command.request_id, f.sid);
      const registry = new PrivateSourceTargetRegistry(pin.source.team_id, store, sha256Base64Url);
      await registry.register(pin, { source_operation_id: pin.source.source_operation_id, attempt_id: "http_runtime_attempt",
        api_user_permission_id: "fictional_owner", owner_permission_id: "fictional_owner", journal_spreadsheet_id: "fictional_private_journal", journal_sheet_id: 97531 });
      let formReads = 0;
      const operation = await createPrivateSourceRuntime({ authorize: () => client.pin(f.command.request_id, f.sid),
        registeredTarget: id => registry.get(id), store, hash: sha256Base64Url, oauthToken: async () => "FICTIONAL_GOOGLE_TOKEN",
        async fetchGoogle(url) {
          const parsed = new URL(url), source = pin.source;
          if (parsed.pathname.endsWith("/about")) return Response.json({ user: { permissionId: "fictional_owner" } });
          if (parsed.hostname === "forms.googleapis.com") {
            formReads++;
            if (revoked) await inSql(f, ctx => { ctx.storage.sql.exec("UPDATE coach_sessions SET revoked_at=?", new Date().toISOString()); });
            return Response.json(parsed.pathname.endsWith("/responses") ? { responses: [] } :
              { formId: source.form_id, linkedSheetId: source.spreadsheet_id, revisionId: "fictional_revision", info: { title: "Fictional" }, items: [] });
          }
          return Response.json({ spreadsheetId: source.spreadsheet_id, properties: { locale: "en_US", timeZone: "America/New_York" },
            sheets: [{ properties: { sheetId: source.sheet_id, title: "Responses", sheetType: "GRID", gridProperties: { rowCount: 1, columnCount: 1 } },
              ...(parsed.pathname.endsWith(":getByDataFilter") ? { data: [{ rowData: [{ values: [{}] }] }] } : {}) }] });
        } });
      if (revoked) {
        await expect(operation.capture()).rejects.toThrow(); expect(formReads).toBe(1);
        expect([...records.values()].some(record => record.format === "c2-private-source-read-v1" && record.pending)).toBe(true);
        expect([...records.values()].filter(record => record.format === "c2-private-source-operation-v1").every(record => record.candidate === null)).toBe(true);
      } else {
        expect((await operation.capture()).phase).toBe("CANDIDATE_DURABLE");
        const before = formReads; await operation.capture(); expect(formReads).toBe(before);
        expect([...records.values()].some(record => record.format === "c2-private-source-read-v1" && record.observed_end_at && !record.pending)).toBe(true);
      }
      expect(sourceAuthorityText(await inSql(f, ctx => ctx.storage.sql.exec("SELECT * FROM source_authority_pins").toArray()))).not.toContain("FICTIONAL_GOOGLE_TOKEN");
    }
  });
  it("derives server actor, cutoff and complete database census without raw names or credentials, then binds a private target", async () => {
    const f = await setup("complete"); await inSql(f, async ctx => {
      ctx.storage.sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id=?", f.sid);
      ctx.storage.sql.exec("UPDATE sync_bindings SET binding_version=2 WHERE season_id=?", f.sid);
      const pin = await new C2SourceAuthority(ctx, f.testEnv).pin(f.command);
      expect(pin.actor_id).toBe(f.coach); expect(pin.source.binding_version).toBe(2);
      expect(pin.source.season_ends_at).toBe("2020-09-21T04:00:00.000Z");
      expect(pin.known_sources).toHaveLength(6); // includes older bindings and inactive members
      expect(pin.known_sources).toContainEqual({ kind: "UNMAPPED_MEMBER", member_id: "member_authority_inactive" });
      expect(pin.known_sources).toContainEqual({ kind: "LEGACY_ROW", source_key: "0:2", status: "IMPORTED" });
      expect(sourceAuthorityText(pin)).not.toMatch(/PRIVATE_|session_token|code_digest|code_salt/);
      const { authority_digest, ...core } = pin;
      expect(await sha256Base64Url("c2-source-authority-pin-v1\n" + sourceAuthorityText(core))).toBe(authority_digest);
      const context = await bindSourceAuthorityContext(pin, { source_operation_id: pin.source.source_operation_id, attempt_id: "private_attempt",
        api_user_permission_id: "fictional_owner", owner_permission_id: "fictional_owner", journal_spreadsheet_id: "private_registered_target", journal_sheet_id: 13579 }, sha256Base64Url);
      expect(context.actor_id).toBe(f.coach); expect(context.read_context.known_sources).toEqual(pin.known_sources);
      expect(context.read_context.declared_mappings).toEqual([]); expect(count(ctx)).toBe(1);
    });
  });
  it("replays the original census after new known IDs arrive and after DO eviction", async () => {
    const f = await setup("replay");
    const first = await inSql(f, ctx => new C2SourceAuthority(ctx, f.testEnv).pin(f.command));
    await inSql(f, async ctx => {
      ctx.storage.sql.exec("INSERT INTO members SELECT season_id,'member_later_added','source-later',source_display_name,display_name_override,status,default_preference,member_version,created_at,updated_at FROM members LIMIT 1");
      expect(await new C2SourceAuthority(ctx, f.testEnv).pin(f.command)).toEqual(first);
    });
    await evictDurableObject(f.stub);
    expect(await inSql(f, ctx => new C2SourceAuthority(ctx, f.testEnv).pin(f.command))).toEqual(first);
  });
  it("requires actual signed current sessions, including on replay", async () => {
    const f = await setup("sessions"); await inSql(f, async ctx => {
      const service = new C2SourceAuthority(ctx, f.testEnv);
      await expect(service.pin({ ...f.command, session_token: "forged.token" })).rejects.toMatchObject({ code: "SESSION_INVALID" });
      await service.pin(f.command);
      ctx.storage.sql.exec("UPDATE coach_sessions SET revoked_at=?", new Date().toISOString());
      await expect(service.pin(f.command)).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    });
  });
  it("rejects client authority fields and later request IDs that would replace a season scope", async () => {
    const f = await setup("scope"); await inSql(f, async ctx => {
      const service = new C2SourceAuthority(ctx, f.testEnv);
      await expect(service.pin({ ...f.command, known_sources: [] })).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_COMMAND_INVALID" });
      await service.pin(f.command);
      await expect(service.pin({ ...f.command, request_id: "different_source_request" })).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_SCOPE_ALREADY_PINNED" });
      await expect(service.pin({ ...f.command, season_id: "different_season_001" })).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_IDEMPOTENCY_CONFLICT" });
      expect(count(ctx)).toBe(1);
    });
  });
  it("rejects not-ended seasons, mismatched binding and noncanonical numeric response tabs", async () => {
    for (const [name, query, code] of [
      ["open", "UPDATE seasons SET status='OPEN'", "SOURCE_AUTHORITY_NOT_DUE"],
      ["future", "UPDATE seasons SET season_ends_at='2099-01-01T00:00:00Z'", "SOURCE_AUTHORITY_NOT_DUE"],
      ["binding", "UPDATE sync_bindings SET binding_version=2", "SOURCE_AUTHORITY_BINDING_UNPROVEN"],
      ["tab", "UPDATE sync_bindings SET response_sheet_id='00'", "SOURCE_AUTHORITY_BINDING_UNPROVEN"],
    ]) {
      const f = await setup(name); await inSql(f, async ctx => {
        ctx.storage.sql.exec(query);
        await expect(new C2SourceAuthority(ctx, f.testEnv).pin(f.command)).rejects.toMatchObject({ code }); expect(count(ctx)).toBe(0);
      });
    }
  });
  it("replay rejects current source, cutoff, title, generation and epoch changes", async () => {
    for (const [name, query] of [["changed_cutoff", "UPDATE seasons SET season_ends_at='2020-09-22T04:00:00Z'"],
      ["changed_form", "UPDATE sync_bindings SET form_id='different_form_001'"],
      ["changed_title", "UPDATE sync_bindings SET response_sheet_name='Changed title'"]]) {
      const f = await setup(name); await inSql(f, async ctx => {
        await new C2SourceAuthority(ctx, f.testEnv).pin(f.command); ctx.storage.sql.exec(query);
        await expect(new C2SourceAuthority(ctx, f.testEnv).pin(f.command)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_OWNERSHIP_CHANGED" });
      });
    }
    const f = await setup("changed_backend"); await inSql(f, async ctx => {
      await new C2SourceAuthority(ctx, f.testEnv).pin(f.command);
      for (const changed of [{ BACKEND_GENERATION: "different_generation" }, { WRITER_EPOCH: "2" }])
        await expect(new C2SourceAuthority(ctx, { ...f.testEnv, ...changed } as unknown as Env).pin(f.command)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    });
  });
  it("census changes or logout inside a hash await stop publication", async () => {
    for (const kind of ["census", "logout"]) {
      const f = await setup(`during_${kind}`); await inSql(f, async ctx => {
        class Changed extends C2SourceAuthority {
          protected async digest(text: string) {
            if (text.startsWith("c2-source-authority-pin-v1\n")) {
              if (kind === "logout") ctx.storage.sql.exec("UPDATE coach_sessions SET revoked_at=?", new Date().toISOString());
              else ctx.storage.sql.exec("INSERT INTO members SELECT season_id,'member_during_hash','source-during',source_display_name,display_name_override,status,default_preference,member_version,created_at,updated_at FROM members LIMIT 1");
            }
            return super.digest(text);
          }
        }
        await expect(new Changed(ctx, f.testEnv).pin(f.command)).rejects.toMatchObject({ code: kind === "logout" ? "SESSION_REVOKED" : "SOURCE_AUTHORITY_CENSUS_CHANGED" });
        expect(count(ctx)).toBe(0);
      });
    }
  });
  it("concurrent identical requests converge to one immutable pin", async () => {
    const f = await setup("concurrent"); await inSql(f, async ctx => {
      const pins = await Promise.all([new C2SourceAuthority(ctx, f.testEnv).pin(f.command), new C2SourceAuthority(ctx, f.testEnv).pin(f.command)]);
      expect(pins[0]).toEqual(pins[1]); expect(count(ctx)).toBe(1);
    });
  });
  it("over-limit census is rejected before identifier materialization", async () => {
    const f = await setup("budget"); await inSql(f, async ctx => {
      ctx.storage.sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001)
        INSERT INTO source_imports SELECT 'LEGACY_ROW:'||?||':bulk-'||x,?,1,'LEGACY_ROW','bulk-'||x,'digest',1,NULL,'REVIEW_REQUIRED',NULL,? FROM n`, f.sid, f.sid, new Date().toISOString());
      await expect(new C2SourceAuthority(ctx, f.testEnv).pin(f.command)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_RESOURCE_EXCEEDED" });
      expect(count(ctx)).toBe(0);
    });
  });
  it("unknown Form identity and stored digest corruption cannot be accepted", async () => {
    const f = await setup("identity"); await inSql(f, async ctx => {
      ctx.storage.sql.exec("UPDATE source_imports SET stable_source_id='FORM_RESPONSE:other_form:bad_source' WHERE source_type='FORM_RESPONSE' AND status='REVIEW_REQUIRED'");
      await expect(new C2SourceAuthority(ctx, f.testEnv).pin(f.command)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_CENSUS_INVALID" });
      ctx.storage.sql.exec("UPDATE source_imports SET stable_source_id=? WHERE source_type='FORM_RESPONSE' AND status='REVIEW_REQUIRED'", formResponseSourceId(f.sid, f.form, "response_authority_002"));
      const pin = await new C2SourceAuthority(ctx, f.testEnv).pin(f.command);
      const changed = { ...pin, known_sources: [] };
      ctx.storage.sql.exec("UPDATE source_authority_pins SET pin_text=?", sourceAuthorityText(changed));
      await expect(new C2SourceAuthority(ctx, f.testEnv).pin(f.command)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_PIN_CHANGED" });
    });
  });
  it("migrates schema15 transactionally and backs up nonempty authority metadata without raw source", async () => {
    const f = await setup("backup"); await inSql(f, async ctx => {
      ctx.storage.sql.exec("DROP TABLE source_authority_pins; UPDATE app_meta SET value='15' WHERE key='schema_version'");
      applySchema(ctx.storage); expect(APPLICATION_SCHEMA_VERSION).toBe(16);
      const pin = await new C2SourceAuthority(ctx, f.testEnv).pin(f.command);
      const history = new C1HistoryService(ctx, f.testEnv);
      const backup: any = await history.handle("/internal/c1/create-backup-snapshot", { request_id: "source_authority_backup_001", session_token: f.token });
      expect(backup.result.manifest.tables).toHaveLength(51);
      const descriptor = backup.result.manifest.tables.find((table: any) => table.name === "source_authority_pins");
      expect(descriptor.row_count).toBe(1);
      const block: any = await history.handle("/internal/c1/get-backup-chunk", { request_id: "source_authority_block_001", session_token: f.token,
        snapshot_id: backup.result.snapshot_id, chunk_index: descriptor.chunk_indices[0] });
      expect(block.chunk.payload.rows[0].pin_text).toBe(sourceAuthorityText(pin));
      expect(sourceAuthorityText(block.chunk.payload)).not.toMatch(/PRIVATE_|session_token|code_digest|code_salt/);
    });
  });
  it("actual SQLite sessions govern private candidate capture and block staging after revocation", async () => {
    for (const duringRead of [false, true]) {
      const f = await setup(`controller_${duringRead}`); await inSql(f, async ctx => {
        const records = new Map<string, PrivateSourceOperationRecord>(); let reads = 0, journalCalls = 0;
        const operation = await createAuthorizedSourceOperation(() => new C2SourceAuthority(ctx, f.testEnv).pin(f.command),
          async source_operation_id => ({ source_operation_id, attempt_id: "private_controller_attempt", api_user_permission_id: "fictional_owner",
            owner_permission_id: "fictional_owner", journal_spreadsheet_id: "private_registered_target", journal_sheet_id: 13579 }), () => ({
            hash: sha256Base64Url, store: {
              async read(key) { return structuredClone(records.get(key) ?? null); },
              async compareAndSet(key, revision, value) {
                if ((records.get(key)?.revision ?? null) !== revision) return false;
                records.set(key, structuredClone(value)); return true;
              },
            }, async readSource(context) {
              reads++;
              const at = new Date().toISOString(), source = context.source;
              const input = { format: "c2-source-input-v1", observed_start_at: at, observed_end_at: at,
                form_schema: { formId: source.form_id, linkedSheetId: source.spreadsheet_id, info: { title: "Fictional" }, items: [] },
                form_responses: [], sheet_schema: { spreadsheetId: source.spreadsheet_id, sheetId: source.sheet_id, title: context.response_tab_title,
                  locale: "en_US", timeZone: "America/New_York", rowCount: 1, columnCount: 1, headerRowIndex: 0, headers: [{}] },
                sheet_rows: [], known_sources: context.known_sources, declared_mappings: [] };
              if (duringRead) ctx.storage.sql.exec("UPDATE coach_sessions SET revoked_at=?", at);
              return { plan: buildLocalSourcePlan(JSON.stringify(input), source), observation: { format: "c2-source-observation-v1",
                state: "TWO_READS_MATCHED_NOT_ATOMIC", observed_start_at: at, observed_end_at: at, passes: 2,
                source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, response_tab_link_evidence: "SERVER_BINDING_DECLARATION_ONLY" } };
            }, journal() { journalCalls++; throw Error("Unexpected journal call"); },
          }));
        if (duringRead) {
          await expect(operation.capture()).rejects.toMatchObject({ code: "SOURCE_OPERATION_AUTHORITY_UNCONFIRMED" });
          expect([...records.values()].every(record => record.candidate === null)).toBe(true);
        } else {
          expect((await operation.capture()).phase).toBe("CANDIDATE_DURABLE");
          await operation.capture(); expect(reads).toBe(1);
          ctx.storage.sql.exec("UPDATE coach_sessions SET revoked_at=?", new Date().toISOString());
          await expect(operation.stage()).rejects.toMatchObject({ code: "SOURCE_OPERATION_AUTHORITY_UNCONFIRMED" });
          expect([...records.values()].some(record => record.phase === "JOURNAL_WRITE_STARTED")).toBe(false);
        }
        expect(journalCalls).toBe(0); expect(count(ctx)).toBe(1);
      });
    }
  });
  it("schema16 failures roll back newly created metadata and preserve incompatible existing storage", async () => {
    const f = await setup("migration_fault"); await inSql(f, ctx => {
      const sql = ctx.storage.sql;
      sql.exec("DROP TABLE source_authority_pins; UPDATE app_meta SET value='15' WHERE key='schema_version'");
      const before = sql.exec("SELECT * FROM members ORDER BY member_id").toArray();
      const wrappedSql = new Proxy(sql, { get(target, key) {
        if (key === "exec") return (query: string, ...args: SqlStorageValue[]) => {
          const result = target.exec(query, ...args);
          if (query.includes("CREATE TABLE IF NOT EXISTS source_authority_pins")) throw Error("Source migration post-DDL fault");
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      const wrapped = { sql: wrappedSql, transactionSync: <T>(fn: () => T) => ctx.storage.transactionSync(fn) };
      expect(() => applySchema(wrapped as DurableObjectStorage)).toThrow("Source migration post-DDL fault");
      expect(sql.exec<{ value: string }>("SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe("15");
      expect(sql.exec<{ n: number }>("SELECT COUNT(*) n FROM sqlite_master WHERE name='source_authority_pins'").one().n).toBe(0);
      sql.exec("CREATE TABLE source_authority_pins(season_id TEXT PRIMARY KEY, saved TEXT); INSERT INTO source_authority_pins VALUES ('existing','preserve')");
      expect(() => applySchema(ctx.storage)).toThrow("Unsupported source authority storage schema");
      expect(sql.exec("SELECT * FROM source_authority_pins").toArray()).toEqual([{ season_id: "existing", saved: "preserve" }]);
      expect(sql.exec<{ value: string }>("SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe("15");
      expect(sql.exec("SELECT * FROM members ORDER BY member_id").toArray()).toEqual(before);
    });
  });
});
