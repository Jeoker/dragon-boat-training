import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { createPrivateFileOperationStore } from "../backend/source-journal/private-file-store.mjs";
import { PrivateSourceReadAttempt, GoogleSourceReader, PrivateSourceOperation, PrivateSourceJournal,
  SourceJournalError, sha, model } from "./source-journal-test-runtime.mjs";
import { sourceModel } from "./source-reader-model.mjs";

function fixture() {
  const source = sourceModel(), records = new Map();
  // Give the fixed grid more than one range, retaining omitted blank cells.
  const fetch = async (url, init) => {
    const response = await source.fetch(url, init);
    if (new URL(url).hostname !== "sheets.googleapis.com") return response;
    const value = await response.json();
    value.sheets[0].properties.gridProperties.rowCount = 112;
    if (new URL(url).pathname.endsWith(":getByDataFilter")) {
      const offset = JSON.parse(init.body).dataFilters[0].gridRange.startRowIndex;
      value.sheets[0].data[0].startRow = offset;
      if (offset) delete value.sheets[0].data[0].rowData;
    }
    return new Response(JSON.stringify(value));
  };
  const context = { read_context: source.context, actor_id: "fictional_coach", attempt_id: "fictional_read_attempt",
    journal_spreadsheet_id: "fictional_private_journal", journal_sheet_id: 54321, owner_permission_id: "fictional_owner" };
  const state = { failBefore: null, failAfter: null, afterSave: null, casCalls: 0 };
  const store = {
    async read(key) { return structuredClone(records.get(key) ?? null); },
    async compareAndSet(key, revision, value) {
      state.casCalls++;
      if (state.failBefore?.(value)) throw new Error("PRIVATE_STORAGE_SENTINEL");
      if ((records.get(key)?.revision ?? null) !== revision) return false;
      records.set(key, structuredClone(value));
      state.afterSave?.(value);
      if (state.failAfter?.(value)) throw new Error("PRIVATE_STORAGE_SENTINEL");
      return true;
    },
  };
  const attempt = (port = store, now = source.now) => new PrivateSourceReadAttempt(() => context, port, sha, now);
  const reader = (port = store, now = source.now, fetchPort = fetch) => new GoogleSourceReader(
    () => source.context, source.token, fetchPort, now, attempt(port, now));
  const saved = () => [...records.values()].find(row => row.format === "c2-private-source-read-v1");
  const contentReads = () => source.state.calls.filter(call => !call.url.pathname.endsWith("/about")).length;
  return { source, context, store, state, records, reader, attempt, saved, contentReads, fetch };
}
const reject = (action, code) => assert.rejects(action, error => error instanceof SourceJournalError && error.code === code &&
  error.message === "Private source journal could not be confirmed.");

test("two-pass pages and ranges persist with original times and digests, complete replay makes no content reads", async () => {
  const item = fixture(), result = await item.reader().read(), reads = item.contentReads();
  assert.equal(item.saved().entries.length, 18);
  assert.equal(item.saved().pending, null);
  assert.equal(item.saved().observed_end_at, result.observation.observed_end_at);
  assert.ok(item.saved().entries.every(entry => /^[A-Za-z0-9_-]{43}$/u.test(entry.digest)));
  item.source.state.cellDrift = true;
  const replayed = await item.reader(item.store, () => "2026-10-03T04:02:00Z").read();
  assert.deepEqual(replayed, result);
  assert.equal(item.contentReads(), reads);
  // Replay checks the new token's identity once, rather than trusting cached about.
  assert.equal(item.source.state.calls.at(-1).url.pathname.endsWith("/about"), true);
  assert.equal(result.plan.source_status, "SOURCE_NOT_VERIFIED");
});

test("checkpoint pin failure and read-start failure prevent the source request", async () => {
  for (const fail of [row => row.revision === 1, row => row.pending !== null]) {
    const item = fixture(); item.state.failBefore = fail;
    await reject(item.reader().read(), "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
    assert.equal(item.contentReads(), 0);
  }
});

test("lost reply after a durable completed block resumes the next range without refetching earlier pages", async () => {
  const item = fixture(); let failed = false;
  item.state.failAfter = row => {
    if (!failed && row.entries.length === 6 && row.pending === null) { failed = true; return true; }
    return false;
  };
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
  assert.equal(item.saved().entries.length, 6);
  item.state.failAfter = null;
  const result = await item.reader().read();
  assert.equal(result.observation.passes, 2);
  assert.equal(item.source.state.listReads, 4);
  const ranges = item.source.state.calls.filter(call => call.url.pathname.endsWith(":getByDataFilter"));
  assert.deepEqual(ranges.map(call => call.body.dataFilters[0].gridRange.startRowIndex), [0, 100, 0, 100]);
});

test("unpersisted response leaves an unresolved request, never refetches or changes attempt to bypass it", async () => {
  const item = fixture(); item.state.failBefore = row => row.entries.length === 3 && row.pending === null;
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
  const reads = item.contentReads();
  assert.equal(item.saved().entries.length, 2);
  assert.ok(item.saved().pending);
  item.state.failBefore = null;
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_REQUEST_UNRESOLVED");
  assert.equal(item.contentReads(), reads);
  item.context.attempt_id = "different_attempt";
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_CONTEXT_CHANGED");
  assert.equal(item.contentReads(), reads);
});

test("failed API page remains unresolved after restart instead of retrying the live page", async () => {
  const item = fixture(); item.source.state.failPage = true;
  await reject(item.reader().read(), "JOURNAL_GOOGLE_REQUEST_UNCONFIRMED");
  const reads = item.contentReads(); item.source.state.failPage = false;
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_REQUEST_UNRESOLVED");
  assert.equal(item.contentReads(), reads);
});

test("all completed replies survive finalization failure and reconstruct without content reads", async () => {
  const item = fixture(); item.state.failBefore = row => row.observed_end_at !== null;
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
  const reads = item.contentReads(); assert.equal(item.saved().entries.length, 18);
  item.state.failBefore = null;
  await item.reader().read(); assert.equal(item.contentReads(), reads);
});

test("context changes after a durable reply stop before the next request", async () => {
  const item = fixture(); item.state.afterSave = row => {
    if (row.entries.length === 3) item.context.actor_id = "changed_coach";
  };
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_CONTEXT_CHANGED");
  const reads = item.contentReads();
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_CONTEXT_CHANGED");
  assert.equal(item.contentReads(), reads);
});

test("replayed checkpoints reject a new API principal before returning raw content", async () => {
  const item = fixture(); await item.reader().read(); const reads = item.contentReads();
  const otherUser = async (url, init) => new URL(url).pathname.endsWith("/about") ?
    new Response(JSON.stringify({ user: { permissionId: "different_owner" } })) : item.fetch(url, init);
  await reject(item.reader(item.store, item.source.now, otherUser).read(), "SOURCE_READ_API_USER_CHANGED");
  assert.equal(item.contentReads(), reads);
});

test("changed checkpoint content, timestamps and revision fail validation before a live content request", async () => {
  for (const mutate of [row => { row.entries[2].response_text = '{"responses":[]}'; },
    row => { row.entries[0].observed_end_at = "2026-10-01T04:03:00Z"; },
    row => { row.revision++; }, row => { row.entries.pop(); }]) {
    const item = fixture(); await item.reader().read(); const reads = item.contentReads();
    mutate(item.saved());
    await assert.rejects(item.reader().read(), SourceJournalError);
    assert.equal(item.contentReads(), reads);
  }
});

test("request identity and exact replay coverage cannot be replaced by a different URL or premature finish", async () => {
  const item = fixture(); await item.reader().read();
  const session = await item.attempt().open(item.source.context, item.source.now());
  let calls = 0;
  await reject(session.request("https://forms.googleapis.com/v1/forms/different", undefined, async () => { calls++; return {}; }),
    "SOURCE_CHECKPOINT_REQUEST_CHANGED");
  await reject(session.finish(item.source.now()), "SOURCE_CHECKPOINT_REQUEST_UNRESOLVED");
  assert.equal(calls, 0);
});

test("expired partial attempt cannot extend its original observation window", async () => {
  const item = fixture(); item.state.failAfter = row => row.entries.length === 3 && row.pending === null;
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
  const reads = item.contentReads(); item.state.failAfter = null;
  await reject(item.reader(item.store, () => "2026-10-01T04:18:00Z").read(), "SOURCE_READ_TIME_BUDGET_EXCEEDED");
  assert.equal(item.contentReads(), reads);
});

test("concurrent readers cannot invoke the same pending request twice", async () => {
  const item = fixture();
  const [a, b] = await Promise.allSettled([item.reader().read(), item.reader().read()]);
  assert.ok([a, b].some(result => result.status === "fulfilled"));
  assert.ok([a, b].some(result => result.status === "rejected"));
  assert.equal(item.source.state.listReads, 4);
});

test("durable read transcript closes operation candidate CAS failure without a live reread", async () => {
  const item = fixture(), journal = model(); let fail = true;
  const operation = () => new PrivateSourceOperation(() => item.context, {
    store: { ...item.store, compareAndSet: async (key, revision, value) => {
      if (value.phase === "CANDIDATE_DURABLE" && fail) throw new Error("PRIVATE_CANDIDATE_SENTINEL");
      return item.store.compareAndSet(key, revision, value);
    } }, hash: sha, readSource: async () => item.reader().read(),
    journal: port => new PrivateSourceJournal(port, journal.store, sha),
  });
  await reject(operation().capture(), "SOURCE_OPERATION_DEPENDENCY_UNCONFIRMED");
  const reads = item.contentReads(); fail = false;
  assert.equal((await operation().capture()).phase, "CANDIDATE_DURABLE");
  assert.equal(item.contentReads(), reads);
  assert.equal((await operation().stage()).phase, "JOURNAL_READBACK_CONFIRMED");
  assert.equal(journal.state.writes, 1);
});

test("private file store recovers completed pages after store and reader recreation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbt-private-read-"));
  try {
    const item = fixture(), store = await createPrivateFileOperationStore(directory);
    let failed = false;
    const interrupted = { ...store, compareAndSet: async (key, revision, row) => {
      const saved = await store.compareAndSet(key, revision, row);
      if (!failed && row.entries.length === 6 && row.pending === null) { failed = true; throw new Error("PRIVATE_CRASH_SENTINEL"); }
      return saved;
    } };
    await reject(item.reader(interrupted).read(), "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
    const resumed = await item.reader(await createPrivateFileOperationStore(directory)).read();
    assert.equal(resumed.observation.passes, 2);
    assert.equal(item.source.state.listReads, 4);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^dbt-private-read-/u);
    await rm(directory, { recursive: true, force: true });
  }
});

test("lost read-start acknowledgement never invokes or refetches its source request", async () => {
  const item = fixture(); item.state.failAfter = row => row.pending !== null;
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
  assert.equal(item.contentReads(), 0);
  item.state.failAfter = null;
  await reject(item.reader().read(), "SOURCE_CHECKPOINT_REQUEST_UNRESOLVED");
  assert.equal(item.contentReads(), 0);
});

test("same read operation rejects changed binding, generation, owner and target", async () => {
  for (const mutate of [ctx => { ctx.read_context.source.binding_version++; },
    ctx => { ctx.read_context.source.backend_generation = "changed_generation"; },
    ctx => { ctx.read_context.source.writer_epoch++; }, ctx => { ctx.journal_sheet_id++; },
    ctx => { ctx.owner_permission_id = "other_owner"; ctx.read_context.api_user_permission_id = "other_owner"; }]) {
    const item = fixture(); await item.reader().read(); const reads = item.contentReads();
    mutate(item.context);
    await reject(item.reader().read(), "SOURCE_CHECKPOINT_CONTEXT_CHANGED");
    assert.equal(item.contentReads(), reads);
  }
});

test("request count and response byte limits stop before publishing a complete transcript", async () => {
  const item = fixture(), session = await item.attempt().open(item.source.context, item.source.now());
  let calls = 0;
  const payload = { value: "x".repeat(1_500_000) };
  for (let i = 0; i < 3; i++) await session.request(`https://forms.googleapis.com/v1/forms/fictional/${i}`, undefined,
    async () => { calls++; return payload; });
  await reject(session.request("https://forms.googleapis.com/v1/forms/fictional/3", undefined,
    async () => { calls++; return payload; }), "SOURCE_CHECKPOINT_BUDGET_EXCEEDED");
  assert.equal(calls, 4);
  assert.equal(item.saved().entries.length, 3);
  assert.ok(item.saved().pending);
  assert.equal(item.saved().observed_end_at, null);
  // Prebuild a valid transcript to exercise the exact request cap without
  // issuing 384 live requests; every replay still validates its full content.
  const capped = fixture(), seed = await capped.attempt().open(capped.source.context, capped.source.now());
  await seed.request("https://forms.googleapis.com/v1/forms/fictional", undefined, async () => ({}));
  const row = capped.saved(), entry = row.entries[0];
  row.entries = await Promise.all(Array.from({ length: 384 }, async (_, index) => ({ ...entry,
    digest: await sha("c2-private-source-read-entry-v1\n" + JSON.stringify([index, entry.request_text, entry.response_text,
      entry.observed_start_at, entry.observed_end_at])) })));
  row.revision = 769;
  const complete = await capped.attempt().open(capped.source.context, capped.source.now());
  for (let i = 0; i < 384; i++) await complete.request("https://forms.googleapis.com/v1/forms/fictional", undefined,
    async () => { throw new Error("No saved entry may refetch."); });
  await reject(complete.request("https://forms.googleapis.com/v1/forms/fictional", undefined,
    async () => { throw new Error("No over-budget source request."); }), "SOURCE_CHECKPOINT_BUDGET_EXCEEDED");
});

test("clock regression and arbitrary storage errors keep safe diagnostics and preserve the request fence", async () => {
  const item = fixture(); let times = 0;
  const attempt = item.attempt(item.store, () => times++ === 0 ? "2026-10-01T04:03:00Z" : "2026-10-01T04:02:00Z");
  const session = await attempt.open(item.source.context, item.source.now());
  await reject(session.request("https://forms.googleapis.com/v1/forms/fictional", undefined, async () => ({})),
    "SOURCE_CHECKPOINT_INVALID");
  assert.ok(item.saved().pending);
  const other = fixture();
  await reject(other.attempt({ read: async () => { throw new Error("PRIVATE_ERROR_SENTINEL"); } }).open(other.source.context, other.source.now()),
    "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
});
