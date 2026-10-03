import assert from "node:assert/strict";
import test from "node:test";
import { bindSourceAuthorityContext, createAuthorizedSourceOperation, PrivateSourceJournal, goldens, sha, model,
  SourceJournalError, sourceCanonical, buildLocalSourcePlan } from "./source-journal-test-runtime.mjs";

async function fixture() {
  const golden = goldens.cases[0], input = JSON.parse(golden.input_text);
  input.declared_mappings = [];
  const captured = buildLocalSourcePlan(JSON.stringify(input), golden.pinned);
  const core = { format: "c2-source-authority-pin-v1", state: "SERVER_AUTHORITY_PIN_ONLY", actor_id: "fixture_coach",
    source: structuredClone(golden.pinned), known_sources: input.known_sources, response_tab_title: "Responses",
    census_scope: "DATABASE_KNOWN_IDENTITIES_ONLY", pinned_at: input.observed_end_at,
    source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
  const pin = { ...core, authority_digest: await sha("c2-source-authority-pin-v1\n" + sourceCanonical(core)) };
  const registry = { source_operation_id: core.source.source_operation_id, attempt_id: "registered_attempt",
    api_user_permission_id: "fixture_owner", owner_permission_id: "fixture_owner", journal_spreadsheet_id: "fixture_private_target", journal_sheet_id: 9876 };
  const state = { denied: false, reads: 0, checks: 0, records: new Map(), afterRead: null, afterWriteStart: null };
  const journal = model();
  const authorize = async () => { state.checks++; if (state.denied) throw new Error("PRIVATE_AUTH_SENTINEL"); return pin; };
  const ports = { hash: sha, store: {
    async read(key) { return structuredClone(state.records.get(key) ?? null); },
    async compareAndSet(key, revision, value) {
      if ((state.records.get(key)?.revision ?? null) !== revision) return false;
      state.records.set(key, structuredClone(value));
      if (value.phase === "JOURNAL_WRITE_STARTED") state.afterWriteStart?.();
      return true;
    },
  }, readSource: async () => {
    state.reads++; state.afterRead?.();
    return { plan: { canonical_text: captured.canonical_text }, observation: { format: "c2-source-observation-v1", state: "TWO_READS_MATCHED_NOT_ATOMIC",
      observed_start_at: input.observed_start_at, observed_end_at: input.observed_end_at, passes: 2,
      source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, response_tab_link_evidence: "SERVER_BINDING_DECLARATION_ONLY" } };
  }, journal: context => new PrivateSourceJournal(context, journal.store, sha) };
  const operation = () => createAuthorizedSourceOperation(authorize, async () => registry, () => ports);
  return { pin, registry, state, journal, operation, ports };
}
const reject = (action, code) => assert.rejects(action, error => error instanceof SourceJournalError && error.code === code &&
  error.message === "Private source journal could not be confirmed.");

test("trusted server authority and private registration produce only the existing operation context", async () => {
  const f = await fixture(), context = await bindSourceAuthorityContext(f.pin, f.registry, sha);
  assert.equal(context.actor_id, "fixture_coach"); assert.deepEqual(context.read_context.known_sources, f.pin.known_sources);
  assert.deepEqual(context.read_context.declared_mappings, []);
  assert.equal(context.journal_spreadsheet_id, f.registry.journal_spreadsheet_id);
});
test("changed authority digest, proof flags, unknown fields or target scope cannot compose a private operation", async () => {
  const f = await fixture();
  for (const changed of [{ ...f.pin, actor_id: "different_coach" }, { ...f.pin, source_status: "SOURCE_VERIFIED" },
    { ...f.pin, annual_export_authorized: true }, { ...f.pin, session_token: "PRIVATE_TOKEN_SENTINEL" }])
    await assert.rejects(bindSourceAuthorityContext(changed, f.registry, sha), SourceJournalError);
  await reject(bindSourceAuthorityContext(f.pin, { ...f.registry, source_operation_id: "different_operation" }, sha), "SOURCE_PRIVATE_TARGET_UNREGISTERED");
  await reject(bindSourceAuthorityContext(f.pin, { ...f.registry, owner_permission_id: "different_owner" }, sha), "SOURCE_OPERATION_CONTEXT_INVALID");
});
test("registration is snapshotted before an asynchronous hash can mutate the caller's object", async () => {
  const f = await fixture(), original = f.registry.journal_sheet_id;
  const context = await bindSourceAuthorityContext(f.pin, f.registry, async text => { f.registry.journal_sheet_id++; return sha(text); });
  assert.equal(context.journal_sheet_id, original);
});
test("composed operation rechecks authority, captures once, stages once and preserves permanent recovery", async () => {
  const f = await fixture(), operation = await f.operation();
  await operation.capture(); await operation.stage();
  assert.equal((await operation.resume()).phase, "JOURNAL_READBACK_CONFIRMED");
  assert.equal(f.state.reads, 1); assert.equal(f.journal.state.writes, 1); assert.ok(f.state.checks >= 8);
});
test("revoked authority before capture or during a read prevents candidate publication", async () => {
  for (const timing of ["before", "during"]) {
    const f = await fixture(), operation = await f.operation();
    if (timing === "before") f.state.denied = true;
    else f.state.afterRead = () => { f.state.denied = true; };
    await reject(operation.capture(), "SOURCE_OPERATION_AUTHORITY_UNCONFIRMED");
    assert.equal(f.journal.state.writes, 0);
    assert.ok([...f.state.records.values()].every(record => record.candidate === null));
  }
});
test("authority loss after write-start keeps original unresolved operation without issuing a Google write", async () => {
  const f = await fixture(), operation = await f.operation(); await operation.capture();
  f.state.afterWriteStart = () => { f.state.denied = true; };
  await reject(operation.stage(), "SOURCE_OPERATION_AUTHORITY_UNCONFIRMED");
  assert.equal(f.journal.state.writes, 0);
  assert.ok([...f.state.records.values()].some(record => record.phase === "JOURNAL_WRITE_STARTED"));
  f.state.denied = false;
  await reject(operation.resume(), "JOURNAL_NOT_FOUND"); assert.equal(f.journal.state.writes, 0);
});
test("registration change after capture blocks journal staging rather than selecting a new target", async () => {
  const f = await fixture(), operation = await f.operation(); await operation.capture();
  f.registry.journal_sheet_id++;
  await reject(operation.stage(), "SOURCE_OPERATION_AUTHORITY_UNCONFIRMED"); assert.equal(f.journal.state.writes, 0);
});
test("private controller never leaks authentication dependency errors", async () => {
  await reject(createAuthorizedSourceOperation(async () => { throw new Error("PRIVATE_TOKEN_SENTINEL"); }, async () => ({}), () => ({})),
    "SOURCE_PRIVATE_AUTHORITY_UNCONFIRMED");
});
