// Development-only, fictional compatibility oracle. CI consumes the committed JSON, never Git history.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import ts from "typescript";

const revision = "8fed6a9";
const sha = value => createHash("sha256").update(value, "utf8").digest("hex");
const cache = new Map();
const sources = {};
function oldModule(path) {
  if (cache.has(path)) return cache.get(path);
  const source = execFileSync("git", ["show", `${revision}:${path}`], { encoding: "utf8" });
  sources[path] = sha(source);
  let code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu, (_, start, relative, end) =>
    start + oldModule(posix.normalize(posix.join(posix.dirname(path), `${relative}.ts`))) + end);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  cache.set(path, url);
  return url;
}
const { buildLocalSourcePlan } = await import(oldModule("shared/c2-source-capture-projection.ts"));
const pinned = {
  source_operation_id: "golden-fictional-operation", team_id: "golden-team", season_id: "golden-season",
  binding_version: 1, backend_generation: "golden-generation", writer_epoch: 0,
  form_id: "golden-form", spreadsheet_id: "golden-sheet", sheet_id: 31,
  season_ends_at: "2026-10-01T04:00:00Z",
};
const text = value => ({ userEnteredValue: { stringValue: value }, effectiveValue: { stringValue: value } });
const response = (id, at = "2026-09-30T12:00:00Z") => ({ responseId: id, createTime: at,
  lastSubmittedTime: "2026-10-01T04:01:00Z", answers: { q: { questionId: "q", textAnswers: { answers: [{ value: `Fictional 😀 ${id}` }] } } } });
function fixture() {
  return {
    format: "c2-source-input-v1", observed_start_at: "2026-10-01T04:01:00Z", observed_end_at: "2026-10-01T04:02:00Z",
    form_schema: { formId: pinned.form_id, linkedSheetId: pinned.spreadsheet_id, info: { title: "Fictional form" },
      items: [{ itemId: "item", questionItem: { question: { questionId: "q", textQuestion: {} } } }] },
    form_responses: [response("early", "2026-09-30T23:59:59.999999999-04:00"), response("late-equal", pinned.season_ends_at),
      response("late-plus", "2026-10-01T04:00:00.000000001Z")],
    sheet_schema: { spreadsheetId: pinned.spreadsheet_id, sheetId: pinned.sheet_id, title: "Responses", locale: "en_US",
      timeZone: "America/New_York", rowCount: 4, columnCount: 2, headerRowIndex: 0, headers: [text("Timestamp"), text("Answer")] },
    sheet_rows: [{ row_index: 1, cells: [{ userEnteredValue: { numberValue: 46296.123456789 }, effectiveValue: {} }, text("Sheet current differs")] },
      { row_index: 2, cells: [{}, { userEnteredValue: { formulaValue: "=1/0" }, effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO", message: "Fictional" } } }] },
      { row_index: 3, cells: [{}, {}] }],
    known_sources: [{ kind: "FORM_RESPONSE", form_id: pinned.form_id, response_id: "known-missing", status: "REVIEW_REQUIRED" },
      { kind: "LEGACY_ROW", source_key: "fictional:7", status: "IMPORTED" }, { kind: "UNMAPPED_MEMBER", member_id: "fictional-member" }],
    declared_mappings: [{ state: "DECLARED_ONLY", row_index: 3, response_id: "absent", evidence_id: "declared-3" },
      { state: "DECLARED_ONLY", row_index: 2, response_id: "late-equal", evidence_id: "declared-2" },
      { state: "DECLARED_ONLY", row_index: 1, response_id: "early", evidence_id: "declared-1" }],
  };
}
const cases = [];
function add(name, input) {
  const input_text = JSON.stringify(input);
  const plan = buildLocalSourcePlan(input_text, pinned);
  cases.push({ name, pinned, input_text, core_text: plan.canonical_text,
    core_sha256: sha(plan.canonical_text), metadata_sha256: sha(plan.metadata_text),
    chunk_sha256: plan.chunks.map(chunk => sha(chunk.payload_text)) });
}
add("nano-late-census-mapping-types", fixture());
const unsupported = fixture();
unsupported.form_schema.future = { complete: ["Unknown", 1.25, null] };
unsupported.sheet_schema.future = { retained: true };
unsupported.sheet_rows[0].cells[1].future = { full: "Retained" };
const file = response("file"); file.answers.q = { questionId: "q", fileUploadAnswers: { answers: [{ fileId: "fictional-file", fileName: "x.txt", mimeType: "text/plain" }] } };
const unknown = response("unknown"); unknown.future = { complete: "Never trimmed" };
const deleted = response("deleted-question"); deleted.answers = { old: { questionId: "old", textAnswers: { answers: [{ value: "Kept" }] } } };
unsupported.form_responses = [file, response("current"), unknown, deleted, response("late", pinned.season_ends_at)];
add("unsupported-schema-raw-attachments", unsupported);
const mixed = fixture();
mixed.form_responses = [unknown, response("current-1"), response("late-1", pinned.season_ends_at), file,
  response("current-2"), deleted, response("late-2", "2026-10-01T04:00:00.000000001Z")];
add("cross-namespace-original-interleave", mixed);
const multichunk = fixture();
multichunk.sheet_schema.rowCount = 104;
multichunk.sheet_rows = Array.from({ length: 103 }, (_, index) => ({ row_index: index + 1, cells: [{}, text(`Fictional row ${index}`)] }));
add("multiple-sheet-chunks", multichunk);
const defaults = fixture();
defaults.form_schema.items[0].questionItem.question = { questionId: "q", scaleQuestion: { high: 5 } };
defaults.form_responses = [response("no-answers"), response("empty-text"), response("empty-file")];
delete defaults.form_responses[0].answers;
defaults.form_responses[1].answers.q.textAnswers = {};
defaults.form_responses[2].answers.q = { questionId: "q", fileUploadAnswers: {} };
add("omitted-rest-defaults", defaults);
const deep = fixture();
deep.form_schema.future = "leaf";
for (let i = 0; i < 30; i++) deep.form_schema.future = [deep.form_schema.future];
add("raw-parent-depth-32-generated-wrapper", deep);

const output = new URL("fixtures/c2-source-plan-v1/goldens.json", import.meta.url);
mkdirSync(dirname(output.pathname.replace(/^\/(?:([A-Za-z]:))/u, "$1")), { recursive: true });
writeFileSync(output, JSON.stringify({ format: "c2-source-plan-test-goldens-v1", provenance: "FICTIONAL_TEST_ORACLE_ONLY",
  oracle_revision: execFileSync("git", ["rev-parse", revision], { encoding: "utf8" }).trim(), oracle_source_sha256: sources, cases }, null, 2) + "\n");
process.stdout.write(`Generated ${cases.length} fictional old-tree golden cases.\n`);
