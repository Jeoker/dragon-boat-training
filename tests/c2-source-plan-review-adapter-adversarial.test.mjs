import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Independent loader, fixture construction, canonical encoder and SHA oracle.
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
const { prepareLocalMappingReviewFromPlan, planLocalMappingReviewFromPlan } = await import(moduleUrl(new URL("../shared/c2-source-plan-review-adapter.ts", import.meta.url)));
const { SourceModelError } = await import(moduleUrl(new URL("../shared/c2-source-capture-contract.ts", import.meta.url)));
const golden = JSON.parse(readFileSync(new URL("fixtures/c2-source-plan-review-v1/goldens.json", import.meta.url), "utf8"));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const nodeHash = text => createHash("sha256").update(text, "utf8").digest("base64url");
const sha = async text => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url");
const bytes = text => Buffer.byteLength(text, "utf8");
const get = value => () => value;
const PRIVATE = "PRIVATE_ADAPTER_RAW_AND_ERROR_😀";
const pinned = {
  source_operation_id: "adapter-attack-source", team_id: "fictional-team", season_id: "fictional-season",
  binding_version: 1, backend_generation: "fictional-generation", writer_epoch: 0,
  form_id: "fictional-form", spreadsheet_id: "fictional-sheet", sheet_id: 31,
  season_ends_at: "2026-10-01T04:00:00Z",
};
const cell = value => ({ userEnteredValue: { stringValue: value }, effectiveValue: { stringValue: value } });
const response = (id, time = "2026-09-30T23:59:59.999999999-04:00") => ({
  responseId: id, createTime: time, lastSubmittedTime: "2026-10-01T04:02:00Z",
  answers: { q: { questionId: "q", textAnswers: { answers: [{ value: PRIVATE }] } } },
});
function input({ rows = 103, responses = 2 } = {}) {
  return {
    format: "c2-source-input-v1", observed_start_at: "2026-10-01T04:02:00Z", observed_end_at: "2026-10-01T04:03:00Z",
    form_schema: { formId: pinned.form_id, linkedSheetId: pinned.spreadsheet_id,
      info: { title: "Fixture", description: "ONCE_ADAPTER_SCHEMA" },
      items: [{ itemId: "item", questionItem: { question: { questionId: "q", textQuestion: {} } } }] },
    form_responses: Array.from({ length: responses }, (_, index) => response(`response-${index + 1}`)),
    sheet_schema: { spreadsheetId: pinned.spreadsheet_id, sheetId: pinned.sheet_id, title: "Responses", locale: "en_US",
      timeZone: "America/New_York", rowCount: rows + 1, columnCount: 1, headerRowIndex: 0, headers: [cell("Answer")] },
    sheet_rows: Array.from({ length: rows }, (_, index) => ({ row_index: index + 1, cells: [cell(`${PRIVATE}_${index}`)] })),
    known_sources: [{ kind: "FORM_RESPONSE", form_id: pinned.form_id, response_id: "known-not-observed", status: "REVIEW_REQUIRED" }],
    declared_mappings: [],
  };
}
function emptyLedger(anchor) {
  return { format: "c2-source-mapping-ledger-v1", state: "LOCAL_REVIEW_PLAN_ONLY", source_status: "SOURCE_NOT_VERIFIED",
    anchor, version: 0, evidence: [] };
}
function setup(raw = input(), source = pinned) {
  const source_input_text = JSON.stringify(raw);
  const plan = buildLocalSourcePlan(source_input_text, source);
  const source_plan_digest = nodeHash("c2-source-review-source-v1\n" + plan.canonical_text);
  const anchor = { source: structuredClone(source), source_plan_digest, local_snapshot_id: `LOCAL_INPUT_${source_plan_digest}`,
    provenance: "LOCAL_INPUT_DECLARATIONS_ONLY" };
  const ledgerText = canonical(emptyLedger(anchor));
  const context = { source: structuredClone(source), actor_id: "fictional-coach", permission_scope: "COACH_SOURCE_MAPPING_REVIEW",
    reviewed_at: "2026-10-01T04:04:00Z", source_plan_digest, local_snapshot_id: anchor.local_snapshot_id,
    ledger_version: 0, ledger_digest: nodeHash("c2-source-review-ledger-v1\n" + ledgerText) };
  return { raw, plan, anchor, ledgerText, context, bundle: { source_input_text, source_plan_text: plan.canonical_text } };
}
async function prepared(f = setup()) {
  const wrapper = await prepareLocalMappingReviewFromPlan(f.plan.canonical_text, get(f.context), sha);
  return { ...f, view: wrapper.result };
}
function command(f, row = 1, id = "response-1", request = "adapter-request-A") {
  return { request_id: request, local_snapshot_id: f.context.local_snapshot_id, row_index: row, response_id: id,
    expected_sheet_digest: f.view.sheet_records.find(record => record.raw.row_index === row).content_digest,
    expected_form_digest: f.view.form_records.find(record => record.raw.responseId === id).content_digest,
    decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" };
}
const advance = (context, result, time = "2026-10-01T04:05:00Z") => ({ ...context,
  ledger_version: JSON.parse(result.ledger_text).version, ledger_digest: result.ledger_digest, reviewed_at: time });
async function rejectSafe(operation, codes) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof SourceModelError);
    assert.equal(error.message, "Source input is unsupported or inconsistent.");
    assert.ok(!JSON.stringify({ code: error.code, message: error.message }).includes(PRIVATE));
    if (codes) assert.ok(codes.includes(error.code), error.code);
    return true;
  });
}
function privacy(result) {
  const text = canonical(result);
  assert.ok(!text.includes(PRIVATE));
  assert.ok(!text.includes("ONCE_ADAPTER_SCHEMA"));
  assert.ok(!text.includes("RETAINED_PLAN_ONLY"));
  assert.equal(result.source_status, "SOURCE_NOT_VERIFIED");
  const derived = JSON.parse(result.derived_text);
  assert.equal(derived.annual_export_authorized, false);
  assert.equal(derived.source_status, "SOURCE_NOT_VERIFIED");
}

test("independent fixed old 705 review oracle preserves all six views and fifteen plans without mode in hashes", async () => {
  assert.ok(golden.oracle_revision.startsWith("705cc9d"));
  assert.equal(golden.cases.length, 6);
  let count = 0;
  for (const fixture of golden.cases) {
    assert.equal(nodeHash(fixture.view_text), fixture.view_sha256);
    const wrapper = await prepareLocalMappingReviewFromPlan(fixture.bundle.source_plan_text, get(fixture.context), sha);
    assert.equal(wrapper.validation_mode, "RETAINED_PLAN_ONLY");
    assert.equal(canonical(wrapper.result), fixture.view_text);
    assert.ok(!Object.hasOwn(wrapper.result, "validation_mode"));
    for (const plan of fixture.plans) {
      assert.equal(nodeHash(plan.result_text), plan.result_sha256);
      const result = await planLocalMappingReviewFromPlan(fixture.bundle.source_plan_text, plan.prior_ledger_text,
        plan.command_text, get(plan.context), sha);
      assert.equal(canonical(result.result), plan.result_text);
      assert.equal(nodeHash(result.result.evidence_text), plan.evidence_sha256);
      assert.equal(nodeHash(result.result.derived_text), plan.derived_sha256);
      count++;
    }
  }
  assert.equal(count, 15);
});

test("both public core-only entrances reject caller proofs, missing text and local views", async () => {
  const f = await prepared();
  for (const fake of [null, undefined, {}, { validated: true }, { private_collection: {} }, f.view, f.bundle]) {
    await rejectSafe(() => prepareLocalMappingReviewFromPlan(fake, get(f.context), sha));
    await rejectSafe(() => planLocalMappingReviewFromPlan(fake, f.ledgerText, canonical(command(f)), get(f.context), sha));
  }
});

test("every call verifies unselected chunks and independent original SHA, including ledger replay", async () => {
  const f = await prepared();
  const first = (await planLocalMappingReviewFromPlan(f.plan.canonical_text, f.ledgerText, canonical(command(f)), get(f.context), sha)).result;
  const ctx = advance(f.context, first);
  for (const mutate of [
    core => { core.chunks.splice(core.chunks.findLastIndex(chunk => chunk.namespace === "PRIVATE_PENDING"), 1); },
    core => { core.chunks = core.chunks.filter(chunk => chunk.namespace !== "GAP_LEDGER"); },
    core => { const chunk = core.chunks.findLast(chunk => chunk.namespace === "PRIVATE_PENDING");
      const payload = JSON.parse(chunk.payload_text); delete payload.records.at(-1).raw.cells;
      chunk.payload_text = canonical(payload); chunk.utf8_bytes = bytes(chunk.payload_text); },
  ]) {
    const core = JSON.parse(f.plan.canonical_text); mutate(core); const text = canonical(core);
    await rejectSafe(() => prepareLocalMappingReviewFromPlan(text, get(f.context), sha));
    await rejectSafe(() => planLocalMappingReviewFromPlan(text, first.ledger_text, canonical(command(f)), get(ctx), sha));
  }
  const altered = structuredClone(f.raw); altered.sheet_rows.at(-1).cells[0] = cell("same-width-raw-change");
  const changed = setup(altered);
  await rejectSafe(() => prepareLocalMappingReviewFromPlan(changed.plan.canonical_text, get(f.context), sha), ["PLAN_ORIGINAL_DIGEST_MISMATCH"]);
});

test("original-core SHA fence checks actor, permission, ledger version and digest, snapshot and epoch", async () => {
  const f = setup();
  for (const mutate of [
    ctx => ({ ...ctx, actor_id: "other-coach" }),
    ctx => ({ ...ctx, permission_scope: "NOT_COACH" }),
    ctx => ({ ...ctx, ledger_version: 1 }),
    ctx => ({ ...ctx, ledger_digest: "A".repeat(43) }),
    ctx => ({ ...ctx, local_snapshot_id: "LOCAL_INPUT_" + "B".repeat(43) }),
    ctx => ({ ...ctx, source: { ...ctx.source, writer_epoch: 1 } }),
  ]) {
    let current = structuredClone(f.context); let reached; let release;
    const hit = new Promise(resolve => { reached = resolve; }); const wait = new Promise(resolve => { release = resolve; });
    let held = false;
    const work = prepareLocalMappingReviewFromPlan(f.plan.canonical_text, () => current, async text => {
      if (!held && text.startsWith("c2-source-review-source-v1\n")) { held = true; reached(); await wait; }
      return sha(text);
    });
    await hit; current = mutate(current); release();
    await rejectSafe(() => work);
  }
});

test("the final next-ledger SHA checks complete review context after the last await", async () => {
  const f = await prepared();
  for (const mutate of [ctx => ({ ...ctx, actor_id: "other" }), ctx => ({ ...ctx, ledger_digest: "B".repeat(43) })]) {
    let current = structuredClone(f.context); let reached; let release; let nextLedgerCalls = 0;
    const hit = new Promise(resolve => { reached = resolve; }); const wait = new Promise(resolve => { release = resolve; });
    const work = planLocalMappingReviewFromPlan(f.plan.canonical_text, f.ledgerText, canonical(command(f)), () => current, async text => {
      if (text.startsWith("c2-source-review-ledger-v1\n") && JSON.parse(text.slice("c2-source-review-ledger-v1\n".length)).version === 1) {
        nextLedgerCalls++;
        if (nextLedgerCalls === 2) { reached(); await wait; }
      }
      return sha(text);
    });
    await hit; current = mutate(current); release();
    await rejectSafe(() => work, ["REVIEW_OWNERSHIP_CHANGED"]);
    assert.equal(nextLedgerCalls, 2);
  }
});

test("advancing fresh clocks do not change the first captured evidence time", async () => {
  const f = await prepared(); let reads = 0;
  const result = (await planLocalMappingReviewFromPlan(f.plan.canonical_text, f.ledgerText, canonical(command(f)), () => {
    reads++; return { ...f.context, reviewed_at: reads === 1 ? f.context.reviewed_at : "2026-10-01T04:06:00Z" };
  }, sha)).result;
  assert.ok(reads >= 3);
  assert.equal(JSON.parse(result.evidence_text).reviewed_at, f.context.reviewed_at);
  privacy(result);
});

test("both directions preserve old T1 evidence and prefix after a later T2 append", async () => {
  const f = await prepared(); const A = canonical(command(f)); const B = canonical(command(f, 103, "response-2", "adapter-request-B"));
  for (const direction of ["OLD_NEW", "NEW_OLD"]) {
    const first = direction === "OLD_NEW"
      ? await planLocalMappingReview(f.bundle, f.ledgerText, A, get(f.context), sha)
      : (await planLocalMappingReviewFromPlan(f.plan.canonical_text, f.ledgerText, A, get(f.context), sha)).result;
    const ctx1 = advance(f.context, first);
    const second = direction === "OLD_NEW"
      ? (await planLocalMappingReviewFromPlan(f.plan.canonical_text, first.ledger_text, B, get(ctx1), sha)).result
      : await planLocalMappingReview(f.bundle, first.ledger_text, B, get(ctx1), sha);
    const ctx2 = advance(ctx1, second, f.context.reviewed_at);
    const replayNew = (await planLocalMappingReviewFromPlan(f.plan.canonical_text, second.ledger_text, A, get(ctx2), sha)).result;
    const replayOld = await planLocalMappingReview(f.bundle, second.ledger_text, A, get(ctx2), sha);
    assert.deepEqual(replayNew, replayOld);
    assert.equal(replayNew.append_required, false);
    assert.equal(replayNew.ledger_text, second.ledger_text);
    assert.equal(replayNew.evidence_text, first.evidence_text);
    assert.equal(replayNew.derived_text, first.derived_text);
    assert.equal(JSON.parse(replayNew.evidence_text).reviewed_at, f.context.reviewed_at);
    assert.equal(JSON.parse(replayNew.derived_text).ledger_version, 1);
    await rejectSafe(() => planLocalMappingReviewFromPlan(f.plan.canonical_text, second.ledger_text,
      canonical({ ...command(f), reason: "DIRECT_KNOWLEDGE_OF_SUBMISSION" }), get(ctx2), sha), ["REVIEW_IDEMPOTENCY_CONFLICT"]);
    const tampered = JSON.parse(second.ledger_text); tampered.evidence[0].reviewed_at = "2026-10-01T04:04:01Z";
    await rejectSafe(() => planLocalMappingReviewFromPlan(f.plan.canonical_text, canonical(tampered), A, get(ctx2), sha), ["REVIEW_LEDGER_ANCHOR_MISMATCH"]);
    privacy(first); privacy(second); privacy(replayNew);
  }
});

test("complete raw hashes, once-only schemas and cross-chunk offsets use original locator bytes", async () => {
  const f = await prepared();
  const old = await prepareLocalMappingReview(f.bundle, get(f.context), sha);
  assert.deepEqual(f.view, old);
  assert.equal(canonical(f.view).split("ONCE_ADAPTER_SCHEMA").length - 1, 1);
  assert.equal(f.view.form_records.length, 2); assert.equal(f.view.sheet_records.length, 103);
  for (const record of [f.view.form_records[0], f.view.sheet_records.at(-1)]) {
    const type = record.locator.record_type === "FORM_RESPONSE" ? "FORM_SCHEMA" : "SHEET_SCHEMA";
    const schema = type === "FORM_SCHEMA" ? f.raw.form_schema : f.raw.sheet_schema;
    const expectedSchema = nodeHash("c2-source-review-schema-v1\n" + canonical({ anchor: f.anchor, kind: type, raw: schema }));
    assert.equal(record.schema_digest, expectedSchema);
    assert.equal(record.content_digest, nodeHash("c2-source-review-record-v1\n" + canonical({ anchor: f.anchor,
      locator: record.locator, schema_digest: expectedSchema, raw: record.raw })));
    assert.ok(!Object.hasOwn(record, "schema"));
  }
  const last = f.view.sheet_records.at(-1);
  assert.ok(last.locator.chunk_index > 0);
  const chunk = f.plan.chunks.find(c => c.namespace === last.locator.namespace && c.chunk_index === last.locator.chunk_index);
  const index = JSON.parse(chunk.payload_text).records.findIndex(row => row.raw?.row_index === 103);
  assert.equal(last.locator.record_offset, chunk.row_offset + index);
});

test("nanosecond late identities stay unreviewable and current edits retain unsupported fields and all conditions", async () => {
  const raw = input({ rows: 3 }); raw.sheet_schema.future_schema = { full: PRIVATE };
  raw.form_responses[0].future = { full: PRIVATE };
  raw.form_responses.push(response("at-cutoff", "2026-10-01T04:00:00.000000000Z"),
    response("after-cutoff", "2026-10-01T00:00:00.000000001-04:00"));
  const f = await prepared(setup(raw));
  assert.deepEqual(f.view.form_records.find(row => row.raw.responseId === "response-1").raw, raw.form_responses[0]);
  assert.deepEqual(f.view.sheet_schema, raw.sheet_schema);
  assert.ok(f.view.sheet_records.every(row => row.unsupported));
  assert.deepEqual(f.view.unreviewable_responses.map(row => row.response_id), ["at-cutoff", "after-cutoff"]);
  for (const id of ["at-cutoff", "after-cutoff"]) await rejectSafe(() => planLocalMappingReviewFromPlan(f.plan.canonical_text,
    f.ledgerText, canonical({ ...command(f), response_id: id }), get(f.context), sha), ["FULL_RESPONSE_NOT_AVAILABLE_FOR_REVIEW"]);
  const result = (await planLocalMappingReviewFromPlan(f.plan.canonical_text, f.ledgerText, canonical(command(f)), get(f.context), sha)).result;
  const derived = JSON.parse(result.derived_text);
  assert.equal(derived.reviews[0].content_status, "UNSUPPORTED_CONTENT_REMAINS");
  assert.equal(derived.reviews[0].submission_scope, "BEFORE_CUTOFF");
  const conditions = f.plan.chunks.filter(c => c.namespace === "GAP_LEDGER").flatMap(c => JSON.parse(c.payload_text).records);
  assert.equal(derived.source_evidence_condition_count, conditions.length);
  assert.equal(derived.source_evidence_condition_digest, nodeHash("c2-source-review-gaps-v1\n" + canonical({ anchor: f.anchor, conditions })));
  assert.equal(f.plan.namespace_counts.SHEET_CURRENT, 0);
  privacy(result);
});

test("arbitrary dependencies and hostile public inputs always redact fixed errors", async () => {
  const f = await prepared(); const explode = () => { throw new Error(`${PRIVATE} https://private.invalid/?token=secret`); };
  for (const ctx of [null, undefined, explode, () => null, () => new Proxy({}, { getPrototypeOf: explode }),
    () => Object.defineProperty({ ...f.context }, "actor_id", { enumerable: true, get: explode })]) {
    await rejectSafe(() => prepareLocalMappingReviewFromPlan(f.plan.canonical_text, ctx, sha));
  }
  for (const hash of [null, undefined, explode, async () => { throw new SourceModelError(PRIVATE); }, async () => PRIVATE]) {
    await rejectSafe(() => prepareLocalMappingReviewFromPlan(f.plan.canonical_text, get(f.context), hash));
  }
  for (const text of ['{"a":1,"\\u0061":2}', "{} trailing", " ".repeat(2_000_001)]) {
    await rejectSafe(() => prepareLocalMappingReviewFromPlan(text, get(f.context), sha));
  }
  await rejectSafe(() => planLocalMappingReviewFromPlan(f.plan.canonical_text, f.ledgerText,
    canonical({ ...command(f), actor_id: PRIVATE }), get(f.context), sha));
});

test("a valid old inner view below 2MB fails only when the new private wrapper exceeds 2MB", async () => {
  const raw = input({ rows: 0, responses: 0 }); raw.known_sources = [];
  raw.form_responses = Array.from({ length: 4_000 }, (_, index) => ({ responseId: `response-${"x".repeat(100)}-${index}`,
    createTime: "2026-09-30T00:00:00Z", lastSubmittedTime: "2026-10-01T04:02:00Z", respondentEmail: "" }));
  const base = setup(raw);
  const baseView = await prepareLocalMappingReview(base.bundle, get(base.context), sha);
  const padding = 1_999_999 - bytes(canonical(baseView));
  assert.ok(padding > 0 && padding < 1_000_000, "bounded known-field padding must be sufficient");
  let left = padding;
  for (let index = 0; left > 0; index++) {
    const length = Math.min(left, 50_000); raw.form_responses[index].respondentEmail = "p".repeat(length); left -= length;
  }
  const f = setup(raw);
  assert.ok(bytes(f.bundle.source_input_text) <= 2_000_000);
  assert.ok(bytes(f.plan.canonical_text) <= 2_000_000);
  assert.ok(f.plan.record_count <= 5_000);
  const oldView = await prepareLocalMappingReview(f.bundle, get(f.context), sha);
  assert.equal(bytes(canonical(oldView)), 1_999_999);
  assert.ok(bytes(canonical({ validation_mode: "RETAINED_PLAN_ONLY", result: oldView })) > 2_000_000);
  let hashCalls = 0;
  await rejectSafe(() => prepareLocalMappingReviewFromPlan(f.plan.canonical_text, get(f.context), async text => {
    hashCalls++; return sha(text);
  }), ["REVIEW_BYTES_EXCEEDED"]);
  // The validator and every candidate hash completed; this is the final wrapper guard.
  assert.equal(hashCalls, raw.form_responses.length + 4);
});

test("a valid anchored ledger replays before a next append exceeds 512KB without partial output", async () => {
  const longId = label => `${label}-` + "x".repeat(511 - label.length);
  const source = { ...pinned };
  for (const key of ["source_operation_id", "team_id", "season_id", "backend_generation", "form_id", "spreadsheet_id"])
    source[key] = longId(key);
  const raw = input({ rows: 100, responses: 100 });
  raw.form_schema.formId = source.form_id; raw.form_schema.linkedSheetId = source.spreadsheet_id;
  raw.sheet_schema.spreadsheetId = source.spreadsheet_id; raw.known_sources = [];
  raw.form_responses.forEach((row, index) => { row.responseId = longId(`response-${index}`); });
  const f = setup(raw, source); f.context.actor_id = longId("actor");
  f.view = (await prepareLocalMappingReviewFromPlan(f.plan.canonical_text, get(f.context), sha)).result;
  let ledger = emptyLedger(f.anchor); let text = canonical(ledger); let next;
  for (let index = 0; index < 100; index++) {
    const cmd = command(f, index + 1, raw.form_responses[index].responseId, longId(`request-${index}`));
    const evidence = { sequence: index + 1, anchor: f.anchor, actor_id: f.context.actor_id, reviewed_at: f.context.reviewed_at,
      command: cmd, command_digest: nodeHash("c2-source-review-command-v1\n" + canonical({ format: "c2-source-mapping-review-v1",
        anchor: f.anchor, actor_id: f.context.actor_id, command: cmd })),
      prior_ledger_digest: nodeHash("c2-source-review-ledger-v1\n" + text),
      form_locator: f.view.form_records[index].locator, sheet_locator: f.view.sheet_records[index].locator,
      mapping_status: "HUMAN_ATTESTED" };
    assert.ok(bytes(canonical(evidence)) <= 8_000);
    const candidate = { ...ledger, version: index + 1, evidence: [...ledger.evidence, evidence] };
    const candidateText = canonical(candidate);
    if (bytes(candidateText) > 512_000) { next = cmd; break; }
    ledger = candidate; text = candidateText;
  }
  assert.ok(next && ledger.version >= 60 && ledger.version < 100);
  const ctx = { ...f.context, ledger_version: ledger.version, ledger_digest: nodeHash("c2-source-review-ledger-v1\n" + text) };
  const replay = (await planLocalMappingReviewFromPlan(f.plan.canonical_text, text,
    canonical(ledger.evidence[0].command), get(ctx), sha)).result;
  assert.equal(replay.append_required, false); assert.equal(replay.ledger_text, text);
  let returned = false;
  await rejectSafe(async () => { await planLocalMappingReviewFromPlan(f.plan.canonical_text, text,
    canonical(next), get(ctx), sha); returned = true; }, ["REVIEW_BYTES_EXCEEDED"]);
  assert.equal(returned, false); assert.equal(replay.ledger_text, text);
  privacy(replay);
});
