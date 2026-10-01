import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const loaded = new Map();
function moduleUrl(url) {
  if (loaded.has(url.href)) return loaded.get(url.href);
  let code = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu, (_, start, path, end) =>
    start + moduleUrl(new URL(path.endsWith(".ts") ? path : `${path}.ts`, url)) + end);
  const result = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  loaded.set(url.href, result);
  return result;
}
const load = file => import(moduleUrl(new URL(file, import.meta.url)));
const { sha256Base64Url: sha } = await load("../cloudflare/src/crypto.ts");
const { buildLocalSourcePlan } = await load("../shared/c2-source-capture-projection.ts");
const { SourceModelError } = await load("../shared/c2-source-capture-contract.ts");
const { REVIEW_DOMAINS, REVIEW_LIMITS, reviewJson, emptyReviewLedger } = await load("../shared/c2-source-mapping-review-contract.ts");
const { prepareLocalMappingReview: prepare, planLocalMappingReview: review } = await load("../shared/c2-source-mapping-review-projection.ts");

const pinned = {
  source_operation_id: "local_review_source", team_id: "local_team", season_id: "local_season",
  binding_version: 1, backend_generation: "local_generation", writer_epoch: 0,
  form_id: "local_form", spreadsheet_id: "local_sheet", sheet_id: 7, season_ends_at: "2026-10-01T04:00:00Z",
};
const response = (id, at = "2026-10-01T03:59:59.999999999Z") => ({
  responseId: id, createTime: at, lastSubmittedTime: "2026-10-01T04:01:00Z",
  answers: { question: { questionId: "question", textAnswers: { answers: [{ value: `Private 😀 ${id}` }] } } },
});
function fixture() {
  return {
    format: "c2-source-input-v1", observed_start_at: "2026-10-01T04:01:00Z", observed_end_at: "2026-10-01T04:02:00Z",
    form_schema: { formId: pinned.form_id, info: { title: "Private form" }, items: [
      { itemId: "item", questionItem: { question: { questionId: "question", textQuestion: {} } } },
    ] },
    form_responses: [response("first"), response("second"), response("late", pinned.season_ends_at)],
    sheet_schema: { spreadsheetId: pinned.spreadsheet_id, sheetId: 7, title: "Private sheet", locale: "en_US",
      timeZone: "America/New_York", rowCount: 3, columnCount: 1, headerRowIndex: 0, headers: [{ formattedValue: "Name" }] },
    sheet_rows: [{ row_index: 1, cells: [{ userEnteredValue: { stringValue: "Sheet original one" } }] },
      { row_index: 2, cells: [{ userEnteredValue: { numberValue: 1.25 }, formattedValue: "1.25" }] }],
    known_sources: [{ kind: "FORM_RESPONSE", form_id: pinned.form_id, response_id: "missing", status: "REVIEW_REQUIRED" }],
    declared_mappings: [],
  };
}
async function setup(source = fixture()) {
  const input = JSON.stringify(source);
  const sourcePlan = buildLocalSourcePlan(input, pinned);
  const sourceDigest = await sha(REVIEW_DOMAINS.source + sourcePlan.canonical_text);
  const anchor = { source: structuredClone(pinned), source_plan_digest: sourceDigest,
    local_snapshot_id: `LOCAL_INPUT_${sourceDigest}`, provenance: "LOCAL_INPUT_DECLARATIONS_ONLY" };
  const ledgerText = reviewJson(emptyReviewLedger(anchor));
  const context = { source: structuredClone(pinned), actor_id: "local_coach", permission_scope: "COACH_SOURCE_MAPPING_REVIEW",
    reviewed_at: "2026-10-01T04:03:00Z", source_plan_digest: sourceDigest, local_snapshot_id: anchor.local_snapshot_id,
    ledger_version: 0, ledger_digest: await sha(REVIEW_DOMAINS.ledger + ledgerText) };
  const bundle = { source_input_text: input, source_plan_text: sourcePlan.canonical_text };
  const getContext = () => structuredClone(context);
  const view = await prepare(bundle, getContext, sha);
  return { source, sourcePlan, bundle, context, getContext, view, ledgerText };
}
function command(s, row = 1, responseId = "first", requestId = "review_one") {
  return { request_id: requestId, local_snapshot_id: s.view.anchor.local_snapshot_id, row_index: row, response_id: responseId,
    expected_sheet_digest: s.view.sheet_records.find(record => record.raw.row_index === row).content_digest,
    expected_form_digest: s.view.form_records.find(record => record.raw.responseId === responseId).content_digest,
    decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" };
}
const run = (s, cmd = command(s), ledger = s.ledgerText, hash = sha) =>
  review(s.bundle, ledger, JSON.stringify(cmd), s.getContext, hash);
async function adopt(s, result) {
  s.ledgerText = result.ledger_text;
  s.context.ledger_version = JSON.parse(result.ledger_text).version;
  s.context.ledger_digest = result.ledger_digest;
  s.context.reviewed_at = "2026-10-01T04:04:00Z";
}
async function rejects(promise, code) {
  await assert.rejects(promise, error => error instanceof SourceModelError && error.code === code &&
    error.message === "Source input is unsupported or inconsistent.");
}

test("real SHA256 matches an independent UTF8/base64url vector and full record domain bytes", async () => {
  assert.equal(await sha("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  const s = await setup();
  const record = s.view.form_records[0];
  const bytes = REVIEW_DOMAINS.record + reviewJson({ anchor: s.view.anchor, locator: record.locator,
    schema_digest: record.schema_digest, raw: record.raw });
  assert.equal(record.content_digest, createHash("sha256").update(bytes, "utf8").digest("base64url"));
  const schemaBytes = REVIEW_DOMAINS.schema + reviewJson({ anchor: s.view.anchor, kind: "FORM_SCHEMA", raw: s.source.form_schema });
  assert.equal(s.view.form_schema_digest, createHash("sha256").update(schemaBytes, "utf8").digest("base64url"));
});

test("private view contains each complete schema once, whole selected raw, and no invented fixed/authenticated status", async () => {
  const s = await setup();
  assert.deepEqual(s.view.form_schema, s.source.form_schema);
  assert.deepEqual(s.view.sheet_schema, s.source.sheet_schema);
  assert.deepEqual(s.view.form_records.map(record => record.raw), s.source.form_responses.slice(0, 2));
  assert.deepEqual(s.view.sheet_records.map(record => record.raw), s.source.sheet_rows);
  assert.equal(s.view.state, "LOCAL_REVIEW_PLAN_ONLY");
  assert.equal(s.view.source_status, "SOURCE_NOT_VERIFIED");
  assert.ok(s.view.anchor.local_snapshot_id.startsWith("LOCAL_INPUT_"));
  assert.ok(s.view.form_records.every(record => !Object.hasOwn(record, "form_schema")));
  assert.ok(Buffer.byteLength(reviewJson(s.view), "utf8") <= REVIEW_LIMITS.view_bytes);
  assert.ok(!Object.hasOwn(s.view, "receipt") && !Object.hasOwn(s.view, "authenticated"));
});

test("whole plan exact validation rejects even unselected chunk, schema, counts and gap modifications", async () => {
  const s = await setup();
  const original = JSON.parse(s.bundle.source_plan_text);
  for (const mutate of [plan => plan.chunks.pop(), plan => plan.chunks.reverse(), plan => plan.record_count++,
    plan => plan.chunks[0].utf8_bytes++, plan => plan.namespace_counts.GAP_LEDGER++,
    plan => { const chunk = plan.chunks.find(row => row.namespace === "GAP_LEDGER"); chunk.payload_text = "{}"; }]) {
    const plan = structuredClone(original);
    mutate(plan);
    await rejects(prepare({ ...s.bundle, source_plan_text: reviewJson(plan) }, s.getContext, sha), "REVIEW_SOURCE_PLAN_MISMATCH");
  }
  const changedInput = structuredClone(s.source);
  changedInput.sheet_rows[1].cells[0].formattedValue = "Changed unselected raw";
  await rejects(prepare({ ...s.bundle, source_input_text: JSON.stringify(changedInput) }, s.getContext, sha), "REVIEW_SOURCE_PLAN_MISMATCH");
});

test("server source and ledger hashes are independent anchors, not hashes supplied by commands", async () => {
  const s = await setup();
  s.context.source_plan_digest = "A".repeat(43);
  s.context.local_snapshot_id = `LOCAL_INPUT_${s.context.source_plan_digest}`;
  await rejects(prepare(s.bundle, s.getContext, sha), "REVIEW_SOURCE_ANCHOR_MISMATCH");
  const valid = await setup();
  valid.context.ledger_digest = "A".repeat(43);
  await rejects(run(valid), "REVIEW_LEDGER_ANCHOR_MISMATCH");
});

test("one explicit Coach attestation produces only control references and leaves every source gap and Sheet pending unchanged", async () => {
  const s = await setup();
  const oldPlan = s.bundle.source_plan_text;
  const result = await run(s);
  const evidence = JSON.parse(result.evidence_text);
  const derived = JSON.parse(result.derived_text);
  assert.equal(result.append_required, true);
  assert.equal(evidence.mapping_status, "HUMAN_ATTESTED");
  assert.equal(evidence.actor_id, s.context.actor_id);
  assert.equal(derived.annual_export_authorized, false);
  assert.equal(derived.reviews[0].submission_scope, "BEFORE_CUTOFF");
  assert.equal(derived.source_status, "SOURCE_NOT_VERIFIED");
  assert.equal(derived.source_evidence_condition_count, s.sourcePlan.namespace_counts.GAP_LEDGER);
  assert.equal(derived.unreviewed_sheet_rows, 1);
  const text = JSON.stringify(result);
  for (const raw of ["Private 😀 first", "Sheet original one", "Private form", "Name"])
    assert.ok(!text.includes(raw), "control output must not contain raw values");
  assert.equal(s.bundle.source_plan_text, oldPlan);
  assert.equal(s.sourcePlan.namespace_counts.SHEET_CURRENT, 0);
});

test("later append keeps earlier evidence bytes; original request replays its original derived prefix and timestamp", async () => {
  const s = await setup();
  const firstCommand = command(s);
  const first = await run(s, firstCommand);
  await adopt(s, first);
  const second = await run(s, command(s, 2, "second", "review_two"));
  assert.equal(reviewJson(JSON.parse(second.ledger_text).evidence[0]), first.evidence_text);
  await adopt(s, second);
  s.context.reviewed_at = "2026-10-01T04:03:00Z"; // Original A clock, despite B having been appended at T2.
  const replay = await run(s, firstCommand);
  assert.equal(replay.append_required, false);
  assert.equal(replay.ledger_text, second.ledger_text);
  assert.equal(replay.evidence_text, first.evidence_text);
  assert.equal(replay.derived_text, first.derived_text);
  assert.equal(replay.expected_ledger_version, 2);
});

test("same request changed decision and one-to-one duplicate links reject without replacement or alias writes", async () => {
  const s = await setup();
  const first = await run(s);
  await adopt(s, first);
  await rejects(run(s, { ...command(s), reason: "DIRECT_KNOWLEDGE_OF_SUBMISSION" }), "REVIEW_IDEMPOTENCY_CONFLICT");
  await rejects(run(s, command(s, 1, "first", "new_same")), "REVIEW_DUPLICATE_DECISION");
  await rejects(run(s, command(s, 2, "first", "duplicate_response")), "REVIEW_DUPLICATE_DECISION");
  await rejects(run(s, command(s, 1, "second", "duplicate_row")), "REVIEW_DUPLICATE_DECISION");
  assert.equal(s.ledgerText, first.ledger_text);
});

test("ledger full semantic validation rejects forged past chain, locator, count, time and command despite self-consistent external hash", async () => {
  const s = await setup();
  const first = await run(s);
  await adopt(s, first);
  const original = JSON.parse(first.ledger_text);
  const cases = [
    [ledger => ledger.version++, "REVIEW_LEDGER_COUNT_INVALID"],
    [ledger => ledger.evidence[0].sequence++, "REVIEW_LEDGER_SEQUENCE_INVALID"],
    [ledger => ledger.evidence[0].prior_ledger_digest = "A".repeat(43), "REVIEW_LEDGER_CHAIN_INVALID"],
    [ledger => ledger.evidence[0].form_locator.record_offset++, "REVIEW_LOCATOR_INVALID"],
    [ledger => ledger.evidence[0].command.reason = "DIRECT_KNOWLEDGE_OF_SUBMISSION", "REVIEW_COMMAND_CHANGED"],
    [ledger => ledger.evidence[0].reviewed_at = "invalid-timestamp", "INVALID_TIMESTAMP"],
  ];
  for (const [mutate, code] of cases) {
    const corrupt = structuredClone(original);
    mutate(corrupt);
    const text = reviewJson(corrupt);
    s.context.ledger_version = corrupt.version;
    s.context.ledger_digest = await sha(REVIEW_DOMAINS.ledger + text);
    await rejects(run(s, command(s, 2, "second", "later"), text), code);
  }
});

test("a late identity alone never becomes a full-response hash or reviewed contents", async () => {
  const s = await setup();
  assert.deepEqual(s.view.unreviewable_responses, [{ response_id: "late", code: "FULL_RESPONSE_NOT_AVAILABLE_FOR_REVIEW" }]);
  assert.equal(s.view.form_records.some(record => record.raw.responseId === "late"), false);
  await rejects(run(s, { ...command(s), response_id: "late" }), "FULL_RESPONSE_NOT_AVAILABLE_FOR_REVIEW");
  await rejects(run(s, { ...command(s), response_id: "missing" }), "REVIEW_RECORD_NOT_FOUND");
});

test("nanosecond cutoff and late current edits remain exact, without considering current Sheet timestamp", async () => {
  const source = fixture();
  source.form_responses[0].createTime = "2026-09-30T23:59:59.999999999-04:00";
  source.form_responses[1].createTime = "2026-10-01T04:00:00.000000001Z";
  source.sheet_rows[0].cells[0] = { userEnteredValue: { numberValue: 99999 } };
  const s = await setup(source);
  const result = await run(s);
  assert.equal(JSON.parse(result.derived_text).reviews[0].submission_scope, "BEFORE_CUTOFF");
  assert.equal(s.view.form_records[0].raw.lastSubmittedTime, "2026-10-01T04:01:00Z");
  assert.deepEqual(s.view.unreviewable_responses.map(row => row.response_id), ["second", "late"]);
});

test("unsupported Sheet schema, unknown raw and attachments retain their conditions after attestation", async () => {
  for (const change of [source => source.sheet_schema.futureStyle = { decimal: 1.25 },
    source => source.form_responses[0].futureAnswers = { all: ["private", 1.25] },
    source => source.form_responses[0].answers.question = { questionId: "question", fileUploadAnswers: {
      answers: [{ fileId: "local_file", fileName: "local.txt", mimeType: "text/plain" }],
    } }]) {
    const source = fixture();
    change(source);
    const s = await setup(source);
    const result = await run(s);
    assert.equal(JSON.parse(result.derived_text).reviews[0].content_status, "UNSUPPORTED_CONTENT_REMAINS");
    assert.equal(JSON.parse(result.derived_text).source_evidence_condition_count, s.sourcePlan.namespace_counts.GAP_LEDGER);
    assert.equal(result.source_status, "SOURCE_NOT_VERIFIED");
  }
});

test("fresh authority across an actual SHA await rejects binding, generation, epoch, actor and ledger changes", async () => {
  for (const mutate of [context => context.source.binding_version++, context => context.source.backend_generation = "changed",
    context => context.source.writer_epoch++, context => context.actor_id = "other_actor", context => context.ledger_digest = "A".repeat(43)]) {
    const s = await setup();
    let release;
    let started;
    const ready = new Promise(resolve => started = resolve);
    const gate = new Promise(resolve => release = resolve);
    let calls = 0;
    const hash = async text => {
      if (++calls === 1) { started(); await gate; }
      return sha(text);
    };
    const pending = prepare(s.bundle, s.getContext, hash);
    await ready;
    mutate(s.context);
    release();
    await rejects(pending, "REVIEW_OWNERSHIP_CHANGED");
  }
});

test("the last next-ledger hash await still rechecks authority before returning control", async () => {
  const s = await setup();
  let release;
  let started;
  const ready = new Promise(resolve => started = resolve);
  const gate = new Promise(resolve => release = resolve);
  let newLedgerCalls = 0;
  const hash = async text => {
    if (text.startsWith(REVIEW_DOMAINS.ledger) && JSON.parse(text.slice(REVIEW_DOMAINS.ledger.length)).version === 1) {
      if (++newLedgerCalls === 2) { started(); await gate; }
    }
    return sha(text);
  };
  const pending = run(s, command(s), s.ledgerText, hash);
  await ready;
  s.context.source.writer_epoch++;
  release();
  await rejects(pending, "REVIEW_OWNERSHIP_CHANGED");
  assert.equal(newLedgerCalls, 2);
  assert.equal(JSON.parse(s.ledgerText).version, 0);
});

test("getter, hash dependency and hostile bundle exceptions never expose private error bodies", async () => {
  const s = await setup();
  await rejects(prepare(s.bundle, () => { throw new Error("private body"); }, sha), "REVIEW_CONTEXT_INVALID");
  await rejects(prepare(s.bundle, s.getContext, async () => { throw new Error("private body"); }), "REVIEW_HASH_FAILED");
  await rejects(prepare(new Proxy({}, { getPrototypeOf() { throw new Error("private body"); } }), s.getContext, sha), "REVIEW_BUNDLE_INVALID");
  let accessed = 0;
  const getterBundle = { get source_input_text() { accessed++; throw new Error("private body"); }, source_plan_text: s.bundle.source_plan_text };
  await rejects(prepare(getterBundle, s.getContext, sha), "REVIEW_BUNDLE_INVALID");
  assert.equal(accessed, 0);
  await rejects(prepare({ ...s.bundle, raw: "not allowed" }, s.getContext, sha), "REVIEW_BUNDLE_INVALID");
});

test("raw command duplicate keys, forged caller fields, free reasons and changed hashes are rejected", async () => {
  const s = await setup();
  const cmd = command(s);
  for (const extra of [{ actor_id: "fake" }, { reviewed_at: "2099-01-01T00:00:00Z" }, { authenticated: true }, { why: "private answer" }, { submission_cutoff_at: "2099" }])
    await rejects(run(s, { ...cmd, ...extra }), "UNEXPECTED_INPUT_FIELD");
  await rejects(run(s, { ...cmd, reason: "Free text private" }), "REVIEW_REASON_INVALID");
  await rejects(run(s, { ...cmd, expected_sheet_digest: "A".repeat(43) }), "REVIEW_CONTENT_CHANGED");
  const duplicate = JSON.stringify(cmd).replace('{', '{"request_id":"duplicate",');
  await rejects(review(s.bundle, s.ledgerText, duplicate, s.getContext, sha), "DUPLICATE_JSON_KEY");
});

test("bytes fail before dependency work; two concurrent local plans carry the same base instead of claiming atomic commit", async () => {
  const s = await setup();
  let calls = 0;
  const hash = async text => { calls++; return sha(text); };
  await rejects(review(s.bundle, "x".repeat(REVIEW_LIMITS.ledger_bytes + 1), "{}", s.getContext, hash), "REVIEW_BYTES_EXCEEDED");
  assert.equal(calls, 0);
  await rejects(prepare({ ...s.bundle, source_plan_text: "x".repeat(REVIEW_LIMITS.input_bytes + 1) }, s.getContext, hash), "REVIEW_BYTES_EXCEEDED");
  assert.equal(calls, 0);
  const [a, b] = await Promise.all([run(s), run(s, command(s, 2, "second", "concurrent"))]);
  assert.equal(a.expected_ledger_version, 0);
  assert.equal(b.expected_ledger_version, 0);
  assert.equal(a.expected_ledger_digest, b.expected_ledger_digest);
  assert.notEqual(a.ledger_digest, b.ledger_digest);
  assert.equal(a.state, "LOCAL_REVIEW_PLAN_ONLY");
  assert.equal(b.source_status, "SOURCE_NOT_VERIFIED");
});
