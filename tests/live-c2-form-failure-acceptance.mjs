import assert from "node:assert/strict";

const host = "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const base = process.env.C2_TEST_URL?.trim();
const c1Key = process.env.C1_TEST_KEY?.trim();
const c2Key = process.env.C2_TEST_KEY?.trim();
if (!base || !c1Key || !c2Key) throw new Error("The ignored C2 acceptance environment is incomplete.");
const url = new URL(base);
if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== "/") {
  throw new Error("This acceptance test only uses the isolated c2test Worker.");
}
const phase = process.argv[2];
if (!["fail", "recover"].includes(phase) || !process.argv.includes("--write-test-data")) {
  throw new Error("Use fail or recover with --write-test-data.");
}
const seasonId = "season_c2_isolated_2026";
const request = { request_id: "c2_bridge_failure_eta_001", season_id: seasonId, limit: 100 };
const pull = async () => {
  const response = await fetch(new URL("/internal/c2/pull-form-responses", url), {
    method: "POST", headers: { authorization: `Bearer ${c2Key}`, "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  return { status: response.status, body: await response.json() };
};
const roster = async () => {
  const response = await fetch(new URL(
    `/internal/c1/public-roster?request_id=c2_bridge_${phase}_${Date.now()}&season_id=${seasonId}`, url),
  { headers: { authorization: `Bearer ${c1Key}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.meta?.writer_epoch, 0);
  return body.data.members;
};
const answer = await pull();
if (phase === "fail") {
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error?.code, "BRIDGE_UNAVAILABLE");
  const members = await roster();
  assert.equal(members.length, 6);
  assert.ok(!members.some((member) => member.display_name === "C2 Test Member Eta"));
  console.log(JSON.stringify({ phase, failure_code: answer.body.error.code, roster_count: members.length }));
} else {
  assert.equal(answer.status, 200);
  assert.equal(answer.body.data?.result?.created, 1);
  assert.equal(answer.body.data?.result?.has_more, false);
  const replay = await pull();
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.data, answer.body.data);
  const members = await roster();
  assert.equal(members.length, 7);
  assert.equal(new Set(members.map((member) => member.member_id)).size, 7);
  assert.ok(members.some((member) => member.display_name === "C2 Test Member Eta"));
  console.log(JSON.stringify({ phase, created: 1, roster_count: members.length, replay_equal: true }));
}
