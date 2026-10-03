import assert from "node:assert/strict";
import test from "node:test";
import { PrivateSourceJournal, SourceJournalError, journalParts, JOURNAL_LIMITS, goldens,
  sha, contextFor, model, sourceCanonical } from "./source-journal-test-runtime.mjs";

const rejected = (promise, code) => assert.rejects(promise, error => error instanceof SourceJournalError &&
  error.code === code && error.message === "Private source journal could not be confirmed.");

test("journal stages and fully validates all six retained goldens; recovery needs no raw input", async () => {
  for (const fixture of goldens.cases) {
    const context = contextFor(fixture), { state, store } = model();
    const first = await new PrivateSourceJournal(() => context, store, sha).stage(fixture.core_text);
    // Replace the entire client instance, with only the pinned command and server rows retained.
    const recovered = await new PrivateSourceJournal(() => context, store, sha).resume();
    assert.deepEqual(recovered, first);
    assert.equal(recovered.core_text, fixture.core_text);
    assert.equal(first.control.source_status, "SOURCE_NOT_VERIFIED");
    assert.equal(first.control.annual_export_authorized, false);
    assert.ok(!JSON.stringify(first.control).includes("Fictional"));
    assert.ok(!JSON.stringify(state.rows).includes("Fictional 😀 late-equal"));
    assert.equal(state.writes, 1);
    await new PrivateSourceJournal(() => context, store, sha).stage(fixture.core_text);
    assert.equal(state.writes, 1);
  }
});

test("lost create reply confirms exact original rows without a second write", async () => {
  const { state, store } = model(), context = contextFor(); state.lostReply = true;
  const result = await new PrivateSourceJournal(() => context, store, sha).stage(goldens.cases[0].core_text);
  assert.equal(result.core_text, goldens.cases[0].core_text);
  assert.equal(state.writes, 1);
});

test("unknown write and unreadable target never regenerate or substitute source content", async () => {
  const { state, store } = model(), context = contextFor(); state.failCreate = true;
  const client = new PrivateSourceJournal(() => context, store, sha);
  await rejected(client.stage(goldens.cases[0].core_text), "JOURNAL_WRITE_UNCONFIRMED");
  assert.equal(state.writes, 1);
  await rejected(new PrivateSourceJournal(() => context, store, sha).resume(), "JOURNAL_NOT_FOUND");
  state.failRead = true;
  await rejected(client.stage(goldens.cases[0].core_text), "JOURNAL_READ_UNCONFIRMED");
  assert.equal(state.writes, 1);
});

test("concurrent identical creates converge to the same whole journal", async () => {
  const { state, store } = model(), context = contextFor();
  const outputs = await Promise.all(Array.from({ length: 3 }, () =>
    new PrivateSourceJournal(() => context, store, sha).stage(goldens.cases[0].core_text)));
  assert.deepEqual(outputs[0], outputs[1]); assert.deepEqual(outputs[1], outputs[2]);
  assert.equal(state.rows.slice(1).join(""), goldens.cases[0].core_text);
});

test("same target with altered actor, attempt, command or owner is rejected without overwrite", async () => {
  const { state, store } = model(), original = contextFor();
  await new PrivateSourceJournal(() => original, store, sha).stage(goldens.cases[0].core_text);
  const before = [...state.rows];
  for (const change of [{ actor_id: "other" }, { attempt_id: "other" }, { owner_permission_id: "other" },
    { plan: { ...original.plan, source: { ...original.plan.source, writer_epoch: 1 } } }]) {
    const modified = { ...original, ...change };
    await rejected(new PrivateSourceJournal(() => modified, store, sha).resume(), "JOURNAL_IDENTITY_OR_CONTENT_CHANGED");
    assert.deepEqual(state.rows, before);
  }
  assert.equal(state.writes, 1);
});

test("tampered complete plan, missing parts and changed content cannot be promoted", async () => {
  const context = contextFor();
  for (const mutation of [rows => rows[1] += " ", rows => rows.pop(), rows => rows[1] = rows[1].replace("LOCAL_SOURCE_PLAN_ONLY", "SOURCE_VERIFIED")]) {
    const { state, store } = model();
    await new PrivateSourceJournal(() => context, store, sha).stage(goldens.cases[0].core_text);
    mutation(state.rows);
    await assert.rejects(new PrivateSourceJournal(() => context, store, sha).resume(), SourceJournalError);
    assert.equal(state.writes, 1);
  }
});

test("authority changes in original SHA and final header SHA are fenced", async () => {
  for (const trigger of ["c2-source-review-source-v1\n", "c2-private-source-journal-header-v1\n"]) {
    let context = contextFor(); const { state, store } = model();
    const hash = async text => {
      if (text.startsWith(trigger)) context = { ...context, actor_id: "changed" };
      return sha(text);
    };
    await rejected(new PrivateSourceJournal(() => context, store, hash).stage(goldens.cases[0].core_text),
      "JOURNAL_OWNERSHIP_CHANGED");
    assert.equal(state.writes, trigger.startsWith("c2-source-review") ? 0 : 1);
  }
});

test("privacy change or read drift after staging prevents a successful control result", async () => {
  const context = contextFor();
  const a = model(); a.state.onCreate = state => { state.privacy = false; };
  await rejected(new PrivateSourceJournal(() => context, a.store, sha).stage(goldens.cases[0].core_text),
    "JOURNAL_PRIVACY_UNPROVEN");
  const b = model(); b.state.onRead = state => { if (state.reads === 3) state.rows[1] += " "; };
  await rejected(new PrivateSourceJournal(() => context, b.store, sha).stage(goldens.cases[0].core_text), "JOURNAL_READ_DRIFT");
});

test("transport splitting preserves Unicode and exact bytes through the 2MB ceiling", () => {
  const text = "😀\"\\\n中".repeat(120000);
  const parts = journalParts(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every(part => Buffer.byteLength(part) <= JOURNAL_LIMITS.part_bytes && !/\p{Surrogate}/u.test(part)));
  assert.ok(parts.length <= JOURNAL_LIMITS.parts);
  assert.throws(() => journalParts("x".repeat(2_000_001)), SourceJournalError);
});

test("invalid controls, supplied proofs and budget overflow reject before any IO", async () => {
  for (const context of [contextFor(undefined, { trusted: true }), contextFor(undefined, { sheet_id: "1" }),
    contextFor(undefined, { spreadsheet_id: goldens.cases[0].pinned.spreadsheet_id })]) {
    const { state, store } = model();
    await rejected(new PrivateSourceJournal(() => context, store, sha).stage(goldens.cases[0].core_text), "JOURNAL_CONTEXT_INVALID");
    assert.equal(state.reads + state.privacyChecks + state.writes, 0);
  }
  const { state, store } = model();
  await rejected(new PrivateSourceJournal(() => contextFor(), store, sha).stage("x".repeat(2_000_001)), "JOURNAL_BUDGET_EXCEEDED");
  assert.equal(state.writes, 0);
});

test("header canonical representation remains bound to the complete original command", async () => {
  const context = contextFor(), { state, store } = model();
  await new PrivateSourceJournal(() => context, store, sha).stage(goldens.cases[0].core_text);
  const header = JSON.parse(state.rows[0]);
  assert.equal(sourceCanonical(header.context), sourceCanonical(context));
  header.part_count++; state.rows[0] = sourceCanonical(header);
  await rejected(new PrivateSourceJournal(() => context, store, sha).resume(), "JOURNAL_IDENTITY_OR_CONTENT_CHANGED");
});

test("untrusted dependency exception text is never returned by public journal methods", async () => {
  const { store } = model();
  store.read = async () => {
    const rows = ["header", "content"];
    Object.defineProperty(rows, 1, { get() { throw new Error("PRIVATE_SOURCE_SENTINEL"); } });
    return rows;
  };
  await rejected(new PrivateSourceJournal(() => contextFor(), store, sha).resume(), "JOURNAL_INPUT_OR_DEPENDENCY_INVALID");
});
