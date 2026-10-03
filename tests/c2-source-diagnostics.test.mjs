import assert from "node:assert/strict";
import test from "node:test";
import { PrivateGoogleClient, PrivateSourceOperation, PrivateSourceReadAttempt, GoogleSourceReader, PrivateSourceJournal,
  SourceJournalError, goldens, sha, contextFor } from "./source-journal-test-runtime.mjs";

const input = JSON.parse(goldens.cases[0].input_text);
const context = { read_context: { source: goldens.cases[0].pinned, known_sources: input.known_sources,
  declared_mappings: [], api_user_permission_id: "fictional_owner", response_tab_title: "Responses" },
  actor_id: "fictional_coach", attempt_id: "fictional_diagnostics_attempt", journal_spreadsheet_id: "fictional_private_journal",
  journal_sheet_id: 12345, owner_permission_id: "fictional_owner" };
function foreignErrors() {
  const forged = new SourceJournalError("SOURCE_CHECKPOINT_INVALID");
  forged.message = "PRIVATE_DEPENDENCY_SENTINEL"; forged.raw = "PRIVATE_RAW_SENTINEL";
  const unknown = new SourceJournalError("PRIVATE_CREDENTIAL_SENTINEL");
  const accessor = new SourceJournalError("SOURCE_CHECKPOINT_INVALID");
  Object.defineProperty(accessor, "code", { get() { throw Error("PRIVATE_GETTER_SENTINEL"); } });
  const proxy = new Proxy(forged, { getPrototypeOf() { throw Error("PRIVATE_REFLECTION_SENTINEL"); } });
  return [forged, unknown, accessor, proxy];
}
async function redacted(action, foreign) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof SourceJournalError); assert.notEqual(error, foreign);
    assert.equal(error.message, "Private source journal could not be confirmed.");
    assert.ok(!JSON.stringify(error).includes("PRIVATE_")); assert.deepEqual(Object.keys(error).sort(), ["code", "name"]);
    return true;
  });
}

test("OAuth and transport errors cannot forward forged journal errors, raw fields or hostile reflection", async () => {
  for (const foreign of foreignErrors()) {
    for (const phase of ["token", "fetch"]) {
      const client = new PrivateGoogleClient(async () => { if (phase === "token") throw foreign; return "FICTIONAL_TOKEN"; },
        async () => { throw foreign; });
      await redacted(client.request("https://www.googleapis.com/drive/v3/about"), foreign);
    }
  }
});

test("candidate and read checkpoint stores cannot expose forged diagnostics", async () => {
  for (const foreign of foreignErrors()) {
    const store = { async read() { throw foreign; }, async compareAndSet() { throw Error("unexpected write"); } };
    const operation = new PrivateSourceOperation(() => context, { store, hash: sha,
      async readSource() { throw Error("unexpected source read"); }, journal() { throw Error("unexpected journal"); } });
    await redacted(operation.capture(), foreign);
    await redacted(new PrivateSourceReadAttempt(() => context, store, sha).open(context.read_context, "2026-10-03T15:00:00Z"), foreign);
  }
});

test("source reader checkpoint failures and journal row accessors cannot forward dependency objects", async () => {
  for (const foreign of foreignErrors()) {
    const reader = new GoogleSourceReader(() => context.read_context, async () => "FICTIONAL_TOKEN",
      async () => { throw Error("unexpected Google fetch"); }, () => "2026-10-03T15:00:00Z", { async open() { throw foreign; } });
    await redacted(reader.read(), foreign);
    const rows = ["header", "body"]; Object.defineProperty(rows, "1", { get() { throw foreign; } });
    const journal = new PrivateSourceJournal(() => contextFor(), { async assertPrivate() {}, async read() { return rows; },
      async create() { throw Error("unexpected write"); } }, sha);
    await redacted(journal.resume(), foreign);
  }
});
