import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { createPrivateFileOperationStore } from "../backend/source-journal/private-file-store.mjs";
import { PrivateSourceOperation, PrivateSourceJournal, SourceJournalError, goldens, sha, model, buildLocalSourcePlan }
  from "./source-journal-test-runtime.mjs";

function fixture() {
  const golden = goldens.cases[0], input = JSON.parse(golden.input_text);
  const context = { read_context: { source: structuredClone(golden.pinned), known_sources: input.known_sources, declared_mappings: input.declared_mappings,
    api_user_permission_id: "fictional_owner", response_tab_title: "Responses" }, attempt_id: "fictional_attempt", actor_id: "fictional_coach",
    journal_spreadsheet_id: "fictional_private_target", journal_sheet_id: 13579, owner_permission_id: "fictional_owner" };
  const observation = { format: "c2-source-observation-v1", state: "TWO_READS_MATCHED_NOT_ATOMIC",
    observed_start_at: input.observed_start_at, observed_end_at: input.observed_end_at, passes: 2,
    source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, response_tab_link_evidence: "SERVER_BINDING_DECLARATION_ONLY" };
  const state = { reads: 0, records: new Map(), onRead: null, failCas: null, onHash: null };
  const journal = model();
  const store = {
    async read(key) { return structuredClone(state.records.get(key) ?? null); },
    async compareAndSet(key, revision, value) {
      if (state.failCas?.(revision)) throw new Error("PRIVATE_STORE_SENTINEL");
      if ((state.records.get(key)?.revision ?? null) !== revision) return false;
      state.records.set(key, structuredClone(value)); return true;
    },
  };
  const ports = { store, hash: async text => { state.onHash?.(text); return sha(text); },
    readSource: async () => { state.reads++; state.onRead?.(); return { plan: { canonical_text: golden.core_text }, observation }; },
    journal: contextPort => new PrivateSourceJournal(contextPort, journal.store, sha) };
  const operation = () => new PrivateSourceOperation(() => context, ports);
  const saved = () => [...state.records.values()].find(row => row.phase !== "PINNED") ?? [...state.records.values()][0];
  return { context, state, ports, observation, journal: journal.state, operation, saved };
}
const safeReject = (action, code) => assert.rejects(action, error => error instanceof SourceJournalError && error.code === code &&
  error.message === "Private source journal could not be confirmed.");
async function cleanup(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.match(basename(directory), /^dbt-private-operation-/u);
  await rm(directory, { recursive: true, force: true });
}

test("operation persists whole candidate before journal write and immutable receipt after readback", async () => {
  const item = fixture();
  const captured = await item.operation().capture();
  assert.equal(captured.phase, "CANDIDATE_DURABLE"); assert.equal(item.journal.writes, 0);
  const staged = await item.operation().stage();
  assert.equal(staged.phase, "JOURNAL_READBACK_CONFIRMED"); assert.equal(staged.revision, 4);
  assert.equal(staged.source_status, "SOURCE_NOT_VERIFIED"); assert.equal(staged.annual_export_authorized, false);
  assert.equal(item.journal.writes, 1);
  assert.deepEqual(await item.operation().resume(), staged);
  assert.deepEqual(await item.operation().capture(), staged);
  assert.equal(item.state.reads, 1); assert.equal(item.journal.writes, 1);
  assert.equal(JSON.stringify(staged).includes("Fictional"), false);
});

test("candidate persistence failure prevents every Google write", async () => {
  const item = fixture(); item.state.failCas = revision => revision === 1;
  await safeReject(item.operation().capture(), "SOURCE_OPERATION_DEPENDENCY_UNCONFIRMED");
  assert.equal(item.journal.writes, 0);
  assert.equal(item.saved().phase, "PINNED");
});

test("write-start marker failure stops before Google and durable candidate never rereads source", async () => {
  const item = fixture(); await item.operation().capture();
  item.state.failCas = revision => revision === 2;
  await safeReject(item.operation().stage(), "SOURCE_OPERATION_DEPENDENCY_UNCONFIRMED");
  assert.equal(item.journal.writes, 0);
  await item.operation().capture(); assert.equal(item.state.reads, 1);
});

test("unknown write with missing target remains unresolved without another create", async () => {
  const item = fixture(); await item.operation().capture(); item.journal.failCreate = true;
  await safeReject(item.operation().stage(), "JOURNAL_WRITE_UNCONFIRMED");
  assert.equal(item.saved().phase, "JOURNAL_WRITE_STARTED");
  item.journal.failCreate = false;
  await safeReject(item.operation().stage(), "JOURNAL_NOT_FOUND");
  await safeReject(item.operation().resume(), "JOURNAL_NOT_FOUND");
  item.context.attempt_id = "changed_attempt_after_unknown_write";
  await safeReject(item.operation().stage(), "SOURCE_OPERATION_IDENTITY_CHANGED");
  assert.equal(item.journal.writes, 1); assert.equal(item.state.reads, 1);
});

test("invalid whole candidate and ownership drift inside plan validation cannot become durable content", async () => {
  const invalid = fixture(), core = JSON.parse(goldens.cases[0].core_text);
  core.namespace_counts.FORM_CURRENT++;
  invalid.ports.readSource = async () => ({ plan: { canonical_text: JSON.stringify(core) }, observation: invalid.observation });
  await safeReject(invalid.operation().capture(), "SOURCE_OPERATION_CANDIDATE_INVALID");
  assert.equal(invalid.journal.writes, 0); assert.equal(invalid.saved().phase, "PINNED");
  const drift = fixture(); let sourceHashes = 0;
  drift.state.onHash = text => {
    if (text.startsWith("c2-source-review-source-v1\n") && ++sourceHashes === 2) drift.context.actor_id = "changed_inside_validation";
  };
  await safeReject(drift.operation().capture(), "SOURCE_OPERATION_OWNERSHIP_CHANGED");
  assert.equal(drift.journal.writes, 0); assert.equal(drift.saved().phase, "PINNED");
});

test("receipt commit failure recovers original content after restart without write or live read", async () => {
  const item = fixture(); await item.operation().capture();
  item.state.failCas = revision => revision === 3;
  await safeReject(item.operation().stage(), "SOURCE_OPERATION_DEPENDENCY_UNCONFIRMED");
  assert.equal(item.journal.writes, 1);
  item.state.failCas = null;
  const resumed = await item.operation().resume();
  assert.equal(resumed.phase, "JOURNAL_READBACK_CONFIRMED");
  assert.equal(item.journal.writes, 1); assert.equal(item.state.reads, 1);
});

test("same operation with different actor or target refuses the durable pin", async () => {
  for (const mutate of [context => { context.actor_id = "other"; }, context => { context.journal_sheet_id++; },
    context => { context.read_context.source.writer_epoch++; }, context => { context.attempt_id = "new_attempt"; }]) {
    const item = fixture(); await item.operation().capture(); mutate(item.context);
    await safeReject(item.operation().stage(), "SOURCE_OPERATION_IDENTITY_CHANGED");
    assert.equal(item.journal.writes, 0);
  }
});

test("observation drift, claimed atomic snapshot or false source verified cannot persist a candidate", async () => {
  for (const mutate of [observation => { observation.observed_end_at = "2026-10-01T04:03:00Z"; },
    observation => { observation.state = "ATOMIC"; }, observation => { observation.source_status = "SOURCE_VERIFIED"; }]) {
    const item = fixture(); mutate(item.observation);
    await safeReject(item.operation().capture(), "SOURCE_OPERATION_OBSERVATION_INVALID");
    assert.equal(item.journal.writes, 0);
  }
});

test("candidate mappings and response Tab title must match the pinned declarations before persistence", async () => {
  for (const mutate of [context => { context.read_context.declared_mappings = []; },
    context => { context.read_context.declared_mappings[0].evidence_id = "changed_declaration"; },
    context => { context.read_context.response_tab_title = "Wrong Tab"; }]) {
    const item = fixture(); mutate(item.context);
    await safeReject(item.operation().capture(), "SOURCE_OPERATION_DECLARATIONS_CHANGED");
    assert.equal(item.saved().phase, "PINNED");
    assert.equal(item.journal.writes, 0);
  }
  const same = fixture(); same.context.read_context.declared_mappings.reverse();
  assert.equal((await same.operation().capture()).phase, "CANDIDATE_DURABLE");
});

test("complete candidate or permanent receipt tampering fails before new source or Google write", async () => {
  const item = fixture(); await item.operation().capture(); await item.operation().stage();
  const saved = item.saved(); saved.receipt.control.utf8_bytes++;
  await safeReject(item.operation().resume(), "SOURCE_OPERATION_RECEIPT_INVALID");
  assert.equal(item.journal.writes, 1); assert.equal(item.state.reads, 1);
});

test("context change inside a hash await refuses candidate publication", async () => {
  const item = fixture();
  item.state.onRead = () => { item.state.onHash = () => { item.context.actor_id = "changed"; }; };
  await safeReject(item.operation().capture(), "SOURCE_OPERATION_OWNERSHIP_CHANGED");
  assert.equal(item.journal.writes, 0);
  assert.equal(item.saved().phase, "PINNED");
});

test("two concurrent capture attempts converge to the exact one durable candidate", async () => {
  const item = fixture();
  const [one, two] = await Promise.all([item.operation().capture(), item.operation().capture()]);
  assert.deepEqual(one, two); assert.equal(item.state.records.size, 2);
  const staged = await Promise.allSettled([item.operation().stage(), item.operation().stage()]);
  assert.ok(staged.some(result => result.status === "fulfilled"));
  for (const result of staged) if (result.status === "rejected") assert.equal(result.reason.code, "JOURNAL_NOT_FOUND");
  assert.equal(item.journal.writes, 1);
  assert.equal((await item.operation().resume()).phase, "JOURNAL_READBACK_CONFIRMED");
});

test("different concurrent source candidates cannot replace the first durable winner", async () => {
  const item = fixture(), golden = goldens.cases[0], input = JSON.parse(golden.input_text);
  input.form_schema.info.description = "Different fictional schema observed by the second reader";
  const alternate = buildLocalSourcePlan(JSON.stringify(input), item.context.read_context.source).canonical_text;
  let reads = 0;
  item.ports.readSource = async () => ({ plan: { canonical_text: reads++ ? alternate : golden.core_text }, observation: item.observation });
  const results = await Promise.allSettled([item.operation().capture(), item.operation().capture()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "SOURCE_OPERATION_CANDIDATE_CONFLICT");
  assert.equal(item.state.records.size, 2); assert.equal(item.journal.writes, 0);
});

test("private file CAS survives a recreated store and rejects stale writers and tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbt-private-operation-"));
  try {
    const item = fixture(); item.ports.store = await createPrivateFileOperationStore(directory);
    const staged = await item.operation().capture();
    item.ports.store = await createPrivateFileOperationStore(directory);
    await item.operation().stage();
    item.ports.store = await createPrivateFileOperationStore(directory);
    const resumed = await item.operation().resume();
    assert.equal(resumed.phase, "JOURNAL_READBACK_CONFIRMED"); assert.equal(item.state.reads, 1); assert.equal(item.journal.writes, 1);
    const raw = await item.ports.store.read(staged.operation_key);
    assert.equal(await item.ports.store.compareAndSet(staged.operation_key, 2, { ...raw, revision: 3 }), false);
    const file = join(directory, `${staged.operation_key}.json`);
    const corrupt = JSON.parse(await readFile(file, "utf8")); corrupt.candidate.candidate_digest = "A".repeat(43);
    await writeFile(file, JSON.stringify(corrupt));
    await safeReject(item.operation().resume(), "SOURCE_OPERATION_CANDIDATE_CHANGED");
    assert.equal(item.journal.writes, 1);
  } finally { await cleanup(directory); }
});

test("independent private file writers have one CAS winner and reject invalid keys and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbt-private-operation-"));
  try {
    const one = await createPrivateFileOperationStore(directory), two = await createPrivateFileOperationStore(directory);
    const key = "A".repeat(43), value = { key, revision: 1 };
    const winners = await Promise.all([one.compareAndSet(key, null, value), two.compareAndSet(key, null, value)]);
    assert.equal(winners.filter(Boolean).length, 1);
    assert.deepEqual(await two.read(key), value);
    await assert.rejects(one.read("../../outside"), error => error.message === "Private operation storage is unavailable.");
    await writeFile(join(directory, `${key}.json`), Buffer.alloc(14_000_001));
    await assert.rejects(one.read(key), error => error.message === "Private operation storage is unavailable.");
  } finally { await cleanup(directory); }
});
