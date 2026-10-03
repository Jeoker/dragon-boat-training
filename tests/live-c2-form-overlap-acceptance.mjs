import assert from "node:assert/strict";

const host = "dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const base = process.env.C2_TEST_URL?.trim();
const c1Key = process.env.C1_TEST_KEY?.trim();
const c2Key = process.env.C2_TEST_KEY?.trim();
if (!base || !c1Key || !c2Key) throw new Error("The ignored C2 test environment is incomplete.");
const url = new URL(base);
if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== "/") {
  throw new Error("This acceptance test only uses the isolated c2test Worker.");
}
const phase = process.argv[2];
if (!["before", "race", "after"].includes(phase) ||
    phase === "race" && !process.argv.includes("--write-test-data")) {
  throw new Error("Use before, race --write-test-data, or after.");
}
const seasonId = "season_c2_isolated_2026";
async function roster() {
  const response = await fetch(new URL(
    `/internal/c1/public-roster?request_id=c2_race_roster_${Date.now()}&season_id=${seasonId}`, url),
  { headers: { authorization: `Bearer ${c1Key}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  return body.data.members;
}
async function pull(requestId) {
  const response = await fetch(new URL("/internal/c2/pull-form-responses", url), {
    method: "POST", headers: { authorization: `Bearer ${c2Key}`, "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, season_id: seasonId, limit: 100 })
  });
  return { status: response.status, body: await response.json() };
}
if (phase === "after") {
  const members = await roster();
  assert.equal(members.length, 9);
  assert.equal(new Set(members.map((member) => member.member_id)).size, 9);
  assert.equal(members.filter((member) => member.display_name === "C2 Test Member Iota").length, 1);
  console.log(JSON.stringify({ phase, roster_count: 9, unique_member_ids: true }));
} else if (phase === "before") {
  const members = await roster();
  assert.equal(members.length, 8);
  assert.ok(!members.some((member) => member.display_name === "C2 Test Member Iota"));
  console.log(JSON.stringify({ phase, roster_count: 8 }));
} else {
  const immediate = await pull("c2_race_immediate_001");
  assert.ok(immediate.status === 200 || immediate.status === 409);
  if (immediate.status === 409) assert.equal(immediate.body.error?.code, "FORM_IMPORT_STALE");
  let members = await roster();
  for (let attempt = 0; members.length === 8 && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    members = await roster();
  }
  assert.equal(members.length, 9);
  assert.equal(new Set(members.map((member) => member.member_id)).size, 9);
  assert.equal(members.filter((member) => member.display_name === "C2 Test Member Iota").length, 1);
  const overlap = await pull("c2_race_overlap_001");
  assert.equal(overlap.status, 200);
  assert.equal(overlap.body.data.result.created, 0);
  assert.equal(overlap.body.data.result.unchanged, 9);
  console.log(JSON.stringify({ phase, immediate_status: immediate.status,
    immediate_created: immediate.body.data?.result?.created ?? null,
    immediate_error: immediate.body.error?.code ?? null,
    roster_count: 9, overlap_created: 0, overlap_unchanged: 9 }));
}
