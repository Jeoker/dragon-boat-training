// Explicitly writes one existing fictitious member to the isolated C2 Google Sheet.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--write-test-data")) throw new Error("Explicit --write-test-data is required.");
const host = "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const base = new URL(process.env.C2_TEST_URL || "");
if (base.protocol !== "https:" || base.hostname !== host || base.pathname !== "/") {
  throw new Error("Only the dedicated c2test Worker is allowed.");
}
const c1Key = process.env.C1_TEST_KEY;
const c2Key = process.env.C2_TEST_KEY;
if (!c1Key || !c2Key) throw new Error("The isolated acceptance credentials are incomplete.");
const privateFile = fileURLToPath(new URL("../../.c2-form-test/review-private.json", import.meta.url));
const { coach_code: coachCode } = JSON.parse(readFileSync(privateFile, "utf8"));
if (!coachCode) throw new Error("The isolated Coach credential is missing.");
const seasonId = "season_c2_isolated_2026";
const requestId = (label) => `c2_member_${label}_${randomUUID().replaceAll("-", "")}`;

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

async function roster() {
  const response = await fetch(new URL(
    `/internal/c1/public-roster?request_id=${requestId("roster")}&season_id=${seasonId}`, base),
  { headers: { authorization: `Bearer ${c1Key}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  return body.data.members;
}

const health = await (await fetch(new URL("/health", base))).json();
assert.equal(health.meta?.service_version, "0.11.0-c2-member-export");
const beforeMembers = await roster();
const beforeDigest = createHash("sha256").update(JSON.stringify(beforeMembers)).digest("base64url");
const login = await api("/internal/c1/coach-login", c1Key,
  { request_id: requestId("login"), coach_code: coachCode });
const token = login.result.session_token;
let writeSucceeded = false;
let beforeRows = -1;
let afterRows = -1;
try {
  const inspect = () => api("/internal/c2/check-sheet-differences", c2Key, {
    request_id: requestId("inspect"), session_token: token,
    season_id: seasonId, entity_type: "MEMBER"
  });
  const before = await inspect();
  assert.equal(before.status, "OK");
  beforeRows = before.rows_read;
  const exportRequestId = requestId("export");
  const result = await api("/internal/c2/export-next-member", c2Key,
    { request_id: exportRequestId, season_id: seasonId });
  assert.equal(result.status, "BATCH_CONFIRMED");
  assert.ok(beforeMembers.some((member) => member.member_id === result.member_id));
  writeSucceeded = true;
  const replay = await api("/internal/c2/export-next-member", c2Key,
    { request_id: exportRequestId, season_id: seasonId });
  assert.deepEqual(replay, result, "The same request ID must return the same exported batch.");
  const after = await inspect();
  assert.equal(after.status, "OK");
  afterRows = after.rows_read;
  assert.equal(afterRows, beforeRows + 1);
  assert.ok(!after.findings.some((finding) => finding.entity_id === result.member_id),
    "The exported member must have no remaining B/C/G difference.");
} finally {
  await api("/internal/c1/coach-logout", c1Key,
    { request_id: requestId("logout"), session_token: token });
}
const afterMembers = await roster();
const afterDigest = createHash("sha256").update(JSON.stringify(afterMembers)).digest("base64url");
assert.equal(afterDigest, beforeDigest, "Export must not change the Cloudflare roster.");
console.log(JSON.stringify({ status: "passed", write_succeeded: writeSucceeded,
  sheet_rows_before: beforeRows, sheet_rows_after: afterRows, roster_unchanged: true }));
