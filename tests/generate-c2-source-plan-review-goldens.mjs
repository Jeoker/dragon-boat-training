// Development-only fictional oracle; runtime tests read committed bytes without Git.
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";

const revision = execFileSync("git", ["rev-parse", "705cc9d"], { encoding: "utf8" }).trim();
const hash = text => createHash("sha256").update(text, "utf8").digest("base64url");
const sha = async text => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sources = {};
const cache = new Map();
function oldModule(path) {
  if (cache.has(path)) return cache.get(path);
  const source = execFileSync("git", ["show", `${revision}:${path}`], { encoding: "utf8" });
  sources[path] = hash(source);
  let code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu, (_, start, pathPart, end) =>
    start + oldModule(posix.normalize(posix.join(posix.dirname(path), `${pathPart}.ts`))) + end);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  cache.set(path, url);
  return url;
}
const { prepareLocalMappingReview, planLocalMappingReview } = await import(oldModule("shared/c2-source-mapping-review-projection.ts"));
const fixtures = JSON.parse(readFileSync(new URL("fixtures/c2-source-plan-v1/goldens.json", import.meta.url), "utf8"));
const cases = [];
for (const row of fixtures.cases) {
  const source_plan_digest = hash("c2-source-review-source-v1\n" + row.core_text);
  const anchor = { source: row.pinned, source_plan_digest, local_snapshot_id: `LOCAL_INPUT_${source_plan_digest}`,
    provenance: "LOCAL_INPUT_DECLARATIONS_ONLY" };
  const ledger = { format: "c2-source-mapping-ledger-v1", state: "LOCAL_REVIEW_PLAN_ONLY",
    source_status: "SOURCE_NOT_VERIFIED", anchor, version: 0, evidence: [] };
  const context = { source: row.pinned, actor_id: "independent-golden-coach", permission_scope: "COACH_SOURCE_MAPPING_REVIEW",
    reviewed_at: "2026-10-01T04:04:00Z", source_plan_digest, local_snapshot_id: anchor.local_snapshot_id,
    ledger_version: 0, ledger_digest: hash("c2-source-review-ledger-v1\n" + canonical(ledger)) };
  const bundle = { source_input_text: row.input_text, source_plan_text: row.core_text };
  const view = await prepareLocalMappingReview(bundle, () => context, sha);
  const view_text = canonical(view);
  const plans = [];
  const command = (pair, request) => ({ request_id: request, local_snapshot_id: context.local_snapshot_id,
    row_index: view.sheet_records[pair].raw.row_index, response_id: view.form_records[pair].raw.responseId,
    expected_sheet_digest: view.sheet_records[pair].content_digest, expected_form_digest: view.form_records[pair].content_digest,
    decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" });
  async function add(name, prior, cmd, authority) {
    const result = await planLocalMappingReview(bundle, prior, canonical(cmd), () => authority, sha);
    const result_text = canonical(result);
    plans.push({ name, prior_ledger_text: prior, command_text: canonical(cmd), context: authority, result_text,
      result_sha256: hash(result_text), evidence_sha256: hash(result.evidence_text), derived_sha256: hash(result.derived_text) });
    return result;
  }
  const firstCommand = command(0, "golden-review-A");
  const first = await add("first-append", canonical(ledger), firstCommand, context);
  if (view.form_records.length >= 2 && view.sheet_records.length >= 2) {
    const secondContext = { ...context, reviewed_at: "2026-10-01T04:05:00Z", ledger_version: 1, ledger_digest: first.ledger_digest };
    const second = await add("second-append", first.ledger_text, command(1, "golden-review-B"), secondContext);
    await add("A-original-time-after-B-replay", second.ledger_text, firstCommand,
      { ...context, ledger_version: 2, ledger_digest: second.ledger_digest });
  } else {
    await add("A-original-time-replay", first.ledger_text, firstCommand,
      { ...context, ledger_version: 1, ledger_digest: first.ledger_digest });
  }
  cases.push({ name: row.name, bundle, context, view_text, view_sha256: hash(view_text), plans });
}
const directory = new URL("fixtures/c2-source-plan-review-v1/", import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL("goldens.json", directory), JSON.stringify({ format: "c2-source-plan-review-test-goldens-v1",
  provenance: "FICTIONAL_TEST_ORACLE_ONLY", oracle_revision: revision, oracle_source_sha256: sources, cases }, null, 2) + "\n");
console.log(`Generated ${cases.length} fictional old review views and ${cases.reduce((sum, row) => sum + row.plans.length, 0)} fixed plans.`);
