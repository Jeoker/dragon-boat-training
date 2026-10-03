// Read-only business evidence; Coach sessions and explicitly requested private backups only.
// Never exports, retries, fixes Google rows, deploys, or changes polling.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLEAN_SHA256, headers } from "./build-c2-associated-fault-overlay.mjs";

const sha = value => createHash("sha256").update(value).digest("base64url");
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` :
  v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const equal = (a, b) => assert.equal(canonical(a), canonical(b));
const load = path => JSON.parse(readFileSync(path, "utf8"));
const id = () => `c2_assoc_inspect_${randomUUID().replaceAll("-", "")}`;
const rowId = (scope, r) => scope === "SIGNUP" ? `${r[1]}:${r[2]}` :
  scope === "SEAT_PLAN_CURRENT" ? `${r[1]}:${r[2]}:${r[3]}` :
    scope === "SEAT_PLAN_REVISION" ? `${r[1]}:${r[2]}` : r[1];
const tablesOf = backup => Object.fromEntries(backup.manifest.tables.map(t => [t.name,
  backup.chunks.filter(c => c.table_name === t.name).flatMap(c => c.payload.rows)]));
export function verifyPrivateBackup(backup) {
  const m = backup.manifest, { content_digest, ...core } = m;
  assert.equal(m.schema_version, 13); assert.equal(m.format, "sqlite-json-chunks-v1");
  assert.equal(content_digest, `sha256_v1:${sha(canonical(core))}`);
  assert.equal(backup.chunks.length, m.chunk_count); assert.equal(m.tables.length, m.table_count);
  assert.equal(m.chunks.length, m.chunk_count);
  for (const [index, c] of backup.chunks.entries()) {
    assert.equal(c.chunk_index, index); assert.equal(c.payload.table, c.table_name);
    assert.equal(c.payload.row_offset, c.row_offset); assert.equal(c.payload.rows.length, c.row_count);
    assert.equal(c.payload_digest, `sha256_v1:${sha(canonical(c.payload))}`);
    equal(m.chunks[index], { chunk_index: c.chunk_index, table_name: c.table_name,
      row_offset: c.row_offset, row_count: c.row_count, payload_digest: c.payload_digest });
  }
  for (const t of m.tables) {
    const chunks = backup.chunks.filter(c => c.table_name === t.name);
    equal(chunks.map(c => c.chunk_index), t.chunk_indices);
    let count = 0;
    for (const c of chunks) { assert.equal(c.row_offset, count); count += c.row_count; }
    assert.equal(count, t.row_count);
  }
  assert.equal(m.record_count, m.tables.reduce((sum, t) => sum + t.row_count, 0));
  return tablesOf(backup);
}

export function assertFaultEvidence(phase, plan, j, tables, before, pages, receipts) {
  const cancel = j.cancel;
  assert.equal(cancel.outbox_id, plan.outbox_id);
  assert.equal(`sha256_v1:${sha(canonical(cancel.snapshot))}`, plan.snapshot_digest);
  const pending = tables.sync_outbox.filter(r => r.status === "PENDING" &&
    JSON.parse(r.payload_json).entity?.season_id === plan.season_id);
  assert.equal(pending.length, 1); assert.equal(pending[0].outbox_id, plan.outbox_id);
  equal(JSON.parse(pending[0].payload_json).entity, cancel.snapshot);
  const cursors = tables.sync_associated_cursors.filter(c => c.season_id === plan.season_id && c.practice_id === plan.practice_id);
  assert.equal(cursors.length, 1);
  for (const [k, v] of Object.entries(plan.prior_cursor)) assert.equal(cursors[0][k], v);
  const scoped = rows => rows.filter(r => r.season_id === plan.season_id && r.binding_version === 1);
  // No event-level acknowledgement means ALL logical/physical baselines must still be old.
  for (const table of ["sync_baselines", "sync_associated_physical_baselines"]) {
    equal(scoped(tables[table]).map(canonical).sort(), scoped(before[table]).map(canonical).sort());
  }
  const batches = scoped(tables.sync_batches).filter(b => b.first_outbox_id === plan.outbox_id);
  assert.ok(batches.every(b => b.last_outbox_id === plan.outbox_id && b.writer_epoch === 0));
  assert.ok(batches.every(b => plan.export_batches.some(spec => spec.batch_id === b.batch_id)));
  const unfinished = scoped(tables.sync_batches).filter(b => ["PREPARED", "SENT", "PARTIAL", "FAILED"].includes(b.status));
  const fault = phase === "partial" ? plan.partial : phase === "lost-reply" ? plan.lost_reply :
    cancel.export_calls.length === 1 ? plan.partial : plan.lost_reply;
  assert.equal(batches.length, fault.call_index + 1);
  for (const spec of plan.export_batches.slice(0, fault.call_index)) {
    assert.equal(batches.find(b => b.batch_id === spec.batch_id)?.status, "CONFIRMED");
    assert.equal(cancel.export_calls[spec.call_index]?.batch_id, spec.batch_id);
    assert.equal(cancel.export_calls[spec.call_index]?.entity_type, spec.scope);
  }
  if (phase === "recovered") {
    assert.equal(unfinished.length, 0);
    assert.equal(cancel.export_calls.length, fault.call_index + 1);
    assert.ok(!cancel.inflight);
  } else {
    assert.equal(unfinished.length, 1); assert.equal(unfinished[0].batch_id, fault.batch_id);
    assert.equal(unfinished[0].status, "FAILED");
    assert.equal(cancel.export_calls.length, fault.call_index);
    assert.equal(cancel.inflight.request_id, fault.request_id);
  }
  const target = batches.find(b => b.batch_id === fault.batch_id);
  assert.ok(target); assert.equal(target.status, phase === "recovered" ? "CONFIRMED" : "FAILED");
  const receipt = receipts[fault.scope];
  assert.equal(receipt.receipt_payload_digest, target.payload_digest);
  assert.equal(receipt.once_consumed, true);
  assert.equal(receipt.status, phase === "partial" ? "PARTIAL" : "VERIFIED");
  const expected = structuredClone(plan.before_sheets);
  for (const spec of plan.export_batches) {
    const batch = batches.find(b => b.batch_id === spec.batch_id);
    if (!batch) continue;
    assert.equal(batch.status, spec.batch_id === fault.batch_id && phase !== "recovered" ? "FAILED" : "CONFIRMED");
    const items = tables.sync_batch_items.filter(i => i.batch_id === spec.batch_id).sort((a,b) => a.item_index-b.item_index);
    assert.equal(items.length, spec.items.length);
    for (const [index, item] of items.entries()) {
      const saved = JSON.parse(item.target_json), planned = spec.items[index];
      equal({ row_id: saved.row_id, expected: saved.expected, target: saved.target }, planned);
      assert.equal(item.entity_type, spec.scope === "SIGNUP" ? "SIGNUP" : "SEAT_PLAN_DRAFT");
      assert.equal(item.dependency_group, spec.scope); assert.equal(saved.scope, spec.scope);
      if (batch.status === "CONFIRMED") assert.equal(item.status, "VERIFIED");
      if (batch.status === "CONFIRMED" || phase === "lost-reply" || phase === "partial" && index === 0) {
        const position = expected[spec.scope].findIndex(r => rowId(spec.scope,r) === planned.row_id);
        if (position < 0) expected[spec.scope].push(planned.target); else expected[spec.scope][position] = planned.target;
      }
    }
  }
  if (phase === "partial") equal(JSON.parse(receipt.result_json), [fault.items[0].row_id]);
  else {
    const verified = JSON.parse(receipt.result_json);
    assert.equal(verified.status, "verified"); assert.equal(verified.operation_id, fault.batch_id);
    assert.equal(verified.entity_type, fault.scope);
    equal(verified.verified_row_ids, fault.items.map(i => i.row_id));
  }
  for (const scope of Object.keys(headers)) {
    equal(pages[scope].map(canonical).sort(), expected[scope].map(canonical).sort());
  }
  const old = pages.SEAT_PLAN_REVISION.filter(r => r[2] === "1");
  assert.equal(old.length, 1); equal(old[0], j.initial.SEAT_PLAN_REVISION[0]);
  assert.equal(pages.SEAT_PLAN_REVISION.filter(r => r[2] === "2").length,
    fault.scope === "SEAT_PLAN_REVISION" ? 1 : 0);
  assert.equal(pages.SEAT_PLAN_REVISION.filter(r => !["1", "2"].includes(r[2])).length, 0);
  return { status: "EVIDENCE_CONFIRMED", phase, worker_batch_status: target.status,
    bridge_receipt_status: receipt.status, pending_outbox: 1, pending_batches: unfinished.length,
    prior_cursor_preserved: true, baselines_preserved: true, original_revision_preserved: true };
}

async function inspect() {
  const phase = process.argv.find(a => a.startsWith("--phase="))?.slice(8);
  assert.ok(["probe", "partial", "lost-reply", "recovered"].includes(phase));
  if (phase !== "probe") assert.ok(process.argv.includes("--capture-private-backup"));
  const privateRoot = new URL("../../.c2-form-test/", import.meta.url);
  const artifactRoot = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
  const plan = load(new URL("associated-fault-overlay/fault-plan.json", artifactRoot));
  const journal = load(new URL("c2-waitlist-journal.json", artifactRoot));
  const identity = load(new URL("isolated-identities.json", privateRoot));
  const fixture = load(new URL("private-test-config.json", privateRoot)).fixture;
  const secrets = load(new URL("worker-secrets.json", privateRoot));
  const { coach_code: coachCode } = load(new URL("review-private.json", privateRoot));
  const worker = new URL(process.env.C2_TEST_URL || "");
  assert.equal(worker.href, "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/");
  assert.equal(plan.worker_url, worker.href); assert.equal(plan.team_id, "pentasus-c2-test");
  assert.equal(plan.season_id, "season_c2_isolated_2026"); assert.equal(plan.writer_epoch, 0);
  assert.equal(plan.service_version, "0.16.2-c2-physical-diagnostics");
  assert.equal(plan.binding_version, 1); assert.equal(plan.clean_code_sha256, CLEAN_SHA256);
  assert.equal(plan.script_id, identity.script_id); assert.equal(plan.deployment_id, identity.deployment_id);
  assert.equal(journal.deployment_id, plan.deployment_id); assert.equal(journal.run_id, plan.run_id);
  assert.equal(journal.runtime_sheet_id, plan.runtime_sheet_id);
  assert.equal(plan.runtime_sheet_id, fixture.runtimeSheetId); assert.equal(fixture.seasonId, plan.season_id);
  assert.equal(fixture.runtimeSheetId, process.env.C2_RUNTIME_SHEET_ID);
  assert.equal(plan.partial.request_id, `${plan.run_id}_export_10_0`);
  for (const spec of plan.export_batches) {
    assert.equal(spec.request_id, `${plan.run_id}_export_10_${spec.call_index}`);
    assert.equal(spec.batch_id, `batch_${sha(`${plan.team_id}\nC2:EXPORT\nexportNextAssociated\n${spec.request_id}`)}`);
  }
  const bridge = new URL(secrets.GOOGLE_BRIDGE_URL);
  assert.equal(bridge.href, `https://script.google.com/macros/s/${plan.deployment_id}/exec`);
  const config = load(new URL("../cloudflare/wrangler.jsonc", import.meta.url)).env.c2test;
  assert.equal(config.vars.C2_EXPORT_POLL_ENABLED, "false"); equal(config.triggers.crons, []);
  assert.ok(process.env.C1_TEST_KEY && process.env.C2_TEST_KEY && coachCode && secrets.GOOGLE_BRIDGE_SECRET);
  const api = async (path, key, payload) => {
    const response = await fetch(new URL(path, worker), { method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ request_id: id(), ...payload }), signal: AbortSignal.timeout(45_000) });
    const body = await response.json();
    assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
    assert.equal(body.meta?.service_version, plan.service_version); assert.equal(body.meta?.writer_epoch, 0);
    assert.ok(response.ok && body.ok); return body.data;
  };
  const signed = async (action, payload) => {
    const payload_json = JSON.stringify(payload), req = { action, request_id: id(),
      protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE", team_id: plan.team_id,
      binding_version: `${plan.season_id}:1`, writer_epoch: 0, timestamp_ms: Date.now(), nonce: id(),
      operation_id: id(), payload_json, payload_digest: sha(payload_json) };
    const signature = createHmac("sha256", secrets.GOOGLE_BRIDGE_SECRET).update([req.protocol_version,
      req.direction, req.team_id, req.binding_version, 0, req.timestamp_ms, req.nonce, req.operation_id,
      req.payload_digest].join("\n")).digest("base64url");
    const response = await fetch(bridge, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ ...req, signature }), redirect: "follow", signal: AbortSignal.timeout(35_000) });
    const body = await response.json(); assert.ok(response.ok && body.ok);
    assert.equal(body.meta?.request_id, req.request_id);
    const data = body.data;
    for (const [k,v] of Object.entries({ team_id: plan.team_id, season_id: plan.season_id,
      binding_version: 1, writer_epoch: 0, operation_id: req.operation_id, payload_digest: req.payload_digest })) assert.equal(data[k],v);
    return data;
  };
  const token = (await api("/internal/c1/coach-login", process.env.C1_TEST_KEY, { coach_code: coachCode })).result.session_token;
  let summary;
  try {
    const overview = await api("/internal/c2/get-sync-overview", process.env.C2_TEST_KEY,
      { session_token: token, season_id: plan.season_id });
    assert.equal(overview.schema_version, 13); assert.equal(overview.binding_current, true);
    assert.equal(overview.binding.runtime_spreadsheet_id, plan.runtime_sheet_id);
    assert.equal(overview.binding.form_id, fixture.formId); assert.equal(overview.binding.binding_version, 1);
  assert.equal(overview.export_control.status, "RUNNING"); assert.equal(overview.export_control.pause_requested, false);
    assert.equal(overview.counts.open_conflicts, 0); assert.equal(overview.counts.sources_needing_review, 0);
    const receipts = {};
    for (const fault of [plan.partial, plan.lost_reply]) {
      const receipt = await signed("c2TestReadAssociatedFaultReceipt", { season_id: plan.season_id,
        batch_id: fault.batch_id, runtime_sheet_id: plan.runtime_sheet_id, deployment_id: plan.deployment_id });
      assert.equal(receipt.batch_id, fault.batch_id); assert.equal(receipt.scope, fault.scope);
      receipts[fault.scope] = receipt;
    }
    if (phase === "probe") {
      assert.equal(overview.counts.pending_outbox, 1); assert.equal(overview.counts.pending_batches, 0);
      assert.ok(Object.values(receipts).every(r => r.status === "MISSING"));
      summary = { phase, status: "SIGNED_PROBE_CONFIRMED", allowed_batches: 2, business_writes: 0 };
    } else {
      const created = await api("/internal/c1/create-backup-snapshot", process.env.C1_TEST_KEY, { session_token: token });
      const manifest = created.result.manifest;
      const verified = await api("/internal/c1/verify-backup-snapshot", process.env.C1_TEST_KEY,
        { session_token: token, snapshot_id: manifest.snapshot_id, content_digest: manifest.content_digest });
      assert.equal(verified.verified, true); assert.equal(verified.expected_content_digest, manifest.content_digest);
      const chunks = [];
      for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index++) {
        chunks.push((await api("/internal/c1/get-backup-chunk", process.env.C1_TEST_KEY,
          { session_token: token, snapshot_id: manifest.snapshot_id, chunk_index })).chunk);
      }
      const backup = { manifest, chunks }, tables = verifyPrivateBackup(backup);
      writeFileSync(new URL(`${manifest.snapshot_id}.json`, artifactRoot), JSON.stringify(backup, null, 2) + "\n", { flag: "wx" });
      const beforeBackup = load(new URL(`${plan.audit_backup.snapshot_id}.json`, artifactRoot));
      assert.equal(beforeBackup.manifest.snapshot_id, plan.audit_backup.snapshot_id);
      assert.equal(beforeBackup.manifest.content_digest, plan.audit_backup.content_digest);
      const before = verifyPrivateBackup(beforeBackup);
      const pages = {};
      for (const scope of Object.keys(headers)) {
        const page = await signed("cloudflareReadSheetRecords", { season_id: plan.season_id, entity_type: scope });
        assert.equal(page.entity_type, scope); assert.equal(page.spreadsheet_id, plan.runtime_sheet_id);
        equal(page.headers, headers[scope]); assert.ok(!page.next_cursor && !page.truncated);
        assert.ok(page.rows.every(r => r.cells[0] === plan.season_id && r.cells[1] === plan.practice_id));
        pages[scope] = page.rows.map(r => r.cells);
      }
      summary = assertFaultEvidence(phase, plan, journal, tables, before, pages, receipts);
      assert.equal(overview.counts.pending_outbox, summary.pending_outbox);
      assert.equal(overview.counts.pending_batches, summary.pending_batches);
      writeFileSync(new URL(`associated-fault-${phase}-${manifest.snapshot_id}.json`, artifactRoot),
        JSON.stringify({ phase, plan_run_id: plan.run_id, backup_snapshot_id: manifest.snapshot_id, receipts, pages, summary }, null, 2) + "\n", { flag: "wx" });
    }
  } finally { await api("/internal/c1/coach-logout", process.env.C1_TEST_KEY, { session_token: token }); }
  console.log(JSON.stringify({ ...summary, coach_logged_out: true, backup_restored: false }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  inspect().catch(() => {
    console.error("Associated fault inspection stopped; retain private evidence and the original inflight request. No business repair was attempted.");
    process.exitCode = 1;
  });
}
