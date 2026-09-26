import assert from "node:assert/strict";

const host = "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const base = process.env.C2_TEST_URL?.trim();
const key = process.env.C1_TEST_KEY?.trim();
if (!base || !key) throw new Error("C2_TEST_URL and C1_TEST_KEY must be set in the ignored test environment file.");
const url = new URL(base);
if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== "/") {
  throw new Error("This acceptance test only reads the isolated c2test Worker.");
}
const phase = process.argv[2];
if (phase !== "before" && phase !== "after") throw new Error("Use before or after as the phase.");

const expected = ["C2 Test Member Alpha", "C2 Test Member Beta", "C2 Test Member Gamma",
  ...(phase === "after" ? ["C2 Test Member Delta"] : [])];
const response = await fetch(new URL(
  `/internal/c1/public-roster?request_id=c2_trigger_${phase}_read&season_id=season_c2_isolated_2026`, url),
{ headers: { authorization: `Bearer ${key}` } });
const body = await response.json();
assert.equal(response.status, 200);
assert.equal(body.ok, true);
assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(body.meta?.writer_epoch, 0);
const members = body.data?.members;
assert.ok(Array.isArray(members));
assert.deepEqual(members.map((member) => member.display_name), expected);
assert.equal(new Set(members.map((member) => member.member_id)).size, expected.length);
console.log(JSON.stringify({ phase, roster_count: members.length, names: expected,
  worker: host, manual_pull_used: false }));
