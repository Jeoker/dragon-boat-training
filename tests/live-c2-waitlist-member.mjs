// Explicit isolated Form-member preparation. The supervisor submits Lambda once in the Form UI.
// This runner never submits Form responses, enables polling, deploys, or restores a backup.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

class AcceptanceStop extends Error {}
function check(condition, message) { if (!condition) throw new AcceptanceStop(message); }
const same = (a, b) => canonical(a) === canonical(b);
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha = v => createHash("sha256").update(v).digest("base64url");
const phase = process.argv.find(a => a.startsWith("--phase="))?.slice(8);
const root = new URL("../../.c2-form-test/", import.meta.url);
const artifactRoot = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
const journalPath = new URL("waitlist-member-journal.json", root);
const seasonId = "season_c2_isolated_2026", teamId = "pentasus-c2-test";
const version = "0.16.2-c2-physical-diagnostics", targetName = "C2 Test Member Lambda";
const uid = label => `c2_wlm_${label}_${randomUUID().replaceAll("-", "")}`;
const load = p => JSON.parse(readFileSync(p, "utf8"));
let worker, bridge, fixture, identities, c1Key, c2Key, coachCode, bridgeSecret;
function save(journal, initial = false) {
  if (initial) writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx" });
  else {
    const temporary = new URL("waitlist-member-journal.pending.json", root);
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`);
    renameSync(temporary, journalPath);
  }
}
function validateJournal(j) {
  check(j.format === "c2-waitlist-member-v1" && j.season_id === seasonId && j.target_name === targetName,
    "The private journal identity changed.");
  check(j.worker_url === worker.href && j.form_id === fixture.formId &&
    j.runtime_sheet_id === fixture.runtimeSheetId && j.google_deployment_id === identities.deployment_id,
    "The private journal environment changed.");
  check(j.before_members.length === 10 && new Set(j.before_members.map(m => m.member_id)).size === 10,
    "The original roster journal is invalid.");
  for (const [key, value] of Object.entries(j.request_ids)) check(value === `c2_wlm_${j.run_id}_${key}`,
    "A durable operation request ID changed.");
}
async function api(path, key, payload, allowStale = false) {
  let response, body;
  try {
    response = await fetch(new URL(path, worker), { method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ request_id: uid("read"), ...payload }), signal: AbortSignal.timeout(45_000) });
    body = await response.json();
  } catch { throw new Error("Worker result unknown; rerun this phase with its unchanged private journal."); }
  check(body.meta?.backend_instance === "dragon-boat-training-c2-test" &&
    body.meta?.service_version === version && body.meta?.writer_epoch === 0, "Worker identity changed.");
  if (allowStale && response.status === 409 && body.error?.code === "FORM_IMPORT_STALE") return null;
  check(response.ok && body.ok, `Worker request failed (${response.status}, ${body.error?.code ?? "unknown"}); retain the private journal.`);
  return body.data;
}
async function roster() {
  const url = new URL("/internal/c1/public-roster", worker);
  url.searchParams.set("request_id", uid("roster")); url.searchParams.set("season_id", seasonId);
  let response, body;
  try { response = await fetch(url, { headers: { authorization: `Bearer ${c1Key}` },
    signal: AbortSignal.timeout(30_000) }); body = await response.json(); }
  catch { throw new Error("Roster read unavailable; do not submit another Form response."); }
  check(response.ok && body.ok && body.meta?.backend_instance === "dragon-boat-training-c2-test" &&
    body.meta?.service_version === version && body.meta?.writer_epoch === 0, "Roster identity/read failed.");
  return body.data;
}
async function sheet(scope) {
  const payload_json = JSON.stringify({ season_id: seasonId, entity_type: scope });
  const envelope = { action: "cloudflareReadSheetRecords", request_id: uid("bridge"),
    protocol_version: "2026-09-19.bridge.v1", direction: "CLOUDFLARE_TO_GOOGLE", team_id: teamId,
    binding_version: `${seasonId}:1`, writer_epoch: 0, timestamp_ms: Date.now(), nonce: uid("nonce"),
    operation_id: uid("inspect"), payload_json, payload_digest: sha(payload_json) };
  const signature = createHmac("sha256", bridgeSecret).update([envelope.protocol_version,
    envelope.direction, teamId, envelope.binding_version, 0, envelope.timestamp_ms,
    envelope.nonce, envelope.operation_id, envelope.payload_digest].join("\n")).digest("base64url");
  let response, body;
  try { response = await fetch(bridge, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...envelope, signature }), redirect: "follow", signal: AbortSignal.timeout(30_000) });
    body = await response.json(); } catch { throw new Error("Google read unavailable; keep the private journal."); }
  const p = body.data;
  check(response.ok && body.ok && body.meta?.request_id === envelope.request_id &&
    p?.team_id === teamId && p.season_id === seasonId && p.entity_type === scope &&
    p.binding_version === 1 && p.writer_epoch === 0 && p.operation_id === envelope.operation_id &&
    p.payload_digest === envelope.payload_digest, "Google read correlation/identity failed.");
  check(p.spreadsheet_id === (scope === "SEASON" ? fixture.systemSheetId : fixture.runtimeSheetId),
    "Google private Sheet identity changed.");
  check(p.tab_name === (scope === "SEASON" ? "Seasons" : "Members") && /^\d+$/.test(p.tab_id) &&
    p.rows.every(r => r.cells[0] === seasonId), "Google tab identity/season scope changed.");
  return p;
}
async function overview(token) {
  const o = await api("/internal/c2/get-sync-overview", c2Key, { session_token: token, season_id: seasonId });
  check(o.schema_version === 13 && o.binding_current && o.binding?.binding_version === 1 &&
    o.binding.form_id === fixture.formId && o.binding.runtime_spreadsheet_id === fixture.runtimeSheetId &&
    o.binding.response_sheet_id === process.env.C2_RESPONSE_SHEET_ID &&
    o.binding.response_sheet_name === process.env.C2_RESPONSE_SHEET_NAME, "Live isolated Form binding changed.");
  check(o.export_control.status === "RUNNING" && !o.export_control.pause_requested &&
    !o.export_control.source_paused && !o.export_control.retry?.action_required &&
    o.counts.open_conflicts === 0 && o.counts.sources_needing_review === 0,
    "Unexpected pause, conflict, source review, or export halt; manual review required.");
  return o;
}
function clean(o) { check(o.counts.pending_outbox === 0 && o.counts.pending_batches === 0,
  "The isolated export queue must be empty."); }
async function semantic(token, scope) {
  const result = await api("/internal/c2/check-sheet-differences", c2Key,
    { session_token: token, season_id: seasonId, entity_type: scope });
  check(result.status === "OK" && result.findings_count === 0 && result.truncated === false,
    `${scope} baseline/cloud/Google comparison is not clean.`);
}
function originalRoster(j, r, expectedCount) {
  check(r.members.length === expectedCount && new Set(r.members.map(m => m.member_id)).size === expectedCount,
    "Unexpected roster cardinality or duplicate member IDs.");
  const oldIds = new Set(j.before_members.map(m => m.member_id));
  check(same([...r.members.filter(m => oldIds.has(m.member_id))].sort((a,b) => a.member_id.localeCompare(b.member_id)),
    [...j.before_members].sort((a,b) => a.member_id.localeCompare(b.member_id))), "An original member changed.");
  const added = r.members.filter(m => !oldIds.has(m.member_id));
  // public-roster is already filtered to ACTIVE and intentionally omits status.
  check(added.length === expectedCount - 10 && added.every(m => m.display_name === targetName) &&
    r.members.filter(m => m.display_name === targetName).length === expectedCount - 10,
    "The added member must be the single active Lambda.");
  if (expectedCount === 11) check(r.season.roster_version === j.before_season.roster_version + 1,
    "The import must advance roster version exactly once.");
  return added[0];
}
function originalGoogle(j, members, season, complete) {
  check(same(members.headers, j.google_member.headers) && same(season.headers, j.google_season.headers) &&
    members.tab_id === j.google_member.tab_id && season.tab_id === j.google_season.tab_id,
    "Google headers or physical tabs changed.");
  check(members.rows.length === (complete ? 11 : 10) && season.rows.length === 1, "Google row count changed unexpectedly.");
  for (const old of j.google_member.rows) {
    const matches = members.rows.filter(r => r.cells[1] === old.cells[1]);
    check(matches.length === 1 && same(matches[0].cells, old.cells), "An original Google member row changed.");
  }
  const previous = j.google_season.rows[0].cells, current = season.rows[0].cells;
  check(previous.every((cell, i) => season.headers[i] === "roster_version" && complete ?
    current[i] === String(j.before_season.roster_version + 1) : cell === current[i]), "An unrelated Google season cell changed.");
  if (complete) {
    const additions = members.rows.filter(r => !j.google_member.rows.some(old => old.cells[1] === r.cells[1]));
    check(additions.length === 1 && additions[0].cells[1] === j.added_member.member_id &&
      additions[0].cells[members.headers.indexOf("source_display_name")] === targetName,
      "Google must contain exactly one new Lambda row.");
  }
}
async function verifyBackup(token) {
  const ref = load(new URL("c2-physical-backup-reference.json", artifactRoot));
  check(ref.worker_url === worker.href && ref.backend_instance === "dragon-boat-training-c2-test" &&
    ref.team_id === teamId && ref.season_id === seasonId && ref.schema_version === 13 &&
    ref.runtime_spreadsheet_id === fixture.runtimeSheetId && ref.system_spreadsheet_id === fixture.systemSheetId &&
    ref.google_deployment_id === identities.deployment_id && /^backup_[A-Za-z0-9_-]+$/.test(ref.snapshot_id),
    "The verified backup reference is not this isolated environment.");
  const { manifest, chunks } = load(new URL(`${ref.snapshot_id}.json`, artifactRoot));
  const { content_digest, ...core } = manifest;
  check(content_digest === `sha256_v1:${sha(canonical(core))}` && content_digest === ref.content_digest &&
    manifest.snapshot_id === ref.snapshot_id && manifest.schema_version === 13 &&
    manifest.format === "sqlite-json-chunks-v1" && chunks.length === manifest.chunk_count &&
    manifest.tables.length === manifest.table_count && manifest.chunks.length === chunks.length,
    "Private backup manifest integrity failed.");
  for (const [index, c] of chunks.entries()) check(c.chunk_index === index &&
    c.payload_digest === `sha256_v1:${sha(canonical(c.payload))}` &&
    same(manifest.chunks[index], { chunk_index: c.chunk_index, table_name: c.table_name,
      row_offset: c.row_offset, row_count: c.row_count, payload_digest: c.payload_digest }),
    "Private backup chunk integrity failed.");
  const bindings = chunks.filter(c => c.table_name === "sync_bindings").flatMap(c => c.payload.rows);
  check(bindings.length === 1 && bindings[0].season_id === seasonId &&
    bindings[0].form_id === fixture.formId && bindings[0].runtime_spreadsheet_id === fixture.runtimeSheetId,
    "The backup does not prove a unique isolated Form binding.");
  const result = await api("/internal/c1/verify-backup-snapshot", c1Key, { session_token: token,
    snapshot_id: ref.snapshot_id, content_digest });
  check(result.verified === true && result.snapshot_id === ref.snapshot_id &&
    result.expected_content_digest === content_digest && result.chunk_count === manifest.chunk_count,
    "The existing private backup did not verify in the same DO.");
  return { snapshot_id: ref.snapshot_id, content_digest, verified: true };
}
async function main() {
  check(["prepare", "import", "export", "final"].includes(phase), "Choose prepare, import, export, or final.");
  check(process.argv.includes("--write-test-data"), "All phases require --write-test-data (Coach sessions and private journal).");
  fixture = load(new URL("private-test-config.json", root)).fixture;
  identities = load(new URL("isolated-identities.json", root));
  ({ coach_code: coachCode } = load(new URL("review-private.json", root)));
  const secrets = load(new URL("worker-secrets.json", root));
  bridgeSecret = secrets.GOOGLE_BRIDGE_SECRET; bridge = new URL(secrets.GOOGLE_BRIDGE_URL);
  worker = new URL(process.env.C2_TEST_URL || ""); c1Key = process.env.C1_TEST_KEY; c2Key = process.env.C2_TEST_KEY;
  check(worker.href === "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/" &&
    fixture.seasonId === seasonId && fixture.formId === process.env.C2_FORM_ID &&
    fixture.runtimeSheetId === process.env.C2_RUNTIME_SHEET_ID &&
    fixture.runtimeSheetId !== fixture.systemSheetId && coachCode && bridgeSecret && c1Key && c2Key,
    "Private test environment is incomplete or has changed.");
  check(bridge.protocol === "https:" && bridge.hostname === "script.google.com" &&
    /^[A-Za-z0-9_-]{30,}$/.test(identities.deployment_id) && bridge.pathname.includes(identities.deployment_id),
    "Only the recorded isolated Google deployment is allowed.");
  const config = load(new URL("../cloudflare/wrangler.jsonc", import.meta.url)).env.c2test;
  check(config.vars.SERVICE_VERSION === version && config.vars.WRITER_EPOCH === "0" &&
    config.vars.TEAM_ID === teamId && config.vars.BACKEND_INSTANCE === "dragon-boat-training-c2-test" &&
    config.vars.C2_EXPORT_POLL_ENABLED === "false" && same(config.triggers.crons, []),
    "The reviewed c2test version/disabled polling configuration changed.");
  const health = await (await fetch(new URL("/health", worker), { signal: AbortSignal.timeout(20_000) })).json();
  check(health.ok && health.meta?.backend_instance === "dragon-boat-training-c2-test" &&
    health.meta?.service_version === version && health.meta?.writer_epoch === 0, "Live c2test identity changed.");
  const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
  const token = login.result.session_token;
  let result;
  try {
    let j = existsSync(journalPath) ? load(journalPath) : null;
    if (j) validateJournal(j);
    let o = await overview(token), r = await roster();
    if (phase === "prepare") {
      clean(o); check(o.counts.imported_sources === 10 && r.members.length === 10 &&
        !r.members.some(m => m.display_name === targetName) && r.members.every(m => /^C2 Test Member /.test(m.display_name)),
        "Prepare requires the untouched ten-member isolated roster.");
      const [members, season] = await Promise.all([sheet("MEMBER"), sheet("SEASON")]);
      check(members.rows.length === 10 && season.rows.length === 1, "Prepare Google row counts changed.");
      for (const scope of ["MEMBER", "SEASON"]) await semantic(token, scope);
      const backup = await verifyBackup(token);
      if (j) { check(j.state === "PREPARED", "Prepare cannot overwrite a started import.");
        originalRoster(j, r, 10); originalGoogle(j, members, season, false); }
      else {
        const runId = randomUUID().replaceAll("-", "");
        j = { format: "c2-waitlist-member-v1", state: "PREPARED", run_id: runId, season_id: seasonId,
          target_name: targetName, worker_url: worker.href, form_id: fixture.formId,
          runtime_sheet_id: fixture.runtimeSheetId, google_deployment_id: identities.deployment_id,
          prepared_at: new Date().toISOString(), before_members: r.members, before_season: r.season,
          google_member: members, google_season: season, backup,
          pull_attempt: 0, pull_results: [],
          request_ids: Object.fromEntries(["pull", "member", "event"].map(k => [k, `c2_wlm_${runId}_${k}`])) };
        save(j, true);
      }
      result = { phase, ready_for_single_form_submission: true, original_members: 10, backup_verified: true };
    } else {
      check(j, "Run prepare before submitting the isolated Form.");
      if (phase === "import") {
        check(["PREPARED", "IMPORT_PENDING", "IMPORTED"].includes(j.state), "Import phase cannot run after export starts.");
        if (r.members.length === 10) {
          originalRoster(j, r, 10); clean(o);
          const attempt = j.pull_attempt ?? 0;
          const pullKey = attempt === 0 ? "pull" : `pull_${attempt}`;
          j.request_ids[pullKey] ??= `c2_wlm_${j.run_id}_${pullKey}`;
          j.state = "IMPORT_PENDING"; save(j);
          const pulled = await api("/internal/c2/pull-form-responses", c2Key,
            { request_id: j.request_ids[pullKey], season_id: seasonId, limit: 100 }, true);
          if (!pulled) { result = { phase, status: "FORM_IMPORT_STALE", retry_same_phase: true }; }
          else { check([0, 1].includes(pulled.result.created) && !pulled.result.has_more,
            "Unexpected Form import count; manual review required.");
            // Only a KNOWN successful empty scan permits advancing to a new pull ID.
            // Persist this before the subsequent roster read, which may itself fail.
            j.pull_results ??= [];
            if (!j.pull_results.some(item => item.request_id === j.request_ids[pullKey])) {
              j.pull_results.push({ request_id: j.request_ids[pullKey], created: pulled.result.created,
                completed_at: new Date().toISOString() });
            }
            if (pulled.result.created === 0) j.pull_attempt = attempt + 1;
            save(j); r = await roster();
            if (pulled.result.created === 0 && r.members.length === 10) {
              originalRoster(j, r, 10); clean(await overview(token));
              result = { phase, status: "WAITING_FOR_FORM_SOURCE", retry_same_phase: true,
                successful_empty_scan_recorded: true, form_resubmission_required: false };
            }
          }
        }
        if (!result) {
          j.added_member = originalRoster(j, r, 11); o = await overview(token);
          check(o.counts.imported_sources === 11 && o.counts.pending_outbox === 1 && o.counts.pending_batches === 0 &&
            o.export_control.oldest_pending?.topic === "MEMBERS_IMPORTED", "Expected exactly one member-import event.");
          originalGoogle(j, await sheet("MEMBER"), await sheet("SEASON"), false);
          j.state = "IMPORTED"; save(j); result = { phase, status: "IMPORTED", members: 11, original_members_unchanged: true };
        }
      } else if (phase === "export") {
        check(["IMPORTED", "MEMBER_PENDING", "MEMBER_DONE", "EVENT_PENDING", "EXPORTED", "FINAL"].includes(j.state),
          "Import must finish before exporting Lambda.");
        originalRoster(j, r, 11);
        if (["EXPORTED", "FINAL"].includes(j.state)) { clean(o); result = { phase, status: "ALREADY_CONFIRMED" }; }
        else if (j.state === "IMPORTED" && Date.parse(o.export_control.oldest_pending?.due_at) > Date.now()) {
          result = { phase, status: "WAITING_FOR_DUE", due_at: o.export_control.oldest_pending.due_at };
        } else {
          const lostEventReply = j.state === "EVENT_PENDING" && o.counts.pending_outbox === 0;
          check(lostEventReply ? o.counts.pending_batches === 0 :
            o.counts.pending_outbox === 1 && o.counts.pending_batches <= 1 &&
            o.export_control.oldest_pending?.topic === "MEMBERS_IMPORTED", "Unexpected isolated export work.");
          const memberStep = ["IMPORTED", "MEMBER_PENDING"].includes(j.state);
          const key = memberStep ? "member" : "event";
          j.state = memberStep ? "MEMBER_PENDING" : "EVENT_PENDING"; save(j);
          const exported = await api("/internal/c2/export-next-member", c2Key,
            { request_id: j.request_ids[key], season_id: seasonId });
          if (memberStep) {
            check(exported.status === "BATCH_CONFIRMED" && exported.member_id === j.added_member.member_id,
              "Expected the single Lambda member batch.");
            j.member_batch_id = exported.batch_id; j.state = "MEMBER_DONE";
          } else {
            check(exported.status === "EVENT_CONFIRMED" && exported.roster_version === j.before_season.roster_version + 1,
              "Expected original member-import event confirmation.");
            j.event_batch_id = exported.batch_id; j.state = "EXPORTED";
          }
          save(j); o = await overview(token);
          check(o.counts.pending_batches === 0 && o.counts.pending_outbox === (memberStep ? 1 : 0),
            "Unexpected queue state after export step.");
          result = { phase, status: exported.status, pending_outbox: o.counts.pending_outbox, run_export_again: memberStep };
        }
      } else {
        check(["EXPORTED", "FINAL"].includes(j.state), "Both export steps must finish before final verification.");
        clean(o); check(o.counts.imported_sources === 11, "Unexpected source count after export.");
        originalRoster(j, r, 11); originalGoogle(j, await sheet("MEMBER"), await sheet("SEASON"), true);
        for (const scope of ["MEMBER", "SEASON"]) await semantic(token, scope);
        clean(await overview(token)); j.state = "FINAL"; save(j);
        result = { phase, status: "PASSED", members: 11, original_members_unchanged: true,
          original_google_rows_unchanged: true, member_and_season_differences: 0, pending_outbox: 0, pending_batches: 0 };
      }
    }
  } finally { await api("/internal/c1/coach-logout", c1Key, { session_token: token }); }
  console.log(JSON.stringify({ ...result, coach_logged_out: true }));
}
main().catch(error => {
  // No raw assertions, private rows, URLs, Form IDs, credentials or session tokens in failures.
  console.error(error instanceof AcceptanceStop ? error.message : "Isolated acceptance encountered an unavailable read or unknown operation result.");
  console.error("Retain the private journal; do not resubmit the Form or generate new operation IDs.");
  process.exitCode = 1;
});
