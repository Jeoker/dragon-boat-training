// A guarded no-visible-change member update and export on the disposable C2 season.
// Enqueue and complete are separate because the outbox is due ten minutes after the update.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--write-test-data")) throw new Error("Explicit --write-test-data is required.");
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);
assert.ok(["enqueue", "complete"].includes(phase), "Use --phase=enqueue or --phase=complete.");
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key, "The isolated acceptance keys are required.");
const privateFile = fileURLToPath(new URL("../../.c2-form-test/review-private.json", import.meta.url));
const { coach_code: coachCode } = JSON.parse(readFileSync(privateFile, "utf8"));
assert.ok(coachCode);
const seasonId = "season_c2_isolated_2026";
const requestId = () => `c2_debt_${randomUUID().replaceAll("-", "")}`;

async function api(path, key, payload) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId(), ...payload })
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  if (!response.ok || body.ok !== true) {
    throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  }
  return body.data;
}

async function roster() {
  const url = new URL(`/internal/c1/public-roster?request_id=${requestId()}&season_id=${seasonId}`, base);
  const response = await fetch(url, { headers: { authorization: `Bearer ${c1Key}` } });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return body.data.members;
}

const health = await (await fetch(new URL("/health", base))).json();
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.service_version, "0.12.0-c2-season-export");
const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.result.session_token;
try {
  const overview = await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: seasonId });
  assert.equal(overview.binding_current, true);
  if (phase === "enqueue") {
    assert.equal(overview.counts.pending_batches, 0);
    assert.equal(overview.counts.pending_outbox, 0);
    const members = await roster();
    assert.equal(members.length, 10);
    const member = members[0];
    assert.ok(["LEFT", "RIGHT", "AMBIENT"].includes(member.default_preference));
    const updated = await api("/internal/c1/update-member", c1Key, {
      session_token: token, season_id: seasonId, member_id: member.member_id,
      member_version: member.member_version, default_preference: member.default_preference
    });
    assert.equal(updated.result.member.member_id, member.member_id);
    assert.equal(updated.result.member.default_preference, member.default_preference);
    assert.equal(updated.result.member.member_version, member.member_version + 1);
    console.log(JSON.stringify({ phase, status: "queued", member_id: member.member_id,
      member_version: updated.result.member.member_version,
      roster_version: updated.result.roster_version, visible_preference_unchanged: true }));
  } else {
    assert.ok(overview.counts.pending_outbox === 0 || overview.counts.pending_outbox === 1);
    const steps = [];
    if (overview.counts.pending_outbox === 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const step = await api("/internal/c2/export-next-member", c2Key, { season_id: seasonId });
        steps.push(step.status);
        if (step.status === "EVENT_CONFIRMED") break;
        assert.equal(step.status, "BATCH_CONFIRMED");
      }
      assert.equal(steps.at(-1), "EVENT_CONFIRMED");
    }
    const inspections = [];
    for (const entity_type of ["MEMBER", "SEASON"]) {
      const checked = await api("/internal/c2/check-sheet-differences", c2Key,
        { session_token: token, season_id: seasonId, entity_type });
      assert.equal(checked.status, "OK");
      assert.equal(checked.findings_count, 0);
      inspections.push({ entity_type, rows_read: checked.rows_read, findings_count: checked.findings_count });
    }
    const after = await api("/internal/c2/get-sync-overview", c2Key,
      { session_token: token, season_id: seasonId });
    assert.equal(after.counts.pending_batches, 0);
    assert.equal(after.counts.pending_outbox, 0);
    console.log(JSON.stringify({ phase, status: "passed", export_steps: steps, inspections,
      pending_batches: after.counts.pending_batches, pending_outbox: after.counts.pending_outbox }));
  }
} finally {
  await api("/internal/c1/coach-logout", c1Key, { session_token: token });
}
