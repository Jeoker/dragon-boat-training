import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { CLEAN_SHA256 } from "./build-c2-associated-fault-overlay.mjs";
import { assertPauseJournal, createPauseState, assertPauseEvidence, assertFutureReceiptMissing, runPausePhase } from "./live-c2-associated-pause-drain.mjs";

const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ?
  `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const sha = v => createHash("sha256").update(v).digest("base64url");
const digest = v => `sha256_v1:${sha(canonical(v))}`;
function fixture() {
  const season = "season_c2_isolated_2026", practice = "practice_synthetic_pause_001", run = "c2_wait_run_" + "b".repeat(32);
  const request_id = `${run}_export_10_0`, batch_id = `batch_${sha(`pentasus-c2-test\nC2:EXPORT\nexportNextAssociated\n${request_id}`)}`;
  const snapshot = { season_id: season, practice_id: practice, signup_version: 12 };
  const old = [[season, practice, "member_alpha_001", "LEFT", "CONFIRMED", "old", "1", "old", "old"],
    [season, practice, "member_waiter_001", "LEFT", "WAITLISTED", "old", "11", "old", "old"]];
  const target = old.map((r,i) => { const v = [...r]; v[4] = i ? "CONFIRMED" : "CANCELLED"; v[7] = "new"; v[8] = `${run}_cancel`; return v; });
  const partial = { call_index: 0, request_id, batch_id, scope: "SIGNUP", items: old.map((r,i) =>
    ({ row_id: `${practice}:${r[2]}`, expected: r, target: target[i] })) };
  const plan = { run_id: run, team_id: "pentasus-c2-test", season_id: season, practice_id: practice,
    worker_url: "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/",
    service_version: "0.16.2-c2-physical-diagnostics", runtime_sheet_id: "spreadsheet_synthetic_pause_001",
    deployment_id: "deployment_synthetic_pause_001", clean_code_sha256: CLEAN_SHA256, writer_epoch: 0, binding_version: 1,
    outbox_id: "out_synthetic_pause_001", snapshot_digest: digest(snapshot), prior_cursor: { signup_version: 11, seat_plan_version: 1, published_revision: 1 },
    partial, export_batches: [partial], before_sheets: { SIGNUP: old, SEAT_PLAN_CURRENT: [[season, practice, "1", "LEFT", "member_alpha_001", "1", "old", "old"]],
      SEAT_PLAN_DRAFT: [[season, practice, "1", "", "", "1", "0", "", "old", "old"]],
      SEAT_PLAN_REVISION: [[season, practice, "1", "revision_old_001", "MANUAL", "1", "", "", "[]", "[]", "old", "old", "old"]] } };
  const journal = { format: 1, run_id: run, worker_url: plan.worker_url, service_version: plan.service_version,
    runtime_sheet_id: plan.runtime_sheet_id, deployment_id: plan.deployment_id, practice_id: practice,
    events: Array.from({ length: 10 }, () => ({ confirmed: true })), initial: structuredClone(plan.before_sheets),
    cancel: { snapshot, outbox_id: plan.outbox_id, export_calls: [], inflight: { request_id, season_id: season } } };
  const before = { sync_baselines: [{ season_id: season, binding_version: 1, baseline_json: "prior_baseline" }],
    sync_associated_physical_baselines: [{ season_id: season, binding_version: 1, cells_json: "prior_physical_cells" }] };
  const data = recovered => {
    const tables = { ...structuredClone(before), sync_outbox: [{ status: "PENDING", outbox_id: plan.outbox_id,
      payload_json: JSON.stringify({ entity: snapshot }) }], sync_associated_cursors: [{ season_id: season, practice_id: practice, ...plan.prior_cursor }],
      sync_batches: [{ season_id: season, binding_version: 1, writer_epoch: 0, first_outbox_id: plan.outbox_id, last_outbox_id: plan.outbox_id,
        batch_id, status: recovered ? "CONFIRMED" : "FAILED", payload_digest: "original_payload_digest" }],
      sync_batch_items: partial.items.map((i,index) => ({ batch_id, item_index: index, entity_type: "SIGNUP", dependency_group: "SIGNUP",
        status: recovered ? "VERIFIED" : "PENDING", target_json: JSON.stringify({ ...i, scope: "SIGNUP" }) })) };
    const pages = structuredClone(plan.before_sheets); pages.SIGNUP[0] = target[0]; if (recovered) pages.SIGNUP[1] = target[1];
    const receipts = { SIGNUP: { once_consumed: true, receipt_payload_digest: "original_payload_digest", status: recovered ? "VERIFIED" : "PARTIAL",
      result_json: JSON.stringify(recovered ? { status: "verified", operation_id: batch_id, entity_type: "SIGNUP",
        verified_row_ids: partial.items.map(i => i.row_id) } : [partial.items[0].row_id]) } };
    return { tables, pages, receipts };
  };
  const result = { status: "BATCH_CONFIRMED", season_id: season, batch_id, outbox_id: plan.outbox_id,
    entity_type: "SIGNUP", row_id: partial.items[0].row_id, row_ids: partial.items.map(i => i.row_id), cloud_version: 12 };
  return { plan, journal, before, data, result };
}
function harness() {
  const f = fixture(), state = createPauseState(f.plan, f.journal), calls = [];
  let diskState = structuredClone(state), diskJournal = structuredClone(f.journal), paused = false, recovered = false;
  let lostPhase, knownErrorPhase, crashJournal, crashAfterJournal;
  const options = () => ({ ...f, state, persistState(s) { diskState = structuredClone(s); },
    persistJournal(next, expected) {
      assert.equal(canonical(diskJournal), canonical(expected));
      if (crashJournal) { crashJournal = false; throw new Error("journal disk error"); }
      diskJournal = structuredClone(next);
      if (crashAfterJournal) { crashAfterJournal = false; throw new Error("process stopped after rename"); }
    },
    async capture(j, allowed) {
      const d = f.data(recovered), status = paused ? recovered ? "PAUSED" : "PAUSING" : "RUNNING";
      const overview = { schema_version: 13, binding_current: true, binding: { runtime_spreadsheet_id: f.plan.runtime_sheet_id, binding_version: 1 },
        export_control: { status, pause_requested: paused, source_paused: false, retry: null,
          unfinished_batch: recovered ? null : { batch_id: f.plan.partial.batch_id, status: "FAILED" } },
        counts: { pending_outbox: 1, pending_batches: recovered ? 0 : 1, open_conflicts: 0, sources_needing_review: 0 } };
      const kind = assertPauseEvidence(f.plan, j, d.tables, f.before, d.pages, d.receipts, overview, allowed);
      return { kind, status, paused };
    },
    async api(path, payload) {
      const phase = Object.keys(state.requests).find(p => state.requests[p] === payload.request_id);
      assert.ok(phase); calls.push({ phase, path, payload: structuredClone(payload) });
      assert.equal(payload.season_id, f.plan.season_id);
      if (knownErrorPhase === phase) { knownErrorPhase = null; return { ok: false, http_status: 503, error_code: "BRIDGE_UNAVAILABLE" }; }
      let response;
      if (phase === "early-resume" || phase === "next-stage") response = { ok: false, http_status: 409,
        error_code: phase === "early-resume" ? "SYNC_EXPORT_DRAINING" : "SYNC_EXPORT_PAUSED" };
      else if (phase === "drain") { recovered = true; response = { ok: true, http_status: 200, data: f.result }; }
      else { paused = phase === "pause"; response = { ok: true, http_status: 200, data: { result: {
        season_id: f.plan.season_id, status: paused ? "PAUSING" : "RUNNING", unfinished_batch_id: paused ? f.plan.partial.batch_id : null } } }; }
      if (lostPhase === phase) { lostPhase = null; throw new Error("response unknown after commit"); }
      return response;
    } });
  return { ...f, state, calls, run: phase => runPausePhase({ ...options(), phase }),
    lose: phase => { lostPhase = phase; }, failKnown: phase => { knownErrorPhase = phase; },
    crashBeforeJournal: () => { crashJournal = true; }, crashAfterJournal: () => { crashAfterJournal = true; },
    reload() { Object.assign(state, structuredClone(diskState)); Object.assign(f.journal, structuredClone(diskJournal)); },
    diskJournal: () => structuredClone(diskJournal), diskState: () => structuredClone(diskState) };
}

test("pause drains only the exact original fault batch; early resume/next batch are refused", async () => {
  const h = harness();
  for (const phase of ["pause", "early-resume", "drain", "next-stage", "resume"]) {
    const count = h.calls.length; assert.equal((await h.run(phase)).status, "STAGE_CONFIRMED"); assert.equal(h.calls.length, count + 1);
  }
  assertPauseJournal(h.plan, h.diskJournal(), true);
  assert.deepEqual(h.diskJournal().cancel.export_calls, [h.result]);
  const drain = h.calls.find(c => c.phase === "drain"); assert.deepEqual(drain.payload,
    { request_id: h.plan.partial.request_id, season_id: h.plan.season_id });
  assert.notEqual(h.state.requests["next-stage"], `${h.plan.run_id}_export_10_1`);
  const count = h.calls.length; await h.run("early-resume"); await h.run("next-stage"); assert.equal(h.calls.length, count);
});
test("unknown pause and resume commit retry their persisted original stage ID without auto advancing", async () => {
  const h = harness(); h.lose("pause"); await assert.rejects(h.run("pause"));
  assert.deepEqual(h.state.completed, []); assert.equal(h.calls.length, 1); h.reload(); await h.run("pause");
  assert.equal(h.calls[0].payload.request_id, h.calls[1].payload.request_id);
  await h.run("early-resume"); await h.run("drain"); await h.run("next-stage");
  h.lose("resume"); await assert.rejects(h.run("resume")); assert.equal(h.state.completed.length, 4);
  h.reload(); await h.run("resume"); assert.equal(h.calls.at(-1).payload.request_id, h.calls.at(-2).payload.request_id);
});
test("unknown drain after Google confirmation retains inflight and retries the same operation", async () => {
  const h = harness(); await h.run("pause"); await h.run("early-resume"); h.lose("drain"); await assert.rejects(h.run("drain"));
  assert.equal(h.diskJournal().cancel.export_calls.length, 0); assert.ok(h.diskJournal().cancel.inflight);
  assert.deepEqual(h.state.completed, ["pause", "early-resume"]); await assert.rejects(h.run("resume"));
  h.reload(); await h.run("drain"); assert.equal(h.calls.filter(c => c.phase === "drain").length, 2);
  assert.equal(new Set(h.calls.filter(c => c.phase === "drain").map(c => c.payload.request_id)).size, 1);
  assert.equal(h.diskJournal().cancel.export_calls.length, 1);
});
test("known drain response survives runner journal failures on either side of its atomic rename", async () => {
  for (const after of [false, true]) {
    const h = harness(); await h.run("pause"); await h.run("early-resume");
    if (after) h.crashAfterJournal(); else h.crashBeforeJournal();
    await assert.rejects(h.run("drain")); assert.equal(h.state.results.drain.ok, true);
    h.reload(); await h.run("drain"); assert.equal(h.calls.filter(c => c.phase === "drain").length, 1);
    assert.equal(h.diskJournal().cancel.export_calls.length, 1); assert.ok(!h.diskState().pending_runner_anchor);
  }
});
test("known transient drain failure can retry its original ID; unrelated runner changes stop all calls", async () => {
  const h = harness(); await h.run("pause"); await h.run("early-resume"); h.failKnown("drain");
  await assert.rejects(h.run("drain")); assert.ok(!h.state.results.drain); assert.ok(h.journal.cancel.inflight);
  await h.run("drain"); assert.equal(h.calls.filter(c => c.phase === "drain").length, 2);
  const count = h.calls.length; h.journal.events[0].confirmed = false;
  await assert.rejects(h.run("next-stage")); assert.equal(h.calls.length, count);
});
test("private evidence rejects changed baselines/cursor/unknown batch and preserves revision one", () => {
  const f = fixture(), d = f.data(false), overview = { schema_version: 13, binding_current: true,
    binding: { runtime_spreadsheet_id: f.plan.runtime_sheet_id, binding_version: 1 }, export_control: {
      source_paused: false, retry: null, unfinished_batch: { batch_id: f.plan.partial.batch_id, status: "FAILED" } },
    counts: { open_conflicts: 0, sources_needing_review: 0, pending_outbox: 1, pending_batches: 1 } };
  const check = (tables = d.tables, pages = d.pages) => assertPauseEvidence(f.plan, f.journal, tables,
    f.before, pages, d.receipts, overview, ["partial"]);
  assert.equal(check(), "partial");
  const changedB = structuredClone(d.tables); changedB.sync_baselines[0].baseline_json = "new"; assert.throws(() => check(changedB));
  const changedCursor = structuredClone(d.tables); changedCursor.sync_associated_cursors[0].signup_version = 12; assert.throws(() => check(changedCursor));
  const newBatch = structuredClone(d.tables); newBatch.sync_batches.push({ ...newBatch.sync_batches[0], batch_id: "batch_unknown_001" }); assert.throws(() => check(newBatch));
  const revision = structuredClone(d.pages); revision.SEAT_PLAN_REVISION[0][4] = "changed"; assert.throws(() => check(d.tables, revision));
});
test("future MISSING receipt accepts the deployed probe's absent marker field without asserting false", () => {
  assertFutureReceiptMissing({ status: "MISSING" });
  assertFutureReceiptMissing({ status: "MISSING", once_consumed: false });
  assert.throws(() => assertFutureReceiptMissing({ status: "MISSING", once_consumed: true }));
  assert.throws(() => assertFutureReceiptMissing({ status: "VERIFIED" }));
});
