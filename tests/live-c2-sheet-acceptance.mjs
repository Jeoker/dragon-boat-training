import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const expectedHost = "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const base = new URL(process.env.C2_TEST_URL || "");
if (base.protocol !== "https:" || base.hostname !== expectedHost || base.pathname !== "/") {
  throw new Error("Only the isolated c2test Worker is allowed.");
}
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
if (!c1Key || !c2Key) throw new Error("The ignored C2 acceptance environment is incomplete.");
const privateFile = fileURLToPath(new URL("../../.c2-form-test/review-private.json", import.meta.url));
const { coach_code: coachCode } = JSON.parse(readFileSync(privateFile, "utf8"));
if (!coachCode) throw new Error("The isolated Coach credential is missing.");
const seasonId = "season_c2_isolated_2026";
const requestId = (label) => `c2_sheet_${label}_${randomUUID().replaceAll("-", "")}`;

async function api(path, key, payload) {
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
  if (!response.ok || !body.ok) throw new Error(`${path}: HTTP ${response.status}, ${body.error?.code}`);
  return body.data;
}

async function rosterDigest() {
  const response = await fetch(new URL(
    `/internal/c1/public-roster?request_id=${requestId("roster")}&season_id=${seasonId}`, base),
  { headers: { authorization: `Bearer ${c1Key}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  return createHash("sha256").update(JSON.stringify(body.data.members)).digest("base64url");
}

const health = await (await fetch(new URL("/health", base))).json();
assert.equal(health.meta?.service_version, "0.11.0-c2-member-export");
const before = await rosterDigest();
const login = await api("/internal/c1/coach-login", c1Key,
  { request_id: requestId("login"), coach_code: coachCode });
const token = login.result.session_token;
const results = [];
try {
  for (const entityType of process.argv.includes("--all")
    ? ["SEASON", "MEMBER", "SIGNUP", "PRACTICE", "SEAT_PLAN_DRAFT"] : ["SEASON"]) {
    const inspection = () => api("/internal/c2/check-sheet-differences", c2Key, {
      request_id: requestId(entityType.toLowerCase()), session_token: token,
      season_id: seasonId, entity_type: entityType
    });
    const result = await inspection();
    assert.equal(result.entity_type, entityType);
    assert.equal(result.binding_version, 1);
    assert.ok(["OK", "STRUCTURE_INVALID"].includes(result.status));
    assert.match(result.sheet_digest, /^sha256_v1:/u);
    const repeated = await inspection();
    assert.equal(repeated.conflict_records.created, 0,
      "Repeating an unchanged inspection must not create duplicate conflicts.");
    assert.equal(repeated.conflict_records.superseded, 0);
    results.push({ entity_type: entityType, status: result.status, rows_read: result.rows_read,
      compared: result.compared, findings_count: result.findings_count,
      conflict_records: result.conflict_records });
  }
  const overview = await api("/internal/c2/get-sync-overview", c2Key, {
    request_id: requestId("overview"), session_token: token, season_id: seasonId
  });
  assert.equal(overview.schema_version, 9);
  assert.ok(overview.counts.open_conflicts >= 0);
} finally {
  await api("/internal/c1/coach-logout", c1Key,
    { request_id: requestId("logout"), session_token: token });
}
assert.equal(await rosterDigest(), before, "Sheet inspection must not change the Cloudflare roster.");
console.log(JSON.stringify({ status: "passed", scopes: results, roster_unchanged: true }));
