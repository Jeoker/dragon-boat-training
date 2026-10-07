// Explicit isolated adapter acceptance only. No production/Worker/Coach access.
// Private payloads and fixed command pins remain outside the repository.
// The c2test fixture config is in the project's Git-ignored .c2-form-test directory.
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizedClient, privatePaths } from "../backend/source-journal/oauth-local.mjs";
import { createPrivateFileOperationStore } from "../backend/source-journal/private-file-store.mjs";
import { GoogleSourceReader, GoogleSourceJournalStore, PrivateSourceJournal, PrivateSourceOperation, PrivateSourceReadAttempt, sourceCanonical, sha }
  from "./source-journal-test-runtime.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mode, clientPath, tokenPath, privateDirectory] = process.argv.slice(2);
assert.ok(["read", "prepare-journal", "stage", "stage-lost", "resume", "resume-lost", "operation-stage", "operation-resume",
  "checkpoint-stage", "checkpoint-resume"].includes(mode));
privatePaths(clientPath, tokenPath);
assert.ok(privateDirectory && isAbsolute(privateDirectory));
const directory = resolve(privateDirectory), local = relative(repository, directory);
assert.ok(local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local), "Private artifacts must stay outside the repository.");
await mkdir(directory, { recursive: true });
const pathFor = name => join(directory, name);
async function load(name) {
  try { return JSON.parse(await readFile(pathFor(name), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
// Immutable file publication: fsync before atomic rename. Every writing mode
// holds a process lock; a crash leaves the lock for explicit operator inspection.
async function fixed(name, value) {
  const existing = await load(name);
  if (existing) { assert.equal(sourceCanonical(existing), sourceCanonical(value)); return existing; }
  const temporary = pathFor(`.${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(sourceCanonical(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, pathFor(name)); return value;
}

const lockPath = pathFor("acceptance.lock");
let lock;
try {
  lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, mode, started_at: new Date().toISOString() }));
  await lock.sync();
  const auth = await authorizedClient(clientPath, tokenPath, "dragon-boat-source-test");
  const token = async () => { const result = await auth.getAccessToken(); assert.ok(result.token); return result.token; };
  const request = async (url, data) => (await auth.request({ url, method: data ? "POST" : "GET", data,
    timeout: 30_000, retry: false })).data;
  const fixture = JSON.parse(await readFile(resolve(repository, ".c2-form-test/private-test-config.json"), "utf8")).fixture;
  assert.equal(fixture.seasonId, "season_c2_isolated_2026");

  if (mode.startsWith("checkpoint-")) {
    const original = await load("read-context.json"), target = await load("target.json");
    assert.ok(original && target);
    assert.equal(original.authority, "ISOLATED_ACCEPTANCE_RUNNER_ONLY");
    assert.equal(original.cutoff_policy, "TEST_ONLY_NOT_REGISTERED_SEASON_END");
    assert.equal(original.census_policy, "EMPTY_TEST_DECLARATION_NOT_AUTHORITATIVE_HISTORY");
    let context = await load("checkpoint-context.json");
    if (mode === "checkpoint-stage") {
      assert.equal(context, null, "An existing attempt must use checkpoint-resume.");
      context = await fixed("checkpoint-context.json", {
        read_context: { ...original.context, source: { ...original.context.source,
          source_operation_id: `c2_checkpoint_${randomUUID()}`, season_ends_at: new Date().toISOString() } },
        actor_id: "isolated_acceptance_runner", attempt_id: `c2_checkpoint_attempt_${randomUUID()}`,
        journal_spreadsheet_id: target.spreadsheet_id, journal_sheet_id: randomInt(1, 2_147_483_647),
        owner_permission_id: target.owner_permission_id,
      });
    }
    assert.ok(context);
    assert.equal(context.read_context.source.form_id, fixture.formId);
    assert.equal(context.read_context.source.spreadsheet_id, fixture.runtimeSheetId);
    assert.equal(context.read_context.source.sheet_id, Number(fixture.responseSheetId));
    assert.equal(context.read_context.response_tab_title, fixture.responseSheetName);
    assert.equal(context.journal_spreadsheet_id, target.spreadsheet_id);
    assert.equal(context.owner_permission_id, target.owner_permission_id);
    assert.deepEqual(context.read_context.known_sources, []);
    assert.deepEqual(context.read_context.declared_mappings, []);
    const durable = await createPrivateFileOperationStore(pathFor("checkpoint-reads"));
    const contextPort = () => JSON.parse(readFileSync(pathFor("checkpoint-context.json"), "utf8"));
    let sourceReads = 0, identityReads = 0, interrupted = false;
    const fetchPort = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === "www.googleapis.com" && parsed.pathname === "/drive/v3/about") {
        assert.equal(init.method, "GET"); identityReads++;
      } else {
        assert.ok(parsed.hostname === "forms.googleapis.com" &&
          [`/v1/forms/${fixture.formId}`, `/v1/forms/${fixture.formId}/responses`].includes(parsed.pathname) && init.method === "GET" ||
          parsed.hostname === "sheets.googleapis.com" &&
          (parsed.pathname === `/v4/spreadsheets/${fixture.runtimeSheetId}` && init.method === "GET" ||
            parsed.pathname === `/v4/spreadsheets/${fixture.runtimeSheetId}:getByDataFilter` && init.method === "POST"));
        sourceReads++;
      }
      return fetch(url, init);
    };
    const attempt = new PrivateSourceReadAttempt(contextPort, {
      read: key => durable.read(key), async compareAndSet(key, revision, row) {
        const saved = await durable.compareAndSet(key, revision, row);
        if (saved && mode === "checkpoint-stage" && !interrupted && row.pending === null && row.entries.length &&
          JSON.parse(row.entries.at(-1).request_text).url.endsWith(":getByDataFilter")) {
          interrupted = true; throw new Error("ISOLATED_CHECKPOINT_AFTER_RANGE_INTERRUPTED");
        }
        return saved;
      },
    }, sha);
    const existing = await load("checkpoint-candidate.json");
    try {
      const result = await new GoogleSourceReader(() => contextPort().read_context, token, fetchPort, undefined, attempt).read();
      assert.equal(mode, "checkpoint-resume");
      if (existing) assert.equal(sourceReads, 0);
      await fixed("checkpoint-candidate.json", { authority: original.authority, source: context.read_context.source,
        core_text: result.plan.canonical_text, observation: result.observation });
      console.log(JSON.stringify({ stage: "CHECKPOINT-RESUME", source_reads: sourceReads, identity_reads: identityReads,
        core_utf8_bytes: Buffer.byteLength(result.plan.canonical_text), namespace_counts: result.plan.namespace_counts,
        source_status: result.plan.source_status, annual_export_authorized: false }));
    } catch (error) {
      assert.equal(mode, "checkpoint-stage"); assert.ok(interrupted);
      assert.equal(error.code, "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
      console.log(JSON.stringify({ stage: "CHECKPOINT-STAGE", source_reads: sourceReads, identity_reads: identityReads,
        controlled_after_range_interrupted: interrupted, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false }));
    }
  } else if (mode === "read") {
    const existing = await load("candidate.json");
    assert.equal(existing, null, "Existing candidate must be recovered, never replaced by a new live-source read.");
    const identity = await request("https://www.googleapis.com/drive/v3/about?fields=user(permissionId)");
    const form = await request(`https://forms.googleapis.com/v1/forms/${encodeURIComponent(fixture.formId)}`);
    const metadata = await request(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fixture.runtimeSheetId)}?fields=` +
      encodeURIComponent("spreadsheetId,properties(title),sheets(properties(sheetId,title))"));
    assert.equal(form.formId, fixture.formId); assert.equal(form.linkedSheetId, fixture.runtimeSheetId);
    assert.equal(metadata.spreadsheetId, fixture.runtimeSheetId);
    assert.equal(metadata.properties.title, "Dragon Boat C2 Isolated Response Test");
    const selected = metadata.sheets.filter(sheet => String(sheet.properties.sheetId) === fixture.responseSheetId);
    assert.equal(selected.length, 1); assert.equal(selected[0].properties.title, fixture.responseSheetName);
    let pin = await load("read-context.json");
    if (!pin) pin = await fixed("read-context.json", {
      authority: "ISOLATED_ACCEPTANCE_RUNNER_ONLY", cutoff_policy: "TEST_ONLY_NOT_REGISTERED_SEASON_END",
      census_policy: "EMPTY_TEST_DECLARATION_NOT_AUTHORITATIVE_HISTORY",
      context: { source: { source_operation_id: `c2_source_adapter_${randomUUID()}`, team_id: "dragon-boat-c2-test",
        season_id: "season_c2_source_adapter_acceptance", binding_version: 1, backend_generation: "local-source-adapter-test",
        writer_epoch: 0, form_id: fixture.formId, spreadsheet_id: fixture.runtimeSheetId,
        sheet_id: Number(fixture.responseSheetId), season_ends_at: new Date().toISOString() },
        known_sources: [], declared_mappings: [], api_user_permission_id: identity.user.permissionId,
        response_tab_title: fixture.responseSheetName } });
    assert.equal(pin.context.source.form_id, fixture.formId);
    assert.equal(pin.context.source.spreadsheet_id, fixture.runtimeSheetId);
    assert.equal(pin.context.api_user_permission_id, identity.user.permissionId);
    const contextPort = () => JSON.parse(readFileSync(pathFor("read-context.json"), "utf8")).context;
    const result = await new GoogleSourceReader(contextPort, token).read();
    const digest = await sha("c2-source-review-source-v1\n" + result.plan.canonical_text);
    await fixed("candidate.json", { authority: pin.authority, source: pin.context.source,
      core_text: result.plan.canonical_text, source_plan_digest: digest, observation: result.observation });
    console.log(JSON.stringify({ stage: "REAL_SOURCE_READ", state: result.observation.state,
      cutoff_policy: pin.cutoff_policy, namespace_counts: result.plan.namespace_counts,
      core_utf8_bytes: Buffer.byteLength(result.plan.canonical_text), source_status: result.plan.source_status,
      annual_export_authorized: false }));
  } else {
    const candidate = await load("candidate.json"), pin = await load("read-context.json");
    assert.ok(candidate && pin);
    assert.equal(candidate.authority, "ISOLATED_ACCEPTANCE_RUNNER_ONLY");
    assert.equal(sourceCanonical(candidate.source), sourceCanonical(pin.context.source));
    assert.equal(candidate.source.form_id, fixture.formId);
    assert.equal(candidate.source.spreadsheet_id, fixture.runtimeSheetId);
    assert.equal(candidate.source_plan_digest, await sha("c2-source-review-source-v1\n" + candidate.core_text));
    if (mode === "prepare-journal") {
      let target = await load("target.json");
      if (!target) {
        // There is no idempotency key for spreadsheet creation. An existing
        // marker with no target is an unknown window: stop rather than recreate.
        assert.equal(await load("spreadsheet-create-started.json"), null,
          "Unknown spreadsheet creation requires explicit recovery of the original target.");
        const preparationId = randomUUID();
        await fixed("spreadsheet-create-started.json", { preparation_id: preparationId,
          source_plan_digest: candidate.source_plan_digest, requested_at: new Date().toISOString() });
        const sheet = await request("https://sheets.googleapis.com/v4/spreadsheets", {
          properties: { title: `Dragon Boat C2 Private Source Journal ${preparationId}`, locale: "en_US", timeZone: "America/New_York" },
          sheets: [{ properties: { sheetId: 0, title: "IsolatedAcceptanceControl", gridProperties: { rowCount: 2, columnCount: 1 } },
            data: [{ rowData: [{ values: [{ userEnteredValue: { stringValue: preparationId } }] },
              { values: [{ userEnteredValue: { stringValue: "ISOLATED_ACCEPTANCE_RUNNER_ONLY" } }] }] }] }] });
        assert.ok(/^[A-Za-z0-9_-]+$/u.test(sheet.spreadsheetId));
        assert.notEqual(sheet.spreadsheetId, fixture.runtimeSheetId);
        assert.notEqual(sheet.spreadsheetId, fixture.systemSheetId);
        target = await fixed("target.json", { preparation_id: preparationId, spreadsheet_id: sheet.spreadsheetId,
          owner_permission_id: pin.context.api_user_permission_id, source_plan_digest: candidate.source_plan_digest });
      }
      assert.equal(target.source_plan_digest, candidate.source_plan_digest);
      const context = { plan: { source: candidate.source, source_format: "c2-source-plan-v1", source_plan_digest: candidate.source_plan_digest },
        attempt_id: "private_target_acl_preflight", actor_id: "isolated_acceptance_runner",
        spreadsheet_id: target.spreadsheet_id, sheet_id: 1, owner_permission_id: target.owner_permission_id };
      await new GoogleSourceJournalStore(token).assertPrivate(context);
      console.log(JSON.stringify({ stage: "PRIVATE_JOURNAL_TARGET", owner_and_parent_acl: "CHECKED", target_reused: !!(await load("context-normal.json")),
        source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false }));
    } else if (mode.startsWith("operation-")) {
      const target = await load("target.json"); assert.ok(target);
      assert.equal(target.source_plan_digest, candidate.source_plan_digest);
      let context = await load("operation-context.json");
      if (!context) {
        assert.equal(mode, "operation-stage");
        context = await fixed("operation-context.json", { read_context: pin.context,
          actor_id: "isolated_acceptance_runner", attempt_id: `c2_private_operation_${randomUUID()}`,
          journal_spreadsheet_id: target.spreadsheet_id, journal_sheet_id: randomInt(1, 2_147_483_647),
          owner_permission_id: target.owner_permission_id });
      }
      assert.equal(sourceCanonical(context.read_context), sourceCanonical(pin.context));
      assert.equal(context.journal_spreadsheet_id, target.spreadsheet_id);
      assert.equal(context.owner_permission_id, target.owner_permission_id);
      const durable = await createPrivateFileOperationStore(pathFor("operations"));
      let writes = 0, sourceReads = 0, candidateImports = 0, commitInterrupted = false;
      const fetchPort = async (url, init) => {
        const parsed = new URL(url);
        if (parsed.hostname === "forms.googleapis.com" || parsed.pathname.includes(fixture.runtimeSheetId)) {
          sourceReads++; throw new Error("Operation recovery must never access current source.");
        }
        if (parsed.pathname.endsWith(":batchUpdate")) {
          assert.equal(mode, "operation-stage"); writes++; assert.equal(writes, 1);
        }
        return fetch(url, init);
      };
      const operation = new PrivateSourceOperation(() => JSON.parse(readFileSync(pathFor("operation-context.json"), "utf8")), {
        hash: sha, store: { read: key => durable.read(key), async compareAndSet(key, revision, value) {
          if (mode === "operation-stage" && revision === 3) {
            commitInterrupted = true; throw new Error("ISOLATED_RECEIPT_COMMIT_INTERRUPTED");
          }
          return durable.compareAndSet(key, revision, value);
        } },
        readSource: async readContext => {
          assert.equal(sourceCanonical(readContext), sourceCanonical(pin.context)); candidateImports++;
          return { plan: { canonical_text: candidate.core_text }, observation: candidate.observation };
        },
        journal: contextPort => new PrivateSourceJournal(contextPort, new GoogleSourceJournalStore(token, fetchPort), sha),
      });
      if (mode === "operation-stage") {
        const captured = await operation.capture();
        let result;
        try { result = await operation.stage(); }
        catch (error) {
          assert.ok(commitInterrupted); assert.equal(error.code, "SOURCE_OPERATION_DEPENDENCY_UNCONFIRMED");
          const record = await durable.read(captured.operation_key);
          assert.equal(record.phase, "JOURNAL_WRITE_STARTED"); assert.equal(record.candidate.core_text, candidate.core_text);
          assert.equal(record.receipt, null);
          result = { phase: record.phase, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
        }
        console.log(JSON.stringify({ stage: "OPERATION-STAGE", phase: result.phase, writes, source_reads: sourceReads,
          original_candidate_imports: candidateImports, controlled_receipt_commit_interrupted: commitInterrupted,
          source_status: result.source_status, annual_export_authorized: false }));
      } else {
        const result = await operation.resume();
        assert.equal(writes, 0); assert.equal(sourceReads, 0); assert.equal(candidateImports, 0);
        await fixed("operation-receipt-summary.json", result);
        console.log(JSON.stringify({ stage: "OPERATION-RESUME", phase: result.phase, revision: result.revision,
          writes, source_reads: sourceReads, original_candidate_imports: candidateImports,
          source_status: result.source_status, annual_export_authorized: false }));
      }
    } else {
      const target = await load("target.json"); assert.ok(target);
      assert.equal(target.source_plan_digest, candidate.source_plan_digest);
      const lost = mode.endsWith("-lost"), kind = lost ? "lost" : "normal", contextName = `context-${kind}.json`;
      let context = await load(contextName);
      if (!context) {
        assert.ok(mode.startsWith("stage"), "Recovery requires the original durable command.");
        context = await fixed(contextName, { plan: { source: candidate.source, source_format: "c2-source-plan-v1",
          source_plan_digest: candidate.source_plan_digest }, attempt_id: `c2_private_${kind}_${randomUUID()}`,
          actor_id: "isolated_acceptance_runner", spreadsheet_id: target.spreadsheet_id,
          sheet_id: randomInt(1, 2_147_483_647), owner_permission_id: target.owner_permission_id });
      }
      assert.equal(context.spreadsheet_id, target.spreadsheet_id);
      assert.equal(context.owner_permission_id, target.owner_permission_id);
      assert.equal(sourceCanonical(context.plan.source), sourceCanonical(candidate.source));
      assert.equal(context.plan.source_plan_digest, candidate.source_plan_digest);
      let writes = 0, sourceReads = 0, dropped = false;
      const fetchPort = async (url, init) => {
        const parsed = new URL(url);
        if (parsed.hostname === "forms.googleapis.com" || parsed.pathname.includes(fixture.runtimeSheetId)) {
          sourceReads++; throw new Error("Acceptance recovery must never access current source.");
        }
        if (parsed.pathname.endsWith(":batchUpdate")) {
          assert.ok(mode.startsWith("stage"), "Resume is read-only."); writes++;
          assert.equal(writes, 1, "Only one original AddSheet request is permitted.");
        }
        const response = await fetch(url, init);
        if (lost && mode === "stage-lost" && parsed.pathname.endsWith(":batchUpdate") && response.ok) {
          await response.arrayBuffer(); dropped = true; throw new Error("ISOLATED_REPLY_DROPPED_AFTER_WRITE");
        }
        return response;
      };
      const contextPort = () => JSON.parse(readFileSync(pathFor(contextName), "utf8"));
      const journal = new PrivateSourceJournal(contextPort, new GoogleSourceJournalStore(token, fetchPort), sha);
      const result = mode.startsWith("resume") ? await journal.resume() : await journal.stage(candidate.core_text);
      assert.equal(result.core_text, candidate.core_text);
      assert.equal(sourceReads, 0);
      if (mode.startsWith("resume")) assert.equal(writes, 0);
      await fixed(`receipt-${kind}.json`, { authority: "ISOLATED_ACCEPTANCE_RUNNER_ONLY", context, control: result.control });
      console.log(JSON.stringify({ stage: mode.toUpperCase(), state: result.control.state, core_exact: true,
        writes, source_reads: sourceReads, controlled_reply_dropped: dropped, utf8_bytes: result.control.utf8_bytes,
        part_count: result.control.part_count, source_status: result.control.source_status, annual_export_authorized: false }));
    }
  }
} catch (error) {
  // Never print dependency messages or stack traces: they can contain source/credentials.
  console.error(JSON.stringify({ stage: mode, status: "ISOLATED_SOURCE_ACCEPTANCE_UNCONFIRMED",
    code: typeof error.code === "string" && /^[A-Z_]+$/u.test(error.code) ? error.code : "PRIVATE_DEPENDENCY_UNCONFIRMED",
    http_status: Number(error.response?.status) || 0 })); process.exitCode = 1;
} finally {
  if (lock) { await lock.close(); await unlink(lockPath); }
}
