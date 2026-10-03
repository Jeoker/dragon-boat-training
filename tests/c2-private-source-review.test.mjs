import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createPrivateFileOperationStore } from "../backend/source-journal/private-file-store.mjs";
import { PrivateSourceReview, PrivateSourceOperation, PrivateSourceJournal, SourceJournalError,
  goldens, sha, model, buildLocalSourcePlan, sourceCanonical } from "./source-journal-test-runtime.mjs";

async function fixture(storePort, secondResponse = false) {
  const golden = goldens.cases[0], input = JSON.parse(golden.input_text); input.declared_mappings = [];
  if (secondResponse) {
    const response = structuredClone(input.form_responses[0]); response.responseId = "fictional_second_response";
    input.form_responses.push(response);
  }
  const plan = buildLocalSourcePlan(JSON.stringify(input), golden.pinned);
  const context = { read_context: { source: structuredClone(golden.pinned), known_sources: input.known_sources, declared_mappings: [],
    api_user_permission_id: "fictional_owner", response_tab_title: "Responses" }, actor_id: "fictional_coach", attempt_id: "fictional_review_attempt",
    journal_spreadsheet_id: "fictional_private_journal", journal_sheet_id: 12345, owner_permission_id: "fictional_owner" };
  const state = { records: new Map(), denied: false, reads: 0, at: "2026-10-03T15:00:00Z", checks: 0, fail: null, afterCas: null, onHash: null };
  const store = storePort ?? { async read(key) { return structuredClone(state.records.get(key) ?? null); }, async compareAndSet(key, revision, value) {
    if (state.fail?.(value)) throw Error("PRIVATE_STORE_SENTINEL");
    if ((state.records.get(key)?.revision ?? null) !== revision) return false;
    state.records.set(key, structuredClone(value)); await state.afterCas?.(value); return true;
  } };
  const journal = model();
  const ports = { store, hash: sha, async checkAuthority() { state.checks++; if (state.denied) throw Error("PRIVATE_SESSION_SENTINEL"); },
    async readSource() { state.reads++; return { plan, observation: { format: "c2-source-observation-v1", state: "TWO_READS_MATCHED_NOT_ATOMIC",
      observed_start_at: input.observed_start_at, observed_end_at: input.observed_end_at, passes: 2, source_status: "SOURCE_NOT_VERIFIED",
      annual_export_authorized: false, response_tab_link_evidence: "SERVER_BINDING_DECLARATION_ONLY" } }; },
    journal: context => new PrivateSourceJournal(context, journal.store, sha) };
  const operation = new PrivateSourceOperation(() => context, ports);
  const review = () => new PrivateSourceReview(new PrivateSourceOperation(() => context, ports), store,
    async text => { state.onHash?.(text); return sha(text); }, () => state.at);
  const ledger = () => [...state.records.values()].find(record => record.format === "c2-private-source-review-ledger-v1");
  const command = (view, request = "review_request_001", row = 1, response = 0) => sourceCanonical({ request_id: request,
    local_snapshot_id: view.result.anchor.local_snapshot_id, row_index: row, response_id: view.result.form_records[response].raw.responseId,
    expected_sheet_digest: view.result.sheet_records.find(record => record.raw.row_index === row).content_digest,
    expected_form_digest: view.result.form_records[response].content_digest, decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" });
  return { context, state, store, journal, ports, operation, review, ledger, command };
}
const denied = action => assert.rejects(action, error => error instanceof SourceJournalError &&
  error.message === "Private source journal could not be confirmed." && !JSON.stringify(error).includes("SENTINEL"));
async function confirmed(f) { await f.operation.capture(); await f.operation.stage(); }

test("private review requires authenticated authority and an already confirmed original journal", async () => {
  const f = await fixture(); await f.operation.capture(); await denied(f.review().view()); assert.equal(f.ledger(), undefined);
  const unauthenticated = new PrivateSourceOperation(() => f.context, { ...f.ports, checkAuthority: undefined });
  await denied(unauthenticated.readForReview()); assert.equal(f.journal.state.writes, 0);
  await f.operation.stage(); f.state.denied = true; await denied(f.review().view()); assert.equal(f.ledger(), undefined);
});

test("authenticated view reads the fixed original journal and appends a durable responsibility declaration only", async () => {
  const f = await fixture(); await confirmed(f); const view = await f.review().view();
  assert.equal(view.ledger_version, 0); assert.equal(view.source_status, "SOURCE_NOT_VERIFIED");
  const before = [...f.state.records.values()].filter(record => record.format === "c2-private-source-operation-v1");
  const result = await f.review().append(f.command(view));
  assert.equal(result.state, "PRIVATE_REVIEW_LEDGER_DURABLE_ONLY"); assert.equal(result.ledger_version, 1);
  const derived = JSON.parse(result.result.derived_text);
  assert.equal(derived.source_status, "SOURCE_NOT_VERIFIED"); assert.equal(derived.annual_export_authorized, false);
  assert.equal(derived.reviews[0].mapping_status, "HUMAN_ATTESTED");
  assert.equal(JSON.parse(f.ledger().ledger_text).evidence[0].actor_id, f.context.actor_id);
  assert.deepEqual([...f.state.records.values()].filter(record => record.format === "c2-private-source-operation-v1"), before);
  assert.equal(f.state.reads, 1); assert.equal(f.journal.state.writes, 1);
  assert.ok(!f.ledger().ledger_text.includes("Sheet current differs")); assert.ok(f.state.checks > 5);
});

test("service recreation replays original evidence and time without another source read or ledger append", async () => {
  const f = await fixture(); await confirmed(f); const view = await f.review().view(), command = f.command(view);
  const first = await f.review().append(command), original = f.ledger(); f.state.at = "2026-10-04T15:00:00Z";
  const replay = await f.review().append(command);
  assert.equal(replay.result.append_required, false); assert.equal(replay.result.evidence_text, first.result.evidence_text);
  assert.equal(replay.result.derived_text, first.result.derived_text); assert.deepEqual(f.ledger(), original);
  assert.equal(f.state.reads, 1); assert.equal(f.journal.state.writes, 1);
});

test("old requests after later decisions keep their original derived prefix and time", async () => {
  const f = await fixture(undefined, true); await confirmed(f); const view = await f.review().view(), command = f.command(view);
  const first = await f.review().append(command); f.state.at = "2026-10-04T15:00:00Z";
  await f.review().append(f.command(view, "later_review_request", 2, 1));
  const ledger = f.ledger(); assert.equal(ledger.revision, 3); f.state.at = "2026-10-05T15:00:00Z";
  const replay = await f.review().append(command);
  assert.equal(replay.ledger_version, 2); assert.equal(replay.result.append_required, false);
  assert.equal(replay.result.evidence_text, first.result.evidence_text); assert.equal(replay.result.derived_text, first.result.derived_text);
  assert.deepEqual(f.ledger(), ledger); assert.equal(f.state.reads, 1);
});

test("changed request payload, one-to-one reuse, caller actor and false proof cannot append", async () => {
  const f = await fixture(); await confirmed(f); const view = await f.review().view(), command = f.command(view);
  await f.review().append(command); const original = f.ledger();
  const parsed = JSON.parse(command);
  for (const changed of [{ ...parsed, row_index: 2 }, { ...parsed, reason: "DIRECT_KNOWLEDGE_OF_SUBMISSION" },
    { ...parsed, actor_id: "browser_actor" }, { ...parsed, verified: true }, JSON.parse(f.command(view, "other_request", 2))])
    await denied(f.review().append(sourceCanonical(changed)));
  assert.deepEqual(f.ledger(), original);
});

test("ledger CAS failure does not append; lost successful acknowledgement replays the original committed time", async () => {
  const f = await fixture(); await confirmed(f); const view = await f.review().view(), command = f.command(view);
  f.state.fail = value => value.format === "c2-private-source-review-ledger-v1" && value.revision === 2;
  await denied(f.review().append(command)); assert.equal(f.ledger().revision, 1);
  f.state.fail = null; let once = true;
  f.state.afterCas = value => { if (once && value.format === "c2-private-source-review-ledger-v1" && value.revision === 2) {
    once = false; throw Error("PRIVATE_ACK_LOST");
  } };
  await denied(f.review().append(command)); const saved = f.ledger(); f.state.at = "2026-10-05T15:00:00Z";
  const result = await f.review().append(command); assert.equal(result.result.append_required, false);
  assert.equal(JSON.parse(result.result.evidence_text).reviewed_at, "2026-10-03T15:00:00Z"); assert.deepEqual(f.ledger(), saved);
});

test("parallel identical requests converge to one durable evidence and different requests cannot rebase a CAS loser", async () => {
  const f = await fixture(); await confirmed(f); const view = await f.review().view(), command = f.command(view);
  const results = await Promise.all([f.review().append(command), f.review().append(command)]);
  assert.equal(f.ledger().revision, 2); assert.equal(results[0].result.evidence_text, results[1].result.evidence_text);
  const g = await fixture(); await confirmed(g); const otherView = await g.review().view();
  const settled = await Promise.allSettled([g.review().append(g.command(otherView)), g.review().append(g.command(otherView, "competing_request", 2))]);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1); assert.equal(g.ledger().revision, 2);
});

test("permission loss during final hash or after evidence save cannot publish a private result", async () => {
  for (const phase of ["hash", "cas"]) {
    const f = await fixture(); await confirmed(f); const view = await f.review().view();
    if (phase === "hash") f.state.onHash = text => { if (text.startsWith("c2-source-review-ledger-v1\n") && text.includes('"version":1')) f.state.denied = true; };
    else f.state.afterCas = value => { if (value.format === "c2-private-source-review-ledger-v1" && value.revision === 2) f.state.denied = true; };
    await denied(f.review().append(f.command(view))); assert.equal(f.ledger().revision, phase === "hash" ? 1 : 2);
    f.state.onHash = null; f.state.afterCas = null; f.state.denied = false;
    assert.equal((await f.review().append(f.command(view))).ledger_version, 1);
  }
});

test("current Google privacy and retained content changes prevent private view and evidence access", async () => {
  for (const mutation of [f => { f.journal.state.privacy = false; }, f => { f.journal.state.rows[1] = "PRIVATE_CHANGED_RAW"; },
    f => { f.context.read_context.source.binding_version++; }]) {
    const f = await fixture(); await confirmed(f); mutation(f); await denied(f.review().view()); assert.equal(f.ledger(), undefined);
  }
});

test("journal privacy and content are rechecked after review hashes and after ledger CAS", async () => {
  for (const phase of ["view", "hash", "cas"]) {
    const f = await fixture(); await confirmed(f); const view = await f.review().view();
    if (phase === "view") f.state.onHash = () => { f.journal.state.privacy = false; };
    else if (phase === "hash") f.state.onHash = text => {
      if (text.startsWith("c2-source-review-ledger-v1\n") && text.includes('"version":1')) f.journal.state.privacy = false;
    };
    else f.state.afterCas = value => {
      if (value.format === "c2-private-source-review-ledger-v1" && value.revision === 2) f.journal.state.rows[1] = "PRIVATE_CHANGED_RAW";
    };
    await denied(phase === "view" ? f.review().view() : f.review().append(f.command(view)));
    assert.equal(f.ledger().revision, phase === "cas" ? 2 : 1);
  }
});

test("stored ledger digest, chain, source identity, shape and bounds fail closed without rewriting", async () => {
  const f = await fixture(); await confirmed(f); const view = await f.review().view(); await f.review().append(f.command(view));
  const original = f.ledger();
  const mutations = [record => { record.ledger_digest = "x".repeat(43); }, record => { record.source_identity_digest = "x".repeat(43); },
    record => { record.revision++; }, record => { record.ledger_text = "x".repeat(512001); }, record => { record.trusted = true; },
    async record => { const ledger = JSON.parse(record.ledger_text); ledger.evidence[0].prior_ledger_digest = "x".repeat(43);
      record.ledger_text = sourceCanonical(ledger); record.ledger_digest = await sha("c2-source-review-ledger-v1\n" + record.ledger_text); }];
  for (const mutate of mutations) {
    const changed = structuredClone(original); await Promise.resolve(mutate(changed)); f.state.records.set(changed.key, changed);
    await denied(f.review().view()); assert.deepEqual(f.state.records.get(changed.key), changed);
  }
});

test("invalid or earlier host clock cannot record evidence before original capture", async () => {
  const f = await fixture(); await confirmed(f);
  for (const at of ["invalid", "2020-01-01T00:00:00Z"]) { f.state.at = at; await denied(f.review().view()); assert.equal(f.ledger(), undefined); }
});

test("private file CAS persists review evidence after operation, store and review service recreation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbt-private-review-"));
  try {
    const store = await createPrivateFileOperationStore(directory), f = await fixture(store); await confirmed(f);
    const view = await f.review().view(), command = f.command(view), first = await f.review().append(command);
    const reopened = new PrivateSourceReview(new PrivateSourceOperation(() => f.context, { ...f.ports, store: await createPrivateFileOperationStore(directory) }),
      await createPrivateFileOperationStore(directory), sha, () => "2026-10-05T15:00:00Z");
    const result = await reopened.append(command); assert.equal(result.result.append_required, false);
    assert.equal(result.result.evidence_text, first.result.evidence_text); assert.equal(f.journal.state.writes, 1); assert.equal(f.state.reads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("separate Node processes replay the original file ledger without source reads or journal writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbt-private-review-process-"));
  try {
    const f = await fixture(await createPrivateFileOperationStore(directory)); await confirmed(f);
    const view = await f.review().view(), command = f.command(view), first = await f.review().append(command);
    const script = `import {PrivateSourceReview,PrivateSourceOperation,PrivateSourceJournal,sha,model} from ${JSON.stringify(new URL("./source-journal-test-runtime.mjs", import.meta.url).href)};
      import {createPrivateFileOperationStore} from ${JSON.stringify(new URL("../backend/source-journal/private-file-store.mjs", import.meta.url).href)};
      let input=''; for await(const part of process.stdin) input+=part;
      const {directory,context,rows,command}=JSON.parse(input), store=await createPrivateFileOperationStore(directory), journal=model();
      journal.state.rows=rows;
      const operation=new PrivateSourceOperation(()=>context,{store,hash:sha,async checkAuthority(){},
        async readSource(){throw Error('unexpected source read');},journal:context=>new PrivateSourceJournal(context,journal.store,sha)});
      const result=await new PrivateSourceReview(operation,store,sha,()=>"2026-10-05T15:00:00Z").append(command);
      console.log(JSON.stringify({appended:result.result.append_required,evidence:await sha(result.result.evidence_text),
        derived:await sha(result.result.derived_text),writes:journal.state.writes,version:result.ledger_version}));`;
    for (let index = 0; index < 2; index++) {
      const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        input: JSON.stringify({ directory, context: f.context, rows: f.journal.state.rows, command }), encoding: "utf8", timeout: 30000,
      }));
      assert.deepEqual(result, { appended: false, evidence: await sha(first.result.evidence_text),
        derived: await sha(first.result.derived_text), writes: 0, version: 1 });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
