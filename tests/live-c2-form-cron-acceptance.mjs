import assert from "node:assert/strict";

const host = "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const base = process.env.C2_TEST_URL?.trim();
const key = process.env.C1_TEST_KEY?.trim();
if (!base || !key) throw new Error("C2_TEST_URL and C1_TEST_KEY are required.");
const url = new URL(base);
if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== "/") {
  throw new Error("This acceptance script only reads the isolated c2test Worker.");
}
const phase = process.argv[2];
if (!["before", "after"].includes(phase)) throw new Error("Use before or after.");
const expected = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon",
  ...(phase === "after" ? ["Zeta"] : [])].map((suffix) => `C2 Test Member ${suffix}`);
const response = await fetch(new URL(
  `/internal/c1/public-roster?request_id=c2_cron_${phase}_${Date.now()}&season_id=season_c2_isolated_2026`, url),
{ headers: { authorization: `Bearer ${key}` } });
const body = await response.json();
assert.equal(response.status, 200);
assert.equal(body.ok, true);
assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(body.meta?.writer_epoch, 0);
const members = body.data?.members;
assert.ok(Array.isArray(members));
assert.deepEqual(members.map((member) => member.display_name).sort(), expected.sort());
assert.equal(new Set(members.map((member) => member.member_id)).size, expected.length);
console.log(JSON.stringify({ phase, roster_count: members.length, names: expected }));
