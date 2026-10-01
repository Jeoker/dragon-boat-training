import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PHASES, assertPhase, assertEventAnchor, assertLaneProgress, assertOriginalRows, assertGoogleUnchanged,
  journalCall, singleRowCas, reverseCas, assertCasReceipt, expectedGoogleRows, readScopeDefinitions, canonical,
  assertBackupDownload, assertMigrationPreserved, assertBatchReceipt, assertPendingBlock, fixtureTimings,
  saveKnownExport, pendingExportEvidence, clearExportEvidence, assertUsageRefresh, assertUpgradeReference, assertApiCorrelation,
  privateFailureRecord, assertRestoredDeployment
} from "./live-c2-associated-lane-acceptance.mjs";

const sha = value => createHash("sha256").update(value).digest("base64url");
const j = () => ({ format: 1, service_version: "0.17.0-c2-associated-lanes", phases: {}, calls: {}, events: {} });
const sheet = () => ({ entity_type: "PRACTICE", spreadsheet_id: "isolated_runtime", tab_id: "104",
  headers: ["season_id", "practice_id", "location"], rows: [
    { cells: ["season_c2_isolated_2026", "practice_A_test", "Original dock"] },
    { cells: ["season_c2_isolated_2026", "practice_B_test", "Independent dock"] }
  ] });

function metricTables() {
  return { usage_snapshots: [{ usage_date: "2026-10-01", captured_at: "2026-10-01T00:00:00.000Z", database_size_bytes: 100,
    request_count: 0, audit_count: 0, outbox_pending: 0, jobs_pending: 0, history_practice_count: 0, history_season_count: 0 }],
  sync_outbox: [], scheduled_jobs: [], system_requests: [], audit_events: [], practice_history: [], season_history: [] };
}

test("known BATCH and EVENT replies retain an audit checkpoint across failure and never send the next call", async () => {
  for (const status of ["BATCH_CONFIRMED", "EVENT_CONFIRMED"]) {
    let disk, sends = 0, healthy = false;
    const journal = j(), request = { request_id: "fixed_original" };
    const event = journal.events.prepare = { outbox_id: "out_fixed", calls: [], inflight: request, confirmed: false };
    journal.events["create-b"] = { outbox_id: "out_next", calls: [], inflight: null, confirmed: false };
    const persist = value => { disk = structuredClone(value); };
    saveKnownExport(journal, "export-schedule", event, request, { status, outbox_id: event.outbox_id }, persist);
    const resume = async () => {
      const loaded = structuredClone(disk), checkpoint = pendingExportEvidence(loaded, "export-schedule");
      if (checkpoint) { assert.ok(healthy, "Evidence mismatch"); clearExportEvidence(loaded, "export-schedule", persist); return "AUDITED_ZERO_NEW_CALLS"; }
      sends++; return "NEXT_CALL_ALLOWED";
    };
    await assert.rejects(resume()); await assert.rejects(resume()); assert.equal(sends, 0);
    assert.equal(disk.events.prepare.calls[0].request.request_id, "fixed_original");
    assert.equal(disk.events.prepare.confirmed, status === "EVENT_CONFIRMED");
    assert.throws(() => pendingExportEvidence(disk, "export-b1"));
    healthy = true; assert.equal(await resume(), "AUDITED_ZERO_NEW_CALLS"); assert.equal(sends, 0);
    assert.equal(await resume(), "NEXT_CALL_ALLOWED"); assert.equal(sends, 1);
  }
});

test("hourly usage refresh preserves dates and validates sampled jobs rather than latest job status", () => {
  const before = metricTables(), current = structuredClone(before);
  current.usage_snapshots[0].captured_at = "2026-10-01T01:00:00.000Z"; current.usage_snapshots[0].database_size_bytes = 120;
  current.scheduled_jobs = [{ created_at: "2026-10-01T00:59:00.000Z", completed_at: "2026-10-01T01:01:00.000Z", status: "COMPLETED" }];
  current.usage_snapshots[0].jobs_pending = 1;
  const evidence = assertUsageRefresh(before, current); assert.equal(evidence.changes.length, 1); assert.equal(evidence.sampled_after_last_business_event, true);
  for (const mutate of [t => t.usage_snapshots = [], t => t.usage_snapshots.push(t.usage_snapshots[0]),
    t => t.usage_snapshots[0].captured_at = "2026-09-30T23:00:00.000Z", t => t.usage_snapshots[0].database_size_bytes = -1,
    t => t.usage_snapshots[0].request_count = Number.MAX_SAFE_INTEGER + 1, t => t.usage_snapshots[0].jobs_pending = 0,
    t => t.usage_snapshots[0].unapproved_field = 1, t => t.usage_snapshots[0].request_count = 1]) {
    const changed = structuredClone(current); mutate(changed); assert.throws(() => assertUsageRefresh(before, changed));
  }
  const stale = metricTables(); stale.sync_outbox.push({ status: "PENDING", created_at: "2026-10-01T00:30:00.000Z" });
  assert.equal(assertUsageRefresh(before, stale).sampled_after_last_business_event, false);
  const between = metricTables(); between.usage_snapshots[0].outbox_pending = 1;
  between.sync_outbox.push({ status: "CONFIRMED", created_at: "2026-09-30T23:00:00.000Z", completed_at: "2026-10-01T00:30:00.000Z" });
  assert.equal(assertUsageRefresh(between, between).sampled_after_last_business_event, false);
});

function privateBundle(tables, snapshotId, createdAt) {
  const chunks = Object.entries(tables).map(([table, rows], index) => ({ chunk_index: index, table_name: table, row_offset: 0, row_count: rows.length,
    payload: { table, row_offset: 0, rows }, payload_digest: `sha256_v1:${sha(canonical({ table, row_offset: 0, rows }))}` }));
  const manifest = { schema_version: 13, format: "sqlite-json-chunks-v1", snapshot_id: snapshotId, created_at: createdAt,
    chunk_count: chunks.length, table_count: chunks.length, record_count: chunks.reduce((n, c) => n + c.row_count, 0),
    tables: chunks.map(c => ({ name: c.table_name, row_count: c.row_count, chunk_indices: [c.chunk_index] })),
    chunks: chunks.map(({ payload, ...descriptor }) => descriptor) };
  manifest.content_digest = `sha256_v1:${sha(canonical(manifest))}`; return { manifest, chunks };
}

test("fresh upgrade reference binds both complete v13 bundles and every explained metric change", () => {
  const old = { ...Object.fromEntries(Array.from({ length: 36 }, (_, i) => [`business_${i}`, []])), ...metricTables() };
  old.business_0 = [{ result: "old_immutable" }];
  const fresh = structuredClone(old); fresh.usage_snapshots[0].captured_at = "2026-10-01T01:00:00.000Z";
  fresh.usage_snapshots[0].database_size_bytes = 130;
  const oldBundle = privateBundle(old, "old_test_snapshot", "2026-10-01T00:01:00.000Z"), freshBundle = privateBundle(fresh, "fresh_test_snapshot", "2026-10-01T01:01:00.000Z");
  const reference = { format: 1, schema_version: 13, snapshot_id: freshBundle.manifest.snapshot_id, digest: freshBundle.manifest.content_digest,
    old_waitlist_digest: oldBundle.manifest.content_digest, original_business_rows_preserved: true, scheduled_jobs_preserved: true,
    backup_created_at: freshBundle.manifest.created_at, created_at: "2026-10-01T01:02:00.000Z",
    metric_changes: [{ usage_date: "2026-10-01", before: old.usage_snapshots[0], after: fresh.usage_snapshots[0],
      changed_fields: ["captured_at", "database_size_bytes"], sampling_age_ms: 120000 }] };
  assert.equal(assertUpgradeReference(reference, oldBundle, freshBundle).tables.business_0[0].result, "old_immutable");
  for (const mutate of [r => r.old_waitlist_digest = "wrong", r => r.digest = "wrong", r => r.snapshot_id = "wrong",
    r => r.backup_created_at = r.created_at, r => r.metric_changes = [], r => r.metric_changes[0].before.database_size_bytes = 90,
    r => r.metric_changes[0].after.database_size_bytes = 900, r => r.metric_changes[0].sampling_age_ms = -1,
    r => r.metric_changes[0].sampling_age_ms = 119000, r => r.metric_changes[0].changed_fields = ["captured_at"],
    r => r.created_at = "2026-10-01T01:10:00.000Z"]) {
    const invalid = structuredClone(reference); mutate(invalid); assert.throws(() => assertUpgradeReference(invalid, oldBundle, freshBundle));
  }
  const corrupt = structuredClone(fresh); corrupt.business_0[0].result = "rewritten";
  const corruptBundle = privateBundle(corrupt, freshBundle.manifest.snapshot_id, freshBundle.manifest.created_at);
  assert.throws(() => assertUpgradeReference({ ...reference, digest: corruptBundle.manifest.content_digest }, oldBundle, corruptBundle));
});

test("unknown local-block recovery requires the exact request pin and full binding/error context", () => {
  const call = { payload: { request_id: "fixed_block_request" } }, event = { outbox_id: "out_A1", sequence: 1, topic: "SIGNUP_CHANGED", due_at_ms: 100,
    payload_json: JSON.stringify({ entity: { practice_id: "practice_A_test" } }) };
  const eventDigest = `sha256_v1:${sha(event.payload_json)}`;
  const tables = { sync_outbox: [{ ...event, status: "PENDING" }], sync_export_event_index: [{ outbox_id: event.outbox_id, event_sequence: 1,
    season_id: "season_c2_isolated_2026", handler_kind: "ASSOCIATED", practice_id: "practice_A_test", topic_anchor: event.topic, payload_anchor: event.payload_json,
    classification_anchor: JSON.stringify([event.outbox_id, 1, "season_c2_isolated_2026", "ASSOCIATED", "practice_A_test"]) }],
    sync_export_request_selections: [{ request_key: `req_v2_${sha("pentasus-c2-test\nC2:EXPORT\nexportNextAssociated\nfixed_block_request")}`,
      season_id: "season_c2_isolated_2026", binding_version: 1, outbox_id: event.outbox_id, event_anchor: event.payload_json, event_digest: eventDigest,
      request_digest: `sha256_v1:${sha(canonical({ season_id: "season_c2_isolated_2026", outbox_id: event.outbox_id }))}` }],
    sync_export_event_blocks: [{ outbox_id: event.outbox_id, season_id: "season_c2_isolated_2026", binding_version: 1, action_required: 1,
      practice_id: "practice_A_test", payload_anchor: event.payload_json, payload_digest: eventDigest, error_code: "SYNC_REFERENCE_NEEDS_REVIEW",
      blocked_scope: "PRACTICE", blocked_entity_id: "practice_A_test" }] };
  assertPendingBlock(event, call, tables, "PRACTICE", "practice_A_test");
  for (const mutate of [t => t.sync_export_request_selections[0].request_digest = "wrong", t => t.sync_export_request_selections[0].outbox_id = "different",
    t => t.sync_export_request_selections[0].binding_version = 2, t => t.sync_export_event_blocks[0].blocked_scope = "MEMBER",
    t => t.sync_export_event_blocks[0].payload_digest = "wrong", t => t.sync_export_event_blocks[0].action_required = 0]) {
    const invalid = structuredClone(tables); mutate(invalid); assert.throws(() => assertPendingBlock(event, call, invalid, "PRACTICE", "practice_A_test"));
  }
});

test("old request, revision and logical baseline values are protected while baseline sync timestamps may advance", () => {
  const fixture = { system_requests: [{ request_id: "old_request", result_json: "immutable" }], seat_plan_revisions: [{ revision_number: 1, seats_json: "original" }],
    sync_baselines: [{ entity_id: "old_row", value_json: "original", payload_digest: "fixed", entity_version: 3, updated_at: "old" }] };
  const wrap = rows => new Proxy(rows, { get: (target, key) => target[key] ?? [] });
  const current = structuredClone(fixture); current.sync_baselines[0].updated_at = "new";
  assertOriginalRows(wrap(fixture), wrap(current));
  for (const mutate of [t => t.system_requests[0].result_json = "changed", t => t.seat_plan_revisions[0].seats_json = "changed",
    t => t.sync_baselines[0].value_json = "changed", t => t.sync_baselines[0].payload_digest = "changed", t => t.sync_baselines[0].entity_version = 4]) {
    const invalid = structuredClone(current); mutate(invalid); assert.throws(() => assertOriginalRows(wrap(fixture), wrap(invalid)));
  }
});

test("a mismatched HTTP reply keeps the original request unknown and never persists a known result", async () => {
  const journal = j(), meta = { service_version: "0.17.0-c2-associated-lanes", backend_instance: "dragon-boat-training-c2-test",
    writer_epoch: 0, backend_generation: "cf-c2-isolated-1", contract_version: "2026-09-21.c1.5", request_id: "another_request" };
  const run = () => journalCall(journal, "signup-a1", () => ({ payload: { request_id: "original_request", preference: "LEFT" } }), () => {},
    async saved => { assertApiCorrelation(meta, saved.payload.request_id, "c1"); return { ok: true }; }, () => {});
  await assert.rejects(run()); assert.equal(journal.calls["signup-a1"].payload.request_id, "original_request");
  assert.ok(!Object.hasOwn(journal.calls["signup-a1"], "result")); meta.request_id = "original_request";
  assert.deepEqual(await run(), { ok: true });
});

test("actual C1 and C2 envelope contracts are distinct and both preserve exact request correlation", () => {
  const common = { service_version: "0.17.0-c2-associated-lanes", backend_instance: "dragon-boat-training-c2-test", writer_epoch: 0,
    backend_generation: "cf-c2-isolated-1", request_id: "fixed_request" };
  for (const [kind, contract] of [["c1", "2026-09-21.c1.5"], ["c2", "2026-09-30.c2.5-associated-export"]]) {
    const meta = { ...common, contract_version: contract }; assertApiCorrelation(meta, "fixed_request", kind);
    assert.throws(() => assertApiCorrelation(meta, "fixed_request", kind === "c1" ? "c2" : "c1"));
    assert.throws(() => assertApiCorrelation({ ...meta, contract_version: "2026-09-19.c0" }, "fixed_request", kind));
    assert.throws(() => assertApiCorrelation(meta, "other_request", kind));
  }
});

test("the configured isolated metadata and authoritative shared contracts match the runner response gate", () => {
  const vars = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8")).env.c2test.vars;
  const meta = { service_version: vars.SERVICE_VERSION, backend_instance: vars.BACKEND_INSTANCE,
    writer_epoch: Number(vars.WRITER_EPOCH), backend_generation: vars.BACKEND_GENERATION, request_id: "fixed_contract_probe" };
  for (const kind of ["c1", "c2"]) {
    const shared = readFileSync(new URL(`../shared/${kind}-actions.ts`, import.meta.url), "utf8");
    const declared = shared.match(new RegExp(`export const ${kind.toUpperCase()}_CONTRACT_VERSION = "([^"]+)";`)); assert.ok(declared);
    const contract = JSON.parse(readFileSync(new URL(`../contracts/api-cloudflare-${kind}.json`, import.meta.url), "utf8"));
    assert.equal(contract.contract_version, declared[1]);
    assertApiCorrelation({ ...meta, contract_version: declared[1] }, meta.request_id, kind);
  }
});

test("the actual restore metadata array permits an unversioned HEAD but requires exactly one original v14 deployment", () => {
  const identity = { deployment_id: "fixed_isolated_deployment" }, deployments = [{ deploymentId: "unversioned_head" },
    { deploymentId: identity.deployment_id, versionNumber: 14, description: "Original isolated clean v14" }];
  assertRestoredDeployment(deployments, identity);
  for (const invalid of [{ deployments }, [], [{ ...deployments[1], versionNumber: 15 }],
    [...deployments, { ...deployments[1] }], [...deployments, { deploymentId: identity.deployment_id }]]) {
    assert.throws(() => assertRestoredDeployment(invalid, identity));
  }
});

test("private failure diagnostics retain stack locations without assertion expected/actual or error messages", () => {
  const secretValue = "private_fixture_sentinel";
  let error; try { assert.equal(secretValue, "different"); } catch (failure) { error = failure; }
  const record = privateFailureRecord(error, "preflight"); assert.equal(record.phase, "preflight");
  assert.ok(record.stack_frames.length > 0); assert.ok(record.stack_frames.every(frame => /^\s+at\s/u.test(frame)));
  assert.ok(!JSON.stringify(record).includes(secretValue)); assert.ok(!Object.hasOwn(record, "message"));
});

test("phase ordering stops writes after an interrupted phase and permits only confirmed history", () => {
  const journal = j();
  assert.throws(() => assertPhase(journal, "prepare"));
  journal.phases.capture = { complete: true };
  assertPhase(journal, "prepare");
  journal.phases.prepare = { complete: false, outcome: { status: "NEW_WEEK_CAPTURED" } };
  assert.throws(() => assertPhase(journal, "create-b"));
  journal.phases.prepare.complete = true;
  assertPhase(journal, "create-b");
  journal.phases["create-b"] = { complete: false };
  assertPhase(journal, "prepare"); // A completed phase may only take the runner's read-only branch.
  const full = j(); for (const phase of PHASES) { assertPhase(full, phase); full.phases[phase] = { complete: true }; }
  assertPhase(full, "final");
});

test("unknown business reply keeps the persisted original request and payload", async () => {
  let journal = j(), persisted, attempt = 0;
  const save = state => { persisted = structuredClone(state); };
  const factory = () => ({ payload: { request_id: "fixed_original_id", signup_version: 0, preference: "LEFT" } });
  await assert.rejects(journalCall(journal, "signup-a1", factory, save, async saved => {
    assert.deepEqual(persisted.calls["signup-a1"], saved); attempt++;
    throw new Error("Remote committed but reply was lost");
  }, () => {}));
  journal = structuredClone(persisted);
  const result = await journalCall(journal, "signup-a1", () => { throw new Error("A replacement payload is forbidden"); }, save,
    async saved => { attempt++; assert.equal(saved.payload.request_id, "fixed_original_id"); assert.equal(saved.payload.signup_version, 0); return { signup_version: 1 }; },
    result => assert.equal(result.signup_version, 1));
  assert.equal(attempt, 2); assert.equal(result.signup_version, 1);
  assert.deepEqual(await journalCall(journal, "signup-a1", factory, save, () => { throw new Error("Known result must be cached"); }, () => {}), result);
});

test("a validation failure never records a success or completes the phase", async () => {
  const journal = j(); journal.phases.capture = { complete: true }; journal.phases.prepare = { complete: false };
  await assert.rejects(journalCall(journal, "prepare", () => ({ payload: { request_id: "fixed" } }), () => {},
    async () => ({ unexpected: true }), () => assert.fail("Wrong result")));
  assert.ok(!Object.hasOwn(journal.calls.prepare, "result")); assert.equal(journal.phases.prepare.complete, false);
  assert.throws(() => assertPhase(journal, "create-b"));
});

test("single-row CAS preserves all other cells and restores from captured bytes", () => {
  const page = sheet(), original = structuredClone(page), drift = singleRowCas(page, "PRACTICE", "practice_A_test", "location", "marker", "apply_fixed");
  assert.deepEqual(page, original); assert.equal(drift.action, "cloudflarePatchPracticeSheet");
  assert.deepEqual(drift.payload.items, [{ practice_id: "practice_A_test", expected: original.rows[0].cells,
    target: ["season_c2_isolated_2026", "practice_A_test", "marker"] }]);
  drift.result = { status: "verified" };
  const restore = reverseCas(drift, "restore_fixed");
  assert.ok(!restore.result); assert.equal(restore.operation_id, "restore_fixed"); assert.equal(restore.payload.batch_id, "restore_fixed");
  assert.deepEqual(restore.payload.items[0].target, original.rows[0].cells);
  assert.throws(() => singleRowCas(page, "PRACTICE", "practice_A_test", "practice_id", "replacement", "bad"));
  assert.throws(() => singleRowCas({ ...page, rows: [...page.rows, page.rows[0]] }, "PRACTICE", "practice_A_test", "location", "marker", "bad"));
});

test("reading target after a lost CAS reply still requires the same operation receipt", async () => {
  const journal = j(), page = sheet(), drift = singleRowCas(page, "PRACTICE", "practice_A_test", "location", "marker", "same_operation");
  let writes = 0, receiptRequests = 0;
  const receipt = saved => ({ status: "verified", operation_id: saved.operation_id, payload_digest: sha(JSON.stringify(saved.payload)),
    spreadsheet_id: saved.payload.spreadsheet_id, tab_id: saved.payload.tab_id, entity_type: "PRACTICE", verified_row_ids: ["practice_A_test"] });
  await assert.rejects(journalCall(journal, "drift-practice", () => drift, () => {}, async saved => {
    writes++; page.rows[0].cells = [...saved.payload.items[0].target]; throw new Error("Unknown receipt");
  }, assertCasReceipt));
  assert.deepEqual(page.rows[0].cells, drift.payload.items[0].target);
  await journalCall(journal, "drift-practice", () => assert.fail("Do not recompute expected from target"), () => {}, async saved => {
    receiptRequests++; assert.equal(saved.operation_id, "same_operation"); return receipt(saved);
  }, assertCasReceipt);
  assert.equal(writes, 1); assert.equal(receiptRequests, 1);
  const good = receipt(drift);
  for (const corrupt of [{ ...good, status: "PARTIAL" }, { ...good, operation_id: "replacement" }, { ...good, payload_digest: "wrong" },
    { ...good, verified_row_ids: [] }, { ...good, tab_id: "999" }]) assert.throws(() => assertCasReceipt(corrupt, drift));
});

test("member CAS uses the existing member receipt and preserves complete original row", () => {
  const page = { ...sheet(), entity_type: "MEMBER", headers: ["season_id", "member_id", "status"], rows: [{ cells: ["season_c2_isolated_2026", "member_alpha_test", "ACTIVE"] }] };
  const saved = singleRowCas(page, "MEMBER", "member_alpha_test", "status", "INACTIVE", "member_same_id");
  assert.equal(saved.action, "cloudflarePatchMemberSheet");
  assertCasReceipt({ status: "verified", operation_id: saved.operation_id, payload_digest: sha(JSON.stringify(saved.payload)),
    spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id, verified_member_ids: ["member_alpha_test"] }, saved);
  assert.deepEqual(reverseCas(saved, "member_restore").payload.items[0].target, page.rows[0].cells);
});

test("immutable event proof detects payload, due, topic and sequence changes", () => {
  const event = { outbox_id: "out_test", payload_json: JSON.stringify({ entity: { season_id: "season_c2_isolated_2026", practice_id: "practice_A_test" } }), topic: "SIGNUPS_CHANGED", due_at_ms: 100, sequence: 2 };
  const tables = { sync_outbox: [{ ...event, status: "PENDING" }], sync_export_event_index: [{ outbox_id: "out_test", payload_anchor: event.payload_json,
    topic_anchor: event.topic, event_sequence: 2, season_id: "season_c2_isolated_2026", handler_kind: "ASSOCIATED", practice_id: "practice_A_test",
    classification_anchor: JSON.stringify(["out_test", 2, "season_c2_isolated_2026", "ASSOCIATED", "practice_A_test"]) }] };
  assert.equal(assertEventAnchor(event, tables).status, "PENDING");
  for (const field of ["payload_json", "topic", "due_at_ms"]) {
    const changed = structuredClone(tables); changed.sync_outbox[0][field] = "changed";
    assert.throws(() => assertEventAnchor(event, changed));
  }
  const changed = structuredClone(tables); changed.sync_export_event_index[0].event_sequence = 9;
  assert.throws(() => assertEventAnchor(event, changed));
});

test("Google protection covers unrelated practices, member rows and complete immutable revisions", () => {
  const before = { PRACTICE: sheet(), SEAT_PLAN_REVISION: { headers: ["season_id", "practice_id", "revision_number", "seats_json"],
    rows: [{ cells: ["season_c2_isolated_2026", "old_practice", "1", "immutable"] }] } };
  const after = structuredClone(before); after.PRACTICE.rows[0].cells[2] = "permitted";
  assertGoogleUnchanged(before, after, [{ scope: "PRACTICE", id: "practice_A_test" }]);
  after.PRACTICE.rows[1].cells[2] = "unexpected"; assert.throws(() => assertGoogleUnchanged(before, after, [{ scope: "PRACTICE", id: "practice_A_test" }]));
  after.PRACTICE.rows[1].cells[2] = "Independent dock"; after.SEAT_PLAN_REVISION.rows[0].cells[3] = "rewritten";
  assert.throws(() => assertGoogleUnchanged(before, after, [{ scope: "PRACTICE", id: "practice_A_test" }]));
});

test("confirmed patches are checked against immutable signup snapshots, not current C", () => {
  const headers = ["season_id", "practice_id", "member_id", "preference", "status", "queue_at", "queue_sequence", "updated_at", "last_request_id"];
  const signup = { season_id: "season_c2_isolated_2026", practice_id: "practice_A_test", member_id: "member_alpha_test", preference: "LEFT",
    status: "CONFIRMED", queue_at: "original_time", queue_sequence: 1, updated_at: "event_time", last_request_id: "original_request" };
  const target = headers.map(field => String(signup[field]));
  const event = { outbox_id: "out_A1", sequence: 1, payload_json: JSON.stringify({ entity: { signup_rows: [signup] } }) };
  const page = { headers, rows: [], spreadsheet_id: "runtime_fixture", tab_id: "101" };
  const journal = { google: { SIGNUP: page }, events: { a1: event }, calls: {} };
  const stored = { scope: "SIGNUP", row_id: "practice_A_test:member_alpha_test", expected: null, target };
  const [batch, item] = confirmedPatch("batch_original", event.outbox_id, "SIGNUP", stored, page);
  const tables = { sync_batches: [batch], sync_batch_items: [item] };
  assert.deepEqual(expectedGoogleRows(journal, tables).SIGNUP, [target]);
  const wrong = [...target]; wrong[3] = "RIGHT";
  const [wrongBatch, wrongItem] = confirmedPatch("batch_original", event.outbox_id, "SIGNUP", { ...stored, target: wrong }, page);
  const corrupt = { sync_batches: [wrongBatch], sync_batch_items: [wrongItem] };
  assertBatchReceipt(wrongBatch, [wrongItem], { SIGNUP: page }); // A valid receipt must still fail the independent snapshot oracle.
  assert.throws(() => expectedGoogleRows(journal, corrupt));
});

function confirmedPatch(batchId, outbox, scope, stored, page) {
  const idKey = scope === "SIGNUP" ? "row_id" : scope === "PRACTICE" ? "practice_id" : scope === "TRAINING_WEEK" ? "week_id" : "season_id";
  const id = stored.row_id ?? stored.season_id;
  const payload = { season_id: "season_c2_isolated_2026", batch_id: batchId, ...(scope === "SEASON" ? {} : { entity_type: scope }),
    spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id, items: [{ [idKey]: id, expected: stored.expected, target: stored.target }] };
  const batch = { batch_id: batchId, first_outbox_id: outbox, status: "CONFIRMED", season_id: "season_c2_isolated_2026", binding_version: 1,
    writer_epoch: 0, direction: "CLOUDFLARE_TO_GOOGLE", payload_digest: sha(JSON.stringify(payload)) };
  const receipt = { status: "verified", operation_id: batchId, payload_digest: batch.payload_digest, protocol_version: "2026-09-19.bridge.v1",
    team_id: "pentasus-c2-test", season_id: batch.season_id, binding_version: 1, writer_epoch: 0, spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id,
    ...(scope === "SEASON" ? { verified_season_ids: [id] } : { entity_type: scope, verified_row_ids: [id] }), acknowledged_at: "2026-10-01T00:00:00.000Z" };
  return [batch, { batch_id: batchId, item_index: 0, entity_type: scope, status: "VERIFIED", target_json: JSON.stringify(stored),
    target_digest: `sha256_v1:${sha(canonical(stored.target))}`, receipt_json: JSON.stringify(receipt) }];
}

test("download integrity rejects missing, reordered, orphaned or changed backup chunks independently of server verify", () => {
  const make = () => {
    const chunks = [0, 1, 2].map(index => ({ chunk_index: index, table_name: index === 2 ? "empty" : "members", row_offset: index === 1 ? 1 : 0,
      row_count: index === 2 ? 0 : 1, payload: { table: index === 2 ? "empty" : "members", row_offset: index === 1 ? 1 : 0,
        rows: index === 2 ? [] : [{ id: index }] } }));
    const manifest = { format: "sqlite-json-chunks-v1", schema_version: 14, table_count: 2, chunk_count: 3, record_count: 2,
      tables: [{ name: "members", row_count: 2, chunk_indices: [0, 1] }, { name: "empty", row_count: 0, chunk_indices: [2] }] };
    return { manifest, chunks };
  };
  const seal = bundle => {
    for (const chunk of bundle.chunks) chunk.payload_digest = `sha256_v1:${sha(canonical(chunk.payload))}`;
    bundle.manifest.chunks = bundle.chunks.map(({ payload, ...chunk }) => chunk);
    delete bundle.manifest.content_digest; bundle.manifest.content_digest = `sha256_v1:${sha(canonical(bundle.manifest))}`;
    return bundle;
  };
  const valid = seal(make()); assert.deepEqual(assertBackupDownload(valid.manifest, valid.chunks), { members: [{ id: 0 }, { id: 1 }], empty: [] });
  for (const mutate of [
    b => b.chunks.pop(), b => b.chunks.reverse(), b => b.chunks[1].chunk_index = 0,
    b => b.chunks[1].table_name = "unknown", b => b.chunks[1].payload.table = "wrong",
    b => { b.chunks[1].row_offset = 2; b.chunks[1].payload.row_offset = 2; }, b => b.chunks[1].row_count = 8,
    b => b.manifest.tables[0].row_count = 9, b => b.manifest.tables[0].chunk_indices = [1, 0],
    b => b.manifest.tables[1].name = "members", b => b.manifest.record_count = 9
  ]) {
    const invalid = make(); mutate(invalid); seal(invalid); assert.throws(() => assertBackupDownload(invalid.manifest, invalid.chunks));
  }
  const badDigest = seal(make()); badDigest.manifest.content_digest = "wrong";
  assert.throws(() => assertBackupDownload(badDigest.manifest, badDigest.chunks));
});

test("the schema13 upgrade preserves business rows, all 43 tables and original rowid ranks", () => {
  const before = Object.fromEntries(Array.from({ length: 35 }, (_, index) => [`original_${index}`, []]));
  Object.assign(before, metricTables());
  before.app_meta = [{ key: "schema_version", value: "13" }, { key: "epoch", value: "0" }];
  before.sync_outbox = [1, 2].map(index => ({ outbox_id: `out_old_${index}`, topic: "SCHEDULE_CHANGED", payload_json: JSON.stringify({ entity: { season_id: "season_c2_isolated_2026" } }), status: "CONFIRMED" }));
  before.original_0 = [{ original_result: "immutable" }];
  const after = structuredClone(before); after.app_meta[0].value = "14";
  after.sync_export_event_index = before.sync_outbox.map((row, index) => ({ outbox_id: row.outbox_id, event_sequence: index + 1,
    payload_anchor: row.payload_json, topic_anchor: row.topic, season_id: "season_c2_isolated_2026", handler_kind: "BARRIER", practice_id: null,
    classification_anchor: JSON.stringify([row.outbox_id, index + 1, "season_c2_isolated_2026", "BARRIER", null]) }));
  for (const table of ["sync_export_event_blocks", "sync_export_request_selections", "sync_export_poll_plans"]) after[table] = [];
  assertMigrationPreserved(before, after);
  for (const mutate of [
    a => a.original_0[0].original_result = "rewritten", a => a.app_meta[1].value = "1",
    a => a.sync_outbox.pop(), a => a.sync_export_event_index[0].event_sequence = 2,
    a => a.sync_export_event_index[0].classification_anchor = "wrong", a => a.sync_export_request_selections.push({ unplanned: true })
  ]) { const invalid = structuredClone(after); mutate(invalid); assert.throws(() => assertMigrationPreserved(before, invalid)); }
});

test("verified batch evidence rejects wrong receipt identity, digest or row coverage", () => {
  const page = { spreadsheet_id: "runtime_fixture", tab_id: "101" }, stored = { scope: "SIGNUP", row_id: "practice_A_test:member_alpha_test", expected: null, target: ["target"] };
  const [batch, item] = confirmedPatch("batch_fixed", "out_fixed", "SIGNUP", stored, page);
  assertBatchReceipt(batch, [item], { SIGNUP: page });
  for (const values of [{ operation_id: "other" }, { payload_digest: "wrong" }, { team_id: "other" }, { writer_epoch: 1 },
    { verified_row_ids: [] }, { spreadsheet_id: "other" }, { protocol_version: "other" }, { status: "PARTIAL" }]) {
    const changed = { ...item, receipt_json: JSON.stringify({ ...JSON.parse(item.receipt_json), ...values }) };
    assert.throws(() => assertBatchReceipt(batch, [changed], { SIGNUP: page }));
  }
  assert.throws(() => assertBatchReceipt(batch, [{ ...item, receipt_json: undefined }], { SIGNUP: page }));
});

test("A/B timing uses actual template day, protects season boundaries and verifies NY cutoff", () => {
  const template = { day_of_week: 3, start_time: "18:00", end_time: "20:00", timezone: "America/New_York" };
  const season = { start_date: "2026-09-01", end_date: "2026-12-31" }, now = Date.parse("2026-10-01T00:00:00Z");
  const result = fixtureTimings("2026-10-19", template, season, now);
  assert.equal(result.a.date, "2026-10-21"); assert.equal(result.b.date, "2026-10-23");
  assert.equal(result.a.start_at, "2026-10-21T22:00:00.000Z"); assert.equal(result.a.signup_cutoff_at, "2026-10-21T20:00:00.000Z");
  assert.throws(() => fixtureTimings("2026-12-28", template, season, now));
  assert.throws(() => fixtureTimings("2026-10-19", { ...template, end_time: "17:00" }, season, now));
  assert.throws(() => fixtureTimings("2026-10-19", template, season, Date.parse("2026-10-24T00:00:00Z")));
});

test("three captured schedule stages independently project new rows while preserving the old season", () => {
  const google = { SEASON: { spreadsheet_id: "system", tab_id: "1", headers: ["season_id", "season_version", "roster_version"], rows: [{ cells: ["season_c2_isolated_2026", "3", "14"] }] },
    TRAINING_WEEK: { spreadsheet_id: "runtime", tab_id: "2", headers: ["season_id", "week_id", "week_version", "status"], rows: [] },
    PRACTICE: { spreadsheet_id: "runtime", tab_id: "3", headers: ["season_id", "practice_id", "practice_version", "location"], rows: [] } };
  const week = number => ({ season_id: "season_c2_isolated_2026", week_id: "week_new", week_version: number, status: number === 3 ? "OPENED" : "DRAFT" });
  const practice = (id, version) => ({ season_id: "season_c2_isolated_2026", practice_id: id, practice_version: version, location: `Dock ${id}` });
  const snapshots = [{ season_version: 3, week: week(1), practices: [practice("A", 1)] },
    { season_version: 3, week: week(2), practices: [practice("B", 1)] }, { season_version: 3, week: week(3), practices: [practice("A", 2), practice("B", 2)] }];
  const journal = { google, events: {}, calls: {} }, tables = { sync_batches: [], sync_batch_items: [] };
  snapshots.forEach((entity, index) => {
    const outbox = `out_schedule_${index}`, event = { sequence: index + 1, outbox_id: outbox, payload_json: JSON.stringify({ entity }) }; journal.events[index] = event;
    const rows = [["TRAINING_WEEK", entity.week], ...entity.practices.map(row => ["PRACTICE", row])];
    for (const [scope, row] of rows) {
      const target = google[scope].headers.map(field => String(row[field]));
      const stored = { entity_type: scope, row_id: row.week_id ?? row.practice_id, expected: null, target };
      const [batch, item] = confirmedPatch(`batch_${index}_${scope}_${stored.row_id}`, outbox, scope, stored, google[scope]);
      tables.sync_batches.push(batch); tables.sync_batch_items.push(item);
    }
    const stored = { season_id: "season_c2_isolated_2026", expected: google.SEASON.rows[0].cells, target: [...google.SEASON.rows[0].cells] };
    const [batch, item] = confirmedPatch(`batch_${index}_season`, outbox, "SEASON", stored, google.SEASON); tables.sync_batches.push(batch); tables.sync_batch_items.push(item);
  });
  const result = expectedGoogleRows(journal, tables);
  assert.deepEqual(result.SEASON, [google.SEASON.rows[0].cells]);
  assert.deepEqual(result.TRAINING_WEEK, [["season_c2_isolated_2026", "week_new", "3", "OPENED"]]);
  assert.deepEqual(result.PRACTICE, [["season_c2_isolated_2026", "A", "2", "Dock A"], ["season_c2_isolated_2026", "B", "2", "Dock B"]]);
});

test("the full actual static scope map is parsed without evaluation", () => {
  const definitions = readScopeDefinitions(readFileSync(new URL("../cloudflare/src/c2-sheet-bridge.ts", import.meta.url), "utf8"));
  assert.equal(Object.keys(definitions).length, 10); assert.equal(definitions.PRACTICE.tab, "Practices");
  assert.ok(definitions.PRACTICE.headers.includes("location")); assert.deepEqual(definitions.COACH.headers, ["coach_id"]);
  assert.throws(() => readScopeDefinitions("export const SHEET_SCOPES = dangerous();"));
});

test("an invalid isolated URL is refused locally with redacted output and no network", () => {
  const result = spawnSync(process.execPath, ["tests/live-c2-associated-lane-acceptance.mjs", "--phase=preflight"], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", env: { ...process.env, C2_TEST_URL: "https://example.invalid/" }
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr.trim()); assert.equal(error.status, "FAILED_STOP");
  assert.ok(["DATA_PRECONDITION_REQUIRED", "PRECONDITION_OR_EVIDENCE_MISMATCH"].includes(error.error_code));
  assert.ok(!result.stderr.includes("example.invalid") && !result.stderr.includes("AssertionError"));
});
