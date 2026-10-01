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
  const result = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  modules.set(url.href, result);
  return result;
}
const { prepareLocalMappingReview, planLocalMappingReview } = await import(moduleUrl(new URL("../shared/c2-source-mapping-review-projection.ts", import.meta.url)));
const { prepareLocalMappingReviewFromPlan, planLocalMappingReviewFromPlan } = await import(moduleUrl(new URL("../shared/c2-source-plan-review-adapter.ts", import.meta.url)));
const { SourceModelError } = await import(moduleUrl(new URL("../shared/c2-source-capture-contract.ts", import.meta.url)));
const golden = JSON.parse(readFileSync(new URL("fixtures/c2-source-plan-review-v1/goldens.json", import.meta.url), "utf8"));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const nodeSha = text => createHash("sha256").update(text, "utf8").digest("base64url");
const sha = async text => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url");
const get = value => () => value;
const sample = golden.cases[0];
const PRIVATE = "FICTIONAL_PRIVATE_ERROR_BODY_😀";
async function rejects(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof SourceModelError);
    assert.equal(error.message, "Source input is unsupported or inconsistent.");
    assert.ok(!JSON.stringify({ message: error.message, code: error.code }).includes(PRIVATE));
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("legacy six complete views and fifteen plans match fixed independently loaded 705cc9d oracle bytes", async () => {
  assert.ok(golden.oracle_revision.startsWith("705cc9d"));
  assert.equal(golden.provenance, "FICTIONAL_TEST_ORACLE_ONLY");
  assert.deepEqual(Object.keys(golden.oracle_source_sha256).sort(), [
    "shared/c2-source-capture-contract.ts", "shared/c2-source-capture-projection.ts",
    "shared/c2-source-mapping-review-contract.ts", "shared/c2-source-mapping-review-projection.ts",
  ]);
  assert.equal(golden.cases.length, 6);
  assert.equal(golden.cases.reduce((sum, row) => sum + row.plans.length, 0), 15);
  for (const row of golden.cases) {
    const view = await prepareLocalMappingReview(row.bundle, get(row.context), sha);
    assert.equal(canonical(view), row.view_text);
    assert.equal(nodeSha(canonical(view)), row.view_sha256);
    assert.ok(!Object.hasOwn(view, "validation_mode"));
    for (const plan of row.plans) {
      const result = await planLocalMappingReview(row.bundle, plan.prior_ledger_text, plan.command_text, get(plan.context), sha);
      assert.equal(canonical(result), plan.result_text);
      assert.equal(nodeSha(canonical(result)), plan.result_sha256);
      assert.equal(nodeSha(result.evidence_text), plan.evidence_sha256);
      assert.equal(nodeSha(result.derived_text), plan.derived_sha256);
    }
  }
});

test("new complete core-only views and plans preserve every old inner byte and keep mode outside all hash domains", async () => {
  for (const row of golden.cases) {
    const wrapped = await prepareLocalMappingReviewFromPlan(row.bundle.source_plan_text, get(row.context), sha);
    assert.deepEqual(Object.keys(wrapped).sort(), ["result", "validation_mode"]);
    assert.equal(wrapped.validation_mode, "RETAINED_PLAN_ONLY");
    assert.equal(canonical(wrapped.result), row.view_text);
    assert.equal(wrapped.result.source_status, "SOURCE_NOT_VERIFIED");
    assert.ok(!Object.hasOwn(wrapped.result, "receipt"));
    for (const plan of row.plans) {
      const current = await planLocalMappingReviewFromPlan(row.bundle.source_plan_text,
        plan.prior_ledger_text, plan.command_text, get(plan.context), sha);
      assert.equal(current.validation_mode, "RETAINED_PLAN_ONLY");
      assert.equal(canonical(current.result), plan.result_text);
      assert.ok(!current.result.ledger_text.includes("RETAINED_PLAN_ONLY"));
      assert.ok(!current.result.evidence_text.includes("RETAINED_PLAN_ONLY"));
      const derived = JSON.parse(current.result.derived_text);
      assert.equal(derived.annual_export_authorized, false);
      assert.equal(derived.source_status, "SOURCE_NOT_VERIFIED");
    }
  }
});

test("new entry takes complete core text only, cannot trust caller proof and validates original bytes on replay", async () => {
  for (const input of [null, {}, { validated: true }, JSON.parse(sample.bundle.source_plan_text), { private_collection: {} }]) {
    await rejects(() => prepareLocalMappingReviewFromPlan(input, get(sample.context), sha));
  }
  const plan = sample.plans[1];
  const core = JSON.parse(sample.bundle.source_plan_text);
  const chunk = core.chunks.find(chunk => chunk.namespace === "GAP_LEDGER");
  const payload = JSON.parse(chunk.payload_text);
  payload.records[0].classification = "SOURCE_GAP";
  chunk.payload_text = canonical(payload);
  chunk.utf8_bytes = Buffer.byteLength(chunk.payload_text, "utf8");
  await rejects(() => planLocalMappingReviewFromPlan(canonical(core), plan.prior_ledger_text,
    plan.command_text, get(plan.context), sha));
});

test("core SHA child port checks actor, permission and ledger authority even when its three source fields stay equal", async () => {
  for (const mutate of [
    context => { context.actor_id += "-different"; },
    context => { context.permission_scope = "NO_REVIEW_PERMISSION"; },
    context => { context.ledger_version++; },
    context => { context.ledger_digest = "B".repeat(43); },
  ]) {
    const context = structuredClone(sample.context);
    let called = false;
    await rejects(() => prepareLocalMappingReviewFromPlan(sample.bundle.source_plan_text, get(context), async bytes => {
      const hash = await sha(bytes);
      if (!called) { called = true; mutate(context); }
      return hash;
    }));
    assert.equal(called, true);
  }
});

test("fresh clock advances without replacing first evidence time or old T1 replay prefix after B at T2", async () => {
  const row = golden.cases.find(row => row.plans.length === 3);
  const first = row.plans[0];
  const context = structuredClone(first.context);
  const result = await planLocalMappingReviewFromPlan(row.bundle.source_plan_text, first.prior_ledger_text,
    first.command_text, get(context), async bytes => {
      const hash = await sha(bytes); context.reviewed_at = "2026-10-01T05:00:00Z"; return hash;
    });
  assert.equal(canonical(result.result), first.result_text);
  const replay = row.plans[2];
  assert.equal(replay.context.reviewed_at, first.context.reviewed_at);
  assert.equal(replay.context.ledger_version, 2);
  const current = await planLocalMappingReviewFromPlan(row.bundle.source_plan_text,
    replay.prior_ledger_text, replay.command_text, get(replay.context), sha);
  assert.equal(canonical(current.result), replay.result_text);
  assert.equal(current.result.append_required, false);
  assert.equal(JSON.parse(current.result.derived_text).ledger_version, 1);
});

test("later final next-ledger SHA cannot return an append or replay after full review context changes", async () => {
  for (const plan of [sample.plans[0], sample.plans[1]]) {
    const context = structuredClone(plan.context);
    const expected = JSON.parse(plan.result_text);
    const finalMatch = expected.append_required ? 2 : 3;
    let matches = 0;
    await rejects(() => planLocalMappingReviewFromPlan(sample.bundle.source_plan_text,
      plan.prior_ledger_text, plan.command_text, get(context), async bytes => {
        const hash = await sha(bytes);
        if (bytes === "c2-source-review-ledger-v1\n" + expected.ledger_text && ++matches === finalMatch) {
          context.actor_id += "-after-final-ledger";
        }
        return hash;
      }));
    assert.equal(matches, finalMatch);
  }
});

test("excluded identities have no invented full response or content hash; source gaps and unsupported stay intact", async () => {
  const view = await prepareLocalMappingReviewFromPlan(sample.bundle.source_plan_text, get(sample.context), sha);
  assert.ok(view.result.unreviewable_responses.some(row => row.response_id === "late-equal"));
  assert.ok(!view.result.form_records.some(row => row.raw.responseId === "late-equal"));
  const plan = sample.plans[0];
  const command = JSON.parse(plan.command_text); command.response_id = "late-equal";
  await rejects(() => planLocalMappingReviewFromPlan(sample.bundle.source_plan_text, plan.prior_ledger_text,
    canonical(command), get(sample.context), sha), "FULL_RESPONSE_NOT_AVAILABLE_FOR_REVIEW");
  const unknown = golden.cases.find(row => row.name === "unsupported-schema-raw-attachments");
  const result = await planLocalMappingReviewFromPlan(unknown.bundle.source_plan_text,
    unknown.plans[0].prior_ledger_text, unknown.plans[0].command_text, get(unknown.context), sha);
  const derived = JSON.parse(result.result.derived_text);
  assert.equal(derived.reviews[0].content_status, "UNSUPPORTED_CONTENT_REMAINS");
  assert.ok(derived.source_evidence_condition_count > 0);
  assert.equal(derived.annual_export_authorized, false);
});

test("private dependency exceptions, getters and null inputs only return fixed controlled errors", async () => {
  const fail = () => { throw new Error(PRIVATE); };
  await rejects(() => prepareLocalMappingReviewFromPlan(sample.bundle.source_plan_text, fail, sha));
  await rejects(() => prepareLocalMappingReviewFromPlan(sample.bundle.source_plan_text, get(sample.context), fail));
  const proxy = new Proxy(sample.context, { ownKeys: fail });
  await rejects(() => prepareLocalMappingReviewFromPlan(sample.bundle.source_plan_text, get(proxy), sha));
  await rejects(() => prepareLocalMappingReviewFromPlan(null, get(sample.context), sha));
});
