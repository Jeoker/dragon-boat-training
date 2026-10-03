// Build-only: exact isolated v14 source, immutable cancellation, two signed fault scopes.
// No fetch, deployment, Form submission, Worker mutation, or production test switch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CLEAN_SHA256 = "2004DF4D80B0FA2B24AB3674A28D899B8E2F0892EC067B01707C9346C1C349F0";
export const DEPLOYED_FIXTURE_SHA256 = "00BE58B00537F0057BCF7F177C3176EE3C63C18CC7F34641B184BAC42CFBE373";
export const HEAD_FIXTURE_SHA256 = "6AEE9C8074C747FA24BDE9B6F81A8205A04D3D846798D221CB2249F56F470DED";
const team = "pentasus-c2-test", season = "season_c2_isolated_2026";
const worker = "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/";
const version = "0.16.2-c2-physical-diagnostics";
const hash = value => createHash("sha256").update(value).digest("hex").toUpperCase();
const sha = value => createHash("sha256").update(value).digest("base64url");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  value && typeof value === "object" ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const load = path => JSON.parse(readFileSync(path, "utf8"));
const equal = (a, b) => assert.equal(canonical(a), canonical(b));
export const headers = {
  SIGNUP: ["season_id", "practice_id", "member_id", "preference", "status", "queue_at", "queue_sequence", "updated_at", "last_request_id"],
  SEAT_PLAN_CURRENT: ["season_id", "practice_id", "row_number", "side", "member_id", "seat_plan_version", "updated_by", "updated_at"],
  SEAT_PLAN_REVISION: ["season_id", "practice_id", "revision_number", "revision_id", "source", "seat_plan_version", "coach_member_id", "steerer_member_id", "seats_json", "names_json", "published_by", "published_at", "request_id"],
  SEAT_PLAN_DRAFT: ["season_id", "practice_id", "seat_plan_version", "coach_member_id", "steerer_member_id", "published_revision", "frozen_revision", "frozen_at", "updated_by", "updated_at"]
};
const cells = (scope, row) => headers[scope].map(key => String(row[key] ?? ""));
const rowId = (scope, row) => scope === "SIGNUP" ? `${row[1]}:${row[2]}` :
  scope === "SEAT_PLAN_CURRENT" ? `${row[1]}:${row[2]}:${row[3]}` :
    scope === "SEAT_PLAN_REVISION" ? `${row[1]}:${row[2]}` : row[1];
const batchId = request => `batch_${sha(`${team}\nC2:EXPORT\nexportNextAssociated\n${request}`)}`;

export function deriveFaultPlan(j, identity) {
  assert.equal(j.format, 1); assert.match(j.run_id, /^c2_wait_run_[a-f0-9]{32}$/);
  assert.equal(j.worker_url, worker); assert.equal(j.service_version, version);
  assert.equal(j.deployment_id, identity.deployment_id);
  assert.match(identity.script_id, /^[A-Za-z0-9_-]{30,}$/);
  assert.match(identity.deployment_id, /^[A-Za-z0-9_-]{30,}$/);
  assert.match(j.runtime_sheet_id, /^[A-Za-z0-9_-]{20,}$/);
  assert.match(j.practice_id, /^practice_[A-Za-z0-9_-]+$/);
  assert.equal(j.events.length, 10); assert.ok(j.events.every(e => e.confirmed && e.snapshot));
  const e = j.cancel, s = e?.snapshot;
  assert.ok(s && e.result && e.outbox_id && Number.isSafeInteger(e.due_at_ms));
  assert.ok(!e.confirmed && e.export_calls.length === 0 && !e.inflight,
    "Generate only after cancellation audit and before any cancellation export.");
  assert.equal(e.payload.request_id, `${j.run_id}_cancel`);
  assert.equal(e.payload.season_id, season); assert.equal(e.payload.practice_id, j.practice_id);
  assert.equal(e.payload.member_id, j.alpha_id); assert.equal(e.payload.signup_version, 11);
  assert.equal(s.season_id, season); assert.equal(s.practice_id, j.practice_id);
  assert.equal(s.snapshot_schema, 2); assert.equal(s.signup_version, 12); assert.equal(s.practice_version, 2);
  assert.equal(s.member_id, j.alpha_id); assert.equal(s.seat_plan_version, 2); assert.equal(s.published_revision, 2);
  assert.equal(s.signup_rows.length, 2);
  const alpha = s.signup_rows.find(r => r.member_id === j.alpha_id);
  const waiter = s.signup_rows.find(r => r.member_id === j.waiter_id);
  assert.equal(alpha?.status, "CANCELLED"); assert.equal(waiter?.status, "CONFIRMED");
  for (const row of s.signup_rows) {
    assert.equal(row.season_id, season); assert.equal(row.practice_id, j.practice_id);
    assert.equal(row.last_request_id, e.payload.request_id); assert.equal(row.preference, "LEFT");
  }
  const oldWaiter = j.events[9].snapshot.signup_rows.find(r => r.member_id === j.waiter_id);
  assert.equal(oldWaiter.status, "WAITLISTED");
  assert.equal(waiter.queue_at, oldWaiter.queue_at); assert.equal(waiter.queue_sequence, oldWaiter.queue_sequence);
  const seating = s.seating_snapshot, state = seating?.state, revision = seating?.revision;
  assert.ok(state && revision); assert.equal(seating.draft_seats.length, 20);
  assert.equal(state.season_id, season); assert.equal(state.practice_id, j.practice_id);
  assert.equal(state.seat_plan_version, 2); assert.equal(state.published_revision, 2);
  assert.equal(revision.season_id, season); assert.equal(revision.practice_id, j.practice_id);
  assert.equal(revision.revision_number, 2); assert.equal(revision.source, "SYSTEM_CANCELSIGNUP");
  assert.equal(revision.seat_plan_version, 2);
  equal(revision.seats, [{ row_number: 1, side: "LEFT", member_id: j.waiter_id }]);
  equal(e.result.promoted_member_ids, [j.waiter_id]);
  assert.equal(e.result.signup_version, 12); assert.equal(e.result.published_revision, 2);
  equal(seating.draft_seats.map(row => `${row.row_number}:${row.side}`).sort(),
    Array.from({ length: 10 }, (_, i) => [`${i + 1}:LEFT`, `${i + 1}:RIGHT`]).flat().sort());
  const before = structuredClone(j.initial);
  for (const event of j.events) {
    assert.ok(!event.snapshot.seating_snapshot);
    for (const row of event.snapshot.signup_rows) {
      const target = cells("SIGNUP", row), index = before.SIGNUP.findIndex(old => old[2] === row.member_id);
      if (index < 0) before.SIGNUP.push(target); else before.SIGNUP[index] = target;
    }
  }
  assert.equal(before.SIGNUP.length, 11); assert.equal(before.SEAT_PLAN_CURRENT.length, 20);
  assert.equal(before.SEAT_PLAN_REVISION.length, 1); assert.equal(before.SEAT_PLAN_REVISION[0][2], "1");
  const stages = s.signup_rows.map(row => ({ scope: "SIGNUP", target: cells("SIGNUP", row) }));
  for (const row of seating.draft_seats) stages.push({ scope: "SEAT_PLAN_CURRENT", target: cells("SEAT_PLAN_CURRENT",
    { season_id: season, practice_id: j.practice_id, ...row, seat_plan_version: 2,
      updated_by: state.updated_by, updated_at: state.updated_at }) });
  stages.push({ scope: "SEAT_PLAN_REVISION", target: cells("SEAT_PLAN_REVISION", {
    ...revision, seats_json: JSON.stringify(revision.seats), names_json: JSON.stringify(revision.names) }) });
  stages.push({ scope: "SEAT_PLAN_DRAFT", target: cells("SEAT_PLAN_DRAFT", { ...state,
    frozen_revision: before.SEAT_PLAN_DRAFT[0][6], frozen_at: before.SEAT_PLAN_DRAFT[0][7] }) });
  const batches = [];
  for (let at = 0; at < stages.length;) {
    const scope = stages[at].scope, callIndex = batches.length;
    const request_id = `${j.run_id}_export_10_${callIndex}`, batch_id = batchId(request_id), items = [];
    while (at < stages.length && stages[at].scope === scope && items.length < 4) {
      const target = stages[at].target, row_id = rowId(scope, target);
      const expected = before[scope].find(row => rowId(scope, row) === row_id) ?? null;
      items.push({ row_id, expected, target }); at++;
    }
    // Reject rather than guess a size-based split: the reviewed fixture must fit four rows
    // even using the maximum accepted numeric tab ID. Worker can then only split at four.
    assert.ok(JSON.stringify({ season_id: season, batch_id, entity_type: scope,
      spreadsheet_id: j.runtime_sheet_id, tab_id: "9999999999999999", items }).length <= 9500);
    assert.equal(new Set(items.map(i => i.row_id)).size, items.length);
    batches.push({ call_index: callIndex, scope, request_id, batch_id, items });
  }
  equal(batches.map(b => b.scope), ["SIGNUP", ...Array(5).fill("SEAT_PLAN_CURRENT"), "SEAT_PLAN_REVISION", "SEAT_PLAN_DRAFT"]);
  assert.ok(batches[0].items.every(i => i.expected !== null));
  assert.equal(batches[6].items.length, 1); assert.equal(batches[6].items[0].expected, null);
  return { format: "c2-associated-fault-v1", team_id: team, season_id: season, binding_version: 1,
    writer_epoch: 0, worker_url: worker, service_version: version, practice_id: j.practice_id,
    runtime_sheet_id: j.runtime_sheet_id, script_id: identity.script_id, deployment_id: identity.deployment_id,
    run_id: j.run_id, outbox_id: e.outbox_id, snapshot_digest: `sha256_v1:${sha(canonical(s))}`,
    clean_code_sha256: CLEAN_SHA256, partial: batches[0], lost_reply: batches[6], export_batches: batches,
    before_sheets: before,
    prior_cursor: { signup_version: 11, seat_plan_version: 1, published_revision: 1 },
    original_revision_sha256: hash(canonical(before.SEAT_PLAN_REVISION[0])) };
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, "Expected one exact v14 insertion point.");
  return source.replace(before, after);
}
export function buildOverlay(clean, plan) {
  assert.equal(hash(clean), CLEAN_SHA256);
  return renderOverlaySource(clean, plan);
}
// Pure renderer for local bridge behavior tests. Real generate() only calls the gated
// buildOverlay(), after full source/HEAD/deployed-v14 identity and hash validation.
export function renderOverlaySource(clean, plan) {
  const p = JSON.stringify(plan);
  let overlay = clean.replaceAll("\r\n", "\n");
  const partial = `      receipts.getRange(receiptRow, 6, 1, 3).setValues([[\n        "PARTIAL", JSON.stringify(verifiedIds), new Date().toISOString()\n      ]]);\n`;
  overlay = replaceOnce(overlay, partial, partial +
    `      if (c2AssociatedFaultMatches_(request, verified, input, scope, "partial") &&\n` +
    `          verifiedIds.length === 1 && id === ${JSON.stringify(plan.partial.items[0].row_id)}) {\n` +
    `        SpreadsheetApp.flush();\n` +
    `        if (c2AssociatedFaultOnce_("partial")) {\n` +
    `          throw dragonBoatRequestError_("TEST_ASSOCIATED_PARTIAL", "Isolated associated partial write.", true);\n` +
    `        }\n` +
    `      }\n`);
  const handler = `    return dragonBoatSuccess_(route.handle(request), requestId);\n`;
  overlay = replaceOnce(overlay, handler,
    `    var result = route.handle(request);\n` +
    `    if (request.action === "cloudflarePatchSeatPlanRevisionSheet" && result && result.status === "verified") {\n` +
    `      var faultVerified = verifyBridgeEnvelope_(request, null);\n` +
    `      if (c2AssociatedFaultMatches_(request, faultVerified, faultVerified.payload, "SEAT_PLAN_REVISION", "lost_reply") &&\n` +
    `          result.operation_id === C2_ASSOCIATED_FAULT_PLAN_.lost_reply.batch_id &&\n` +
    `          JSON.stringify(result.verified_row_ids) === JSON.stringify(C2_ASSOCIATED_FAULT_PLAN_.lost_reply.items.map(function (i) { return i.row_id; }))) {\n` +
    `        return withBridgeScriptLock_(function () {\n` +
    `          SpreadsheetApp.flush();\n` +
    `          return c2AssociatedFaultOnce_("lost_reply") ? ContentService.createTextOutput("") : dragonBoatSuccess_(result, requestId);\n` +
    `        });\n` +
    `      }\n` +
    `    }\n` +
    `    return dragonBoatSuccess_(result, requestId);\n`);
  const route = `  add("getSeasonManagement", "POST", function (r) { return withDragonBoatScriptLock_(function () { return getSeasonManagement_(r); }); });\n`;
  overlay = replaceOnce(overlay, route,
    `  add("c2TestReadAssociatedFaultReceipt", "POST", function (r) { return c2TestReadAssociatedFaultReceipt_(r); });\n` + route);
  overlay += `\n// PRIVATE ISOLATED OVERLAY ONLY. Remove by restoring every clean v14 source file.\n` +
    `var C2_ASSOCIATED_FAULT_PLAN_ = ${p};\n` +
    `function c2AssociatedFaultMatches_(request, verified, input, scope, kind) {\n` +
    `  var p = C2_ASSOCIATED_FAULT_PLAN_, t = p[kind];\n` +
    `  return ScriptApp.getScriptId() === p.script_id && verified.team_id === p.team_id &&\n` +
    `    verified.binding_version === p.season_id + ":1" && verified.writer_epoch === 0 &&\n` +
    `    input.season_id === p.season_id && input.spreadsheet_id === p.runtime_sheet_id &&\n` +
    `    input.batch_id === t.batch_id && verified.operation_id === t.batch_id &&\n` +
    `    request.request_id === t.request_id && scope === t.scope && input.entity_type === scope &&\n` +
    `    JSON.stringify(input.items) === JSON.stringify(t.items);\n` +
    `}\n` +
    `function c2AssociatedFaultOnce_(kind) {\n` +
    `  var p = C2_ASSOCIATED_FAULT_PLAN_, properties = getScriptProperties_();\n` +
    `  var key = "C2_ASSOCIATED_FAULT_ONCE_" + p[kind].batch_id;\n` +
    `  if (properties.getProperty(key) === "1") return false;\n` +
    `  properties.setProperty(key, "1");\n` +
    `  return true;\n` +
    `}\n` +
    `function c2TestReadAssociatedFaultReceipt_(request) {\n` +
    `  var verified = verifyBridgeEnvelope_(request, null), input = verified.payload, p = C2_ASSOCIATED_FAULT_PLAN_;\n` +
    `  var t = input.batch_id === p.partial.batch_id ? p.partial : input.batch_id === p.lost_reply.batch_id ? p.lost_reply : null;\n` +
    `  if (!t || ScriptApp.getScriptId() !== p.script_id || verified.team_id !== p.team_id ||\n` +
    `      verified.binding_version !== p.season_id + ":1" || verified.writer_epoch !== 0 ||\n` +
    `      input.season_id !== p.season_id || input.runtime_sheet_id !== p.runtime_sheet_id ||\n` +
    `      input.deployment_id !== p.deployment_id) {\n` +
    `    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "Isolated receipt scope invalid.");\n` +
    `  }\n` +
    `  return withBridgeScriptLock_(function () {\n` +
    `    var sheet = getSystemSpreadsheet_().getSheetByName("BridgeExportReceipts");\n` +
    `    var base = { batch_id: t.batch_id, scope: t.scope, team_id: p.team_id, season_id: p.season_id, binding_version: 1, writer_epoch: 0,\n` +
    `      operation_id: verified.operation_id, payload_digest: verified.payload_digest };\n` +
    `    if (!sheet || sheet.getLastRow() < 2) { base.status = "MISSING"; return base; }\n` +
    `    var matches = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(t.batch_id).matchEntireCell(true).matchCase(true).findAll();\n` +
    `    if (matches.length === 0) { base.status = "MISSING"; return base; }\n` +
    `    if (matches.length !== 1) throw dragonBoatRequestError_("BRIDGE_STATE_INVALID", "Receipt duplicated.");\n` +
    `    var row = sheet.getRange(matches[0].getRow(), 1, 1, 9).getDisplayValues()[0];\n` +
    `    if (row[0] !== t.batch_id || row[2] !== p.season_id || row[3] !== "1" || row[4] !== "0") {\n` +
    `      throw dragonBoatRequestError_("BRIDGE_STATE_INVALID", "Receipt ownership changed.");\n` +
    `    }\n` +
    `    base.status = row[5]; base.receipt_payload_digest = row[1]; base.result_json = row[6];\n` +
    `    base.once_consumed = getScriptProperties_().getProperty("C2_ASSOCIATED_FAULT_ONCE_" + t.batch_id) === "1";\n` +
    `    return base;\n` +
    `  });\n` +
    `}\n`;
  return overlay;
}

export function sourceFiles(directory) {
  const files = readdirSync(directory, { withFileTypes: true });
  assert.ok(files.every(f => f.isFile() && !f.isSymbolicLink()), "Source must be a reviewed flat file set.");
  const normalized = files.map(f => ({ source_name: f.name,
    name: /^(Code|C2Fixture)\.(gs|js)$/.test(f.name)
      ? f.name.startsWith("Code.") ? "Code.js" : "C2Fixture.gs" : f.name }));
  equal(normalized.map(f => f.name).sort(), ["C2Fixture.gs", "Code.js", "appsscript.json"]);
  return normalized.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(f =>
    ({ ...f, hash: hash(readFileSync(new URL(f.source_name, directory))) }));
}

export function assertCleanSourceSets(current, deployed, head) {
  const mapped = files => files.map(({ name, hash }) => ({ name, hash })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const files of [current, deployed, head]) {
    equal(files.map(f => f.name).sort(), ["C2Fixture.gs", "Code.js", "appsscript.json"]);
    assert.equal(files.find(f => f.name === "Code.js").hash, CLEAN_SHA256);
  }
  equal(mapped(current), mapped(head));
  for (const name of ["Code.js", "appsscript.json"]) {
    assert.equal(deployed.find(f => f.name === name).hash, head.find(f => f.name === name).hash);
  }
  assert.equal(deployed.find(f => f.name === "C2Fixture.gs").hash, DEPLOYED_FIXTURE_SHA256);
  assert.equal(head.find(f => f.name === "C2Fixture.gs").hash, HEAD_FIXTURE_SHA256);
}

function generate() {
  assert.ok(process.argv.includes("--build-isolated-overlay"));
  const privateRoot = new URL("../../.c2-form-test/", import.meta.url);
  const artifactRoot = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
  const identity = load(new URL("isolated-identities.json", privateRoot));
  const j = load(new URL("c2-waitlist-journal.json", artifactRoot));
  const fixture = load(new URL("private-test-config.json", privateRoot)).fixture;
  const clasp = load(new URL(".clasp.json", privateRoot));
  assert.equal(clasp.scriptId, identity.script_id); assert.equal(clasp.rootDir, "source");
  assert.equal(fixture.seasonId, season); assert.equal(fixture.runtimeSheetId, j.runtime_sheet_id);
  assert.equal(fixture.runtimeSheetId, process.env.C2_RUNTIME_SHEET_ID);
  assert.equal(process.env.C2_TEST_URL, worker);
  const bridge = new URL(load(new URL("worker-secrets.json", privateRoot)).GOOGLE_BRIDGE_URL);
  assert.equal(bridge.href, `https://script.google.com/macros/s/${identity.deployment_id}/exec`);
  const config = load(new URL("../cloudflare/wrangler.jsonc", import.meta.url)).env.c2test;
  assert.equal(config.vars.TEAM_ID, team); assert.equal(config.vars.WRITER_EPOCH, "0");
  assert.equal(config.vars.SERVICE_VERSION, version); assert.equal(config.vars.C2_EXPORT_POLL_ENABLED, "false");
  equal(config.triggers.crons, []);
  const current = new URL("source/", privateRoot), v14 = new URL("associated-fault-clean-v14/source/", privateRoot);
  const head = new URL("associated-fault-clean-head/source/", privateRoot);
  const hashes = sourceFiles(current), deployedHashes = sourceFiles(v14), headHashes = sourceFiles(head);
  assertCleanSourceSets(hashes, deployedHashes, headHashes);
  const deployedFixture = readFileSync(new URL(deployedHashes.find(f => f.name === "C2Fixture.gs").source_name, v14));
  const headFixture = readFileSync(new URL(headHashes.find(f => f.name === "C2Fixture.gs").source_name, head));
  assert.equal(headFixture.length - deployedFixture.length, 1613);
  assert.ok(headFixture.subarray(0, deployedFixture.length).equals(deployedFixture));
  for (const project of ["associated-fault-clean-v14/", "associated-fault-clean-head/"]) {
    const snapshotClasp = load(new URL(`${project}.clasp.json`, privateRoot));
    assert.equal(snapshotClasp.scriptId, identity.script_id); assert.equal(snapshotClasp.rootDir, "source");
  }
  const clean = readFileSync(new URL(deployedHashes.find(f => f.name === "Code.js").source_name, v14), "utf8");
  assert.equal(hash(clean), CLEAN_SHA256);
  assert.equal(hash(readFileSync(new URL("../backend/.build/Code.gs", import.meta.url))), CLEAN_SHA256);
  const plan = deriveFaultPlan(j, identity);
  // Audit-queued must have captured a private DO backup containing exactly this pending event.
  let audit;
  for (const name of readdirSync(artifactRoot).filter(n => /^backup_[A-Za-z0-9_-]+\.json$/.test(n))) {
    const backup = load(new URL(name, artifactRoot)), m = backup.manifest;
    const tables = Object.fromEntries(m.tables.map(t => [t.name, backup.chunks.filter(c => c.table_name === t.name).flatMap(c => c.payload.rows)]));
    const pending = tables.sync_outbox?.filter(r => r.status === "PENDING" && JSON.parse(r.payload_json).entity?.season_id === season) ?? [];
    if (pending.length !== 1 || pending[0].outbox_id !== j.cancel.outbox_id ||
        canonical(JSON.parse(pending[0].payload_json).entity) !== canonical(j.cancel.snapshot)) continue;
    const { content_digest, ...core } = m;
    assert.equal(content_digest, `sha256_v1:${sha(canonical(core))}`); assert.equal(m.schema_version, 13);
    assert.equal(backup.chunks.length, m.chunk_count);
    for (const c of backup.chunks) {
      assert.equal(c.payload_digest, `sha256_v1:${sha(canonical(c.payload))}`);
      equal(m.chunks[c.chunk_index], { chunk_index: c.chunk_index, table_name: c.table_name,
        row_offset: c.row_offset, row_count: c.row_count, payload_digest: c.payload_digest });
    }
    assert.equal(pending[0].topic, "SIGNUPS_CHANGED");
    assert.equal(JSON.parse(pending[0].payload_json).action, "cancelSignup");
    assert.equal(tables.sync_batches.filter(b => b.season_id === season && ["PREPARED", "SENT", "PARTIAL", "FAILED"].includes(b.status)).length, 0);
    const cursors = tables.sync_associated_cursors.filter(c => c.season_id === season && c.practice_id === j.practice_id);
    assert.equal(cursors.length, 1);
    for (const [key, value] of Object.entries(plan.prior_cursor)) assert.equal(cursors[0][key], value);
    audit = { snapshot_id: m.snapshot_id, content_digest }; break;
  }
  assert.ok(audit, "A verified cancellation audit snapshot is required.");
  const output = new URL("associated-fault-overlay/", artifactRoot);
  assert.ok(!existsSync(output), "Never replace a reviewed overlay or reset its once markers; resume the existing run.");
  const overlay = buildOverlay(clean, plan);
  mkdirSync(new URL("source/", output), { recursive: true });
  mkdirSync(new URL("clean-source/", output));
  mkdirSync(new URL("head-clean-source/", output));
  for (const { source_name } of deployedHashes) {
    copyFileSync(new URL(source_name, v14), new URL(`source/${source_name}`, output));
    copyFileSync(new URL(source_name, v14), new URL(`clean-source/${source_name}`, output));
  }
  for (const { source_name } of headHashes) {
    copyFileSync(new URL(source_name, head), new URL(`head-clean-source/${source_name}`, output));
  }
  copyFileSync(new URL(".clasp.json", privateRoot), new URL(".clasp.json", output));
  writeFileSync(new URL(`source/${deployedHashes.find(f => f.name === "Code.js").source_name}`, output), overlay);
  writeFileSync(new URL("fault-plan.json", output), JSON.stringify({ ...plan, audit_backup: audit,
    clean_source_files: deployedHashes, head_clean_source_files: headHashes,
    clean_source_directory: "clean-source/", head_clean_source_directory: "head-clean-source/",
    clean_deployment_version: 14, approved_fixture_append_bytes: 1613,
    overlay_code_sha256: hash(overlay) }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "GENERATED_NOT_DEPLOYED", clean_code_sha256: CLEAN_SHA256,
    overlay_code_sha256: hash(overlay), copied_clean_files: hashes.length, faults: 2,
    partial_scope: "SIGNUP", lost_reply_scope: "SEAT_PLAN_REVISION", private_output_ignored: true }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { generate(); } catch {
    console.error("Associated overlay generation stopped; inspect private prerequisites. No deployment was attempted.");
    process.exitCode = 1;
  }
}
