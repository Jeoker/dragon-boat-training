import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

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
const { validateLocalSourcePlanCore } = await import(moduleUrl(new URL("../shared/c2-source-plan-validation-projection.ts", import.meta.url)));
const { sourceCanonical, parseSourceJson, parseGeneratedSourceJson, SourceModelError } = await import(moduleUrl(new URL("../shared/c2-source-capture-contract.ts", import.meta.url)));
const { assembleSourceChunks, SOURCE_NAMESPACES } = await import(moduleUrl(new URL("../shared/c2-source-capture-records.ts", import.meta.url)));
const goldens = JSON.parse(readFileSync(new URL("fixtures/c2-source-plan-v1/goldens.json", import.meta.url), "utf8"));
const shaHex = value => createHash("sha256").update(value, "utf8").digest("hex");
const shaNode = value => createHash("sha256").update(value, "utf8").digest("base64url");
const sha = async value => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("base64url");
const canonical = sourceCanonical;
const context = (text, pinned = goldens.cases[0].pinned) => ({ source: pinned, source_format: "c2-source-plan-v1",
  source_plan_digest: shaNode("c2-source-review-source-v1\n" + text) });
const get = value => () => value;
function recordGroups(core) {
  const groups = Object.fromEntries(SOURCE_NAMESPACES.map(name => [name, []]));
  for (const chunk of core.chunks) groups[chunk.namespace].push(...JSON.parse(chunk.payload_text).records);
  return groups;
}
function repack(core, groups) {
  core.chunks = assembleSourceChunks(groups, JSON.parse(core.metadata_text).pinned_context.source_operation_id);
  core.namespace_counts = Object.fromEntries(SOURCE_NAMESPACES.map(name => [name, groups[name].length]));
  core.record_count = Object.values(core.namespace_counts).reduce((sum, count) => sum + count, 0);
  return canonical(core);
}
async function rejects(operation, code) {
  await assert.rejects(operation, error => error instanceof SourceModelError && error.code === code &&
    error.message === "Source input is unsupported or inconsistent.");
}

test("committed old-tree goldens retain exact source core, metadata and every chunk after shared extraction", () => {
  assert.equal(goldens.provenance, "FICTIONAL_TEST_ORACLE_ONLY");
  assert.ok(goldens.oracle_revision.startsWith("8fed6a9"));
  assert.deepEqual(Object.keys(goldens.oracle_source_sha256).sort(), ["shared/c2-source-capture-contract.ts", "shared/c2-source-capture-projection.ts"]);
  for (const fixture of goldens.cases) {
    assert.equal(shaHex(fixture.core_text), fixture.core_sha256);
    const now = buildLocalSourcePlan(fixture.input_text, fixture.pinned);
    assert.equal(now.canonical_text, fixture.core_text, fixture.name);
    assert.equal(shaHex(now.metadata_text), fixture.metadata_sha256, fixture.name);
    assert.deepEqual(now.chunks.map(chunk => shaHex(chunk.payload_text)), fixture.chunk_sha256, fixture.name);
  }
});

test("all six original retained plans validate without raw input, preserve every original record and location", async () => {
  for (const fixture of goldens.cases) {
    const original = JSON.parse(fixture.core_text);
    const result = await validateLocalSourcePlanCore(fixture.core_text, get(context(fixture.core_text, fixture.pinned)), sha);
    assert.equal(result.state, "LOCAL_PLAN_VALIDATION_ONLY");
    assert.equal(result.source_status, "SOURCE_NOT_VERIFIED");
    assert.equal(result.control.annual_export_authorized, false);
    assert.equal(result.control.source_authenticity, "NOT_PROVEN");
    assert.equal(result.control.excluded_body_evidence, "NOT_PRESENT_NOT_RECONSTRUCTED");
    assert.ok(!Object.hasOwn(result, "core_text") && !Object.hasOwn(result, "source_input_text") && !Object.hasOwn(result, "receipt"));
    assert.equal(canonical(result.private_collection.metadata), original.metadata_text);
    for (const namespace of SOURCE_NAMESPACES) {
      const expected = original.chunks.filter(chunk => chunk.namespace === namespace).flatMap(chunk =>
        JSON.parse(chunk.payload_text).records.map((record, i) => ({ record,
          locator: { namespace, chunk_index: chunk.chunk_index, record_offset: chunk.row_offset + i } })));
      assert.deepEqual(result.private_collection.records[namespace], expected);
    }
    assert.equal(result.private_collection.records.SHEET_CURRENT.length, 0);
    assert.ok(Buffer.byteLength(canonical(result), "utf8") <= 2_000_000);
    assert.ok(Buffer.byteLength(canonical(result.control), "utf8") <= 8_000);
  }
});

test("excluded identities never synthesize late answers or a lastSubmittedTime", async () => {
  const fixture = goldens.cases[0];
  assert.ok(!fixture.core_text.includes("Fictional 😀 late-equal"));
  const result = await validateLocalSourcePlanCore(fixture.core_text, get(context(fixture.core_text)), sha);
  for (const item of result.private_collection.records.EXCLUDED_IDENTITIES) {
    assert.deepEqual(Object.keys(item.record).sort(), ["identity", "reason", "record_type"]);
    assert.deepEqual(Object.keys(item.record.identity).sort(), ["createTime", "form_id", "response_id"]);
    assert.ok(!Object.hasOwn(item.record, "raw"));
  }
  assert.ok(!canonical(result.control).includes("Fictional"));
});

test("input_bytes is a bounded original declaration, protected by the original digest rather than reconstruction", async () => {
  const original = goldens.cases[0].core_text;
  const core = JSON.parse(original); const metadata = JSON.parse(core.metadata_text);
  metadata.input_bytes += 17; core.metadata_text = canonical(metadata);
  const text = canonical(core);
  await rejects(() => validateLocalSourcePlanCore(text, get(context(original)), sha), "PLAN_ORIGINAL_DIGEST_MISMATCH");
  const declared = await validateLocalSourcePlanCore(text, get(context(text)), sha);
  assert.equal(declared.control.input_bytes_declared, metadata.input_bytes);
  assert.equal(declared.control.input_byte_evidence, "ORIGINAL_DECLARATION_ONLY");
  for (const invalid of [0, -1, 2_000_001, 1.5, "100"]) {
    metadata.input_bytes = invalid; core.metadata_text = canonical(metadata);
    const changed = canonical(core);
    await rejects(() => validateLocalSourcePlanCore(changed, get(context(changed)), sha), "INTEGER_BOUNDS");
  }
});

test("legitimate metadata exceeding 64KB uses the whole-core budget and preserves complete census", async () => {
  const fixture = goldens.cases[0]; const input = JSON.parse(fixture.input_text);
  input.known_sources = Array.from({ length: 800 }, (_, index) => ({ kind: "FORM_RESPONSE", form_id: fixture.pinned.form_id,
    response_id: `fictional-known-${index}-${"x".repeat(90)}`, status: "REVIEW_REQUIRED" }));
  const plan = buildLocalSourcePlan(JSON.stringify(input), fixture.pinned);
  assert.ok(Buffer.byteLength(plan.metadata_text, "utf8") > 64_000);
  const result = await validateLocalSourcePlanCore(plan.canonical_text, get(context(plan.canonical_text)), sha);
  assert.deepEqual(result.private_collection.metadata.known_sources, input.known_sources);
  assert.equal(result.private_collection.records.GAP_LEDGER.filter(item => item.record.code === "KNOWN_RESPONSE_NOT_OBSERVED").length, 800);
});

test("generated wrapper depth accepts an old raw-parent32 boundary; raw-parent33 remains rejected", async () => {
  const fixture = goldens.cases.find(row => row.name === "raw-parent-depth-32-generated-wrapper");
  const core = JSON.parse(fixture.core_text); const groups = recordGroups(core);
  const schemaRecord = groups.PRIVATE_PENDING.find(row => row.record_type === "FORM_SCHEMA");
  assert.doesNotThrow(() => parseSourceJson(canonical({ form_schema: schemaRecord.raw })));
  const chunk = core.chunks.find(row => row.namespace === "PRIVATE_PENDING");
  assert.throws(() => parseSourceJson(chunk.payload_text), error => error.code === "DEPTH_EXCEEDED");
  assert.doesNotThrow(() => parseGeneratedSourceJson(chunk.payload_text));
  await validateLocalSourcePlanCore(fixture.core_text, get(context(fixture.core_text)), sha);
  schemaRecord.raw.future = [schemaRecord.raw.future];
  const deeper = repack(core, groups);
  await rejects(() => validateLocalSourcePlanCore(deeper, get(context(deeper)), sha), "DEPTH_EXCEEDED");
  assert.throws(() => parseGeneratedSourceJson("[".repeat(41) + "0" + "]".repeat(41)), error => error.code === "DEPTH_EXCEEDED");
});

test("self-consistent namespace layout and condition tampering cannot be normalized into a valid original plan", async () => {
  for (const mutate of [
    groups => { groups.FORM_CURRENT.reverse(); },
    groups => { groups.PRIVATE_PENDING.reverse(); },
    groups => { groups.GAP_LEDGER = groups.GAP_LEDGER.filter(row => row.code !== "KNOWN_RESPONSE_NOT_OBSERVED"); },
    groups => { groups.GAP_LEDGER.reverse(); },
  ]) {
    const core = JSON.parse(goldens.cases[0].core_text); const groups = recordGroups(core); mutate(groups);
    const text = repack(core, groups);
    await assert.rejects(() => validateLocalSourcePlanCore(text, get(context(text)), sha), error =>
      error instanceof SourceModelError && ["PLAN_LAYOUT_INVALID", "PLAN_CONDITIONS_INVALID"].includes(error.code));
  }
});

test("final original SHA await rechecks a fresh getter; canonical bytes are independently verified", async () => {
  const text = goldens.cases[0].core_text;
  let current = context(text); let ready; let release;
  const reached = new Promise(resolve => { ready = resolve; }); const barrier = new Promise(resolve => { release = resolve; });
  const operation = validateLocalSourcePlanCore(text, () => current, async bytes => {
    assert.equal(bytes, "c2-source-review-source-v1\n" + text);
    assert.equal(await sha(bytes), shaNode(bytes)); ready(); await barrier; return sha(bytes);
  });
  await reached; current = { ...current, source: { ...current.source, writer_epoch: 1 } }; release();
  await rejects(() => operation, "PLAN_OWNERSHIP_CHANGED");
});

test("hostile dependency errors and malformed input stay fixed and never leak source bodies", async () => {
  const text = goldens.cases[0].core_text; const secret = "PRIVATE_DEPENDENCY_BODY_URL_AND_TOKEN";
  const throwPrivate = () => { throw new Error(secret); };
  for (const port of [null, undefined, throwPrivate, () => new Proxy({}, { getPrototypeOf: throwPrivate }), () => null]) {
    await rejects(() => validateLocalSourcePlanCore(text, port, sha), "PLAN_CONTEXT_INVALID");
  }
  for (const port of [null, undefined, throwPrivate, async () => secret, async () => { throw new SourceModelError(secret); }]) {
    await rejects(() => validateLocalSourcePlanCore(text, get(context(text)), port), "PLAN_HASH_FAILED");
  }
  for (const invalid of [null, undefined, '{"format":1,"\\u0066ormat":2}', "{} extra"]) {
    await assert.rejects(() => validateLocalSourcePlanCore(invalid, get(context(text)), sha), error =>
      error instanceof SourceModelError && error.message === "Source input is unsupported or inconsistent." && !error.code.includes(secret));
  }
  const core = JSON.parse(text); const metadata = JSON.parse(core.metadata_text);
  metadata.known_sources = Array(5_001).fill(null); core.metadata_text = canonical(metadata);
  const oversizedCensus = canonical(core);
  await rejects(() => validateLocalSourcePlanCore(oversizedCensus, get(context(oversizedCensus)), sha), "RECORD_COUNT_EXCEEDED");
});
