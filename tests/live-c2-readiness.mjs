// C2 isolation check. No business writes; Sheet inspection may refresh persisted diagnostics.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--read-isolated-state")) {
  throw new Error("Explicit --read-isolated-state is required.");
}
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.protocol, "https:");
assert.equal(base.hostname, "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev");
assert.equal(base.pathname, "/");
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
assert.ok(c1Key && c2Key, "The isolated acceptance keys are required.");
const privateFile = fileURLToPath(new URL("../../.c2-form-test/review-private.json", import.meta.url));
const { coach_code: coachCode } = JSON.parse(readFileSync(privateFile, "utf8"));
assert.ok(coachCode, "The isolated Coach credential is required.");
const requestId = () => `c2_readiness_${randomUUID().replaceAll("-", "")}`;

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

const health = await (await fetch(new URL("/health", base))).json();
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
const login = await api("/internal/c1/coach-login", c1Key, { coach_code: coachCode });
const token = login.result.session_token;
try {
  const sheet_checks = [];
  for (const entity_type of ["SEASON", "MEMBER"]) {
    const checked = await api("/internal/c2/check-sheet-differences", c2Key,
      { session_token: token, season_id: "season_c2_isolated_2026", entity_type });
    sheet_checks.push({ entity_type, status: checked.status, rows_read: checked.rows_read,
      findings_count: checked.findings_count, truncated: checked.truncated });
  }
  const overview = await api("/internal/c2/get-sync-overview", c2Key,
    { session_token: token, season_id: "season_c2_isolated_2026" });
  assert.equal(overview.counts.pending_batches, 0);
  assert.equal(overview.counts.pending_outbox, 0);
  const exportProbe = await api("/internal/c2/export-next-member", c2Key,
    { season_id: "season_c2_isolated_2026" });
  assert.equal(exportProbe.status, "IDLE");
  console.log(JSON.stringify({
    service_version: health.meta.service_version,
    backend_generation: health.meta.backend_generation,
    schema_version: overview.schema_version,
    binding_current: overview.binding_current,
    binding_version: overview.binding?.binding_version ?? null,
    counts: overview.counts,
    sheet_checks,
    export_probe: exportProbe.status
  }));
} finally {
  await api("/internal/c1/coach-logout", c1Key, { session_token: token });
}
