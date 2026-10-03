import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { deriveFaultPlan, buildOverlay, renderOverlaySource, headers, sourceFiles, assertCleanSourceSets,
  CLEAN_SHA256, DEPLOYED_FIXTURE_SHA256, HEAD_FIXTURE_SHA256 } from "./build-c2-associated-fault-overlay.mjs";
import { assertFaultEvidence } from "./live-c2-associated-fault-inspect.mjs";
import { assertFutureReceiptMissing } from "./live-c2-associated-pause-drain.mjs";

const season = "season_c2_isolated_2026", practice = "practice_synthetic_associated_001";
const run = "c2_wait_run_" + "a".repeat(32), alpha = "member_synthetic_alpha_001", waiter = "member_synthetic_waiter_001";
const identity = { script_id: "script_" + "x".repeat(32), deployment_id: "deploy_" + "y".repeat(32) };
const row = (scope, value) => headers[scope].map(k => String(value[k] ?? ""));
test("logical source names accept clasp extensions and reject duplicates or extra files", () => {
  const directory = mkdtempSync(join(tmpdir(), "c2-overlay-files-"));
  const target = pathToFileURL(directory + "/");
  try {
    for (const name of ["Code.js", "C2Fixture.js", "appsscript.json"]) writeFileSync(join(directory, name), "synthetic-source");
    assert.deepEqual(sourceFiles(target).map(f => f.name), ["C2Fixture.gs", "Code.js", "appsscript.json"]);
    writeFileSync(join(directory, "C2Fixture.gs"), "synthetic-source");
    assert.throws(() => sourceFiles(target));
    rmSync(join(directory, "C2Fixture.gs"));
    writeFileSync(join(directory, "unreviewed.js"), "synthetic-source");
    assert.throws(() => sourceFiles(target));
    rmSync(join(directory, "unreviewed.js")); rmSync(join(directory, "Code.js"));
    assert.throws(() => sourceFiles(target));
  } finally { rmSync(directory, { recursive: true }); }
});
test("clean source gate pins separately approved deployment and HEAD fixture hashes", () => {
  const files = fixtureHash => [
    { name: "C2Fixture.gs", source_name: "C2Fixture.js", hash: fixtureHash },
    { name: "Code.js", source_name: "Code.js", hash: CLEAN_SHA256 },
    { name: "appsscript.json", source_name: "appsscript.json", hash: "same-manifest" }];
  const deployed = files(DEPLOYED_FIXTURE_SHA256), head = files(HEAD_FIXTURE_SHA256);
  const current = structuredClone(head); current[0].source_name = "C2Fixture.gs";
  assert.doesNotThrow(() => assertCleanSourceSets(current, deployed, head));
  for (const [which, index] of [[0,0], [1,0], [2,0], [1,1], [2,2]]) {
    const sets = [structuredClone(current), structuredClone(deployed), structuredClone(head)];
    sets[which][index].hash = "unreviewed-source";
    assert.throws(() => assertCleanSourceSets(...sets));
  }
  assert.throws(() => assertCleanSourceSets(deployed, deployed, head));
  assert.throws(() => assertCleanSourceSets(head, head, head));
});
// Build in memory so npm test needs no ignored output or private v14 snapshot. These
// behavior tests use the current bridge; real generator independently requires v14's
// immutable hash and full deployed/HEAD snapshots. Never relax that historical gate.
function backendSource() {
  const build = readFileSync(new URL("../backend/build.mjs", import.meta.url), "utf8");
  const list = build.match(/const sourceOrder = \[([\s\S]*?)\];/)[1];
  return [...list.matchAll(/"([A-Za-z]+\.gs)"/g)].map(([,name]) =>
    `// ---- ${name} ----\n${readFileSync(new URL(`../backend/src/${name}`, import.meta.url), "utf8").trim()}\n`).join("\n");
}
function fixture() {
  const signup = (member_id, status, sequence, request) => ({ season_id: season, practice_id: practice,
    member_id, preference: "LEFT", status, queue_at: "2026-09-30T12:00:00.000Z", queue_sequence: sequence,
    updated_at: "2026-09-30T12:00:00.000Z", last_request_id: request });
  const seats = Array.from({ length: 10 }, (_, i) => ["LEFT", "RIGHT"].map(side => ({
    row_number: i + 1, side, member_id: i === 0 && side === "LEFT" ? waiter : "" }))).flat();
  const state = { season_id: season, practice_id: practice, seat_plan_version: 2, published_revision: 2,
    coach_member_id: "", steerer_member_id: "", updated_by: "coach_synthetic_001", updated_at: "2026-09-30T12:05:00.000Z" };
  const revision = { ...state, revision_number: 2, revision_id: "revision_synthetic_002", source: "SYSTEM_CANCELSIGNUP",
    seats: [{ row_number: 1, side: "LEFT", member_id: waiter }], names: [{ member_id: waiter, display_name: "Lambda" }],
    published_by: state.updated_by, published_at: state.updated_at, request_id: `${run}_cancel` };
  const snapshot = { season_id: season, practice_id: practice, practice_version: 2, snapshot_schema: 2,
    signup_version: 12, member_id: alpha, seat_plan_version: 2, published_revision: 2,
    signup_rows: [signup(alpha, "CANCELLED", 1, `${run}_cancel`), signup(waiter, "CONFIRMED", 11, `${run}_cancel`)],
    seating_snapshot: { state, draft_seats: seats, revision } };
  const oldState = { ...state, seat_plan_version: 1, published_revision: 1 };
  const oldRevision = { ...revision, ...oldState, revision_number: 1, revision_id: "revision_synthetic_001", source: "MANUAL",
    seats_json: JSON.stringify([{ row_number: 1, side: "LEFT", member_id: alpha }]), names_json: "[]" };
  const j = { format: 1, run_id: run,
    worker_url: "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/",
    service_version: "0.16.2-c2-physical-diagnostics", deployment_id: identity.deployment_id,
    runtime_sheet_id: "spreadsheet_synthetic_private_001", practice_id: practice, alpha_id: alpha, waiter_id: waiter,
    initial: { SIGNUP: [row("SIGNUP", signup(alpha, "CONFIRMED", 1, "initial_request_001"))],
      SEAT_PLAN_CURRENT: seats.map(s => row("SEAT_PLAN_CURRENT", { ...s, ...oldState,
        member_id: s.member_id ? alpha : "" })),
      SEAT_PLAN_REVISION: [row("SEAT_PLAN_REVISION", oldRevision)], SEAT_PLAN_DRAFT: [row("SEAT_PLAN_DRAFT", oldState)] },
    events: Array.from({ length: 10 }, (_, i) => ({ confirmed: true, snapshot: { signup_version: i + 2,
      signup_rows: [signup(i === 9 ? waiter : `member_synthetic_fill_00${i}`, i === 9 ? "WAITLISTED" : "CONFIRMED", i + 2, `${run}_signup_${i + 1}`)] } })),
    cancel: { result: { promoted_member_ids: [waiter], signup_version: 12, published_revision: 2 },
      outbox_id: "outbox_synthetic_cancel_001", due_at_ms: 12345, snapshot,
      payload: { request_id: `${run}_cancel`, season_id: season, practice_id: practice, member_id: alpha, signup_version: 11 },
      export_calls: [] } };
  return j;
}

test("fault plan derives exact request/batch ordering and rejects oversized or unaudited cancellations", () => {
  const j = fixture(), plan = deriveFaultPlan(j, identity);
  assert.equal(plan.partial.call_index, 0); assert.equal(plan.partial.items.length, 2);
  assert.equal(plan.lost_reply.call_index, 6); assert.equal(plan.lost_reply.items.length, 1);
  assert.equal(plan.export_batches.length, 8);
  assert.notEqual(plan.partial.batch_id, plan.lost_reply.batch_id);
  const pending = structuredClone(j); pending.cancel.inflight = { request_id: "already_started" };
  assert.throws(() => deriveFaultPlan(pending, identity));
  const oversized = structuredClone(j); oversized.cancel.snapshot.seating_snapshot.state.updated_at = "x".repeat(9500);
  assert.throws(() => deriveFaultPlan(oversized, identity));
  const duplicate = structuredClone(j); duplicate.cancel.snapshot.seating_snapshot.draft_seats[19] =
    duplicate.cancel.snapshot.seating_snapshot.draft_seats[18];
  assert.throws(() => deriveFaultPlan(duplicate, identity));
});

test("overlay renderer compiles, exact scope guards reject unrelated requests, and once markers persist", () => {
  const plan = deriveFaultPlan(fixture(), identity);
  const clean = backendSource();
  const overlay = renderOverlaySource(clean, plan);
  new vm.Script(overlay);
  assert.throws(() => buildOverlay(clean + "\n", plan));
  const properties = new Map(); let lockCalls = 0;
  const context = vm.createContext({ ScriptApp: { getScriptId: () => plan.script_id },
    getScriptProperties_: () => ({ getProperty: k => properties.get(k), setProperty: (k,v) => properties.set(k,v) }),
    withBridgeScriptLock_: cb => { lockCalls++; return cb(); },
    dragonBoatRequestError_: code => new Error(code) });
  vm.runInContext(overlay.slice(overlay.indexOf("// PRIVATE ISOLATED OVERLAY ONLY.")), context);
  const request = { request_id: plan.partial.request_id };
  const verified = { team_id: plan.team_id, binding_version: `${season}:1`, writer_epoch: 0, operation_id: plan.partial.batch_id };
  const input = { season_id: season, spreadsheet_id: plan.runtime_sheet_id, batch_id: plan.partial.batch_id,
    entity_type: "SIGNUP", items: plan.partial.items };
  const match = (r,v,p) => context.c2AssociatedFaultMatches_(r,v,p,"SIGNUP","partial");
  assert.equal(match(request,verified,input), true);
  assert.equal(match(request,{ ...verified, team_id: "other_team" },input), false);
  assert.equal(match(request,{ ...verified, writer_epoch: 1 },input), false);
  assert.equal(match(request,verified,{ ...input, batch_id: plan.lost_reply.batch_id }), false);
  const changed = structuredClone(input); changed.items[0].target[4] = "CONFIRMED";
  assert.equal(match(request,verified,changed), false);
  assert.equal(context.c2AssociatedFaultOnce_("partial"), true);
  assert.equal(context.c2AssociatedFaultOnce_("partial"), false);
  assert.equal(context.c2AssociatedFaultOnce_("lost_reply"), true);
  assert.equal(context.c2AssociatedFaultOnce_("lost_reply"), false);
  const beforeHandler = overlay.indexOf('var result = route.handle(request);');
  const lostReply = overlay.slice(beforeHandler, overlay.indexOf('return dragonBoatSuccess_(result, requestId);', beforeHandler));
  assert.match(lostReply, /withBridgeScriptLock_/);
  const hook = overlay.slice(overlay.indexOf('if (c2AssociatedFaultMatches_(request, verified, input, scope, "partial")'));
  assert.ok(hook.indexOf("SpreadsheetApp.flush();") < hook.indexOf('c2AssociatedFaultOnce_("partial")'));
  assert.equal(lockCalls, 0); // Guards and marker checks themselves never mutate business rows.
});

test("inspector proves partial target/expected rows, prior B/cursor, and same-batch recovery", () => {
  const j = fixture(), plan = deriveFaultPlan(j, identity);
  const before = { sync_baselines: [], sync_associated_physical_baselines: [] };
  const target = plan.partial;
  const base = { season_id: season, binding_version: 1, writer_epoch: 0, first_outbox_id: plan.outbox_id,
    last_outbox_id: plan.outbox_id, batch_id: target.batch_id, status: "FAILED", payload_digest: "original_payload_digest" };
  const tables = { ...before, sync_outbox: [{ status: "PENDING", outbox_id: plan.outbox_id,
    payload_json: JSON.stringify({ entity: j.cancel.snapshot }) }],
    sync_associated_cursors: [{ season_id: season, practice_id: practice, ...plan.prior_cursor }],
    sync_batches: [base], sync_batch_items: target.items.map((item,index) => ({ batch_id: target.batch_id,
      item_index: index, entity_type: "SIGNUP", dependency_group: "SIGNUP", status: "PENDING",
      target_json: JSON.stringify({ ...item, scope: "SIGNUP" }) })) };
  const pages = structuredClone(plan.before_sheets);
  pages.SIGNUP[pages.SIGNUP.findIndex(r => `${r[1]}:${r[2]}` === target.items[0].row_id)] = target.items[0].target;
  const receipts = { SIGNUP: { status: "PARTIAL", receipt_payload_digest: base.payload_digest,
    once_consumed: true, result_json: JSON.stringify([target.items[0].row_id]) } };
  j.cancel.inflight = { request_id: target.request_id };
  assert.equal(assertFaultEvidence("partial", plan, j, tables, before, pages, receipts).pending_batches, 1);
  const wrong = structuredClone(tables); wrong.sync_associated_cursors[0].signup_version = 12;
  assert.throws(() => assertFaultEvidence("partial", plan, j, wrong, before, pages, receipts));
  const overwritten = structuredClone(pages);
  overwritten.SIGNUP[overwritten.SIGNUP.findIndex(r => `${r[1]}:${r[2]}` === target.items[1].row_id)] = target.items[1].target;
  assert.throws(() => assertFaultEvidence("partial", plan, j, tables, before, overwritten, receipts));
  tables.sync_batches[0].status = "CONFIRMED";
  for (const item of tables.sync_batch_items) item.status = "VERIFIED";
  j.cancel.inflight = null; j.cancel.export_calls = [{ batch_id: target.batch_id, entity_type: "SIGNUP" }];
  receipts.SIGNUP.status = "VERIFIED";
  receipts.SIGNUP.result_json = JSON.stringify({ status: "verified", operation_id: target.batch_id,
    entity_type: "SIGNUP", verified_row_ids: target.items.map(i => i.row_id) });
  assert.equal(assertFaultEvidence("recovered", plan, j, tables, before, overwritten, receipts).pending_batches, 0);
});

test("actual overlay bridge writes only the first signup before fault and returns one empty revision reply", () => {
  const j = fixture(), plan = deriveFaultPlan(j, identity);
  const clean = backendSource();
  const context = vm.createContext({ console });
  new vm.Script(renderOverlaySource(clean, plan)).runInContext(context);
  class Tab {
    constructor(header, rows, tabId) { this.rows = [header, ...structuredClone(rows)]; this.tabId = tabId; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return this.rows[0].length; }
    getSheetId() { return this.tabId; }
    getRange(start, column, height, width) {
      const tab = this;
      return {
        getDisplayValues: () => Array.from({ length: height }, (_, i) =>
          Array.from({ length: width }, (_, k) => String(tab.rows[start + i - 1]?.[column + k - 1] ?? ""))),
        setNumberFormat() { return this; },
        setValues(rows) {
          for (const [i,row] of rows.entries()) for (const [k,value] of row.entries()) {
            tab.rows[start + i - 1] ??= [];
            tab.rows[start + i - 1][column + k - 1] = String(value);
          }
          return this;
        },
        createTextFinder(value) { return { matchEntireCell() { return this; }, matchCase() { return this; },
          findAll: () => tab.rows.flatMap((row,i) => i >= start - 1 && row[column - 1] === value
            ? [{ getRow: () => i + 1 }] : []) }; }
      };
    }
  }
  const properties = new Map(); let flushes = 0;
  const seasonHeaders = Array.from(context.DRAGON_BOAT_SHEET_HEADERS_.Seasons);
  const seasonTab = new Tab(seasonHeaders, [seasonHeaders.map(h => h === "season_id" ? season :
    h === "binding_version" ? "1" : h === "runtime_spreadsheet_id" ? plan.runtime_sheet_id : "")], 1);
  const receiptTab = new Tab(Array.from(context.DRAGON_BOAT_SHEET_HEADERS_.BridgeExportReceipts),
    [["batch_unrelated_old_001", "unrelated", season, "1", "0", "VERIFIED", "{}", "old", "old"]], 2);
  const signupTab = new Tab(headers.SIGNUP, plan.before_sheets.SIGNUP, 3);
  const revisionTab = new Tab(headers.SEAT_PLAN_REVISION, plan.before_sheets.SEAT_PLAN_REVISION, 4);
  const runtime = { getId: () => plan.runtime_sheet_id,
    getSheetByName: name => name === "SignupsCurrent" ? signupTab : name === "SeatPlanRevisions" ? revisionTab : null };
  Object.assign(context, {
    ScriptApp: { getScriptId: () => plan.script_id }, SpreadsheetApp: { flush: () => { flushes++; } },
    createDragonBoatRequestId_: () => "request_synthetic_handler_001",
    ContentService: { createTextOutput: text => ({ text }) },
    getScriptProperties_: () => ({ getProperty: k => properties.get(k), setProperty: (k,v) => properties.set(k,v) }),
    withBridgeScriptLock_: cb => cb(), ensureSheetHeader_: () => {},
    requireSeason_: () => ({ binding_version: 1, runtime_spreadsheet_id: plan.runtime_sheet_id }),
    getSeasonSpreadsheet_: () => runtime, getSystemSheet_: () => seasonTab,
    getSystemSpreadsheet_: () => ({ getSheetByName: () => receiptTab }),
    verifyBridgeEnvelope_: request => ({ protocol: "2026-09-19.bridge.v1", team_id: plan.team_id,
      binding_version: `${season}:1`, writer_epoch: 0, operation_id: request.operation_id,
      payload_digest: request.payload_digest, payload: JSON.parse(request.payload_json) }),
    dragonBoatSuccess_: data => ({ ok: true, data }),
    dragonBoatError_: (code, _message, retryable) => ({ ok: false, error: { code, retryable } })
  });
  const requestFor = (spec, action) => ({ action, request_id: spec.request_id, operation_id: spec.batch_id,
    payload_digest: "synthetic_payload_digest", payload_json: JSON.stringify({ season_id: season,
      batch_id: spec.batch_id, spreadsheet_id: plan.runtime_sheet_id, tab_id: String(spec.scope === "SIGNUP" ? 3 : 4),
      entity_type: spec.scope, items: spec.items }) });
  const probe = { operation_id: "probe_synthetic_001", payload_digest: "probe_digest", payload_json: JSON.stringify({
    season_id: season, batch_id: plan.partial.batch_id, runtime_sheet_id: plan.runtime_sheet_id, deployment_id: plan.deployment_id }) };
  const missingReceipt = context.c2TestReadAssociatedFaultReceipt_(probe);
  assert.equal(missingReceipt.status, "MISSING");
  assert.equal(Object.hasOwn(missingReceipt, "once_consumed"), false);
  assertFutureReceiptMissing(missingReceipt);
  const badProbe = { ...probe, payload_json: JSON.stringify({ ...JSON.parse(probe.payload_json), batch_id: "batch_unrelated_old_001" }) };
  assert.throws(() => context.c2TestReadAssociatedFaultReceipt_(badProbe));
  const partialRequest = requestFor(plan.partial, "cloudflarePatchSignupSheet");
  assert.throws(() => context.cloudflarePatchSignupSheet_(partialRequest), /Isolated associated partial write/);
  for (const [index,item] of plan.partial.items.entries()) {
    const actual = signupTab.rows.find(r => `${r[1]}:${r[2]}` === item.row_id);
    assert.deepEqual(actual, index === 0 ? item.target : item.expected);
  }
  const partialReceipt = context.c2TestReadAssociatedFaultReceipt_(probe);
  assert.equal(partialReceipt.status, "PARTIAL"); assert.equal(partialReceipt.once_consumed, true);
  assert.deepEqual(JSON.parse(partialReceipt.result_json), [plan.partial.items[0].row_id]);
  const recovered = context.cloudflarePatchSignupSheet_(partialRequest);
  assert.equal(recovered.status, "verified");
  for (const item of plan.partial.items) assert.deepEqual(signupTab.rows.find(r => `${r[1]}:${r[2]}` === item.row_id), item.target);
  const originalRevision = [...revisionTab.rows[1]];
  const revisionRequest = requestFor(plan.lost_reply, "cloudflarePatchSeatPlanRevisionSheet");
  const invoke = () => context.handleDragonBoatRequest_("POST", { postData: { contents: JSON.stringify(revisionRequest) } });
  assert.deepEqual(invoke(), { text: "" });
  assert.equal(revisionTab.rows.length, 3);
  assert.deepEqual(revisionTab.rows[1], originalRevision);
  assert.equal(receiptTab.rows.find(r => r[0] === plan.lost_reply.batch_id)[5], "VERIFIED");
  assert.equal(invoke().data.status, "verified");
  assert.equal(revisionTab.rows.length, 3); assert.deepEqual(revisionTab.rows[1], originalRevision);
  assert.ok(flushes >= 5);
});

test("inspector accepts actual logical seat item shape after lost reply and rejects unknown batches", () => {
  const j = fixture(), plan = deriveFaultPlan(j, identity), before = { sync_baselines: [], sync_associated_physical_baselines: [] };
  const tables = { ...before, sync_outbox: [{ status: "PENDING", outbox_id: plan.outbox_id,
    payload_json: JSON.stringify({ entity: j.cancel.snapshot }) }],
    sync_associated_cursors: [{ season_id: season, practice_id: practice, ...plan.prior_cursor }],
    sync_batches: [], sync_batch_items: [] };
  const pages = structuredClone(plan.before_sheets);
  for (const spec of plan.export_batches.slice(0,7)) {
    tables.sync_batches.push({ season_id: season, binding_version: 1, writer_epoch: 0,
      first_outbox_id: plan.outbox_id, last_outbox_id: plan.outbox_id, batch_id: spec.batch_id,
      status: spec.call_index === 6 ? "FAILED" : "CONFIRMED", payload_digest: "fixed_original_payload" });
    for (const [index,item] of spec.items.entries()) {
      tables.sync_batch_items.push({ batch_id: spec.batch_id, item_index: index,
        entity_type: spec.scope === "SIGNUP" ? "SIGNUP" : "SEAT_PLAN_DRAFT", dependency_group: spec.scope,
        status: spec.call_index === 6 ? "PENDING" : "VERIFIED", target_json: JSON.stringify({ ...item, scope: spec.scope }) });
      const identity = r => spec.scope === "SIGNUP" ? `${r[1]}:${r[2]}` :
        spec.scope === "SEAT_PLAN_CURRENT" ? `${r[1]}:${r[2]}:${r[3]}` : `${r[1]}:${r[2]}`;
      const at = pages[spec.scope].findIndex(r => identity(r) === item.row_id);
      if (at < 0) pages[spec.scope].push(item.target); else pages[spec.scope][at] = item.target;
    }
  }
  j.cancel.export_calls = plan.export_batches.slice(0,6).map(s => ({ batch_id: s.batch_id, entity_type: s.scope }));
  j.cancel.inflight = { request_id: plan.lost_reply.request_id };
  const receipts = { SEAT_PLAN_REVISION: { status: "VERIFIED", receipt_payload_digest: "fixed_original_payload",
    once_consumed: true, result_json: JSON.stringify({ status: "verified", operation_id: plan.lost_reply.batch_id,
      entity_type: "SEAT_PLAN_REVISION", verified_row_ids: plan.lost_reply.items.map(i => i.row_id) }) } };
  assert.equal(assertFaultEvidence("lost-reply",plan,j,tables,before,pages,receipts).pending_batches,1);
  const wrong = structuredClone(tables); wrong.sync_batches.push({ ...wrong.sync_batches[0], batch_id: "batch_unknown_001" });
  assert.throws(() => assertFaultEvidence("lost-reply",plan,j,wrong,before,pages,receipts));
});
