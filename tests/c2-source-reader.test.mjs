import assert from "node:assert/strict";
import test from "node:test";
import { GoogleSourceReader, PrivateGoogleClient, PrivateSourceJournal, SourceJournalError, SourceModelError, sha, model }
  from "./source-journal-test-runtime.mjs";

import { sourceModel } from "./source-reader-model.mjs";
const safeReject = (operation, code) => assert.rejects(operation, error => error instanceof SourceJournalError &&
  (!code || error.code === code) && error.message === "Private source journal could not be confirmed.");

test("two full REST passes include undersized pages, typed cells and exact cutoff; one API token", async () => {
  const source = sourceModel(), result = await source.reader().read();
  assert.equal(source.state.listReads, 4); assert.equal(source.state.tokenReads, 1);
  assert.equal(result.observation.state, "TWO_READS_MATCHED_NOT_ATOMIC");
  assert.equal(result.observation.annual_export_authorized, false);
  assert.ok(result.plan.canonical_text.includes("46296.123456789"));
  assert.ok(result.plan.canonical_text.includes("DIVIDE_BY_ZERO"));
  assert.ok(result.plan.canonical_text.includes("=1/0"));
  assert.ok(result.plan.canonical_text.includes("Fictional 😀 early"));
  assert.ok(!result.plan.canonical_text.includes("Fictional 😀 late-equal"));
  assert.equal(result.plan.source_status, "SOURCE_NOT_VERIFIED");
  assert.ok(source.state.calls.filter(call => call.url.pathname.endsWith("/responses")).every(call =>
    !call.url.searchParams.has("filter")));
  assert.ok(source.state.calls.filter(call => call.url.pathname.endsWith(":getByDataFilter")).every(call =>
    !call.url.searchParams.has("fields")));
});

test("matching response IDs tolerate reordering without assigning identity from page position", async () => {
  const source = sourceModel(); source.state.shuffled = true;
  const result = await source.reader().read();
  assert.equal(result.observation.passes, 2);
});

test("real REST omission of a blank form title retains exact schema and validates journal recovery", async () => {
  const source = sourceModel();
  delete source.input.form_schema.info.title;
  source.input.form_schema.info.documentTitle = "Fictional document name";
  const observed = await source.reader().read();
  const schema = observed.plan.chunks.flatMap(chunk => JSON.parse(chunk.payload_text).records)
    .filter(record => record.record_type === "FORM_SCHEMA");
  assert.ok(!Object.hasOwn(schema[0].raw.info, "title"));
  assert.equal(schema[0].raw.info.documentTitle, "Fictional document name");
  const context = { plan: { source: source.context.source, source_format: "c2-source-plan-v1",
    source_plan_digest: await sha("c2-source-review-source-v1\n" + observed.plan.canonical_text) },
    attempt_id: "fictional_missing_title", actor_id: "fictional_coach", spreadsheet_id: "fictional_private_journal",
    sheet_id: 98766, owner_permission_id: "fictional_owner" };
  const { store } = model();
  await new PrivateSourceJournal(() => context, store, sha).stage(observed.plan.canonical_text);
  assert.equal((await new PrivateSourceJournal(() => context, store, sha).resume()).core_text, observed.plan.canonical_text);
});

test("known source model failures expose only a fixed diagnostic code and keep messages private", async () => {
  const source = sourceModel();
  source.input.form_schema.info.title = 42;
  await safeReject(source.reader().read(), "SOURCE_READ_STRING_REQUIRED");
});

test("source dependency model errors cannot leak arbitrary codes or execute diagnostic getters", async () => {
  const source = sourceModel();
  let getterCalls = 0;
  const forged = new SourceModelError("PRIVATE_CLOCK_SENTINEL");
  const accessor = new SourceModelError("STRING_REQUIRED");
  Object.defineProperty(accessor, "code", { get() { getterCalls++; throw new Error("PRIVATE_GETTER_SENTINEL"); } });
  for (const error of [forged, accessor])
    await safeReject(new GoogleSourceReader(() => source.context, source.token, source.fetch, () => { throw error; }).read(),
      "SOURCE_READ_INPUT_UNSUPPORTED");
  assert.equal(getterCalls, 0);
});

test("omitted trailing blank rows retain all fixed matrix coordinates", async () => {
  const source = sourceModel(); source.state.extraBlankRows = true;
  const result = await source.reader().read();
  const records = result.plan.chunks.filter(chunk => chunk.namespace === "PRIVATE_PENDING")
    .flatMap(chunk => JSON.parse(chunk.payload_text).records);
  const rows = records.filter(record => record.record_type === "SHEET_ROW");
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.at(-1).raw, { row_index: 5, cells: [{}, {}] });
});

test("schema, cell or even excluded late answer drift stops the entire observation", async () => {
  for (const variation of [{ schemaDrift: true }, { cellDrift: true }, { lateDrift: true }]) {
    const source = sourceModel(); Object.assign(source.state, variation);
    await safeReject(source.reader().read(), "SOURCE_READ_DRIFT");
  }
});

test("failed pagination, duplicate IDs and repeated tokens never produce a partial plan", async () => {
  for (const [variation, code] of [[{ failPage: true }, "JOURNAL_GOOGLE_REQUEST_UNCONFIRMED"],
    [{ duplicate: true }, "SOURCE_READ_DUPLICATE_RESPONSE"], [{ tokenCycle: true }, "SOURCE_READ_PAGE_TOKEN_INVALID"]]) {
    const source = sourceModel(); Object.assign(source.state, variation);
    await safeReject(source.reader().read(), code);
  }
});

test("raw response lexical duplicate keys and numeric overflow are rejected before parsing loss", async () => {
  for (const body of ['{"responses":[],"respon\\u0073es":[]}', '{"totalScore":1e999}']) {
    const source = sourceModel();
    const fetch = async (url, init) => new URL(url).pathname.endsWith("/responses") ? new Response(body) : source.fetch(url, init);
    await safeReject(new GoogleSourceReader(() => source.context, source.token, fetch, source.now).read(),
      "JOURNAL_GOOGLE_REQUEST_UNCONFIRMED");
  }
});

test("context drift during a source page stops before further reads or publication", async () => {
  const source = sourceModel();
  source.state.onCall = (_state, url) => {
    if (url.pathname.endsWith("/responses")) source.context.source = { ...source.context.source, writer_epoch: 1 };
  };
  await safeReject(source.reader().read(), "SOURCE_READ_OWNERSHIP_CHANGED");
});

test("different API principal and missing exact linked Spreadsheet refuse capture", async () => {
  for (const mutate of [source => { source.context.api_user_permission_id = "other"; },
    source => { delete source.input.form_schema.linkedSheetId; },
    source => { source.context.response_tab_title = "Other Tab"; }]) {
    const source = sourceModel(); mutate(source); await safeReject(source.reader().read());
  }
});

test("source response budget and observation time budget fail without a partial result", async () => {
  const source = sourceModel(); source.state.oversized = true;
  await safeReject(source.reader().read(), "JOURNAL_BUDGET_EXCEEDED");
  const other = sourceModel(); let calls = 0;
  const now = () => calls++ === 0 ? "2026-10-01T04:02:00Z" : "2026-10-01T04:18:00Z";
  await safeReject(new GoogleSourceReader(() => other.context, other.token, other.fetch, now).read(), "SOURCE_READ_TIME_BUDGET_EXCEEDED");
});

test("full observed retained plan can be privately staged and recovered without another source read", async () => {
  const source = sourceModel(), observed = await source.reader().read(), reads = source.state.calls.length;
  const context = { plan: { source: source.context.source, source_format: "c2-source-plan-v1",
    source_plan_digest: await sha("c2-source-review-source-v1\n" + observed.plan.canonical_text) },
  attempt_id: "fictional_source_attempt", actor_id: "fictional_coach", spreadsheet_id: "fictional_private_journal",
  sheet_id: 98765, owner_permission_id: "fictional_owner" };
  const { state, store } = model(); state.lostReply = true;
  await new PrivateSourceJournal(() => context, store, sha).stage(observed.plan.canonical_text);
  const recovered = await new PrivateSourceJournal(() => context, store, sha).resume();
  assert.equal(recovered.core_text, observed.plan.canonical_text);
  assert.equal(source.state.calls.length, reads);
  assert.equal(recovered.control.source_status, "SOURCE_NOT_VERIFIED");
});

test("private transport rejects credential forwarding to arbitrary hosts before token retrieval", async () => {
  let tokens = 0;
  const client = new PrivateGoogleClient(async () => { tokens++; return "TOKEN"; }, async () => new Response("{}"));
  for (const url of ["https://example.invalid/", "http://forms.googleapis.com/", "https://user:pass@forms.googleapis.com/"])
    await safeReject(client.request(url, "GET"), "JOURNAL_GOOGLE_HOST_INVALID");
  assert.equal(tokens, 0);
});

test("source clock and context dependency failures return fixed messages", async () => {
  const source = sourceModel();
  await safeReject(new GoogleSourceReader(() => source.context, source.token, source.fetch,
    () => { throw new Error("PRIVATE_SOURCE_SENTINEL"); }).read(), "SOURCE_READ_INPUT_UNSUPPORTED");
  await safeReject(new GoogleSourceReader(() => { throw new Error("PRIVATE_SOURCE_SENTINEL"); }, source.token,
    source.fetch, source.now).read(), "SOURCE_READ_CONTEXT_INVALID");
});
