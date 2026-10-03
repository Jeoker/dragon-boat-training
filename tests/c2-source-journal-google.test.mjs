import assert from "node:assert/strict";
import test from "node:test";
import { PrivateSourceJournal, GoogleSourceJournalStore, SourceJournalError, googleModel, contextFor, goldens, sha }
  from "./source-journal-test-runtime.mjs";
const token = async () => "FICTIONAL_OAUTH_TOKEN";

test("Google adapter emits one atomic AddSheet plus literal string cells and restores original content", async () => {
  const model = googleModel(), context = contextFor(), store = new GoogleSourceJournalStore(token, model.fetch);
  const first = await new PrivateSourceJournal(() => context, store, sha).stage(goldens.cases[0].core_text);
  const writes = model.state.calls.filter(call => call.url.pathname.endsWith(":batchUpdate"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.requests.length, 2);
  assert.equal(writes[0].body.requests[0].addSheet.properties.sheetId, context.sheet_id);
  assert.ok(writes[0].body.requests[1].updateCells.rows.every(row =>
    Object.keys(row.values[0].userEnteredValue).join() === "stringValue"));
  const recovered = await new PrivateSourceJournal(() => context, new GoogleSourceJournalStore(token, model.fetch), sha).resume();
  assert.deepEqual(recovered, first);
  assert.ok(!JSON.stringify(first).includes("FICTIONAL_OAUTH_TOKEN"));
  assert.ok(model.state.calls.every(call => call.init.redirect === "error"));
  assert.ok(model.state.calls.filter(call => call.url.pathname.endsWith("permissions")).every(call =>
    call.url.searchParams.get("includePermissionsForView") === "published"));
});

test("Google lost response, duplicate ID and concurrent caller never overwrite pinned rows", async () => {
  const model = googleModel(); model.state.lostReply = true;
  const context = contextFor(), client = () => new PrivateSourceJournal(() => context,
    new GoogleSourceJournalStore(token, model.fetch), sha);
  const outputs = await Promise.all([client().stage(goldens.cases[0].core_text), client().stage(goldens.cases[0].core_text)]);
  assert.deepEqual(outputs[0], outputs[1]);
  assert.equal(model.state.sheets.size, 1);
  assert.ok(model.state.calls.filter(call => call.url.pathname.endsWith(":batchUpdate")).every(call =>
    call.body.requests[0].addSheet && call.body.requests[1].updateCells));
});

test("owner, direct sharing, published sharing, inherited folder sharing and later ACL pages reject", async () => {
  for (const variation of [{ owner: "another" }, { shared: true }, { published: true },
    { folder: true, parentShared: true }, { permissionPages: true }]) {
    const model = googleModel(); Object.assign(model.state, variation);
    const store = new GoogleSourceJournalStore(token, model.fetch);
    await assert.rejects(new PrivateSourceJournal(() => contextFor(), store, sha).stage(goldens.cases[0].core_text),
      error => error instanceof SourceJournalError && error.code === "JOURNAL_PRIVACY_UNPROVEN");
    assert.equal(model.state.sheets.size, 0);
  }
});

test("private parent folders are traversed and do not prevent storage", async () => {
  const model = googleModel(); model.state.folder = true;
  const output = await new PrivateSourceJournal(() => contextFor(), new GoogleSourceJournalStore(token, model.fetch), sha)
    .stage(goldens.cases[0].core_text);
  assert.equal(output.core_text, goldens.cases[0].core_text);
  assert.ok(model.state.calls.some(call => call.url.pathname.includes("fictional_folder/permissions")));
});

test("formula mutation and expanded target grids reject complete readback", async () => {
  for (const change of [{ formula: true }, { metadataOverride: { gridProperties: { rowCount: 1000000, columnCount: 1 } } }]) {
    const model = googleModel(), context = contextFor(), store = new GoogleSourceJournalStore(token, model.fetch);
    await new PrivateSourceJournal(() => context, store, sha).stage(goldens.cases[0].core_text);
    Object.assign(model.state, change);
    await assert.rejects(new PrivateSourceJournal(() => context, store, sha).resume(), error =>
      error instanceof SourceJournalError && error.code === "JOURNAL_READ_UNCONFIRMED");
  }
});

test("404 and network or token errors never become empty successful source or disclose error content", async () => {
  for (const fetch of [async () => new Response("PRIVATE_ERROR_SENTINEL", { status: 404 }),
    async () => { throw new Error("PRIVATE_ERROR_SENTINEL"); }]) {
    await assert.rejects(new GoogleSourceJournalStore(token, fetch).read(contextFor()), error =>
      error instanceof SourceJournalError && !error.message.includes("PRIVATE_ERROR_SENTINEL"));
  }
  await assert.rejects(new GoogleSourceJournalStore(async () => { throw new Error("PRIVATE_ERROR_SENTINEL"); }).assertPrivate(contextFor()),
    error => error instanceof SourceJournalError && !error.message.includes("PRIVATE_ERROR_SENTINEL"));
});

test("declared or streamed oversized response is bounded before JSON processing", async () => {
  for (const response of [new Response("{}", { headers: { "content-length": "64001" } }), new Response("x".repeat(64001))]) {
    await assert.rejects(new GoogleSourceJournalStore(token, async () => response).assertPrivate(contextFor()), error =>
      error instanceof SourceJournalError && error.code === "JOURNAL_BUDGET_EXCEEDED");
  }
});

test("actual formula-like characters remain literal even at transport part boundaries", async () => {
  const model = googleModel(), store = new GoogleSourceJournalStore(token, model.fetch), context = contextFor();
  const rows = ["header", '=HYPERLINK("https://example.invalid","😀")', "+1", "@SUM(A1)"];
  await store.create(context, rows);
  assert.deepEqual(await store.read(context), rows);
  const write = model.state.calls.find(call => call.url.pathname.endsWith(":batchUpdate"));
  assert.deepEqual(write.body.requests[1].updateCells.rows.map(row => row.values[0].userEnteredValue),
    rows.map(stringValue => ({ stringValue })));
});
