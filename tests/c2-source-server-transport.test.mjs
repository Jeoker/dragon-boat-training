import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createPrivateFileOperationStore } from "../backend/source-journal/private-file-store.mjs";
import { SourceServerAuthorityClient, PrivateSourceTargetRegistry, SourceJournalError, sourceCanonical,
  goldens, sha, createAuthorizedSourceOperation, buildLocalSourcePlan, PrivateSourceJournal, model, createPrivateSourceRuntime, googleModel }
  from "./source-journal-test-runtime.mjs";
import { sourceModel } from "./source-reader-model.mjs";

async function fixture() {
  const source = structuredClone(goldens.cases[0].pinned), input = JSON.parse(goldens.cases[0].input_text);
  input.declared_mappings = [];
  const core = { format: "c2-source-authority-pin-v1", state: "SERVER_AUTHORITY_PIN_ONLY", actor_id: "fictional_coach",
    source, known_sources: input.known_sources, response_tab_title: "Responses", census_scope: "DATABASE_KNOWN_IDENTITIES_ONLY",
    pinned_at: input.observed_end_at, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
  const pin = { ...core, authority_digest: await sha("c2-source-authority-pin-v1\n" + sourceCanonical(core)) };
  const config = { origin: "https://fictional.example", team_id: source.team_id, backend_instance: "fictional_private_backend",
    backend_generation: source.backend_generation, writer_epoch: source.writer_epoch };
  const envelope = { ok: true, data: { pin }, meta: { contract_version: "2026-09-30.c2.5-associated-export", request_id: "fictional_request_001",
    environment: "staging", backend_instance: config.backend_instance, backend_generation: config.backend_generation,
    writer_epoch: config.writer_epoch, server_time: input.observed_end_at, service_version: "fictional_service" } };
  const target = { source_operation_id: source.source_operation_id, attempt_id: "fictional_registered_attempt", api_user_permission_id: "fictional_owner",
    owner_permission_id: "fictional_owner", journal_spreadsheet_id: "fictional_private_journal", journal_sheet_id: 97531 };
  const state = { calls: [], credentials: { transport_key: "PRIVATE_KEY_SENTINEL", session_token: "PRIVATE_SESSION_SENTINEL" }, records: new Map() };
  const store = { async read(key) { return structuredClone(state.records.get(key) ?? null); }, async compareAndSet(key, revision, value) {
    if ((state.records.get(key)?.revision ?? null) !== revision) return false;
    state.records.set(key, structuredClone(value)); return true;
  } };
  const client = (port = async (url, init) => { state.calls.push({ url, init }); return Response.json(envelope); }, hash = sha) =>
    new SourceServerAuthorityClient(config, async () => state.credentials, hash, port);
  return { source, input, pin, config, envelope, target, state, store, client,
    registry: new PrivateSourceTargetRegistry(source.team_id, store, sha) };
}
const denied = action => assert.rejects(action, error => error instanceof SourceJournalError &&
  error.message === "Private source journal could not be confirmed." && !JSON.stringify(error).includes("PRIVATE_"));

test("HTTPS authority requests keep credentials out of URLs, preserve request identity and refresh credentials", async () => {
  const f = await fixture(), client = f.client();
  assert.deepEqual(await client.pin("fictional_request_001", f.source.season_id), f.pin);
  f.state.credentials.session_token = "PRIVATE_REFRESHED_SESSION_SENTINEL";
  await client.pin("fictional_request_001", f.source.season_id);
  for (const { url, init } of f.state.calls) {
    assert.equal(url, "https://fictional.example/internal/c2/pin-source-authority");
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    assert.equal(init.headers.Authorization, "Bearer PRIVATE_KEY_SENTINEL");
    assert.equal(init.signal.aborted, false);
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ["request_id", "season_id", "session_token"]);
  }
  assert.equal(JSON.parse(f.state.calls[1].init.body).session_token, "PRIVATE_REFRESHED_SESSION_SENTINEL");
});

test("noncanonical origin, browser fields and malformed credentials fail before a request", async () => {
  const f = await fixture();
  for (const origin of ["http://fictional.example", "https://fictional.example/", "https://user:secret@fictional.example",
    "https://fictional.example/path", "https://fictional.example?token=secret", "https://fictional.example#hash", "https://fictional.example:444"])
    assert.throws(() => new SourceServerAuthorityClient({ ...f.config, origin }, async () => f.state.credentials, sha), SourceJournalError);
  assert.throws(() => new SourceServerAuthorityClient({ ...f.config, trusted: true }, async () => f.state.credentials, sha), SourceJournalError);
  for (const credentials of [{ ...f.state.credentials, actor_id: "browser_actor" }, { transport_key: "\r\nsecret", session_token: "secret" },
    { transport_key: "secret", session_token: "" }]) {
    f.state.credentials = credentials; await denied(f.client().pin("fictional_request_001", f.source.season_id));
  }
  assert.equal(f.state.calls.length, 0);
});

test("incorrect request, contract, backend, source and digest cannot authenticate a pin", async () => {
  const f = await fixture();
  const mutations = [e => { e.meta.request_id = "another_request"; }, e => { e.meta.contract_version = "old_contract"; },
    e => { e.meta.backend_instance = "another_backend"; }, e => { e.meta.backend_generation = "another_generation"; },
    e => { e.meta.writer_epoch++; }, e => { e.meta.environment = "production"; }, e => { e.data.pin.actor_id = "another_actor"; },
    e => { e.data.pin.source.team_id = "another_team"; }, e => { e.data.pin.source.season_id = "another_season"; },
    e => { e.data.pin.annual_export_authorized = true; }, e => { e.data.raw_answers = "PRIVATE_RAW_SENTINEL"; }, e => { e.ok = false; }];
  for (const mutate of mutations) {
    const envelope = structuredClone(f.envelope); mutate(envelope);
    await denied(f.client(async () => Response.json(envelope)).pin("fictional_request_001", f.source.season_id));
  }
});

test("error responses and redirects are rejected without reading or logging their body", async () => {
  const f = await fixture(); let reads = 0;
  for (const status of [301, 302, 307, 308, 401, 403, 500]) {
    const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new TextEncoder().encode("PRIVATE_ERROR_SENTINEL")); controller.close(); } }, { highWaterMark: 0 });
    await denied(f.client(async () => new Response(body, { status })).pin("fictional_request_001", f.source.season_id));
  }
  assert.equal(reads, 0);
  await denied(f.client(async () => { throw new Error("PRIVATE_URL_SENTINEL"); }).pin("fictional_request_001", f.source.season_id));
  await denied(f.client(undefined, async () => { throw new Error("PRIVATE_HASH_SENTINEL"); }).pin("fictional_request_001", f.source.season_id));
});

test("stream budgets, decoded duplicate keys, invalid UTF8 and non-JSON content are rejected", async () => {
  const f = await fixture();
  for (const text of ["x".repeat(2_000_001), '{"ok":true,"o\\u006b":false,"meta":{},"data":{}}', "{} trailing"])
    await denied(f.client(async () => new Response(text, { headers: { "content-type": "application/json" } })).pin("fictional_request_001", f.source.season_id));
  await denied(f.client(async () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })).pin("fictional_request_001", f.source.season_id));
  await denied(f.client(async () => new Response("{}", { headers: { "content-type": "text/html" } })).pin("fictional_request_001", f.source.season_id));
  await denied(f.client(async () => Response.json(f.envelope, { headers: { "content-length": "2000001" } })).pin("fictional_request_001", f.source.season_id));
});

test("hostile response cleanup and forged registry diagnostics cannot leak dependency exceptions", async () => {
  const f = await fixture();
  await denied(f.client(async () => ({ status: 500, get body() { throw Error("PRIVATE_CLEANUP_SENTINEL"); } }))
    .pin("fictional_request_001", f.source.season_id));
  const forged = new SourceJournalError("SOURCE_TARGET_REGISTRY_CONFLICT"); forged.message = "PRIVATE_FOREIGN_DIAGNOSTIC";
  await denied(new PrivateSourceTargetRegistry(f.source.team_id, { async read() { throw forged; } }, sha).register(f.pin, f.target));
  Object.defineProperty(forged, "code", { get() { throw Error("PRIVATE_DIAGNOSTIC_GETTER"); } });
  await denied(new PrivateSourceTargetRegistry(f.source.team_id, { async read() { throw forged; } }, sha).register(f.pin, f.target));
});

test("concurrent target registration converges and never replaces attempt, target, owner or original pin", async () => {
  const f = await fixture();
  const result = await Promise.all([f.registry.register(f.pin, f.target), f.registry.register(f.pin, f.target)]);
  assert.deepEqual(result, [f.target, f.target]); assert.equal(f.state.records.size, 1);
  for (const target of [{ ...f.target, attempt_id: "replacement_attempt" }, { ...f.target, journal_sheet_id: f.target.journal_sheet_id + 1 },
    { ...f.target, journal_spreadsheet_id: "replacement_private_target" }, { ...f.target, owner_permission_id: "replacement_owner", api_user_permission_id: "replacement_owner" }])
    await denied(f.registry.register(f.pin, target));
  assert.deepEqual(await f.registry.get(f.source.source_operation_id), f.target);
  const { authority_digest, ...changed } = { ...f.pin, actor_id: "another_actor" };
  await denied(f.registry.register({ ...changed, authority_digest: await sha("c2-source-authority-pin-v1\n" + sourceCanonical(changed)) }, f.target));
  assert.equal(f.state.records.size, 1);
});

test("lost registration acknowledgement recovers original data; corruption and arbitrary store failures stay private", async () => {
  const f = await fixture(); let once = true;
  const store = { ...f.store, async compareAndSet(...args) {
    const result = await f.store.compareAndSet(...args); if (once) { once = false; throw Error("PRIVATE_STORE_SENTINEL"); } return result;
  } };
  const registry = new PrivateSourceTargetRegistry(f.source.team_id, store, sha);
  await denied(registry.register(f.pin, f.target));
  assert.deepEqual(await registry.register(f.pin, f.target), f.target);
  const record = [...f.state.records.values()][0]; record.target.journal_sheet_id++;
  await denied(registry.get(f.source.source_operation_id));
  await denied(new PrivateSourceTargetRegistry(f.source.team_id, { async read() { throw Error("PRIVATE_STORE_SENTINEL"); } }, sha).get(f.source.source_operation_id));
});

test("target registry is durable across separate Node processes and refuses a replacement", async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "dragon-boat-private-registry-"));
  const runtimeUrl = new URL("./source-journal-test-runtime.mjs", import.meta.url).href;
  const storeUrl = new URL("../backend/source-journal/private-file-store.mjs", import.meta.url).href;
  const script = `import {PrivateSourceTargetRegistry,sha} from ${JSON.stringify(runtimeUrl)};
    import {createPrivateFileOperationStore} from ${JSON.stringify(storeUrl)};
    const [directory,pinText,targetText,mode]=process.argv.slice(1),pin=JSON.parse(pinText);
    const registry=new PrivateSourceTargetRegistry(pin.source.team_id,await createPrivateFileOperationStore(directory),sha);
    const target=mode==='get'?await registry.get(pin.source.source_operation_id):await registry.register(pin,JSON.parse(targetText));
    process.stdout.write(JSON.stringify(target));`;
  const run = mode => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, directory,
    JSON.stringify(f.pin), JSON.stringify(f.target), mode], { encoding: "utf8" }));
  try {
    assert.deepEqual(run("register"), f.target); assert.deepEqual(run("get"), f.target); assert.deepEqual(run("register"), f.target);
    const registry = new PrivateSourceTargetRegistry(f.source.team_id, await createPrivateFileOperationStore(directory), sha);
    await denied(registry.register(f.pin, { ...f.target, attempt_id: "replacement_attempt" }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTTPS client, persistent target registry and private operation compose through capture and original journal recovery", async () => {
  const f = await fixture(), client = f.client(), journal = model(); let reads = 0;
  await f.registry.register(await client.pin("fictional_request_001", f.source.season_id), f.target);
  const operation = await createAuthorizedSourceOperation(() => client.pin("fictional_request_001", f.source.season_id),
    operationId => f.registry.get(operationId), () => ({ hash: sha, store: f.store, async readSource() {
      reads++; return { plan: buildLocalSourcePlan(JSON.stringify(f.input), f.source), observation: { format: "c2-source-observation-v1",
        state: "TWO_READS_MATCHED_NOT_ATOMIC", observed_start_at: f.input.observed_start_at, observed_end_at: f.input.observed_end_at,
        passes: 2, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, response_tab_link_evidence: "SERVER_BINDING_DECLARATION_ONLY" } };
    }, journal: context => new PrivateSourceJournal(context, journal.store, sha) }));
  await operation.capture(); await operation.stage();
  const result = await operation.resume(); assert.equal(result.phase, "JOURNAL_READBACK_CONFIRMED");
  assert.equal(result.annual_export_authorized, false); assert.equal(result.source_status, "SOURCE_NOT_VERIFIED");
  assert.equal(reads, 1); assert.equal(journal.state.writes, 1); assert.ok(f.state.calls.length >= 8);
});

async function runtimeFixture() {
  const f = await fixture(), source = sourceModel(), journal = googleModel(); let denied = false;
  await f.registry.register(f.pin, f.target);
  const ports = { authorize: async () => { if (denied) throw Error("PRIVATE_SESSION_SENTINEL"); return f.pin; },
    registeredTarget: operationId => f.registry.get(operationId), store: f.store, hash: sha, oauthToken: source.token, now: source.now,
    fetchGoogle: (url, init) => {
      const parsed = new URL(url);
      return parsed.hostname === "forms.googleapis.com" || parsed.pathname.includes(f.source.spreadsheet_id) || parsed.pathname.endsWith("/about")
        ? source.fetch(url, init) : journal.fetch(url, init);
    } };
  return { f, source, journal, ports, revoke: () => { denied = true; } };
}

test("private runtime always checkpoints full REST reads and restores the original unknown journal write", async () => {
  const r = await runtimeFixture(), operation = await createPrivateSourceRuntime(r.ports);
  await operation.capture();
  const readRecord = [...r.f.state.records.values()].find(record => record.format === "c2-private-source-read-v1");
  assert.ok(readRecord.observed_end_at); assert.equal(readRecord.pending, null); assert.ok(readRecord.entries.length > 0);
  const reads = r.source.state.calls.length;
  r.journal.state.lostReply = true; r.journal.state.afterWrite = state => { state.failGet = true; };
  await denied(operation.stage());
  r.journal.state.lostReply = false; r.journal.state.failGet = false; r.journal.state.afterWrite = null;
  const restarted = await createPrivateSourceRuntime(r.ports);
  assert.equal((await restarted.resume()).phase, "JOURNAL_READBACK_CONFIRMED");
  assert.equal(r.journal.state.calls.filter(call => call.url.pathname.endsWith(":batchUpdate")).length, 1);
  assert.ok(r.source.state.calls.slice(reads).every(call => call.url.pathname.endsWith("/about")));
});

test("revoked authority after a source request stops all later requests and leaves its original unresolved checkpoint", async () => {
  const r = await runtimeFixture(), operation = await createPrivateSourceRuntime(r.ports);
  r.source.state.onCall = (_state, url) => { if (url.hostname === "forms.googleapis.com") r.revoke(); };
  await denied(operation.capture());
  assert.equal(r.source.state.calls.filter(call => call.url.hostname === "forms.googleapis.com").length, 1);
  assert.ok([...r.f.state.records.values()].some(record => record.format === "c2-private-source-read-v1" && record.pending));
  assert.ok([...r.f.state.records.values()].filter(record => record.format === "c2-private-source-operation-v1").every(record => record.candidate === null));
  assert.equal(r.journal.state.calls.length, 0);
});

test("runtime recreation resumes durable range replies after acknowledgement loss instead of refetching earlier source pages", async () => {
  const r = await runtimeFixture(); let interrupted = false;
  const store = { ...r.ports.store, async compareAndSet(key, revision, value) {
    const result = await r.ports.store.compareAndSet(key, revision, value);
    if (!interrupted && result && value.format === "c2-private-source-read-v1" && value.pending === null &&
      value.entries.at(-1)?.request_text.includes(":getByDataFilter")) { interrupted = true; throw Error("PRIVATE_DURABLE_REPLY_INTERRUPTED"); }
    return result;
  } };
  await denied((await createPrivateSourceRuntime({ ...r.ports, store })).capture()); assert.equal(interrupted, true);
  assert.equal(r.source.state.listReads, 2);
  const restarted = await createPrivateSourceRuntime(r.ports);
  assert.equal((await restarted.capture()).phase, "CANDIDATE_DURABLE"); assert.equal(r.source.state.listReads, 4);
  const after = r.source.state.calls.length; await restarted.capture(); assert.equal(r.source.state.calls.length, after);
});
