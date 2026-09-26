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
if (!["before", "after", "overlap"].includes(phase)) {
  throw new Error("Use before, after or overlap as the phase.");
}
if (phase === "overlap" && !process.argv.includes("--write-test-data")) {
  throw new Error("Overlap advances the isolated import cursor; pass --write-test-data explicitly.");
}

const expected = ["C2 Test Member Alpha", "C2 Test Member Beta", "C2 Test Member Gamma",
  ...(phase !== "before" ? ["C2 Test Member Delta"] : [])];
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
assert.deepEqual(members.map((member) => member.display_name).sort(), [...expected].sort());
assert.equal(new Set(members.map((member) => member.member_id)).size, expected.length);
let overlap = null;
if (phase === "overlap") {
  const c2Key = process.env.C2_TEST_KEY?.trim();
  if (!c2Key) throw new Error("C2_TEST_KEY must be set for the overlap phase.");
  const payload = { request_id: "c2_trigger_overlap_001", season_id: "season_c2_isolated_2026", limit: 100 };
  async function pull() {
    const answer = await fetch(new URL("/internal/c2/pull-form-responses", url), {
      method: "POST", headers: { authorization: `Bearer ${c2Key}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await answer.json();
    assert.equal(answer.status, 200);
    assert.equal(data.ok, true);
    return data.data;
  }
  overlap = await pull();
  assert.equal(overlap.result.created, 0);
  assert.equal(overlap.result.unchanged, 4);
  assert.deepEqual(await pull(), overlap);
}
console.log(JSON.stringify({ phase, roster_count: members.length, names: expected,
  worker: host, manual_pull_used: phase === "overlap", overlap_created: overlap?.result.created ?? null,
  overlap_unchanged: overlap?.result.unchanged ?? null }));
