import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Independent loader, encoding, hash and malicious-plan assembly. No author-test imports.
const modules = new Map();
function moduleUrl(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  let code = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu, (_, start, path, end) =>
    start + moduleUrl(new URL(path.endsWith(".ts") ? path : `${path}.ts`, url)) + end);
  const result = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  modules.set(url.href, result);
  return result;
}
const { buildLocalSourcePlan } = await import(moduleUrl(new URL("../shared/c2-source-capture-projection.ts", import.meta.url)));
const { SourceModelError } = await import(moduleUrl(new URL("../shared/c2-source-capture-contract.ts", import.meta.url)));
const { prepareLocalMappingReview } = await import(moduleUrl(new URL("../shared/c2-source-mapping-review-projection.ts", import.meta.url)));
const golden = JSON.parse(readFileSync(new URL("fixtures/c2-source-plan-v1/goldens.json", import.meta.url), "utf8"));
const namespaces = ["FORM_CURRENT", "SHEET_CURRENT", "EXCLUDED_IDENTITIES", "PRIVATE_PENDING", "GAP_LEDGER"];
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const bytes = value => Buffer.byteLength(value, "utf8");
const nodeHash = text => createHash("sha256").update(text, "utf8").digest("base64url");
const hexHash = text => createHash("sha256").update(text, "utf8").digest("hex");
const sha = async text => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url");
const digest = text => nodeHash("c2-source-review-source-v1\n" + text);
const clone = value => structuredClone(value);
const PRIVATE = "PRIVATE_SOURCE_VALIDATION_SENTINEL_😀";

function fixture(name = "nano-late-census-mapping-types") {
  const row = golden.cases.find(item => item.name === name);
  assert.ok(row);
  return { pinned: clone(row.pinned), core: JSON.parse(row.core_text), input: JSON.parse(row.input_text), text: row.core_text };
}
function records(core) {
  return Object.fromEntries(namespaces.map(namespace => [namespace,
    core.chunks.filter(chunk => chunk.namespace === namespace).flatMap(chunk => JSON.parse(chunk.payload_text).records)]));
}
function payload(core, namespace, chunk_index, row_offset, rows) {
  return { format: core.format, source_operation_id: JSON.parse(core.metadata_text).pinned_context.source_operation_id,
    namespace, chunk_index, row_offset, records: rows };
}
function descriptor(core, namespace, chunk_index, row_offset, rows) {
  const payload_text = canonical(payload(core, namespace, chunk_index, row_offset, rows));
  return { namespace, chunk_index, row_offset, row_count: rows.length, payload_text, utf8_bytes: bytes(payload_text) };
}
// Deliberately independent assembler: mutations stay byte/count/chunk self-consistent.
function assemble(core, rows) {
  core.chunks = [];
  core.namespace_counts = Object.fromEntries(namespaces.map(namespace => [namespace, rows[namespace].length]));
  core.record_count = Object.values(core.namespace_counts).reduce((sum, count) => sum + count, 0);
  for (const namespace of namespaces) {
    let offset = 0;
    let index = 0;
    while (offset < rows[namespace].length) {
      const block = [];
      while (block.length < 100 && offset + block.length < rows[namespace].length) {
        const candidate = [...block, rows[namespace][offset + block.length]];
        if (bytes(canonical(payload(core, namespace, index, offset, candidate))) > 64_000) break;
        block.push(candidate.at(-1));
      }
      assert.ok(block.length, "fictional mutation must fit a real source chunk");
      core.chunks.push(descriptor(core, namespace, index++, offset, block));
      offset += block.length;
    }
  }
  const metadata = JSON.parse(core.metadata_text);
  metadata.evidence_condition_counts = Object.fromEntries(["SOURCE_GAP", "UNSUPPORTED", "PROOF_REQUIRED", "COVERAGE_LIMIT"]
    .map(kind => [kind, rows.GAP_LEDGER.filter(row => row.classification === kind).length]));
  core.metadata_text = canonical(metadata);
  return canonical(core);
}
function forged(f, mutate) {
  const core = clone(f.core);
  const rows = records(core);
  mutate(rows, core);
  return assemble(core, rows);
}
async function rejectSafe(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof SourceModelError);
    assert.equal(error.message, "Source input is unsupported or inconsistent.");
    assert.ok(!JSON.stringify({ code: error.code, message: error.message }).includes(PRIVATE));
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("independent fixed old-tree golden bytes cover complete core, metadata, chunks and deep raw parent", () => {
  assert.equal(golden.oracle_revision, "8fed6a983ea184164397730620a7cd00d364f855");
  assert.equal(golden.provenance, "FICTIONAL_TEST_ORACLE_ONLY");
  assert.equal(golden.cases.length, 6);
  for (const row of golden.cases) {
    const current = buildLocalSourcePlan(row.input_text, row.pinned);
    assert.equal(current.canonical_text, row.core_text);
    assert.equal(hexHash(current.canonical_text), row.core_sha256);
    assert.equal(hexHash(current.metadata_text), row.metadata_sha256);
    assert.deepEqual(current.chunks.map(chunk => hexHash(chunk.payload_text)), row.chunk_sha256);
    const rebuilt = assemble(JSON.parse(row.core_text), records(JSON.parse(row.core_text)));
    assert.equal(rebuilt, row.core_text, "independent assembler must reproduce the old fixed bytes");
  }
});

// Independently generated by loading commit 705cc9d's review and every relative dependency
// from Git during development. Runtime tests use these fixed SHA bytes, never Git history.
const priorReviewHashes = {
  "nano-late-census-mapping-types": "-lranFatSkL_0FnD2Lcrnc0ff4i87V7mo7fPhD_uuJE",
  "unsupported-schema-raw-attachments": "WnjtkGfQPb3w_8hWBUTubMJ95sC4VlHfeEMw5Vsf35s",
  "cross-namespace-original-interleave": "U968u-ruSJUHP7urEdScz5CDGQ7PwUjDz5W-FehfnWc",
  "multiple-sheet-chunks": "wO7KCZNnFWZj47kBhJPdtM5pNtWQres21V8KZpj7G1Y",
  "omitted-rest-defaults": "oDJntgRrtWXpjhtE9BW7wTUwEADR1N9p9MY0TyoZxaU",
  "raw-parent-depth-32-generated-wrapper": "MxCm4XinLwpyajd9YBdEIwYtOxloOfoBuOnCAZhpM8Q",
};
test("unchanged LOCAL_INPUT review outputs match independently generated pre-refactor fixed SHA oracle", async () => {
  for (const row of golden.cases) {
    const source_plan_digest = digest(row.core_text);
    const context = { source: clone(row.pinned), actor_id: "independent-golden-coach",
      permission_scope: "COACH_SOURCE_MAPPING_REVIEW", reviewed_at: "2026-10-01T04:04:00Z",
      source_plan_digest, local_snapshot_id: `LOCAL_INPUT_${source_plan_digest}`,
      ledger_version: 0, ledger_digest: "A".repeat(43) };
    const view = await prepareLocalMappingReview({ source_input_text: row.input_text, source_plan_text: row.core_text }, () => context, sha);
    assert.equal(nodeHash(canonical(view)), priorReviewHashes[row.name]);
  }
});

let adapter;
async function validate(text, contextPort, hashPort = sha) {
  adapter ??= await import(moduleUrl(new URL("../shared/c2-source-plan-validation-projection.ts", import.meta.url)));
  return adapter.validateLocalSourcePlanCore(text, contextPort, hashPort);
}
function context(f, text = f.text) {
  return { source: clone(f.pinned), source_format: "c2-source-plan-v1", source_plan_digest: digest(text) };
}
const get = value => () => value;
async function rejectReanchored(f, text, code) {
  assert.ok(bytes(text) <= 2_000_000);
  await rejectSafe(() => validate(text, get(context(f, text))), code);
}
function mutateMetadata(text, change) {
  const core = JSON.parse(text);
  const metadata = JSON.parse(core.metadata_text);
  change(metadata);
  core.metadata_text = canonical(metadata);
  return canonical(core);
}

test("complete six old cores validate without original input; excluded answers are never manufactured", async () => {
  assert.equal(await sha("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  for (const row of golden.cases) {
    const f = fixture(row.name);
    const result = await validate(f.text, get(context(f)));
    assert.equal(result.state, "LOCAL_PLAN_VALIDATION_ONLY");
    assert.equal(result.source_status, "SOURCE_NOT_VERIFIED");
    assert.equal(result.control.annual_export_authorized, false);
    assert.equal(result.control.source_plan_digest, digest(f.text));
    assert.deepEqual(result.control.namespace_counts, f.core.namespace_counts);
    assert.equal(result.control.record_count, f.core.record_count);
    assert.equal(result.control.input_bytes_declared, JSON.parse(f.core.metadata_text).input_bytes);
    assert.deepEqual(result.private_collection.metadata, JSON.parse(f.core.metadata_text));
    const expected = records(f.core);
    for (const namespace of namespaces) {
      assert.deepEqual(result.private_collection.records[namespace].map(item => item.record), expected[namespace]);
    }
    for (const item of result.private_collection.records.EXCLUDED_IDENTITIES) {
      assert.ok(!Object.hasOwn(item.record, "raw"));
      assert.ok(!Object.hasOwn(item.record.identity, "answers"));
    }
    assert.equal(result.private_collection.records.SHEET_CURRENT.length, 0);
    assert.ok(!JSON.stringify(result.control).includes('"raw":'));
    assert.ok(!Object.hasOwn(result, "receipt"));
    assert.ok(!Object.hasOwn(result, "canonical_text"));
  }
});

test("independent original SHA forbids self-authorized edits even when namespaces and metadata are coherent", async () => {
  const f = fixture();
  const changed = forged(f, rows => { rows.FORM_CURRENT[1].raw.answers.q.textAnswers.answers[0].value = PRIVATE; });
  await rejectSafe(() => validate(changed, get(context(f))));
  const result = await validate(changed, get(context(f, changed)));
  assert.equal(result.private_collection.records.FORM_CURRENT[1].record.raw.answers.q.textAnswers.answers[0].value, PRIVATE);
  assert.equal(result.source_status, "SOURCE_NOT_VERIFIED");
  for (const key of ["team_id", "season_id", "source_operation_id", "form_id", "spreadsheet_id", "backend_generation"]) {
    const wrong = context(f); wrong.source[key] += "-wrong";
    await rejectSafe(() => validate(f.text, get(wrong)));
  }
  for (const key of ["binding_version", "writer_epoch", "sheet_id"]) {
    const wrong = context(f); wrong.source[key]++;
    await rejectSafe(() => validate(f.text, get(wrong)));
  }
  const wrong = context(f); wrong.source.season_ends_at = "2026-10-01T04:00:00.000000001Z";
  await rejectSafe(() => validate(f.text, get(wrong)));
});

test("self-consistent forged namespace layouts cannot put schema last, interleave phases or qualify Sheet rows", async () => {
  const supported = fixture();
  const mixed = fixture("cross-namespace-original-interleave");
  for (const [f, mutation] of [
    [supported, rows => { rows.FORM_CURRENT.reverse(); }],
    [supported, rows => { rows.FORM_CURRENT.push(clone(rows.FORM_CURRENT[0])); }],
    [supported, rows => { rows.PRIVATE_PENDING.push(rows.PRIVATE_PENDING.shift()); }],
    [supported, rows => { rows.SHEET_CURRENT.push(rows.PRIVATE_PENDING.pop()); }],
    [mixed, rows => { const i = rows.PRIVATE_PENDING.findIndex(row => row.record_type === "SHEET_ROW"); rows.PRIVATE_PENDING.splice(1, 0, rows.PRIVATE_PENDING.splice(i, 1)[0]); }],
  ]) await rejectReanchored(f, forged(f, mutation));
});

test("complete chunk descriptors, canonical payloads and greedy boundaries remain exact under reanchored SHA", async () => {
  const f = fixture("multiple-sheet-chunks");
  for (const mutation of [
    core => { core.chunks.at(-1).row_count--; },
    core => { core.chunks.at(-1).utf8_bytes++; },
    core => { core.chunks.at(-1).row_offset++; },
    core => { core.chunks.at(-1).chunk_index++; },
    core => { core.chunks.at(-1).extra = PRIVATE; },
    core => { const chunk = core.chunks.at(-1); const data = JSON.parse(chunk.payload_text); data.source_operation_id += "-wrong"; chunk.payload_text = canonical(data); chunk.utf8_bytes = bytes(chunk.payload_text); },
    core => { const chunk = core.chunks.at(-1); chunk.payload_text = JSON.stringify(JSON.parse(chunk.payload_text), null, 1); chunk.utf8_bytes = bytes(chunk.payload_text); },
  ]) {
    const core = clone(f.core); mutation(core);
    await rejectReanchored(f, canonical(core));
  }
  const core = clone(f.core);
  const rows = records(core).PRIVATE_PENDING;
  const first = descriptor(core, "PRIVATE_PENDING", 0, 0, rows.slice(0, 50));
  const second = descriptor(core, "PRIVATE_PENDING", 1, 50, rows.slice(50));
  assert.ok(first.utf8_bytes < 64_000 && second.utf8_bytes < 64_000);
  const start = core.chunks.findIndex(chunk => chunk.namespace === "PRIVATE_PENDING");
  core.chunks.splice(start, core.chunks.filter(chunk => chunk.namespace === "PRIVATE_PENDING").length, first, second);
  await rejectReanchored(f, canonical(core));
});

test("reanchored coherent condition counts cannot bleach, reorder, duplicate or misclassify original conditions", async () => {
  const f = fixture("unsupported-schema-raw-attachments");
  for (const mutation of [
    rows => { rows.GAP_LEDGER.shift(); },
    rows => { rows.GAP_LEDGER.reverse(); },
    rows => { rows.GAP_LEDGER.push(clone(rows.GAP_LEDGER.at(-1))); },
    rows => { rows.GAP_LEDGER[0].classification = "SOURCE_GAP"; },
    rows => { rows.GAP_LEDGER.find(row => row.code === "KNOWN_RESPONSE_NOT_OBSERVED").identity.response_id = "changed-census-id"; },
    rows => { rows.PRIVATE_PENDING.find(row => row.record_type === "FORM_RESPONSE").reasons.reverse(); },
    rows => { rows.PRIVATE_PENDING.find(row => row.record_type === "SHEET_SCHEMA").reasons = ["SHEET_SCOPE_UNPROVEN"]; },
  ]) await rejectReanchored(f, forged(f, mutation));
});

test("raw schema, finite cell unions and complete grid remain typed despite a valid independent forged anchor", async () => {
  const f = fixture();
  for (const mutation of [
    rows => { rows.FORM_CURRENT[0].raw.formId = "other-form"; },
    rows => { rows.FORM_CURRENT[0].raw.items[0].questionItem.question.choiceQuestion = { type: "RADIO", options: [] }; },
    rows => { rows.FORM_CURRENT[1].raw.answers.q.questionId = "other-question"; },
    rows => { rows.FORM_CURRENT[1].raw.lastSubmittedTime = "2026-10-01T04:02:00.000000001Z"; },
    rows => { rows.PRIVATE_PENDING[0].raw.headers.pop(); },
    rows => { rows.PRIVATE_PENDING[1].raw.cells.pop(); },
    rows => { rows.PRIVATE_PENDING[1].raw.cells[0].userEnteredValue.stringValue = "second-union-arm"; },
    rows => { rows.PRIVATE_PENDING[1].raw.cells[0].userEnteredValue.numberValue = "not-a-number"; },
    rows => { rows.PRIVATE_PENDING[1].identity.row_index++; },
    rows => { rows.PRIVATE_PENDING[1].raw.row_index++; },
  ]) await rejectReanchored(f, forged(f, mutation));
});

test("all Form namespaces, census and declaration identities share complete uniqueness and scope checks", async () => {
  const f = fixture();
  for (const mutation of [
    rows => { rows.EXCLUDED_IDENTITIES[1].identity.response_id = rows.EXCLUDED_IDENTITIES[0].identity.response_id; },
    rows => { rows.EXCLUDED_IDENTITIES[0].identity.response_id = rows.FORM_CURRENT[1].raw.responseId; },
    rows => { rows.EXCLUDED_IDENTITIES[0].identity.form_id += "-wrong"; },
    rows => { rows.PRIVATE_PENDING[2].declared_mapping.response_id = rows.PRIVATE_PENDING[1].declared_mapping.response_id; },
    rows => { rows.PRIVATE_PENDING[1].declared_mapping.row_index++; },
    rows => { rows.PRIVATE_PENDING[1].declared_mapping.state = "HUMAN_ATTESTED"; },
  ]) await rejectReanchored(f, forged(f, mutation));
  for (const mutation of [
    metadata => { metadata.known_sources.push(clone(metadata.known_sources[0])); },
    metadata => { metadata.known_sources[0].form_id += "-wrong"; },
    metadata => { metadata.known_sources[0].status = "VERIFIED"; },
    metadata => { metadata.known_sources[0].extra = PRIVATE; },
  ]) await rejectReanchored(f, mutateMetadata(f.text, mutation));
});

test("nanosecond cutoff cannot be shifted or guessed from Sheet serial; excluded records never gain bodies", async () => {
  const f = fixture();
  for (const mutation of [
    rows => { rows.FORM_CURRENT[1].raw.createTime = f.pinned.season_ends_at; },
    rows => { rows.EXCLUDED_IDENTITIES[0].identity.createTime = "2026-10-01T03:59:59.999999999Z"; },
    rows => { rows.EXCLUDED_IDENTITIES[0].identity.createTime = "2026-10-01T04:02:00.000000001Z"; },
    rows => { rows.EXCLUDED_IDENTITIES[0].raw = { answers: {}, lastSubmittedTime: f.pinned.season_ends_at }; },
    rows => { rows.PRIVATE_PENDING[2].candidate_submission_scope = "BEFORE_CUTOFF"; },
    rows => { rows.PRIVATE_PENDING[3].candidate_submission_scope = "BEFORE_CUTOFF"; },
  ]) await rejectReanchored(f, forged(f, mutation));
  await rejectReanchored(f, mutateMetadata(f.text, metadata => { metadata.submission_cutoff_at = "2026-10-01T04:00:01Z"; }));
});

test("input_bytes is bounded original producer declaration, never synthesized from retained or absent late bodies", async () => {
  const f = fixture();
  const declared = mutateMetadata(f.text, metadata => { metadata.input_bytes = 17; });
  await rejectSafe(() => validate(declared, get(context(f))));
  const result = await validate(declared, get(context(f, declared)));
  assert.equal(result.control.input_bytes_declared, 17);
  assert.equal(result.source_status, "SOURCE_NOT_VERIFIED");
  for (const value of [0, -1, 2_000_001, "17", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await rejectReanchored(f, mutateMetadata(f.text, metadata => { metadata.input_bytes = value; }));
  }
});

test("decoded duplicate keys and Unicode/UTF8 budgets precede lossy parse or injected hash calls", async () => {
  const f = fixture();
  let calls = 0;
  const hash = async value => { calls++; return sha(value); };
  for (const text of [
    f.text.replace('"format":"c2-source-plan-v1"', '"format":"c2-source-plan-v1","\\u0066ormat":"c2-source-plan-v1"'),
    canonical({ ...f.core, metadata_text: f.core.metadata_text.replace('"format":"c2-source-plan-v1"', '"format":"c2-source-plan-v1","\\u0066ormat":"c2-source-plan-v1"') }),
    "\"" + "😀".repeat(500_001) + "\"",
    '"\\ud800"',
  ]) {
    calls = 0;
    await rejectSafe(() => validate(text, get(context(f, text)), hash));
    assert.equal(calls, 0);
  }
  const core = clone(f.core);
  const chunk = core.chunks[0];
  chunk.payload_text = chunk.payload_text.replace('"namespace":"FORM_CURRENT"', '"namespace":"FORM_CURRENT","\\u006eamespace":"FORM_CURRENT"');
  chunk.utf8_bytes = bytes(chunk.payload_text);
  await rejectReanchored(f, canonical(core), "DUPLICATE_JSON_KEY");
});

test("old raw parent depth32 remains valid inside generated wrappers, retained parent depth33 fails", async () => {
  const f = fixture("raw-parent-depth-32-generated-wrapper");
  await validate(f.text, get(context(f)));
  const over = forged(f, rows => {
    const schema = rows.PRIVATE_PENDING.find(row => row.record_type === "FORM_SCHEMA");
    schema.raw.future = [schema.raw.future];
  });
  await rejectReanchored(f, over, "DEPTH_EXCEEDED");
});

test("latest awaited hash rechecks every server-owned source/digest anchor; dependency errors stay fixed", async () => {
  const f = fixture();
  for (const mutate of [
    value => { value.source.writer_epoch++; },
    value => { value.source.backend_generation += "-new"; },
    value => { value.source_plan_digest = "B".repeat(43); },
  ]) {
    const current = context(f);
    let hashCalls = 0;
    await rejectSafe(() => validate(f.text, get(current), async value => {
      hashCalls++;
      const result = await sha(value);
      mutate(current);
      return result;
    }));
    assert.ok(hashCalls > 0);
  }
  const error = new Error(PRIVATE);
  await rejectSafe(() => validate(f.text, () => { throw error; }));
  await rejectSafe(() => validate(f.text, get(context(f)), async () => { throw error; }));
  const accessor = context(f);
  Object.defineProperty(accessor, "source_plan_digest", { enumerable: true, get() { throw error; } });
  await rejectSafe(() => validate(f.text, get(accessor)));
  const proxy = new Proxy(context(f), { ownKeys() { throw error; } });
  await rejectSafe(() => validate(f.text, get(proxy)));
  await rejectSafe(() => validate(null, get(context(f))));
});

test("valid original input and core fit 2MB but expanded complete private collection exceeds its own output budget", async () => {
  const f = fixture();
  let overflow;
  for (const width of [120, 140, 160, 180, 200]) {
    const input = clone(f.input);
    input.form_responses = Array.from({ length: 4900 }, (_, index) => ({
      responseId: `excluded-${index}-${"x".repeat(width)}`,
      createTime: f.pinned.season_ends_at, lastSubmittedTime: "2026-10-01T04:01:00Z",
    }));
    const inputText = JSON.stringify(input);
    assert.ok(bytes(inputText) <= 2_000_000);
    let plan;
    try { plan = buildLocalSourcePlan(inputText, f.pinned); }
    catch (error) {
      assert.ok(error instanceof SourceModelError);
      assert.equal(error.code, "TOTAL_BYTES_EXCEEDED");
      break;
    }
    assert.ok(bytes(plan.canonical_text) <= 2_000_000);
    assert.ok(plan.record_count <= 5000);
    const located = Object.fromEntries(namespaces.map(namespace => [namespace, []]));
    for (const chunk of plan.chunks) {
      JSON.parse(chunk.payload_text).records.forEach((record, index) => located[chunk.namespace].push({
        locator: { namespace: chunk.namespace, chunk_index: chunk.chunk_index, record_offset: chunk.row_offset + index }, record,
      }));
    }
    // Construct only the documented output shape using independent canonical/UTF8 calculation.
    const privateBytes = bytes(canonical({ metadata: JSON.parse(plan.metadata_text), records: located }));
    if (privateBytes > 2_000_000) { overflow = { plan, privateBytes }; break; }
  }
  assert.ok(overflow, "fixture must prove an actual expanded output overflow while original core remains valid");
  let hashCalls = 0;
  await rejectSafe(() => validate(overflow.plan.canonical_text, get(context(f, overflow.plan.canonical_text)), async value => {
    hashCalls++; return sha(value);
  }), "PLAN_PRIVATE_OUTPUT_EXCEEDED");
  assert.equal(hashCalls, 0, "private output must fail atomically before async hash");
});
