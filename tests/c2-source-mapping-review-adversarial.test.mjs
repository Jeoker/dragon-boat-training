import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// This file owns its loader and fixtures. It does not import the author's tests.
const modules = new Map();
function moduleUrl(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  let code = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu, (_, start, path, end) =>
    start + moduleUrl(new URL(path.endsWith(".ts") ? path : `${path}.ts`, url)) + end);
  const result = `data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${url.href}`).toString("base64")}`;
  modules.set(url.href, result);
  return result;
}
const { buildLocalSourcePlan } = await import(moduleUrl(new URL("../shared/c2-source-capture-projection.ts", import.meta.url)));
const { prepareLocalMappingReview, planLocalMappingReview } = await import(moduleUrl(new URL("../shared/c2-source-mapping-review-projection.ts", import.meta.url)));
const { SourceModelError } = await import(moduleUrl(new URL("../shared/c2-source-capture-contract.ts", import.meta.url)));

// Independent canonical encoding and Node SHA-256 oracle; the injected port uses WebCrypto.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const nodeHash = text => createHash("sha256").update(text, "utf8").digest("base64url");
const sha = async text => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url");
const pinned = {
  source_operation_id: "adversarial-source-op", team_id: "fictional-team", season_id: "fictional-season",
  binding_version: 1, backend_generation: "fictional-generation", writer_epoch: 0,
  form_id: "fictional-form", spreadsheet_id: "fictional-sheet", sheet_id: 23,
  season_ends_at: "2026-10-01T04:00:00Z",
};
const PRIVATE = "PRIVATE_SENTINEL_NOT_IN_CONTROL_😀";
const cell = value => ({ userEnteredValue: { stringValue: value }, effectiveValue: { stringValue: value } });
const response = (id, createTime, value) => ({
  responseId: id, createTime, lastSubmittedTime: "2026-10-01T04:02:00Z", respondentEmail: "private-fixture@example.invalid",
  answers: { question: { questionId: "question", textAnswers: { answers: [{ value }] } } },
});
function input({ sheetRows = 103, formResponses = 2, schemaDescription = "SCHEMA_ONLY_ONCE_独立" } = {}) {
  return {
    format: "c2-source-input-v1", observed_start_at: "2026-10-01T04:02:00Z", observed_end_at: "2026-10-01T04:03:00Z",
    form_schema: { formId: pinned.form_id, linkedSheetId: pinned.spreadsheet_id, info: { title: "Fixture", description: schemaDescription },
      items: [{ itemId: "item", title: "Answer", questionItem: { question: { questionId: "question", textQuestion: {} } } }] },
    form_responses: Array.from({ length: formResponses }, (_, index) => response(`response-${index + 1}`,
      index === 0 ? "2026-09-30T23:59:59.999999999-04:00" : "2026-09-30T03:00:00Z", `${PRIVATE}_${index + 1}`)),
    sheet_schema: { spreadsheetId: pinned.spreadsheet_id, sheetId: pinned.sheet_id, title: "Responses", locale: "en_US",
      timeZone: "America/New_York", rowCount: sheetRows + 1, columnCount: 2, headerRowIndex: 0, headers: [cell("Timestamp"), cell("Private answer")] },
    sheet_rows: Array.from({ length: sheetRows }, (_, index) => ({ row_index: index + 1,
      cells: [{ userEnteredValue: { numberValue: 46296.9999999 }, effectiveValue: { numberValue: 46296.9999999 } }, cell(`${PRIVATE}_sheet_${index + 1}`)] })),
    known_sources: [{ kind: "FORM_RESPONSE", form_id: pinned.form_id, response_id: "known-not-observed", status: "REVIEW_REQUIRED" }],
    declared_mappings: [],
  };
}
function initialLedger(anchor) {
  return { format: "c2-source-mapping-ledger-v1", state: "LOCAL_REVIEW_PLAN_ONLY", source_status: "SOURCE_NOT_VERIFIED", anchor, version: 0, evidence: [] };
}
function setup(source = input(), pinnedContext = pinned) {
  const source_input_text = JSON.stringify(source);
  const sourcePlan = buildLocalSourcePlan(source_input_text, pinnedContext);
  const source_plan_digest = nodeHash("c2-source-review-source-v1\n" + sourcePlan.canonical_text);
  const anchor = { source: structuredClone(pinnedContext), source_plan_digest, local_snapshot_id: `LOCAL_INPUT_${source_plan_digest}`, provenance: "LOCAL_INPUT_DECLARATIONS_ONLY" };
  const ledgerText = canonical(initialLedger(anchor));
  const context = { source: structuredClone(pinnedContext), actor_id: "fictional-coach", permission_scope: "COACH_SOURCE_MAPPING_REVIEW",
    reviewed_at: "2026-10-01T04:04:00Z", source_plan_digest, local_snapshot_id: anchor.local_snapshot_id,
    ledger_version: 0, ledger_digest: nodeHash("c2-source-review-ledger-v1\n" + ledgerText) };
  return { source, sourcePlan, bundle: { source_input_text, source_plan_text: sourcePlan.canonical_text }, context, ledgerText, anchor };
}
const get = value => () => value;
async function prepared(fixture = setup()) {
  return { ...fixture, view: await prepareLocalMappingReview(fixture.bundle, get(fixture.context), sha) };
}
function command(fixture, row = 1, id = "response-1", request = "review-request-1") {
  return { request_id: request, local_snapshot_id: fixture.context.local_snapshot_id, row_index: row, response_id: id,
    expected_sheet_digest: fixture.view.sheet_records.find(record => record.raw.row_index === row).content_digest,
    expected_form_digest: fixture.view.form_records.find(record => record.raw.responseId === id).content_digest,
    decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" };
}
function advance(context, result, at = "2026-10-01T04:05:00Z") {
  return { ...context, ledger_version: JSON.parse(result.ledger_text).version, ledger_digest: result.ledger_digest, reviewed_at: at };
}
async function rejectSafe(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof SourceModelError);
    assert.equal(error.message, "Source input is unsupported or inconsistent.");
    assert.ok(!JSON.stringify({ message: error.message, code: error.code }).includes(PRIVATE));
    if (code) assert.equal(error.code, code);
    return true;
  });
}
function assertControlPrivacy(result) {
  const text = JSON.stringify(result) + result.ledger_text + result.evidence_text + result.derived_text;
  for (const sensitive of [PRIVATE, "private-fixture@example.invalid", "SCHEMA_ONLY_ONCE_独立", '"raw":', '"source_input_text":', '"source_plan_text":'])
    assert.ok(!text.includes(sensitive), `control must exclude ${sensitive}`);
  assert.equal(result.state, "LOCAL_REVIEW_PLAN_ONLY");
  assert.equal(result.source_status, "SOURCE_NOT_VERIFIED");
  const derived = JSON.parse(result.derived_text);
  assert.equal(derived.annual_export_authorized, false);
  assert.equal(derived.source_status, "SOURCE_NOT_VERIFIED");
}

test("independent SHA bytes cover whole raw plus once-only schema; unselected chunks remain in source anchor", async () => {
  assert.equal(await sha("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  const f = await prepared();
  const schema = nodeHash("c2-source-review-schema-v1\n" + canonical({ anchor: f.anchor, kind: "FORM_SCHEMA", raw: f.source.form_schema }));
  assert.equal(f.view.form_schema_digest, schema);
  const record = f.view.form_records[0];
  assert.deepEqual(record.raw, f.source.form_responses[0]);
  assert.equal(record.content_digest, nodeHash("c2-source-review-record-v1\n" + canonical({ anchor: f.anchor,
    locator: { namespace: "FORM_CURRENT", chunk_index: 0, record_offset: 1, record_type: "FORM_RESPONSE" }, schema_digest: schema, raw: f.source.form_responses[0] })));
  assert.equal(f.view.sheet_records.length, 103);
  assert.ok(f.sourcePlan.chunks.filter(chunk => chunk.namespace === "PRIVATE_PENDING").length >= 2);
  assert.equal(JSON.stringify(f.view).split("SCHEMA_ONLY_ONCE_独立").length - 1, 1);
  assert.ok(!Object.hasOwn(record, "schema"));
  assert.equal(f.sourcePlan.namespace_counts.SHEET_CURRENT, 0);
});

test("complete source proof rejects nonselected chunk deletion, gap removal and source-plan shape changes", async () => {
  const f = setup();
  for (const mutate of [
    core => { core.chunks.splice(core.chunks.findLastIndex(chunk => chunk.namespace === "PRIVATE_PENDING"), 1); },
    core => { const chunk = core.chunks.findLast(chunk => chunk.namespace === "PRIVATE_PENDING"); const payload = JSON.parse(chunk.payload_text);
      delete payload.records.at(-1).raw.cells; chunk.payload_text = canonical(payload); chunk.utf8_bytes = Buffer.byteLength(chunk.payload_text); },
    core => { core.chunks = core.chunks.filter(chunk => chunk.namespace !== "GAP_LEDGER"); },
    core => { core.source_status = "SOURCE_VERIFIED"; },
  ]) {
    const core = JSON.parse(f.bundle.source_plan_text); mutate(core);
    await rejectSafe(() => prepareLocalMappingReview({ ...f.bundle, source_plan_text: canonical(core) }, get(f.context), sha), "REVIEW_SOURCE_PLAN_MISMATCH");
  }
});

test("equal-byte raw edits and self-consistent rebuilt plan cannot replace the independent source anchor", async () => {
  const f = setup();
  const changed = structuredClone(f.source); changed.sheet_rows.at(-1).cells[1].userEnteredValue.stringValue += "X";
  const newer = setup(changed);
  await rejectSafe(() => prepareLocalMappingReview(newer.bundle, get(f.context), sha), "REVIEW_SOURCE_ANCHOR_MISMATCH");
  const edit = f.bundle.source_input_text.replace("SCHEMA_ONLY_ONCE", "SCHEMA_ONLY_0NCE");
  assert.equal(Buffer.byteLength(edit), Buffer.byteLength(f.bundle.source_input_text));
  await rejectSafe(() => prepareLocalMappingReview({ ...f.bundle, source_input_text: edit }, get(f.context), sha), "REVIEW_SOURCE_PLAN_MISMATCH");
  // Even unchanged parsed values with a new byte count do not match the original plan metadata.
  await rejectSafe(() => prepareLocalMappingReview({ ...f.bundle, source_input_text: " " + f.bundle.source_input_text }, get(f.context), sha), "REVIEW_SOURCE_PLAN_MISMATCH");
});

test("old request replay after later append reconstructs exactly its original derived prefix and time", async () => {
  const f = await prepared(); const firstCommand = command(f);
  const first = await planLocalMappingReview(f.bundle, f.ledgerText, canonical(firstCommand), get(f.context), sha);
  const ctx1 = advance(f.context, first);
  const second = await planLocalMappingReview(f.bundle, first.ledger_text, canonical(command(f, 103, "response-2", "review-request-2")), get(ctx1), sha);
  // A retry retains the original request's server time, even after a later B request.
  const ctx2 = advance(ctx1, second, f.context.reviewed_at);
  const replay = await planLocalMappingReview(f.bundle, second.ledger_text, canonical(firstCommand), get(ctx2), sha);
  assert.equal(replay.append_required, false);
  assert.equal(replay.ledger_text, second.ledger_text);
  assert.equal(replay.evidence_text, first.evidence_text);
  assert.equal(replay.derived_text, first.derived_text);
  assert.equal(JSON.parse(replay.derived_text).ledger_version, 1);
  assert.equal(JSON.parse(replay.evidence_text).reviewed_at, f.context.reviewed_at);
  assert.equal(replay.expected_ledger_version, 2);
  const originalConditions = f.sourcePlan.chunks.filter(chunk => chunk.namespace === "GAP_LEDGER")
    .flatMap(chunk => JSON.parse(chunk.payload_text).records);
  const originalGapDigest = nodeHash("c2-source-review-gaps-v1\n" + canonical({ anchor: f.anchor, conditions: originalConditions }));
  assert.equal(JSON.parse(replay.derived_text).source_evidence_condition_digest, originalGapDigest);
  assert.equal(JSON.parse(replay.derived_text).source_evidence_condition_count, originalConditions.length);
  assertControlPrivacy(first); assertControlPrivacy(second); assertControlPrivacy(replay);
  assert.equal(f.bundle.source_plan_text, f.sourcePlan.canonical_text);
});

test("changed same ID and one-to-one reuse reject; tampered old ledger cannot authorize itself", async () => {
  const f = await prepared(); const original = command(f);
  const first = await planLocalMappingReview(f.bundle, f.ledgerText, canonical(original), get(f.context), sha);
  const ctx = advance(f.context, first);
  await rejectSafe(() => planLocalMappingReview(f.bundle, first.ledger_text, canonical({ ...original, reason: "DIRECT_KNOWLEDGE_OF_SUBMISSION" }), get(ctx), sha), "REVIEW_IDEMPOTENCY_CONFLICT");
  await rejectSafe(() => planLocalMappingReview(f.bundle, first.ledger_text, canonical(command(f, 1, "response-2", "new-request")), get(ctx), sha), "REVIEW_DUPLICATE_DECISION");
  const ledger = JSON.parse(first.ledger_text); ledger.evidence[0].reviewed_at = "2026-10-01T04:04:01Z";
  await rejectSafe(() => planLocalMappingReview(f.bundle, canonical(ledger), canonical(command(f, 103, "response-2", "next")), get(ctx), sha), "REVIEW_LEDGER_ANCHOR_MISMATCH");
  await rejectSafe(() => planLocalMappingReview(f.bundle, first.ledger_text, canonical(command(f, 103, "response-2", "next")), get({ ...ctx, ledger_digest: "A".repeat(43) }), sha), "REVIEW_LEDGER_ANCHOR_MISMATCH");
});

test("ledger chain validation rejects an internally reanchored but altered old command", async () => {
  const f = await prepared(); const first = await planLocalMappingReview(f.bundle, f.ledgerText, canonical(command(f)), get(f.context), sha);
  const ledger = JSON.parse(first.ledger_text); ledger.evidence[0].command.reason = "DIRECT_KNOWLEDGE_OF_SUBMISSION";
  const text = canonical(ledger); const ctx = { ...advance(f.context, first), ledger_digest: nodeHash("c2-source-review-ledger-v1\n" + text) };
  await rejectSafe(() => planLocalMappingReview(f.bundle, text, canonical(command(f, 103, "response-2", "next")), get(ctx), sha), "REVIEW_COMMAND_CHANGED");
});

test("two concurrent local proposals return the same CAS base and do not claim a persisted winner", async () => {
  const f = await prepared();
  const [one, two] = await Promise.all([
    planLocalMappingReview(f.bundle, f.ledgerText, canonical(command(f)), get(f.context), sha),
    planLocalMappingReview(f.bundle, f.ledgerText, canonical(command(f, 103, "response-2", "parallel")), get(f.context), sha),
  ]);
  assert.equal(one.expected_ledger_version, 0); assert.equal(two.expected_ledger_version, 0);
  assert.equal(one.expected_ledger_digest, f.context.ledger_digest); assert.equal(two.expected_ledger_digest, f.context.ledger_digest);
  assert.equal(one.append_required, true); assert.equal(two.append_required, true);
  assert.notEqual(one.ledger_digest, two.ledger_digest);
  assert.equal(JSON.parse(f.ledgerText).evidence.length, 0);
  assertControlPrivacy(one); assertControlPrivacy(two);
});

test("context changes at an explicit hash barrier fail; caller bundle mutation cannot change frozen text", async () => {
  const f = setup(); let current = f.context; let signal; let release;
  const reached = new Promise(resolve => { signal = resolve; });
  const barrier = new Promise(resolve => { release = resolve; }); let first = true;
  const heldHash = async text => { if (first) { first = false; signal(); await barrier; } return sha(text); };
  const work = prepareLocalMappingReview(f.bundle, () => current, heldHash);
  await reached; current = { ...current, source: { ...current.source, writer_epoch: 1 } }; release();
  await rejectSafe(() => work, "REVIEW_OWNERSHIP_CHANGED");
  const clean = setup(); let ready; let unblock; let entered = false;
  const hit = new Promise(resolve => { ready = resolve; }); const wait = new Promise(resolve => { unblock = resolve; });
  const copying = prepareLocalMappingReview(clean.bundle, get(clean.context), async text => { if (!entered) { entered = true; ready(); await wait; } return sha(text); });
  await hit; clean.bundle.source_input_text = PRIVATE; clean.bundle.source_plan_text = PRIVATE; unblock();
  const view = await copying; assert.deepEqual(view.form_records[0].raw, clean.source.form_responses[0]);
});

test("nanosecond cutoff uses original Form time, preserves later current edits and does not review identity-only late answers", async () => {
  const raw = input({ sheetRows: 3 });
  raw.form_responses.push(response("equal", "2026-10-01T04:00:00.000000000Z", "LATE_RAW_NEVER_IN_PLAN"),
    response("plus", "2026-10-01T00:00:00.000000001-04:00", "LATE_RAW_NEVER_IN_PLAN"));
  const f = await prepared(setup(raw));
  assert.equal(f.view.form_records[0].raw.createTime, "2026-09-30T23:59:59.999999999-04:00");
  assert.equal(f.view.form_records[0].raw.lastSubmittedTime, "2026-10-01T04:02:00Z");
  assert.deepEqual(f.view.unreviewable_responses.map(row => row.response_id), ["equal", "plus"]);
  assert.ok(!JSON.stringify(f.view).includes("LATE_RAW_NEVER_IN_PLAN"));
  const result = await planLocalMappingReview(f.bundle, f.ledgerText, canonical(command(f)), get(f.context), sha);
  assert.equal(JSON.parse(result.derived_text).reviews[0].submission_scope, "BEFORE_CUTOFF");
  for (const id of ["equal", "plus"]) await rejectSafe(() => planLocalMappingReview(f.bundle, f.ledgerText,
    canonical({ ...command(f), response_id: id }), get(f.context), sha), "FULL_RESPONSE_NOT_AVAILABLE_FOR_REVIEW");
  assertControlPrivacy(result);
});

test("unknown full schema/raw and file references stay unsupported even after HUMAN_ATTESTED", async () => {
  const raw = input({ sheetRows: 2 }); raw.sheet_schema.future_schema = { private_extra: PRIVATE };
  raw.form_responses[0].answers.question = { questionId: "question", fileUploadAnswers: { answers: [{ fileId: "fictional-file", fileName: "private.bin", mimeType: "application/octet-stream" }] } };
  raw.sheet_rows[0].cells[1].future_cell = { entire: PRIVATE };
  const f = await prepared(setup(raw));
  assert.deepEqual(f.view.sheet_schema, raw.sheet_schema);
  assert.deepEqual(f.view.form_records.find(record => record.raw.responseId === "response-1").raw, raw.form_responses[0]);
  assert.deepEqual(f.view.sheet_records[0].raw, raw.sheet_rows[0]);
  for (const [kind, schema, record] of [
    ["FORM_SCHEMA", raw.form_schema, f.view.form_records.find(record => record.raw.responseId === "response-1")],
    ["SHEET_SCHEMA", raw.sheet_schema, f.view.sheet_records[0]],
  ]) {
    const schemaDigest = nodeHash("c2-source-review-schema-v1\n" + canonical({ anchor: f.anchor, kind, raw: schema }));
    assert.equal(record.schema_digest, schemaDigest);
    assert.equal(record.content_digest, nodeHash("c2-source-review-record-v1\n" + canonical({ anchor: f.anchor,
      locator: record.locator, schema_digest: schemaDigest, raw: record.raw })));
  }
  const result = await planLocalMappingReview(f.bundle, f.ledgerText, canonical(command(f)), get(f.context), sha);
  assert.equal(JSON.parse(result.derived_text).reviews[0].content_status, "UNSUPPORTED_CONTENT_REMAINS");
  assertControlPrivacy(result);
  const onlySchema = input({ sheetRows: 2 }); onlySchema.sheet_schema.future_schema = { private_extra: PRIVATE };
  const g = await prepared(setup(onlySchema));
  const schemaResult = await planLocalMappingReview(g.bundle, g.ledgerText, canonical(command(g)), get(g.context), sha);
  assert.equal(JSON.parse(schemaResult.derived_text).reviews[0].content_status, "UNSUPPORTED_CONTENT_REMAINS");
});

test("large shared schemas occur once in a bounded complete private view, never once per response", async () => {
  const description = "ONCE_LARGE_SCHEMA_" + "x".repeat(53_000);
  const f = setup(input({ sheetRows: 2, formResponses: 200, schemaDescription: description }));
  const view = await prepareLocalMappingReview(f.bundle, get(f.context), sha);
  assert.equal(view.form_records.length, 200);
  assert.equal(JSON.stringify(view).split("ONCE_LARGE_SCHEMA_").length - 1, 1);
  assert.ok(Buffer.byteLength(canonical(view), "utf8") <= 2_000_000);
  assert.ok(view.form_records.every(record => !Object.hasOwn(record, "schema") && !Object.hasOwn(record, "form_schema")));
  assert.deepEqual(view.form_schema, f.source.form_schema);
});

test("a source within its own limits cannot return an oversized expanded review view", async () => {
  const raw = input({ sheetRows: 1, formResponses: 0 });
  raw.form_responses = Array.from({ length: 4_990 }, (_, index) => ({ responseId: `response-${"x".repeat(100)}-${index}`,
    createTime: "2026-09-30T00:00:00Z", lastSubmittedTime: "2026-10-01T04:02:00Z" }));
  const f = setup(raw);
  assert.ok(Buffer.byteLength(f.bundle.source_input_text) < 2_000_000);
  assert.ok(Buffer.byteLength(f.bundle.source_plan_text) < 2_000_000);
  assert.ok(f.sourcePlan.record_count <= 5_000);
  await rejectSafe(() => prepareLocalMappingReview(f.bundle, get(f.context), sha), "REVIEW_BYTES_EXCEEDED");
});

test("a valid authority-bound ledger can exhaust the output budget only at the next append, with no partial success", async () => {
  const longId = label => `${label}-` + "x".repeat(511 - label.length);
  const longPinned = { ...pinned };
  for (const key of ["source_operation_id", "team_id", "season_id", "backend_generation", "form_id", "spreadsheet_id"])
    longPinned[key] = longId(key);
  const raw = input({ sheetRows: 100, formResponses: 100 });
  raw.form_schema.formId = longPinned.form_id; raw.form_schema.linkedSheetId = longPinned.spreadsheet_id;
  raw.sheet_schema.spreadsheetId = longPinned.spreadsheet_id;
  raw.known_sources[0].form_id = longPinned.form_id;
  raw.form_responses.forEach((row, index) => { row.responseId = longId(`response-${index}`); });
  const f = setup(raw, longPinned); f.context.actor_id = longId("actor");
  f.view = await prepareLocalMappingReview(f.bundle, get(f.context), sha);
  let ledger = initialLedger(f.anchor); let priorText = canonical(ledger); let nextCommand; let overflowingText;
  // These are independently encoded pure evidence fixtures, never storage or authenticated receipts.
  for (let index = 0; index < 100; index++) {
    const cmd = command(f, index + 1, raw.form_responses[index].responseId, longId(`request-${index}`));
    const evidence = { sequence: index + 1, anchor: f.anchor, actor_id: f.context.actor_id, reviewed_at: f.context.reviewed_at,
      command: cmd, command_digest: nodeHash("c2-source-review-command-v1\n" + canonical({ format: "c2-source-mapping-review-v1", anchor: f.anchor, actor_id: f.context.actor_id, command: cmd })),
      prior_ledger_digest: nodeHash("c2-source-review-ledger-v1\n" + priorText),
      form_locator: f.view.form_records.find(record => record.raw.responseId === cmd.response_id).locator,
      sheet_locator: f.view.sheet_records[index].locator, mapping_status: "HUMAN_ATTESTED" };
    assert.ok(Buffer.byteLength(canonical(evidence)) <= 8_000);
    const candidate = { ...ledger, version: index + 1, evidence: [...ledger.evidence, evidence] };
    const candidateText = canonical(candidate);
    if (Buffer.byteLength(candidateText) > 512_000) { nextCommand = cmd; overflowingText = candidateText; break; }
    ledger = candidate; priorText = candidateText;
  }
  assert.ok(nextCommand, "the bounded fixture must reach a real output overflow within 100 decisions");
  assert.ok(ledger.version >= 60 && ledger.version < 100);
  assert.ok(Buffer.byteLength(priorText) <= 512_000 && Buffer.byteLength(overflowingText) > 512_000);
  const ctx = { ...f.context, ledger_version: ledger.version, ledger_digest: nodeHash("c2-source-review-ledger-v1\n" + priorText) };
  // Replay verifies that the old ledger is valid, rather than relying on a malformed input rejection.
  const replay = await planLocalMappingReview(f.bundle, priorText, canonical(ledger.evidence[0].command), get(ctx), sha);
  assert.equal(replay.append_required, false); assert.equal(replay.ledger_text, priorText);
  let returned = false;
  await rejectSafe(async () => { await planLocalMappingReview(f.bundle, priorText, canonical(nextCommand), get(ctx), sha); returned = true; }, "REVIEW_BYTES_EXCEEDED");
  assert.equal(returned, false);
  assert.equal(replay.ledger_text, priorText);
});

test("bundle/context/hash arbitrary failures and malformed inputs always redact private error text", async () => {
  const f = setup(); const privateError = () => { throw new Error(`${PRIVATE} https://private.example.invalid/?token=secret`); };
  for (const bundle of [null, undefined, new Proxy({}, { getPrototypeOf: privateError }), new Proxy({}, { ownKeys: privateError }),
    Object.defineProperty({}, "source_input_text", { enumerable: true, get: privateError }), { ...f.bundle, extra: PRIVATE }])
    await rejectSafe(() => prepareLocalMappingReview(bundle, get(f.context), sha));
  for (const context of [null, undefined, () => null, privateError, () => new Proxy({}, { getPrototypeOf: privateError }),
    () => Object.defineProperty({ ...f.context }, "actor_id", { enumerable: true, get: privateError })])
    await rejectSafe(() => prepareLocalMappingReview(f.bundle, context, sha), "REVIEW_CONTEXT_INVALID");
  for (const hash of [null, undefined, privateError, async () => { throw new SourceModelError(PRIVATE); }, async () => PRIVATE])
    await rejectSafe(() => prepareLocalMappingReview(f.bundle, get(f.context), hash), "REVIEW_HASH_FAILED");
  const g = await prepared(f);
  for (const text of [null, undefined, '{"a":1,"\\u0061":2}', canonical({ ...command(g), why: PRIVATE }), " ".repeat(8_001)])
    await rejectSafe(() => planLocalMappingReview(g.bundle, g.ledgerText, text, get(g.context), sha));
  await rejectSafe(() => planLocalMappingReview(g.bundle, " ".repeat(512_001), canonical(command(g)), get(g.context), sha), "REVIEW_BYTES_EXCEEDED");
});
