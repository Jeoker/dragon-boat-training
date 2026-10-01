// Explicit isolated acceptance only. Importing this module never reads secrets or calls a network.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertCleanSourceSets, sourceFiles } from "./build-c2-associated-fault-overlay.mjs";
import { verifyPrivateBackup } from "./live-c2-associated-fault-inspect.mjs";

export const PHASES = ["capture", "prepare", "create-b", "open", "export-schedule", "signup-a1", "signup-b1",
  "drift-practice", "block-a1", "signup-a2", "probe-successor", "export-b1", "restore-practice", "retry-a1",
  "export-a1", "signup-b2", "drift-member", "block-a2", "block-b2", "restore-member", "retry-a2", "retry-b2",
  "export-a2", "export-b2", "final"];
const SEASON = "season_c2_isolated_2026", TEAM = "pentasus-c2-test";
const VERSION = "0.17.0-c2-associated-lanes", WORKER = "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/";
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const equal = (a, b) => assert.equal(canonical(a), canonical(b));
const sha = value => createHash("sha256").update(value).digest("base64url");
const digest = value => `sha256_v1:${sha(canonical(value))}`;
const load = path => JSON.parse(readFileSync(path, "utf8"));
const fresh = label => `c2_lane_${label}_${randomUUID().replaceAll("-", "")}`;
const requireData = (test, code) => { if (!test) throw Object.assign(new Error("DATA_PRECONDITION_REQUIRED"), { condition: code }); };

export function assertPhase(journal, phase) {
  assert.ok(PHASES.includes(phase));
  assert.equal(journal.format, 1); assert.equal(journal.service_version, VERSION);
  const index = PHASES.indexOf(phase);
  assert.ok(PHASES.slice(0, index).every(key => journal.phases[key]?.complete), "Previous phases are incomplete.");
  if (journal.phases[phase]?.complete) return; // Read-only current-progress verification is allowed.
  assert.ok(!PHASES.slice(index + 1).some(key => journal.phases[key] && !journal.phases[key].complete));
}
// The caller persists before awaiting. Unknown outcomes retain exactly this payload and ID.
export async function journalCall(journal, label, factory, persist, invoke, verify) {
  let saved = journal.calls[label];
  if (!saved) { saved = journal.calls[label] = factory(); persist(journal); }
  if (Object.hasOwn(saved, "result")) return saved.result;
  const result = await invoke(saved);
  verify(result, saved);
  saved.result = result; persist(journal);
  return result;
}
export function saveKnownExport(journal, phase, event, request, result, persist) {
  assert.equal(journal.evidence_pending ?? null, null);
  assert.ok(["BATCH_CONFIRMED", "EVENT_CONFIRMED"].includes(result.status));
  assert.equal(result.outbox_id, event.outbox_id); equal(event.inflight, request);
  event.calls.push({ request, result }); event.inflight = null;
  event.confirmed = result.status === "EVENT_CONFIRMED";
  journal.evidence_pending = { phase, outbox_id: event.outbox_id, call_index: event.calls.length - 1, request_id: request.request_id };
  persist(journal);
}
export function pendingExportEvidence(journal, phase) {
  if (!journal.evidence_pending) return null;
  const checkpoint = journal.evidence_pending; assert.equal(checkpoint.phase, phase);
  const event = Object.values(journal.events).find(row => row.outbox_id === checkpoint.outbox_id); assert.ok(event);
  assert.equal(event.inflight, null); assert.equal(checkpoint.call_index, event.calls.length - 1);
  const call = event.calls[checkpoint.call_index]; assert.equal(call.request.request_id, checkpoint.request_id);
  assert.ok(["BATCH_CONFIRMED", "EVENT_CONFIRMED"].includes(call.result.status)); assert.equal(call.result.outbox_id, event.outbox_id);
  return { event, call };
}
export function clearExportEvidence(journal, phase, persist) {
  assert.ok(pendingExportEvidence(journal, phase)); journal.evidence_pending = null; persist(journal);
}
export function assertApiCorrelation(meta, requestId, kind) {
  assert.ok(kind === "c1" || kind === "c2");
  assert.equal(meta?.service_version, VERSION); assert.equal(meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(meta?.writer_epoch, 0); assert.equal(meta?.request_id, requestId);
  assert.equal(meta?.backend_generation, "cf-c2-isolated-1");
  assert.equal(meta?.contract_version, kind === "c1" ? "2026-09-21.c1.5" : "2026-09-30.c2.5-associated-export");
}
export function assertRestoredDeployment(deployments, identity) {
  assert.ok(Array.isArray(deployments));
  assert.equal(deployments.filter(item => item.deploymentId === identity.deployment_id && item.versionNumber === 14).length, 1);
  assert.equal(deployments.filter(item => item.deploymentId === identity.deployment_id).length, 1);
}
export function privateFailureRecord(error, phase) {
  return { format: 1, phase, recorded_at: new Date().toISOString(), error_name: error.name,
    condition: error.condition ?? null, ...(error.http_context ? { http_context: error.http_context } : {}),
    stack_frames: String(error.stack ?? "").split("\n").filter(line => /^\s+at\s/u.test(line)) };
}
const HTTP_PATHS = new Set(["coach-login", "coach-logout", "create-backup-snapshot", "verify-backup-snapshot", "get-backup-chunk", "schedule-workspace",
  "prepare-training-week", "create-practice", "confirm-training-week", "signup"].map(action => `/internal/c1/${action}`).concat(
  ["get-sync-overview", "check-sheet-differences", "check-associated-physical-differences", "export-next-associated", "export-next-schedule", "retry-export", "list-export-blocks"].map(action => `/internal/c2/${action}`)));
const HTTP_SCOPES = new Set(["SEASON", "COACH", "MEMBER", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE", "SIGNUP", "SEAT_PLAN_DRAFT", "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION"]);
export function goodHttp(result) {
  if (result.http === 200 && result.ok === true) return result.data;
  const codes = new Set(["SERVICE_BUSY", ...["c1", "c2"].flatMap(kind => load(new URL(`../contracts/api-cloudflare-${kind}.json`, import.meta.url)).errors)]);
  const status = Number.isInteger(result.http) && result.http >= 100 && result.http <= 599 ? result.http : "UNKNOWN";
  const code = codes.has(result.error) ? result.error : "UNCLASSIFIED_ERROR";
  const context = { status, error_code: code, retryable: typeof result.retryable === "boolean" ? result.retryable : null,
    path: HTTP_PATHS.has(result.context?.path) ? result.context.path : null,
    scope: HTTP_SCOPES.has(result.context?.scope) ? result.context.scope : null };
  throw Object.assign(new Error("HTTP_REQUEST_FAILED"), { condition: `HTTP_${status}_${code}`, http_context: context });
}
export function singleRowCas(page, scope, id, field, value, operationId) {
  assert.ok(["PRACTICE", "MEMBER"].includes(scope)); assert.equal(page.entity_type, scope);
  const idIndex = page.headers.indexOf(scope === "PRACTICE" ? "practice_id" : "member_id");
  const fieldIndex = page.headers.indexOf(field);
  assert.ok(idIndex >= 0 && fieldIndex >= 0);
  assert.ok(scope === "PRACTICE" && field === "location" || scope === "MEMBER" && field === "status");
  const matches = page.rows.filter(row => row.cells[idIndex] === id); assert.equal(matches.length, 1);
  const expected = [...matches[0].cells], target = [...expected]; target[fieldIndex] = value;
  assert.notEqual(expected[fieldIndex], value); assert.ok(!String(value).startsWith("="));
  return { action: scope === "PRACTICE" ? "cloudflarePatchPracticeSheet" : "cloudflarePatchMemberSheet", operation_id: operationId,
    payload: { season_id: SEASON, entity_type: scope, batch_id: operationId, spreadsheet_id: page.spreadsheet_id,
      tab_id: page.tab_id, items: [{ [scope === "PRACTICE" ? "practice_id" : "member_id"]: id, expected, target }] } };
}
export function reverseCas(original, operationId) {
  const restored = structuredClone(original); delete restored.result;
  restored.operation_id = operationId; restored.payload.batch_id = operationId;
  [restored.payload.items[0].expected, restored.payload.items[0].target] =
    [restored.payload.items[0].target, restored.payload.items[0].expected];
  return restored;
}
export function assertCasReceipt(receipt, saved) {
  const { payload, operation_id } = saved, item = payload.items[0];
  assert.equal(receipt.status, "verified"); assert.equal(receipt.operation_id, operation_id);
  assert.equal(receipt.payload_digest, sha(JSON.stringify(payload)));
  assert.equal(receipt.spreadsheet_id, payload.spreadsheet_id); assert.equal(receipt.tab_id, payload.tab_id);
  const member = payload.entity_type === "MEMBER";
  if (!member) assert.equal(receipt.entity_type, payload.entity_type);
  equal(receipt[member ? "verified_member_ids" : "verified_row_ids"], [item[member ? "member_id" : "practice_id"]]);
}
export function assertEventAnchor(event, tables) {
  const row = tables.sync_outbox.find(item => item.outbox_id === event.outbox_id); assert.ok(row);
  assert.equal(row.payload_json, event.payload_json); assert.equal(row.topic, event.topic);
  assert.equal(row.due_at_ms, event.due_at_ms);
  const index = tables.sync_export_event_index.find(item => item.outbox_id === event.outbox_id); assert.ok(index);
  assert.equal(index.payload_anchor, event.payload_json); assert.equal(index.topic_anchor, event.topic);
  assert.equal(index.event_sequence, event.sequence);
  const entity = JSON.parse(event.payload_json).entity;
  assert.equal(index.season_id, SEASON);
  assert.equal(index.handler_kind, event.topic === "SCHEDULE_CHANGED" ? "BARRIER" : "ASSOCIATED");
  assert.equal(index.practice_id, event.topic === "SCHEDULE_CHANGED" ? null : entity.practice_id);
  assert.equal(index.classification_anchor, JSON.stringify([event.outbox_id, event.sequence, SEASON, index.handler_kind, index.practice_id]));
  return row;
}
export function assertBackupDownload(manifest, chunks) {
  return assertDownloadSchema(manifest, chunks, 14);
}
function assertDownloadSchema(manifest, chunks, schema) {
  const { content_digest, ...core } = manifest;
  assert.equal(manifest.schema_version, schema); assert.equal(manifest.format, "sqlite-json-chunks-v1");
  assert.equal(content_digest, digest(core)); assert.equal(chunks.length, manifest.chunk_count);
  assert.equal(manifest.chunks.length, chunks.length); assert.equal(manifest.tables.length, manifest.table_count);
  const names = manifest.tables.map(row => row.name); assert.equal(new Set(names).size, names.length);
  const used = [];
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.chunk_index, index); assert.ok(names.includes(chunk.table_name));
    assert.equal(chunk.payload.table, chunk.table_name); assert.equal(chunk.payload.row_offset, chunk.row_offset);
    assert.equal(chunk.row_count, chunk.payload.rows.length); assert.equal(chunk.payload_digest, digest(chunk.payload));
    equal(manifest.chunks[index], { chunk_index: index, table_name: chunk.table_name, row_offset: chunk.row_offset,
      row_count: chunk.row_count, payload_digest: chunk.payload_digest });
  }
  for (const table of manifest.tables) {
    const group = chunks.filter(chunk => chunk.table_name === table.name); let offset = 0;
    equal(table.chunk_indices, group.map(chunk => chunk.chunk_index)); used.push(...table.chunk_indices);
    for (const chunk of group) { assert.equal(chunk.row_offset, offset); offset += chunk.row_count; }
    assert.equal(offset, table.row_count);
  }
  equal(used.sort((a, b) => a - b), chunks.map((_, index) => index));
  assert.equal(manifest.record_count, manifest.tables.reduce((sum, table) => sum + table.row_count, 0));
  return Object.fromEntries(manifest.tables.map(table => [table.name, chunks.filter(chunk => chunk.table_name === table.name).flatMap(chunk => chunk.payload.rows)]));
}
const USAGE_FIELDS = ["usage_date", "captured_at", "database_size_bytes", "request_count", "audit_count", "outbox_pending", "jobs_pending", "history_practice_count", "history_season_count"];
export function assertUsageRefresh(before, tables) {
  const rows = tables.usage_snapshots; assert.ok(Array.isArray(rows));
  assert.equal(new Set(rows.map(row => row.usage_date)).size, rows.length);
  for (const row of rows) {
    equal(Object.keys(row).sort(), [...USAGE_FIELDS].sort()); assert.match(row.usage_date, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(Number.isFinite(Date.parse(row.captured_at))); assert.equal(row.captured_at.slice(0, 10), row.usage_date);
    for (const field of USAGE_FIELDS.slice(2)) assert.ok(Number.isSafeInteger(row[field]) && row[field] >= 0);
  }
  const changes = [];
  for (const old of before.usage_snapshots) {
    const row = rows.find(item => item.usage_date === old.usage_date); assert.ok(row);
    equal(Object.keys(old).sort(), [...USAGE_FIELDS].sort()); assert.ok(Date.parse(row.captured_at) >= Date.parse(old.captured_at));
    const changed_fields = Object.keys(old).filter(field => canonical(old[field]) !== canonical(row[field]));
    if (changed_fields.length) {
      assert.ok(Date.parse(row.captured_at) > Date.parse(old.captured_at));
      changes.push({ usage_date: old.usage_date, before: old, after: row, sampling_age_ms: Date.now() - Date.parse(row.captured_at), changed_fields });
    }
  }
  const latest = [...rows].sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at))[0]; assert.ok(latest);
  const sampleAt = Date.parse(latest.captured_at);
  const lastBusinessAt = Math.max(0, ...tables.sync_outbox.flatMap(row => [row.created_at, row.completed_at].map(Date.parse)).filter(Number.isFinite));
  if (sampleAt >= lastBusinessAt) assert.equal(latest.outbox_pending, tables.sync_outbox.filter(row => row.status === "PENDING").length);
  const jobsAtSample = tables.scheduled_jobs.filter(row => {
    assert.ok(Number.isFinite(Date.parse(row.created_at))); if (Date.parse(row.created_at) > sampleAt) return false;
    if (row.completed_at) { assert.ok(Number.isFinite(Date.parse(row.completed_at))); return Date.parse(row.completed_at) > sampleAt; }
    if (["PENDING", "RUNNING"].includes(row.status)) return true;
    assert.ok(Number.isFinite(Date.parse(row.updated_at)) && Date.parse(row.updated_at) <= sampleAt);
    return false;
  }).length;
  assert.equal(latest.jobs_pending, jobsAtSample);
  assert.ok(latest.request_count <= tables.system_requests.length && latest.audit_count <= tables.audit_events.length);
  assert.equal(latest.history_practice_count, tables.practice_history.length); assert.equal(latest.history_season_count, tables.season_history.length);
  return { changes, added_dates: rows.filter(row => !before.usage_snapshots.some(old => old.usage_date === row.usage_date)).map(row => row.usage_date),
    sample_captured_at: latest.captured_at, sampling_age_ms: Date.now() - sampleAt,
    sampled_after_last_business_event: sampleAt >= lastBusinessAt, before: before.usage_snapshots, after: rows };
}
export function assertUpgradeReference(reference, oldBundle, freshBundle) {
  assert.equal(reference.format, 1); assert.equal(reference.schema_version, 13);
  assert.equal(reference.old_waitlist_digest, oldBundle.manifest.content_digest);
  assert.equal(reference.snapshot_id, freshBundle.manifest.snapshot_id); assert.equal(reference.digest, freshBundle.manifest.content_digest);
  assert.equal(reference.backup_created_at, freshBundle.manifest.created_at);
  assert.equal(reference.original_business_rows_preserved, true); assert.equal(reference.scheduled_jobs_preserved, true);
  const old = verifyPrivateBackup(oldBundle), freshTables = verifyPrivateBackup(freshBundle);
  assertDownloadSchema(oldBundle.manifest, oldBundle.chunks, 13); assertDownloadSchema(freshBundle.manifest, freshBundle.chunks, 13);
  assert.equal(Object.keys(old).length, 43); equal(Object.keys(old).sort(), Object.keys(freshTables).sort());
  for (const [name, rows] of Object.entries(old)) {
    if (name === "usage_snapshots") continue;
    const current = new Set(freshTables[name].map(canonical)); assert.ok(rows.every(row => current.has(canonical(row))));
  }
  equal(freshTables.sync_outbox, old.sync_outbox);
  const metrics = assertUsageRefresh(old, freshTables);
  equal(reference.metric_changes.map(({ sampling_age_ms, ...change }) => change), metrics.changes.map(({ sampling_age_ms, ...change }) => change));
  for (const change of reference.metric_changes) {
    assert.ok(Number.isSafeInteger(change.sampling_age_ms) && change.sampling_age_ms >= 0);
    assert.equal(change.sampling_age_ms, Date.parse(reference.created_at) - Date.parse(change.after.captured_at));
  }
  const referenceAge = Date.parse(reference.created_at) - Date.parse(freshBundle.manifest.created_at);
  assert.ok(Number.isFinite(referenceAge) && referenceAge >= 0 && referenceAge <= 300000);
  return { tables: freshTables, metrics };
}
export function assertMigrationPreserved(before, tables) {
  assert.equal(Object.keys(before).length, 43);
  equal(Object.keys(tables).sort(), [...Object.keys(before), "sync_export_event_index", "sync_export_event_blocks", "sync_export_request_selections", "sync_export_poll_plans"].sort());
  for (const [name, rows] of Object.entries(before)) {
    assert.ok(Array.isArray(tables[name])); const actual = new Set(tables[name].map(canonical));
    if (name === "usage_snapshots") continue;
    for (const old of rows) {
      const expected = name === "app_meta" && old.key === "schema_version" ? { ...old, value: "14" } : old;
      if (name === "app_meta" && old.key === "schema_version") assert.equal(old.value, "13");
      assert.ok(actual.has(canonical(expected)), `Upgrade changed an original ${name} row.`);
    }
  }
  equal(tables.sync_outbox.map(canonical).sort(), before.sync_outbox.map(canonical).sort());
  assert.equal(tables.sync_export_event_index.length, before.sync_outbox.length);
  for (const [rank, old] of before.sync_outbox.entries()) {
    const index = tables.sync_export_event_index.find(row => row.outbox_id === old.outbox_id); assert.ok(index);
    assert.equal(index.event_sequence, rank + 1); assert.equal(index.payload_anchor, old.payload_json); assert.equal(index.topic_anchor, old.topic);
    assert.equal(index.classification_anchor, JSON.stringify([index.outbox_id, rank + 1, index.season_id, index.handler_kind, index.practice_id]));
  }
  for (const name of ["sync_export_event_blocks", "sync_export_request_selections", "sync_export_poll_plans"]) equal(tables[name], []);
  return assertUsageRefresh(before, tables);
}
export function assertBatchReceipt(batch, items, google) {
  assert.equal(batch.status, "CONFIRMED"); assert.equal(batch.season_id, SEASON); assert.equal(batch.binding_version, 1);
  assert.equal(batch.writer_epoch, 0); assert.equal(batch.direction, "CLOUDFLARE_TO_GOOGLE"); assert.ok(items.length);
  const saved = items.map(item => JSON.parse(item.target_json));
  const scope = saved[0].scope ?? saved[0].entity_type ?? items[0].entity_type, page = google[scope]; assert.ok(page);
  const idKey = scope === "SIGNUP" ? "row_id" : scope === "PRACTICE" ? "practice_id" : scope === "TRAINING_WEEK" ? "week_id" : "season_id";
  const payload = { season_id: SEASON, batch_id: batch.batch_id, ...(scope === "SEASON" ? {} : { entity_type: scope }),
    spreadsheet_id: page.spreadsheet_id, tab_id: page.tab_id,
    items: saved.map(row => ({ [idKey]: row.row_id ?? row.season_id, expected: row.expected, target: row.target })) };
  assert.equal(batch.payload_digest, sha(JSON.stringify(payload)));
  const receipt = JSON.parse(items[0].receipt_json);
  assert.equal(receipt.status, "verified"); assert.equal(receipt.operation_id, batch.batch_id); assert.equal(receipt.payload_digest, batch.payload_digest);
  assert.equal(receipt.protocol_version, "2026-09-19.bridge.v1"); assert.equal(receipt.team_id, TEAM); assert.equal(receipt.season_id, SEASON);
  assert.equal(receipt.binding_version, 1); assert.equal(receipt.writer_epoch, 0);
  assert.equal(receipt.spreadsheet_id, page.spreadsheet_id); assert.equal(receipt.tab_id, page.tab_id);
  if (scope !== "SEASON") assert.equal(receipt.entity_type, scope);
  equal(receipt[scope === "SEASON" ? "verified_season_ids" : "verified_row_ids"], saved.map(row => row.row_id ?? row.season_id));
  assert.ok(Number.isFinite(Date.parse(receipt.acknowledged_at)));
  for (const item of items) { assert.equal(item.status, "VERIFIED"); equal(JSON.parse(item.receipt_json), receipt); }
}
export function assertPendingBlock(event, call, tables, scope, entityId) {
  assert.equal(assertEventAnchor(event, tables).status, "PENDING");
  const requestKey = `req_v2_${sha(`${TEAM}\nC2:EXPORT\nexportNextAssociated\n${call.payload.request_id}`)}`;
  const pin = tables.sync_export_request_selections.find(row => row.request_key === requestKey); assert.ok(pin);
  assert.equal(pin.season_id, SEASON); assert.equal(pin.binding_version, 1); assert.equal(pin.outbox_id, event.outbox_id);
  assert.equal(pin.event_anchor, event.payload_json); assert.equal(pin.event_digest, `sha256_v1:${sha(event.payload_json)}`);
  assert.equal(pin.request_digest, digest({ season_id: SEASON, outbox_id: event.outbox_id }));
  const block = tables.sync_export_event_blocks.find(row => row.outbox_id === event.outbox_id); assert.ok(block);
  assert.equal(block.season_id, SEASON); assert.equal(block.binding_version, 1); assert.equal(block.action_required, 1);
  assert.equal(block.practice_id, JSON.parse(event.payload_json).entity.practice_id); assert.equal(block.payload_anchor, event.payload_json);
  assert.equal(block.payload_digest, `sha256_v1:${sha(event.payload_json)}`); assert.equal(block.error_code, "SYNC_REFERENCE_NEEDS_REVIEW");
  assert.equal(block.blocked_scope, scope); assert.equal(block.blocked_entity_id, entityId);
  return block;
}
function localIso(date, time, timezone) {
  assert.match(time, /^(?:[01]\d|2[0-3]):[0-5]\d$/u);
  const desired = Date.parse(`${date}T${time}:00Z`), formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = instant => Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  const asUtc = part => Date.parse(`${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}Z`);
  let instant = desired;
  for (let attempt = 0; attempt < 3; attempt++) instant -= asUtc(parts(instant)) - desired;
  assert.equal(asUtc(parts(instant)), desired, "A local time cannot be resolved uniquely to the planned date.");
  return new Date(instant).toISOString();
}
export function fixtureTimings(week, template, season, now = Date.now()) {
  const monday = new Date(`${week}T00:00:00Z`); assert.equal(monday.getUTCDay(), 1);
  assert.equal(template.timezone, "America/New_York"); assert.ok(Number.isInteger(template.day_of_week) && template.day_of_week >= 1 && template.day_of_week <= 7);
  const build = (offset, start, end) => {
    const day = new Date(monday); day.setUTCDate(day.getUTCDate() + offset); const date = day.toISOString().slice(0, 10);
    assert.ok(date >= season.start_date && date <= season.end_date);
    const start_at = localIso(date, start, template.timezone), end_at = localIso(date, end, template.timezone);
    assert.ok(Date.parse(end_at) > Date.parse(start_at)); assert.ok(Date.parse(start_at) - 7200000 > now + 3600000);
    return { date, start_at, end_at, signup_cutoff_at: new Date(Date.parse(start_at) - 7200000).toISOString() };
  };
  return { a: build(template.day_of_week - 1, template.start_time, template.end_time), b: build(template.day_of_week === 5 ? 3 : 4, "18:00", "19:30") };
}
export function assertOriginalRows(initial, tables) {
  for (const name of ["seasons", "coaches", "members", "schedule_templates", "training_weeks", "practices", "practice_versions", "signups",
    "seat_plan_states", "seat_plan_draft_seats", "seat_plan_revisions", "seat_plan_revision_seats", "seat_plan_revision_names",
    "practice_history", "history_corrections", "season_history", "sync_outbox", "system_requests", "audit_events", "sync_batches", "sync_batch_items",
    "sync_export_event_index", "sync_export_request_selections", "sync_associated_cursors", "sync_associated_physical_baselines"]) {
    assert.ok(Array.isArray(initial[name]) && Array.isArray(tables[name]), `Missing protected table ${name}.`);
    const actual = new Set(tables[name].map(canonical));
    assert.ok(initial[name].every(row => actual.has(canonical(row))), `An original ${name} row changed.`);
  }
  const stable = row => { const { updated_at, ...content } = row; return canonical(content); };
  const baseline = new Set(tables.sync_baselines.map(stable));
  assert.ok(initial.sync_baselines.every(row => baseline.has(stable(row))), "An original logical baseline changed.");
}
// Independently validate every confirmed patch against its original event, then compare all Google rows.
export function expectedGoogleRows(journal, tables) {
  const expected = Object.fromEntries(Object.entries(journal.google).map(([scope, page]) => [scope, page.rows.map(row => [...row.cells])]));
  for (const event of Object.values(journal.events).sort((a, b) => a.sequence - b.sequence)) {
    const snapshot = JSON.parse(event.payload_json).entity;
    for (const batch of tables.sync_batches.filter(row => row.first_outbox_id === event.outbox_id && row.status === "CONFIRMED")) {
      const batchItems = tables.sync_batch_items.filter(row => row.batch_id === batch.batch_id).sort((a, b) => a.item_index - b.item_index);
      assertBatchReceipt(batch, batchItems, journal.google);
      for (const item of batchItems) {
        assert.equal(item.status, "VERIFIED");
        const saved = JSON.parse(item.target_json), scope = saved.scope ?? saved.entity_type ?? item.entity_type;
        assert.ok(["SIGNUP", "TRAINING_WEEK", "PRACTICE", "SEASON"].includes(scope));
        assert.ok(Array.isArray(saved.target));
        const headers = journal.google[scope].headers;
        let independent;
        if (scope === "SEASON") {
          independent = [...journal.google.SEASON.rows[0].cells]; independent[headers.indexOf("season_version")] = String(snapshot.season_version);
        } else {
          const row = scope === "SIGNUP" ? snapshot.signup_rows.find(row => `${row.practice_id}:${row.member_id}` === saved.row_id) :
            scope === "TRAINING_WEEK" ? snapshot.week : snapshot.practices.find(row => row.practice_id === saved.row_id);
          assert.ok(row); independent = headers.map(field => String(row[field] ?? ""));
        }
        equal(saved.target, independent); assert.equal(item.target_digest, digest(saved.target));
        const targetId = rowKey(scope, independent), index = expected[scope].findIndex(row => rowKey(scope, row) === targetId);
        if (index < 0) expected[scope].push(independent); else expected[scope][index] = independent;
      }
    }
  }
  for (const phase of ["drift-practice", "restore-practice", "drift-member", "restore-member"]) {
    const call = journal.calls[phase]; if (!call?.result) continue;
    const scope = call.payload.entity_type, target = call.payload.items[0].target, index = expected[scope].findIndex(row => rowKey(scope, row) === rowKey(scope, target));
    assert.ok(index >= 0); expected[scope][index] = [...target];
  }
  return expected;
}
const rowKey = (scope, row) => scope === "SEASON" ? row[0] : scope === "COACH" ? row[0] :
  scope === "SIGNUP" ? `${row[1]}:${row[2]}` : scope === "SEAT_PLAN_CURRENT" ? `${row[1]}:${row[2]}:${row[3]}` :
    scope === "SEAT_PLAN_REVISION" ? `${row[1]}:${row[2]}` : row[1];
export function assertGoogleUnchanged(before, after, allowed = []) {
  for (const scope of Object.keys(before)) {
    equal(before[scope].headers, after[scope].headers);
    const skip = new Set(allowed.filter(item => item.scope === scope).map(item => item.id));
    const filtered = page => page.rows.map(row => row.cells).filter(row => !skip.has(rowKey(scope, row))).map(canonical).sort();
    equal(filtered(before[scope]), filtered(after[scope]));
  }
}
export function readScopeDefinitions(source) {
  const block = source.match(/export const SHEET_SCOPES = \{([\s\S]*?)\} as const;/u); assert.ok(block);
  const result = Object.fromEntries([...block[1].matchAll(/(\w+): \{ tab: "([^"]+)", headers: (\[[\s\S]*?\]) \}/gu)]
    .map(([, scope, tab, headers]) => [scope, { tab, headers: JSON.parse(headers) }]));
  assert.equal(Object.keys(result).length, 10); return result;
}
export function assertLaneProgress(journal, tables) {
  for (const lane of ["a", "b"]) {
    const practice = journal[`practice_${lane}`]; if (!practice) continue;
    const versions = tables.practice_versions.find(row => row.practice_id === practice); assert.ok(versions);
    assert.equal(versions.seat_plan_version, 0); assert.equal(versions.published_revision, 0);
    const events = [1, 2].map(number => journal.events[`signup-${lane}${number}`]).filter(Boolean);
    const confirmed = events.filter(event => assertEventAnchor(event, tables).status === "CONFIRMED");
    const cursor = tables.sync_associated_cursors.find(row => row.practice_id === practice);
    equal([cursor?.signup_version ?? 0, cursor?.seat_plan_version ?? 0, cursor?.published_revision ?? 0], [confirmed.length, 0, 0]);
    if (events.length) {
      const latest = JSON.parse(events.at(-1).payload_json).entity.signup_rows[0];
      const current = tables.signups.filter(row => row.practice_id === practice); assert.equal(current.length, 1);
      for (const field of Object.keys(latest)) assert.equal(current[0][field], latest[field]);
      assert.equal(versions.signup_version, events.length);
    }
  }
}

async function main() {
  const phase = process.argv.find(arg => arg.startsWith("--phase="))?.slice(8);
  assert.ok(phase === "preflight" || PHASES.includes(phase));
  if (phase !== "preflight") assert.ok(process.argv.includes("--capture-private-backup"));
  if (!['preflight', 'capture', 'final'].includes(phase)) assert.ok(process.argv.includes("--write-test-data"));
  const args = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url), privateRoot = new URL("../../.c2-form-test/", import.meta.url);
  const journalPath = new URL("c2-associated-lane-journal.json", root);
  const config = load(new URL("../cloudflare/wrangler.jsonc", import.meta.url));
  // This local guard prevents all network calls while the previous Worker is still configured.
  requireData(config.env.c2test.vars.SERVICE_VERSION === VERSION, "WORKER_UPGRADE_NOT_CONFIGURED");
  equal(config.env.c2test.triggers.crons, []);
  assert.equal(config.env.c2test.vars.C2_EXPORT_POLL_ENABLED, "false");
  assert.equal(config.env.c2test.vars.C2_ASSOCIATED_EXPORT_ENABLED, "true"); assert.equal(config.env.c2test.vars.C2_SCHEDULE_EXPORT_ENABLED, "true");
  assert.equal(String(config.env.c2test.vars.WRITER_EPOCH), "0");
  assert.equal(config.env.c2test.vars.TEAM_ID, TEAM);
  for (const vars of [config.vars, config.env.production.vars]) for (const flag of ["C2_ASSOCIATED_EXPORT_ENABLED", "C2_SCHEDULE_EXPORT_ENABLED", "C2_EXPORT_POLL_ENABLED"]) assert.equal(vars[flag], "false");
  assert.equal(process.env.C2_TEST_URL, WORKER);
  const fixture = load(new URL("private-test-config.json", privateRoot)).fixture;
  const identity = load(new URL("isolated-identities.json", privateRoot));
  const faultPlan = load(new URL("associated-fault-overlay/fault-plan.json", root));
  const restored = new URL("associated-clean-restored/", root);
  for (const clasp of [new URL("head/.clasp.json", restored), new URL("v14/.clasp.json", restored), new URL(".clasp.json", privateRoot)]) {
    const saved = load(clasp); assert.equal(saved.scriptId, identity.script_id); assert.equal(saved.rootDir, "source");
  }
  const deployedFiles = sourceFiles(new URL("v14/source/", restored));
  const headFiles = sourceFiles(new URL("head/source/", restored));
  const currentFiles = sourceFiles(new URL("source/", privateRoot));
  assertCleanSourceSets(currentFiles, deployedFiles, headFiles);
  for (const [files, expected] of [[deployedFiles, faultPlan.clean_source_files], [headFiles, faultPlan.head_clean_source_files]]) {
    equal(files.map(({ name, hash }) => ({ name, hash })), expected.map(({ name, hash }) => ({ name, hash })));
  }
  const deployments = load(new URL("associated-fault-overlay/deployments-restored.json", root));
  assertRestoredDeployment(deployments, identity);
  assert.equal(faultPlan.script_id, identity.script_id); assert.equal(faultPlan.deployment_id, identity.deployment_id);
  const waitlist = load(new URL("c2-waitlist-journal.json", root));
  requireData(Boolean(waitlist.final_backup && waitlist.cancel?.confirmed && waitlist.events?.every(event => event.confirmed)), "WAITLIST_FINAL_NOT_CONFIRMED");
  assert.equal(waitlist.practice_id, faultPlan.practice_id);
  assert.equal(fixture.seasonId, SEASON); assert.equal(fixture.runtimeSheetId, process.env.C2_RUNTIME_SHEET_ID);
  const credentials = load(new URL("worker-secrets.json", privateRoot));
  const coach = load(new URL("review-private.json", privateRoot)).coach_code;
  const bridgeUrl = new URL(credentials.GOOGLE_BRIDGE_URL);
  assert.equal(bridgeUrl.hostname, "script.google.com"); assert.equal(bridgeUrl.protocol, "https:");
  assert.equal(bridgeUrl.pathname, `/macros/s/${identity.deployment_id}/exec`); assert.equal(bridgeUrl.search, ""); assert.equal(bridgeUrl.hash, "");
  const save = journal => {
    mkdirSync(fileURLToPath(root), { recursive: true });
    const temp = new URL("c2-associated-lane-journal.tmp", root);
    writeFileSync(temp, JSON.stringify(journal, null, 2) + "\n"); renameSync(temp, journalPath);
  };
  const key = kind => kind === "c1" ? process.env.C1_TEST_KEY : process.env.C2_TEST_KEY;
  assert.ok(key("c1") && key("c2") && coach && credentials.GOOGLE_BRIDGE_SECRET);
  const api = async (path, kind, payload = {}, token) => {
    const envelope = { request_id: fresh("read"), ...payload, ...(token ? { session_token: token } : {}) };
    const response = await fetch(new URL(path, WORKER), { method: "POST", headers: { authorization: `Bearer ${key(kind)}`,
      "content-type": "application/json" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(45_000) });
    const body = await response.json(); assertApiCorrelation(body.meta, envelope.request_id, kind);
    return { http: response.status, ok: body.ok, data: body.data, error: body.error?.code ?? null,
      retryable: typeof body.error?.retryable === "boolean" ? body.error.retryable : null,
      context: { path, scope: payload.entity_type ?? payload.scope ?? null } };
  };
  const good = goodHttp;
  const login = good(await api("/internal/c1/coach-login", "c1", { coach_code: coach }));
  const token = login.result.session_token;
  try {
    const read = async (path, kind = "c2", payload = {}) => good(await api(path, kind, payload, token));
    const overview = async () => {
      const value = await read("/internal/c2/get-sync-overview", "c2", { season_id: SEASON });
      assert.equal(value.schema_version, 14); assert.equal(value.binding_current, true);
      assert.equal(value.binding.binding_version, 1); assert.equal(value.binding.export_paused, false);
      assert.equal(value.binding.runtime_spreadsheet_id, fixture.runtimeSheetId);
      assert.equal(value.binding.form_id, fixture.formId); assert.equal(value.binding.response_sheet_id, fixture.responseSheetId);
      assert.equal(value.counts.open_conflicts, 0); assert.equal(value.counts.sources_needing_review, 0);
      assert.equal(value.export_control.status, "RUNNING"); assert.equal(value.export_control.retry, null);
      return value;
    };
    const bridge = async saved => {
      const payload_json = JSON.stringify(saved.payload);
      const unsigned = { action: saved.action, request_id: fresh("bridge"), protocol_version: "2026-09-19.bridge.v1",
        direction: "CLOUDFLARE_TO_GOOGLE", team_id: TEAM, binding_version: `${SEASON}:1`, writer_epoch: 0,
        timestamp_ms: Date.now(), nonce: fresh("nonce"), operation_id: saved.operation_id, payload_json, payload_digest: sha(payload_json) };
      const signature = createHmac("sha256", credentials.GOOGLE_BRIDGE_SECRET).update([unsigned.protocol_version, unsigned.direction,
        unsigned.team_id, unsigned.binding_version, unsigned.writer_epoch, unsigned.timestamp_ms, unsigned.nonce,
        unsigned.operation_id, unsigned.payload_digest].join("\n")).digest("base64url");
      const response = await fetch(bridgeUrl, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ ...unsigned, signature }), redirect: "follow", signal: AbortSignal.timeout(45_000) });
      const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.ok, true);
      assert.equal(body.meta?.request_id, unsigned.request_id);
      for (const [field, expected] of Object.entries({ team_id: TEAM, season_id: SEASON, binding_version: 1, writer_epoch: 0,
        operation_id: unsigned.operation_id, payload_digest: unsigned.payload_digest })) assert.equal(body.data[field], expected);
      return body.data;
    };
    const definitions = readScopeDefinitions(readFileSync(new URL("../cloudflare/src/c2-sheet-bridge.ts", import.meta.url), "utf8"));
    const scopes = Object.keys(definitions);
    const pages = async () => {
      const result = {};
      for (const scope of scopes) {
        const page = await bridge({ action: "cloudflareReadSheetRecords", operation_id: fresh("inspect"), payload: { season_id: SEASON, entity_type: scope } });
        assert.equal(page.entity_type, scope); assert.equal(page.spreadsheet_id, ["SEASON", "COACH"].includes(scope) ? fixture.systemSheetId : fixture.runtimeSheetId);
        equal(page.headers, definitions[scope].headers); assert.equal(page.tab_name, definitions[scope].tab); assert.match(page.tab_id, /^\d+$/u);
        assert.ok(!page.next_cursor && !page.truncated); assert.ok(scope === "COACH" || page.rows.every(row => row.cells[0] === SEASON));
        assert.ok(page.headers.length && page.rows.every(row => row.cells.length === page.headers.length));
        result[scope] = page;
      }
      return result;
    };
    const backup = async () => {
      const manifest = (await read("/internal/c1/create-backup-snapshot", "c1")).result.manifest;
      assert.equal(manifest.schema_version, 14);
      const verified = await read("/internal/c1/verify-backup-snapshot", "c1", { snapshot_id: manifest.snapshot_id, content_digest: manifest.content_digest });
      assert.equal(verified.verified, true); assert.equal(verified.expected_content_digest, manifest.content_digest);
      const chunks = [];
      for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index++) {
        const response = await read("/internal/c1/get-backup-chunk", "c1", { snapshot_id: manifest.snapshot_id, chunk_index });
        assert.equal(response.snapshot_id, manifest.snapshot_id); equal(response.manifest, manifest); const part = response.chunk;
        assert.equal(part.payload_digest, digest(part.payload)); chunks.push(part);
      }
      const tables = assertBackupDownload(manifest, chunks);
      mkdirSync(fileURLToPath(root), { recursive: true });
      const path = new URL(`lane-${manifest.snapshot_id}.json`, root);
      writeFileSync(path, JSON.stringify({ manifest, chunks }, null, 2) + "\n", { flag: "wx" });
      for (const name of ["sync_export_event_index", "sync_export_event_blocks", "sync_export_request_selections", "sync_export_poll_plans"]) assert.ok(Array.isArray(tables[name]));
      return { path: fileURLToPath(path), manifest, tables };
    };
    const workspace = async () => read("/internal/c1/schedule-workspace", "c1", { season_id: SEASON });
    const clean = async () => {
      for (const entity_type of ["SEASON", "MEMBER", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE", "SIGNUP", "SEAT_PLAN_DRAFT"]) {
        const value = await read("/internal/c2/check-sheet-differences", "c2", { season_id: SEASON, entity_type });
        assert.equal(value.status, "OK"); assert.equal(value.findings_count, 0); assert.equal(value.truncated, false);
      }
      for (const scope of ["SIGNUP", "SEAT_PLAN_DRAFT", "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION"]) {
        const value = await read("/internal/c2/check-associated-physical-differences", "c2", { season_id: SEASON, scope });
        assert.equal(value.status, "OK"); assert.equal(value.coverage, "complete"); assert.equal(value.findings_count, 0);
        assert.equal(value.truncated, false); assert.equal(value.rows_read, value.baselines_checked);
      }
    };
    let journal = existsSync(journalPath) ? load(journalPath) : null;
    const status = await overview();
    if (phase === "preflight") {
      requireData(status.counts.pending_outbox === 0 && status.counts.pending_batches === 0 && status.lanes.local_action_required === 0, "OLD_EXPORT_WORK_NOT_FINAL");
      await clean();
      return { phase, status: "READY_FOR_CAPTURE", schema_version: 14, poll_enabled: false, business_data_writes: 0 };
    }
    if (phase === "capture" && !journal) {
      requireData(status.counts.pending_outbox === 0 && status.counts.pending_batches === 0 && status.lanes.local_action_required === 0, "OLD_EXPORT_WORK_NOT_FINAL");
      await clean();
      const initial = await backup(), google = await pages(), work = await workspace();
      assert.match(waitlist.final_backup.snapshot_id, /^[A-Za-z0-9_-]{8,128}$/u);
      const v13Bundle = load(new URL(`${waitlist.final_backup.snapshot_id}.json`, root));
      assert.equal(v13Bundle.manifest.content_digest, waitlist.final_backup.digest);
      assertDownloadSchema(v13Bundle.manifest, v13Bundle.chunks, 13);
      let v13Tables = verifyPrivateBackup(v13Bundle), referenceEvidence = null;
      const referencePath = new URL("c2-lane-upgrade-reference.json", root);
      if (existsSync(referencePath)) {
        const reference = load(referencePath); assert.match(reference.snapshot_id, /^[A-Za-z0-9_-]{8,128}$/u);
        const verified = assertUpgradeReference(reference, v13Bundle, load(new URL(`${reference.snapshot_id}.json`, root)));
        v13Tables = verified.tables; referenceEvidence = { fresh_bundle_digest: reference.digest,
          old_waitlist_digest: reference.old_waitlist_digest, metric_changes: verified.metrics, reference_created_at: reference.created_at };
      }
      const migrationMetrics = assertMigrationPreserved(v13Tables, initial.tables);
      equal([google.SIGNUP.rows.length, google.SEAT_PLAN_DRAFT.rows.length, google.SEAT_PLAN_CURRENT.rows.length, google.SEAT_PLAN_REVISION.rows.length], [11, 1, 20, 2]);
      assert.equal(initial.tables.members.length, 11); assert.ok(initial.tables.members.every(row => /^C2 Test Member /u.test(row.source_display_name)));
      const alpha = initial.tables.members.filter(row => row.source_display_name === "C2 Test Member Alpha"); assert.equal(alpha.length, 1); assert.equal(alpha[0].status, "ACTIVE");
      const date = args("week-date"); requireData(/^2026-\d{2}-\d{2}$/u.test(date ?? ""), "NEW_WEEK_DATE_REQUIRED");
      const selectedDate = new Date(`${date}T00:00:00Z`); assert.equal(selectedDate.getUTCDay(), 1); assert.ok(selectedDate.getTime() > Date.now() + 7 * 86400000);
      const season = initial.tables.seasons.find(row => row.season_id === SEASON); assert.ok(season);
      const weekEnd = new Date(selectedDate); weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      assert.ok(date >= season.start_date && weekEnd.toISOString().slice(0, 10) <= season.end_date); assert.ok(!work.weeks.some(week => week.week_start_date === date));
      assert.equal(work.templates.length, 1); assert.equal(work.templates[0].timezone, "America/New_York");
      const timings = fixtureTimings(date, work.templates[0], season);
      const cursor = initial.tables.sync_associated_cursors.find(row => row.practice_id === waitlist.practice_id);
      assert.ok(cursor); equal([cursor.signup_version, cursor.seat_plan_version, cursor.published_revision], [12, 2, 2]);
      journal = { format: 1, service_version: VERSION, run_id: fresh("run"), runtime_sheet_id: fixture.runtimeSheetId,
        script_id: identity.script_id, deployment_id: identity.deployment_id, week_date: date, alpha_id: alpha[0].member_id,
        baseline: initial, google, timings, upgrade_evidence: { old_bundle_digest: v13Bundle.manifest.content_digest,
          original_business_rows_preserved: true, scheduled_jobs_preserved: true, fixed_migration_rank_verified: true, old_table_count: 43,
          fresh_reference: referenceEvidence, postmigration_metrics: migrationMetrics },
        events: {}, calls: {}, phases: { capture: { complete: true } } };
      save(journal); return { phase, status: "BASELINE_CAPTURED", private_chunks: initial.manifest.chunk_count,
        original_business_rows_preserved: true, metric_changes_recorded: true, fixed_migration_rank_verified: true };
    }
    assert.ok(journal); assertPhase(journal, phase);
    assert.equal(journal.runtime_sheet_id, fixture.runtimeSheetId); assert.equal(journal.deployment_id, identity.deployment_id);
    const replay = Boolean(journal.phases[phase]?.complete);
    const auditPending = pendingExportEvidence(journal, phase);
    journal.phases[phase] ??= { complete: false }; save(journal);
    const current = await backup(); assertOriginalRows(journal.baseline.tables, current.tables);
    for (const event of Object.values(journal.events)) assertEventAnchor(event, current.tables);
    equal(current.tables.sync_export_poll_plans, journal.baseline.tables.sync_export_poll_plans);
    const action = async (label, path, kind, payload, expectedError) => journalCall(journal, label,
      () => ({ path, kind, payload: { request_id: `${journal.run_id}_${label}`, ...payload } }), save,
      saved => api(saved.path, saved.kind, saved.payload, saved.kind === "c1" || saved.path.endsWith("retry-export") ? token : undefined),
      result => { if (expectedError) { assert.equal(result.http, 409); assert.equal(result.error, expectedError); } else good(result); });
    const captureEvent = async (label, response) => {
      const captured = await backup(), saved = journal.calls[label];
      const requests = captured.tables.system_requests.filter(row => row.request_id === saved.payload.request_id); assert.equal(requests.length, 1);
      const rows = captured.tables.sync_outbox.filter(row => row.request_key === requests[0].request_key); assert.equal(rows.length, 1);
      const row = rows[0], index = captured.tables.sync_export_event_index.find(item => item.outbox_id === row.outbox_id); assert.ok(index);
      const snapshot = JSON.parse(row.payload_json).entity;
      if (row.topic === "SCHEDULE_CHANGED") assert.equal(snapshot.season_version, journal.baseline.tables.seasons.find(row => row.season_id === SEASON).season_version);
      const event = { outbox_id: row.outbox_id, payload_json: row.payload_json, topic: row.topic, due_at_ms: row.due_at_ms,
        sequence: index.event_sequence, calls: [], inflight: null, confirmed: false, mutation_result: response.data.result };
      if (journal.events[label]) equal({ ...journal.events[label], calls: [], inflight: null, confirmed: false }, event);
      else { journal.events[label] = event; save(journal); }
      return event;
    };
    const p = lane => journal[lane === "a" ? "practice_a" : "practice_b"];
    const eventOf = label => { const event = journal.events[`signup-${label}`]; assert.ok(event); return event; };
    // Never mark completion before the post-call backup/Google/page checks succeed.
    const mark = outcome => { journal.phases[phase].outcome = outcome; save(journal); return outcome; };
    let outcome;
    if (auditPending) {
      assertEventAnchor(auditPending.event, current.tables);
      if (auditPending.event.confirmed) assert.equal(assertEventAnchor(auditPending.event, current.tables).status, "CONFIRMED");
      const events = phase === "export-schedule" ? [journal.events.prepare, journal.events["create-b"], journal.events.open] : [auditPending.event];
      outcome = events.every(event => event.confirmed) ? mark({ status: "EVENTS_CONFIRMED", business_calls: 0 }) :
        { status: "BATCH_PROGRESS", business_calls: 0, evidence_checkpoint_recovered: true, remaining_events: events.filter(event => !event.confirmed).length };
    } else if (replay) { outcome = { status: "ALREADY_CONFIRMED", business_calls: 0, original_status: journal.phases[phase].outcome?.status ?? "BASELINE_CAPTURED" }; }
    else if (phase === "prepare") {
      const season = current.tables.seasons.find(row => row.season_id === SEASON);
      const result = await action(phase, "/internal/c1/prepare-training-week", "c1", { season_id: SEASON, season_version: season.season_version, week_start_date: journal.week_date });
      assert.equal(result.data.result.created, true); assert.equal(result.data.result.practices.length, 1);
      const practice = result.data.result.practices[0];
      for (const field of ["start_at", "end_at", "signup_cutoff_at"]) assert.equal(practice[field], journal.timings.a[field]);
      equal([practice.left_capacity, practice.right_capacity, practice.timezone, practice.practice_version], [10, 10, "America/New_York", 1]);
      journal.week_id = result.data.result.week.week_id; journal.practice_a = result.data.result.practices[0].practice_id; save(journal);
      await captureEvent(phase, result); outcome = mark({ status: "NEW_WEEK_CAPTURED" });
    } else if (phase === "create-b") {
      const work = await workspace(), week = work.weeks.find(row => row.week_id === journal.week_id); assert.ok(week); assert.equal(week.status, "DRAFT");
      const result = await action(phase, "/internal/c1/create-practice", "c1", { season_id: SEASON, week_id: journal.week_id, week_version: week.week_version,
        practice_date: journal.timings.b.date, start_time: "18:00", end_time: "19:30", timezone: "America/New_York",
        location: "C2 Isolated Lane B Dock", address: "Fictitious isolated acceptance address", map_url: "" });
      for (const field of ["start_at", "end_at", "signup_cutoff_at"]) assert.equal(result.data.result.practice[field], journal.timings.b[field]);
      equal([result.data.result.practice.left_capacity, result.data.result.practice.right_capacity, result.data.result.practice.timezone], [10, 10, "America/New_York"]);
      journal.practice_b = result.data.result.practice.practice_id; assert.notEqual(journal.practice_b, journal.practice_a); save(journal);
      await captureEvent(phase, result); outcome = mark({ status: "PRACTICE_B_CAPTURED" });
    } else if (phase === "open") {
      const work = await workspace(), week = work.weeks.find(row => row.week_id === journal.week_id); assert.ok(week);
      equal(work.practices.filter(row => row.week_id === journal.week_id).map(row => row.practice_id).sort(), [p("a"), p("b")].sort());
      const result = await action(phase, "/internal/c1/confirm-training-week", "c1", { season_id: SEASON, week_id: journal.week_id, week_version: week.week_version });
      assert.equal(result.data.result.week.status, "OPENED"); assert.equal(result.data.result.practices.length, 2);
      await captureEvent(phase, result); outcome = mark({ status: "TWO_PRACTICES_OPENED" });
    } else if (phase.startsWith("signup-")) {
      const label = phase.slice(7), lane = label[0], number = Number(label[1]);
      const practice = current.tables.practices.find(row => row.practice_id === p(lane));
      const state = current.tables.practice_versions.find(row => row.practice_id === p(lane)); assert.ok(practice && state);
      assert.ok(state.signup_version === number - 1 || journal.calls[phase] && state.signup_version === number);
      assert.equal(state.seat_plan_version, 0); assert.equal(state.published_revision, 0);
      const result = await action(phase, `/internal/c1/${number === 1 ? "signup" : "update-signup"}`, "c1", { season_id: SEASON, practice_id: p(lane),
        member_id: journal.alpha_id, practice_version: practice.practice_version, signup_version: state.signup_version, preference: number === 1 ? "LEFT" : "RIGHT" });
      assert.equal(result.data.result.signup_version, number); assert.equal(result.data.result.signup.status, "CONFIRMED");
      const event = await captureEvent(phase, result), snapshot = JSON.parse(event.payload_json).entity;
      assert.equal(snapshot.signup_rows.length, 1); assert.ok(!snapshot.seating_snapshot);
      if (number === 2) {
        const original = JSON.parse(eventOf(`${lane}1`).payload_json).entity.signup_rows[0];
        assert.equal(snapshot.signup_rows[0].queue_at, original.queue_at); assert.equal(snapshot.signup_rows[0].queue_sequence, original.queue_sequence);
      }
      outcome = mark({ status: "SIGNUP_EVENT_CAPTURED", signup_version: number });
    } else if (phase === "drift-practice" || phase === "drift-member" || phase === "restore-practice" || phase === "restore-member") {
      const member = phase.endsWith("member"), scope = member ? "MEMBER" : "PRACTICE", targetId = member ? journal.alpha_id : p("a");
      const before = await pages(), restoring = phase.startsWith("restore"), driftPhase = member ? "drift-member" : "drift-practice";
      await journalCall(journal, phase, () => restoring ? reverseCas(journal.calls[driftPhase], `${journal.run_id}_${phase}`) :
        singleRowCas(before[scope], scope, targetId, member ? "status" : "location", member ? "INACTIVE" : `${journal.run_id}_practice_marker`, `${journal.run_id}_${phase}`),
      save, bridge, assertCasReceipt);
      const after = await pages(); assertGoogleUnchanged(before, after, [{ scope, id: targetId }]);
      const target = journal.calls[phase].payload.items[0].target;
      equal(after[scope].rows.filter(row => row.cells[1] === targetId).map(row => row.cells), [target]);
      outcome = mark({ status: restoring ? "EXACT_ORIGINAL_ROW_RESTORED" : "SINGLE_ROW_DRIFT_VERIFIED" });
    } else if (phase.startsWith("retry-")) {
      const event = eventOf(phase.slice(6));
      await action(phase, "/internal/c2/retry-export", "c2", { season_id: SEASON, outbox_id: event.outbox_id });
      outcome = mark({ status: "ORIGINAL_EVENT_REARMED" });
    } else if (phase.startsWith("block-")) {
      const event = eventOf(phase.slice(6));
      requireData(Date.now() >= event.due_at_ms, "NATURAL_DUE_NOT_REACHED"); assert.equal(status.counts.pending_batches, 0);
      const before = await pages();
      const originalCall = journal.calls[phase], existingBlock = current.tables.sync_export_event_blocks.find(row => row.outbox_id === event.outbox_id && row.action_required === 1);
      if (originalCall && !originalCall.result && existingBlock) {
        assertPendingBlock(event, originalCall, current.tables, phase === "block-a1" ? "PRACTICE" : "MEMBER", phase === "block-a1" ? p("a") : journal.alpha_id);
        originalCall.result = { http: 409, ok: false, error: existingBlock.error_code }; save(journal);
      }
      const result = await action(phase, "/internal/c2/export-next-associated", "c2", { season_id: SEASON, outbox_id: event.outbox_id }, "SYNC_REFERENCE_NEEDS_REVIEW");
      event.preflight_request = journal.calls[phase].payload.request_id; save(journal);
      const after = await backup(); assert.equal(after.tables.sync_batches.length, current.tables.sync_batches.length);
      assertPendingBlock(event, journal.calls[phase], after.tables, phase === "block-a1" ? "PRACTICE" : "MEMBER", phase === "block-a1" ? p("a") : journal.alpha_id);
      equal(after.tables.sync_associated_cursors, current.tables.sync_associated_cursors);
      equal(after.tables.sync_baselines, current.tables.sync_baselines); equal(after.tables.sync_associated_physical_baselines, current.tables.sync_associated_physical_baselines);
      assertGoogleUnchanged(before, await pages()); good({ http: 200, ok: true, data: await overview() });
      outcome = mark({ status: "LOCAL_BLOCK_WITH_ZERO_BATCHES", error_code: result.error });
    } else if (phase === "probe-successor") {
      const event = eventOf("a2"), before = await pages();
      requireData(Date.now() >= event.due_at_ms, "NATURAL_DUE_NOT_REACHED");
      assertPendingBlock(eventOf("a1"), journal.calls["block-a1"], current.tables, "PRACTICE", p("a"));
      assert.equal(assertEventAnchor(event, current.tables).status, "PENDING");
      await action(phase, "/internal/c2/export-next-associated", "c2", { season_id: SEASON, outbox_id: event.outbox_id }, "SYNC_OUTBOX_BLOCKED");
      const after = await backup(); equal(after.tables.sync_batches, current.tables.sync_batches);
      equal(after.tables.sync_associated_cursors, current.tables.sync_associated_cursors); assertGoogleUnchanged(before, await pages());
      equal(after.tables.sync_export_request_selections, current.tables.sync_export_request_selections);
      equal(after.tables.sync_baselines, current.tables.sync_baselines); equal(after.tables.sync_associated_physical_baselines, current.tables.sync_associated_physical_baselines);
      outcome = mark({ status: "SAME_PRACTICE_SUCCESSOR_HELD" });
    } else if (phase.startsWith("export-")) {
      const schedule = phase === "export-schedule";
      const events = schedule ? [journal.events.prepare, journal.events["create-b"], journal.events.open] : [eventOf(phase.slice(7))];
      const event = events.find(item => !item.confirmed);
      if (event) {
        requireData(Date.now() >= event.due_at_ms, "NATURAL_DUE_NOT_REACHED");
        const request = event.inflight ?? { request_id: event.calls.length === 0 && event.preflight_request ? event.preflight_request :
          `${journal.run_id}_${phase}_${events.indexOf(event)}_${event.calls.length}`, season_id: SEASON, ...(schedule ? {} : { outbox_id: event.outbox_id }) };
        event.inflight = request; save(journal);
        const result = good(await api(`/internal/c2/export-next-${schedule ? "schedule" : "associated"}`, "c2", request));
        assert.ok(["BATCH_CONFIRMED", "EVENT_CONFIRMED"].includes(result.status)); assert.equal(result.outbox_id, event.outbox_id);
        saveKnownExport(journal, phase, event, request, result, save);
        const evidence = await backup(); assertEventAnchor(event, evidence.tables);
        if (event.confirmed) assert.equal(evidence.tables.sync_outbox.find(row => row.outbox_id === event.outbox_id).status, "CONFIRMED");
      }
      outcome = events.every(item => item.confirmed) ? mark({ status: "EVENTS_CONFIRMED" }) : { status: "BATCH_PROGRESS", remaining_events: events.filter(item => !item.confirmed).length };
    } else if (phase === "final") {
      assert.equal(status.counts.pending_outbox, 0); assert.equal(status.counts.pending_batches, 0); assert.equal(status.lanes.local_action_required, 0);
      const actual = await pages();
      for (const event of Object.values(journal.events)) { assert.equal(event.confirmed, true); assert.equal(assertEventAnchor(event, current.tables).status, "CONFIRMED"); }
      assert.equal(current.tables.sync_export_event_blocks.length, journal.baseline.tables.sync_export_event_blocks.length);
      for (const lane of ["a", "b"]) {
        const cursor = current.tables.sync_associated_cursors.find(row => row.practice_id === p(lane)); assert.ok(cursor);
        equal([cursor.signup_version, cursor.seat_plan_version, cursor.published_revision], [2, 0, 0]);
        const rows = actual.SIGNUP.rows.filter(row => row.cells[1] === p(lane)); assert.equal(rows.length, 1);
        const snapshot = JSON.parse(eventOf(`${lane}2`).payload_json).entity.signup_rows[0];
        equal(rows[0].cells, actual.SIGNUP.headers.map(field => String(snapshot[field] ?? "")));
      }
      assertGoogleUnchanged(journal.google, actual, [{ scope: "TRAINING_WEEK", id: journal.week_id },
        ...[p("a"), p("b")].flatMap(id => [{ scope: "PRACTICE", id }, { scope: "SIGNUP", id: `${id}:${journal.alpha_id}` }])]);
      const physical = current.tables.sync_associated_physical_baselines;
      assert.equal(physical.length, journal.baseline.tables.sync_associated_physical_baselines.length + 2);
      for (const lane of ["a", "b"]) {
        const baseline = physical.find(row => row.row_id === `${p(lane)}:${journal.alpha_id}`); assert.ok(baseline);
        equal(JSON.parse(baseline.cells_json), actual.SIGNUP.rows.find(row => row.cells[1] === p(lane)).cells);
      }
      for (const scope of ["SEASON", "MEMBER", "SCHEDULE_TEMPLATE", "TRAINING_WEEK", "PRACTICE", "SIGNUP", "SEAT_PLAN_DRAFT"]) {
        const result = await read("/internal/c2/check-sheet-differences", "c2", { season_id: SEASON, entity_type: scope });
        assert.equal(result.status, "OK"); assert.equal(result.findings_count, 0);
        assert.equal(result.truncated, false);
      }
      for (const scope of ["SIGNUP", "SEAT_PLAN_DRAFT", "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION"]) {
        const result = await read("/internal/c2/check-associated-physical-differences", "c2", { season_id: SEASON, scope });
        assert.equal(result.status, "OK"); assert.equal(result.coverage, "complete"); assert.equal(result.findings_count, 0);
        assert.equal(result.truncated, false); assert.equal(result.rows_read, result.baselines_checked);
      }
      journal.final_backup = { snapshot_id: current.manifest.snapshot_id, digest: current.manifest.content_digest };
      outcome = mark({ status: "FINAL_CONFIRMED", independent_practices: 2, poll_enabled: false, old_history_unchanged: true });
    }
    assert.ok(outcome);
    const finalState = await backup(); assertOriginalRows(journal.baseline.tables, finalState.tables);
    assertLaneProgress(journal, finalState.tables);
    const ownedRequests = new Set(Object.values(journal.calls).map(call => call.payload?.request_id).filter(Boolean));
    for (const event of Object.values(journal.events)) for (const call of [...event.calls.map(row => row.request), event.inflight].filter(Boolean)) ownedRequests.add(call.request_id);
    const oldOutbox = new Set(journal.baseline.tables.sync_outbox.map(row => row.outbox_id));
    const newRequests = new Set(finalState.tables.system_requests.filter(row => ownedRequests.has(row.request_id)).map(row => row.request_key));
    assert.ok(finalState.tables.sync_outbox.every(row => oldOutbox.has(row.outbox_id) || newRequests.has(row.request_key)));
    const finalPages = await pages(), expected = expectedGoogleRows(journal, finalState.tables);
    for (const [scope, rows] of Object.entries(expected)) equal(finalPages[scope].rows.map(row => canonical(row.cells)).sort(), rows.map(canonical).sort());
    const blocks = []; let cursor;
    do {
      const page = await read("/internal/c2/list-export-blocks", "c2", { season_id: SEASON, limit: 1, ...(cursor ? { cursor } : {}) });
      blocks.push(...page.items); assert.ok(!cursor || !page.next_cursor || Number(page.next_cursor) > Number(cursor)); cursor = page.next_cursor;
    } while (cursor);
    const dbBlocks = finalState.tables.sync_export_event_blocks.filter(row => finalState.tables.sync_outbox.some(event => event.outbox_id === row.outbox_id && event.status === "PENDING"));
    equal(blocks.map(row => row.outbox_id).sort(), dbBlocks.map(row => row.outbox_id).sort());
    for (const listed of blocks) {
      const block = dbBlocks.find(row => row.outbox_id === listed.outbox_id);
      for (const field of ["practice_id", "error_code", "payload_digest", "blocked_scope", "blocked_entity_id", "failure_count", "next_attempt_at_ms"])
        assert.equal(listed[field], block[field]);
      assert.equal(listed.action_required, block.action_required === 1);
    }
    if (!replay && phase === "export-b1") {
      assert.ok(dbBlocks.some(row => row.outbox_id === eventOf("a1").outbox_id && row.action_required === 1));
      assert.equal(assertEventAnchor(eventOf("a1"), finalState.tables).status, "PENDING");
      assert.equal(assertEventAnchor(eventOf("a2"), finalState.tables).status, "PENDING");
    }
    if (!replay && phase === "block-b2") assert.equal(dbBlocks.filter(row => row.action_required === 1).length, 2);
    const finalStatus = await overview(); assert.equal(finalStatus.lanes.local_action_required, dbBlocks.filter(row => row.action_required === 1).length);
    journal.phases[phase].evidence = { snapshot_id: finalState.manifest.snapshot_id, digest: finalState.manifest.content_digest, block_count: blocks.length };
    (journal.phases[phase].evidence_history ??= []).push(journal.phases[phase].evidence); save(journal);
    if (journal.evidence_pending) clearExportEvidence(journal, phase, save);
    journal.phases[phase].complete = outcome.status !== "BATCH_PROGRESS"; save(journal);
    return { phase, ...outcome, private_evidence_verified: true };
  } finally { good(await api("/internal/c1/coach-logout", "c1", { session_token: token })); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify({ ...result, coach_logged_out: true }))).catch(error => {
    const phase = process.argv.find(arg => arg.startsWith("--phase="))?.slice(8);
    try {
      const directory = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url); mkdirSync(fileURLToPath(directory), { recursive: true });
      writeFileSync(new URL("c2-associated-lane-failure.json", directory), JSON.stringify(privateFailureRecord(error, phase), null, 2) + "\n");
    } catch { /* Preserve controlled stderr even if private diagnostic storage is unavailable. */ }
    console.error(JSON.stringify({ status: "FAILED_STOP", phase,
    error_code: error.message === "DATA_PRECONDITION_REQUIRED" ? error.message : "PRECONDITION_OR_EVIDENCE_MISMATCH",
    condition: error.condition ?? null, next_action: "Inspect private evidence; preserve the original request and journal." })); process.exitCode = 1; });
}
