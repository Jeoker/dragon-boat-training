// Exact c2test SIGNUP fault only. One explicit stage per invocation; no automatic resume.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLEAN_SHA256, headers } from "./build-c2-associated-fault-overlay.mjs";
import { assertFaultEvidence, verifyPrivateBackup } from "./live-c2-associated-fault-inspect.mjs";

const phases = ["pause", "early-resume", "drain", "next-stage", "resume"];
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` :
  v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const sha = v => createHash("sha256").update(v).digest("base64url");
const equal = (a,b) => assert.equal(canonical(a), canonical(b));
const anchor = v => `sha256_v1:${sha(canonical(v))}`;
const load = path => JSON.parse(readFileSync(path, "utf8"));
const id = () => `c2_pause_read_${randomUUID().replaceAll("-", "")}`;

export function assertPauseJournal(plan, j, recovered = false) {
  assert.equal(plan.team_id, "pentasus-c2-test"); assert.equal(plan.season_id, "season_c2_isolated_2026");
  assert.equal(plan.writer_epoch, 0); assert.equal(plan.binding_version, 1);
  assert.equal(plan.clean_code_sha256, CLEAN_SHA256);
  assert.equal(j.format, 1); assert.equal(j.run_id, plan.run_id);
  assert.equal(j.worker_url, plan.worker_url); assert.equal(j.service_version, plan.service_version);
  assert.equal(j.runtime_sheet_id, plan.runtime_sheet_id); assert.equal(j.deployment_id, plan.deployment_id);
  assert.equal(j.practice_id, plan.practice_id);
  assert.equal(j.events.length, 10); assert.ok(j.events.every(e => e.confirmed));
  assert.ok(!j.cancel.confirmed); assert.equal(j.cancel.outbox_id, plan.outbox_id);
  assert.equal(anchor(j.cancel.snapshot), plan.snapshot_digest);
  assert.equal(plan.partial.call_index, 0); assert.equal(plan.partial.scope, "SIGNUP");
  assert.equal(plan.partial.request_id, `${j.run_id}_export_10_0`);
  assert.equal(plan.partial.batch_id, `batch_${sha(`${plan.team_id}\nC2:EXPORT\nexportNextAssociated\n${plan.partial.request_id}`)}`);
  equal(plan.partial, plan.export_batches[0]); assert.equal(plan.partial.items.length, 2);
  assert.equal(j.cancel.export_calls.length, recovered ? 1 : 0);
  if (recovered) {
    assert.ok(!j.cancel.inflight); assertDrainResult(plan, j.cancel.export_calls[0]);
  } else equal(j.cancel.inflight, { request_id: plan.partial.request_id, season_id: plan.season_id });
}
function assertDrainResult(plan, result) {
  assert.equal(result.status, "BATCH_CONFIRMED"); assert.equal(result.season_id, plan.season_id);
  assert.equal(result.batch_id, plan.partial.batch_id); assert.equal(result.outbox_id, plan.outbox_id);
  assert.equal(result.entity_type, "SIGNUP"); assert.equal(result.row_id, plan.partial.items[0].row_id);
  equal(result.row_ids, plan.partial.items.map(i => i.row_id));
  assert.equal(result.cloud_version, 12);
}
export function assertFutureReceiptMissing(receipt) {
  assert.equal(receipt.status, "MISSING");
  // Deployed overlay's MISSING path omits this field. Missing is not evidence that
  // a once marker is false; only the absence of this future business receipt is known.
  assert.ok(receipt.once_consumed === undefined || receipt.once_consumed === false);
}
export function createPauseState(plan, journal) {
  assertPauseJournal(plan, journal);
  return { format: 1, run_id: plan.run_id, plan_anchor: anchor(plan), runner_anchor: anchor(journal),
    completed: [], requests: Object.fromEntries(phases.map(p => [p, p === "drain" ?
      plan.partial.request_id : `${plan.run_id}_pause_${p.replaceAll("-", "_")}`])), attempts: {}, results: {} };
}
export function assertPauseEvidence(plan, journal, tables, before, pages, receipts, overview, allowed) {
  assert.equal(overview.schema_version, 13); assert.equal(overview.binding_current, true);
  assert.equal(overview.binding.runtime_spreadsheet_id, plan.runtime_sheet_id);
  assert.equal(overview.binding.binding_version, 1); assert.equal(overview.export_control.source_paused, false);
  assert.equal(overview.counts.open_conflicts, 0); assert.equal(overview.counts.sources_needing_review, 0);
  assert.ok(!overview.export_control.retry || overview.export_control.retry.action_required === false &&
    overview.export_control.retry.failure_count === 0);
  const unfinished = tables.sync_batches.filter(b => b.season_id === plan.season_id &&
    ["PREPARED", "SENT", "PARTIAL", "FAILED"].includes(b.status));
  const kind = unfinished.length ? "partial" : "recovered";
  assert.ok(allowed.includes(kind));
  const virtual = structuredClone(journal);
  if (kind === "recovered" && virtual.cancel.export_calls.length === 0) {
    virtual.cancel.export_calls.push({ status: "BATCH_CONFIRMED", season_id: plan.season_id,
      batch_id: plan.partial.batch_id, outbox_id: plan.outbox_id, entity_type: "SIGNUP",
      row_id: plan.partial.items[0].row_id, row_ids: plan.partial.items.map(i => i.row_id), cloud_version: 12 });
    virtual.cancel.inflight = null;
  }
  const summary = assertFaultEvidence(kind, plan, virtual, tables, before, pages, receipts);
  assert.equal(overview.counts.pending_outbox, 1); assert.equal(overview.counts.pending_batches, summary.pending_batches);
  if (kind === "partial") equal(overview.export_control.unfinished_batch,
    { batch_id: plan.partial.batch_id, status: "FAILED" });
  else assert.equal(overview.export_control.unfinished_batch, null);
  return kind;
}

// Injected I/O permits real state-machine tests without any remote operation.
// capture() must validate full private backup + signed receipt/sheets and return its kind/status.
export async function runPausePhase({ phase, plan, journal, state, api, capture, persistState, persistJournal }) {
  assert.ok(phases.includes(phase)); assert.equal(state.format, 1); assert.equal(state.run_id, plan.run_id);
  assert.equal(state.plan_anchor, anchor(plan));
  if (state.pending_runner_anchor && anchor(journal) === state.pending_runner_anchor) {
    assertDrainResult(plan, state.results.drain?.data); assertPauseJournal(plan, journal, true);
    state.runner_anchor = state.pending_runner_anchor; delete state.pending_runner_anchor; persistState(state);
  }
  assert.equal(state.runner_anchor, anchor(journal));
  const expectedRequests = createPauseState(plan, { ...journal, cancel: { ...journal.cancel,
    export_calls: [], inflight: { request_id: plan.partial.request_id, season_id: plan.season_id } } }).requests;
  equal(state.requests, expectedRequests);
  const position = phases.indexOf(phase);
  equal(state.completed, phases.slice(0, state.completed.length));
  if (state.completed.includes(phase)) return { phase, status: "STAGE_ALREADY_CONFIRMED", business_calls: 0 };
  assert.equal(position, state.completed.length);
  // Known drain response persisted before runner journal means a crash cannot lose the result.
  if (phase === "drain" && state.results.drain?.ok) {
    assertDrainResult(plan, state.results.drain.data);
    if (journal.cancel.export_calls.length === 0) {
      assertPauseJournal(plan, journal);
      const updated = structuredClone(journal); updated.cancel.export_calls.push(state.results.drain.data);
      updated.cancel.inflight = null;
      state.pending_runner_anchor = anchor(updated); persistState(state);
      persistJournal(updated, journal); Object.assign(journal, updated);
      state.runner_anchor = anchor(journal); delete state.pending_runner_anchor; persistState(state);
    }
  }
  assertPauseJournal(plan, journal, position > 2 || phase === "drain" && journal.cancel.export_calls.length === 1);
  const expect = async (statuses, allowed) => {
    const evidence = await capture(journal, allowed);
    assert.ok(statuses.includes(evidence.status));
    assert.equal(evidence.paused, ["PAUSING", "PAUSED"].includes(evidence.status));
    assert.ok(allowed.includes(evidence.kind));
    return evidence;
  };
  if (phase === "pause") await expect(state.attempts.pause ? ["RUNNING", "PAUSING"] : ["RUNNING"], ["partial"]);
  if (phase === "early-resume") await expect(["PAUSING"], ["partial"]);
  if (phase === "drain") await expect(journal.cancel.export_calls.length ? ["PAUSED"] :
    state.attempts.drain ? ["PAUSING", "PAUSED"] : ["PAUSING"],
    state.attempts.drain || journal.cancel.export_calls.length ? ["partial", "recovered"] : ["partial"]);
  if (phase === "next-stage") await expect(["PAUSED"], ["recovered"]);
  if (phase === "resume") await expect(state.attempts.resume ? ["PAUSED", "RUNNING"] : ["PAUSED"], ["recovered"]);
  let response = state.results[phase];
  if (!response) {
    state.attempts[phase] = Number(state.attempts[phase] ?? 0) + 1; persistState(state);
    const payload = { request_id: state.requests[phase], season_id: plan.season_id };
    const path = ["drain", "next-stage"].includes(phase) ? "/internal/c2/export-next-associated" : "/internal/c2/set-export-pause";
    if (path.endsWith("set-export-pause")) payload.paused = phase === "pause";
    response = await api(path, payload); // Unknown network/JSON result leaves attempted stage and original ID intact.
    state.last_response = { phase, response };
    const expectedError = phase === "early-resume" ? "SYNC_EXPORT_DRAINING" : phase === "next-stage" ? "SYNC_EXPORT_PAUSED" : null;
    // Known transient errors retain the attempted phase and original ID for a later retry.
    if (response.ok || response.http_status === 409 && response.error_code === expectedError) state.results[phase] = response;
    persistState(state);
  }
  if (phase === "early-resume" || phase === "next-stage") {
    assert.equal(response.ok, false); assert.equal(response.http_status, 409);
    assert.equal(response.error_code, phase === "early-resume" ? "SYNC_EXPORT_DRAINING" : "SYNC_EXPORT_PAUSED");
  } else {
    assert.equal(response.ok, true);
    if (phase === "drain") {
      assertDrainResult(plan, response.data);
      if (journal.cancel.export_calls.length === 0) {
        const updated = structuredClone(journal); updated.cancel.export_calls.push(response.data); updated.cancel.inflight = null;
        state.pending_runner_anchor = anchor(updated); persistState(state);
        persistJournal(updated, journal); Object.assign(journal, updated);
        state.runner_anchor = anchor(journal); delete state.pending_runner_anchor; persistState(state);
      }
    } else {
      assert.equal(response.data.result.season_id, plan.season_id);
      assert.equal(response.data.result.status, phase === "pause" ? "PAUSING" : "RUNNING");
      assert.equal(response.data.result.unfinished_batch_id, phase === "pause" ? plan.partial.batch_id : null);
    }
  }
  await expect(phase === "pause" || phase === "early-resume" ? ["PAUSING"] : phase === "resume" ? ["RUNNING"] : ["PAUSED"],
    phase === "pause" || phase === "early-resume" ? ["partial"] : ["recovered"]);
  state.completed.push(phase); persistState(state);
  return { phase, status: "STAGE_CONFIRMED", original_batch_only: true,
    prior_cursor_preserved: true, baselines_preserved: true, event_still_pending: true };
}

async function main() {
  const phase = process.argv.find(a => a.startsWith("--phase="))?.slice(8);
  assert.ok(phases.includes(phase)); assert.ok(process.argv.includes("--write-test-data"));
  assert.ok(process.argv.includes("--capture-private-backup"));
  const privateRoot = new URL("../../.c2-form-test/", import.meta.url);
  const artifacts = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
  const journalPath = new URL("c2-waitlist-journal.json", artifacts), statePath = new URL("c2-pause-drain-journal.json", artifacts);
  const plan = load(new URL("associated-fault-overlay/fault-plan.json", artifacts)), journal = load(journalPath);
  const identities = load(new URL("isolated-identities.json", privateRoot)), fixture = load(new URL("private-test-config.json", privateRoot)).fixture;
  const secrets = load(new URL("worker-secrets.json", privateRoot)), coachCode = load(new URL("review-private.json", privateRoot)).coach_code;
  const worker = new URL(process.env.C2_TEST_URL || ""), bridge = new URL(secrets.GOOGLE_BRIDGE_URL);
  assert.equal(worker.href, "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/");
  assert.equal(plan.worker_url, worker.href); assert.equal(plan.service_version, "0.16.2-c2-physical-diagnostics");
  assert.equal(plan.script_id, identities.script_id); assert.equal(plan.deployment_id, identities.deployment_id);
  assert.equal(bridge.href, `https://script.google.com/macros/s/${plan.deployment_id}/exec`);
  assert.equal(plan.runtime_sheet_id, fixture.runtimeSheetId); assert.equal(fixture.runtimeSheetId, process.env.C2_RUNTIME_SHEET_ID);
  assert.equal(fixture.seasonId, plan.season_id); assert.ok(fixture.systemSheetId && fixture.systemSheetId !== fixture.runtimeSheetId);
  const config = load(new URL("../cloudflare/wrangler.jsonc", import.meta.url)).env.c2test;
  assert.equal(config.name, "dragon-boat-training-api-c2-test"); assert.equal(config.vars.TEAM_ID, plan.team_id);
  assert.equal(config.vars.SERVICE_VERSION, plan.service_version);
  assert.equal(config.vars.C2_ASSOCIATED_EXPORT_ENABLED, "true"); assert.equal(config.vars.C2_EXPORT_POLL_ENABLED, "false"); equal(config.triggers.crons, []);
  assert.ok(process.env.C1_TEST_KEY && process.env.C2_TEST_KEY && coachCode && secrets.GOOGLE_BRIDGE_SECRET);
  const beforeBackup = load(new URL(`${plan.audit_backup.snapshot_id}.json`, artifacts));
  assert.equal(beforeBackup.manifest.snapshot_id, plan.audit_backup.snapshot_id);
  assert.equal(beforeBackup.manifest.content_digest, plan.audit_backup.content_digest);
  const before = verifyPrivateBackup(beforeBackup);
  const atomic = (path, value) => { const temp = new URL(`${path.href}.${randomUUID()}.pause.tmp`);
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); renameSync(temp, path); };
  const state = existsSync(statePath) ? load(statePath) : createPauseState(plan, journal);
  if (!existsSync(statePath)) atomic(statePath, state);
  const request = async (path, payload, key) => {
    const response = await fetch(new URL(path, worker), { method: "POST", headers: {
      authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ request_id: id(), ...payload }),
      signal: AbortSignal.timeout(45_000) });
    const body = await response.json();
    assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
    assert.equal(body.meta?.service_version, plan.service_version); assert.equal(body.meta?.writer_epoch, 0);
    assert.equal(body.meta?.request_id, payload.request_id ?? body.meta.request_id);
    if (response.ok && body.ok) return { ok: true, http_status: response.status, data: body.data };
    assert.ok(!response.ok && body.ok === false && typeof body.error?.code === "string");
    return { ok: false, http_status: response.status, error_code: body.error.code };
  };
  const good = async (path, payload, key) => { const r = await request(path, payload, key); assert.equal(r.ok, true); return r.data; };
  const signed = async (action, payload) => {
    const payload_json = JSON.stringify(payload), req = { action, request_id: id(), protocol_version: "2026-09-19.bridge.v1",
      direction: "CLOUDFLARE_TO_GOOGLE", team_id: plan.team_id, binding_version: `${plan.season_id}:1`, writer_epoch: 0,
      timestamp_ms: Date.now(), nonce: id(), operation_id: id(), payload_json, payload_digest: sha(payload_json) };
    const signature = createHmac("sha256", secrets.GOOGLE_BRIDGE_SECRET).update([req.protocol_version, req.direction,
      req.team_id, req.binding_version, 0, req.timestamp_ms, req.nonce, req.operation_id, req.payload_digest].join("\n")).digest("base64url");
    const response = await fetch(bridge, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ ...req, signature }), redirect: "follow", signal: AbortSignal.timeout(35_000) });
    const body = await response.json(); assert.ok(response.ok && body.ok); assert.equal(body.meta?.request_id, req.request_id);
    for (const [k,v] of Object.entries({ team_id: plan.team_id, season_id: plan.season_id, binding_version: 1,
      writer_epoch: 0, operation_id: req.operation_id, payload_digest: req.payload_digest })) assert.equal(body.data[k],v);
    return body.data;
  };
  const token = (await good("/internal/c1/coach-login", { coach_code: coachCode }, process.env.C1_TEST_KEY)).result.session_token;
  try {
    const capture = async (current, allowed) => {
      const overview = await good("/internal/c2/get-sync-overview", { session_token: token, season_id: plan.season_id }, process.env.C2_TEST_KEY);
      assert.equal(overview.binding.form_id, fixture.formId);
      const manifest = (await good("/internal/c1/create-backup-snapshot", { session_token: token }, process.env.C1_TEST_KEY)).result.manifest;
      const verified = await good("/internal/c1/verify-backup-snapshot", { session_token: token,
        snapshot_id: manifest.snapshot_id, content_digest: manifest.content_digest }, process.env.C1_TEST_KEY);
      assert.equal(verified.verified, true); assert.equal(verified.expected_content_digest, manifest.content_digest);
      const chunks = [];
      for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index++) chunks.push((await good("/internal/c1/get-backup-chunk",
        { session_token: token, snapshot_id: manifest.snapshot_id, chunk_index }, process.env.C1_TEST_KEY)).chunk);
      const backup = { manifest, chunks }, tables = verifyPrivateBackup(backup);
      writeFileSync(new URL(`${manifest.snapshot_id}.json`, artifacts), JSON.stringify(backup, null, 2) + "\n", { flag: "wx" });
      const receipts = {}, pages = {};
      for (const fault of [plan.partial, plan.lost_reply]) {
        const receipt = await signed("c2TestReadAssociatedFaultReceipt", { season_id: plan.season_id, batch_id: fault.batch_id,
          runtime_sheet_id: plan.runtime_sheet_id, deployment_id: plan.deployment_id });
        assert.equal(receipt.batch_id, fault.batch_id); assert.equal(receipt.scope, fault.scope); receipts[fault.scope] = receipt;
      }
      assertFutureReceiptMissing(receipts.SEAT_PLAN_REVISION);
      for (const scope of Object.keys(headers)) {
        const page = await signed("cloudflareReadSheetRecords", { season_id: plan.season_id, entity_type: scope });
        assert.equal(page.entity_type, scope); assert.equal(page.spreadsheet_id, plan.runtime_sheet_id); equal(page.headers, headers[scope]);
        assert.ok(!page.next_cursor && !page.truncated);
        assert.ok(page.rows.every(r => r.cells[0] === plan.season_id && r.cells[1] === plan.practice_id)); pages[scope] = page.rows.map(r => r.cells);
      }
      const kind = assertPauseEvidence(plan, current, tables, before, pages, receipts, overview, allowed);
      writeFileSync(new URL(`associated-pause-${phase}-${manifest.snapshot_id}.json`, artifacts),
        JSON.stringify({ phase, overview, backup_snapshot_id: manifest.snapshot_id, receipts, pages, kind }, null, 2) + "\n", { flag: "wx" });
      return { kind, status: overview.export_control.status, paused: overview.export_control.pause_requested };
    };
    const summary = await runPausePhase({ phase, plan, journal, state, capture,
      api: (path, payload) => request(path, { ...payload, ...(path.endsWith("set-export-pause") ? { session_token: token } : {}) }, process.env.C2_TEST_KEY),
      persistState: value => atomic(statePath, value), persistJournal: (value, expected) => {
        equal(load(journalPath), expected); atomic(journalPath, value);
      } });
    console.log(JSON.stringify(summary));
  } finally { await good("/internal/c1/coach-logout", { session_token: token }, process.env.C1_TEST_KEY); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => {
  console.error("Pause/drain stopped. Retain both private journals and retry only the same explicit stage; do not resume blindly.");
  process.exitCode = 1;
});
