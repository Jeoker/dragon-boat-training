// Exercises a no-op signed patch and same-batch replay on the isolated Google test file.
// Optional partial-recovery mode changes two test-member cells and restores them.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--write-isolated-receipt")) {
  throw new Error("Explicit --write-isolated-receipt is required.");
}
const secretFile = fileURLToPath(new URL("../.c2-form-test/worker-secrets.json", import.meta.url));
const { GOOGLE_BRIDGE_URL: rawUrl, GOOGLE_BRIDGE_SECRET: secret } =
  JSON.parse(readFileSync(secretFile, "utf8"));
const url = new URL(rawUrl);
assert.equal(url.protocol, "https:");
assert.equal(url.hostname, "script.google.com");
assert.ok(secret);
const seasonId = "season_c2_isolated_2026";
const protocol = "2026-09-19.bridge.v1";
const operationId = `c2_receipt_replay_${randomUUID().replaceAll("-", "")}`;

async function bridge(action, operation_id, payload) {
  const payload_json = JSON.stringify(payload);
  const envelope = {
    action, request_id: `c2_bridge_${randomUUID().replaceAll("-", "")}`,
    protocol_version: protocol, direction: "CLOUDFLARE_TO_GOOGLE",
    team_id: "pentasus-c2-test", binding_version: `${seasonId}:1`, writer_epoch: 0,
    timestamp_ms: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
    operation_id, payload_json,
    payload_digest: createHash("sha256").update(payload_json).digest("base64url")
  };
  const message = [envelope.protocol_version, envelope.direction, envelope.team_id,
    envelope.binding_version, envelope.writer_epoch, envelope.timestamp_ms,
    envelope.nonce, envelope.operation_id, envelope.payload_digest].join("\n");
  const signature = createHmac("sha256", secret).update(message).digest("base64url");
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...envelope, signature }), redirect: "follow",
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  assert.equal(body.meta?.request_id, envelope.request_id);
  if (!response.ok || body.ok !== true) {
    throw new Error(`${action}: HTTP ${response.status}, ${body.error?.code}`);
  }
  assert.equal(body.data.protocol_version, protocol);
  assert.equal(body.data.team_id, envelope.team_id);
  assert.equal(body.data.season_id, seasonId);
  assert.equal(body.data.operation_id, operation_id);
  assert.equal(body.data.payload_digest, envelope.payload_digest);
  return body.data;
}

const inspect = () => bridge("cloudflareReadSheetRecords",
  `inspect_${randomUUID().replaceAll("-", "")}`,
  { season_id: seasonId, entity_type: "SEASON" });
const before = await inspect();
assert.equal(before.entity_type, "SEASON");
assert.equal(before.rows.length, 1);
assert.equal(before.rows[0].cells[0], seasonId);
const row = before.rows[0].cells;
const payload = { season_id: seasonId, batch_id: operationId,
  spreadsheet_id: before.spreadsheet_id, tab_id: before.tab_id,
  items: [{ season_id: seasonId, expected: row, target: row }] };
const first = await bridge("cloudflarePatchSeasonSheet", operationId, payload);
const replay = await bridge("cloudflarePatchSeasonSheet", operationId, payload);
assert.equal(first.status, "verified");
assert.deepEqual(replay, first, "Same-batch replay must return the saved receipt.");
assert.deepEqual(first.verified_season_ids, [seasonId]);
const after = await inspect();
assert.deepEqual(after.rows[0].cells, row, "No-op patch must leave every season cell unchanged.");

let partialRecovered = false;
if (process.argv.includes("--verify-partial-recovery")) {
  const inspectMembers = () => bridge("cloudflareReadSheetRecords",
    `inspect_${randomUUID().replaceAll("-", "")}`,
    { season_id: seasonId, entity_type: "MEMBER" });
  const beforeMembers = await inspectMembers();
  assert.equal(beforeMembers.rows.length, 10);
  const nameIndex = beforeMembers.headers.indexOf("display_name_override");
  assert.ok(nameIndex >= 0);
  const originalA = beforeMembers.rows[0].cells;
  const originalB = beforeMembers.rows[1].cells;
  assert.ok(originalA.every((cell) => typeof cell === "string" && !cell.startsWith("=")));
  assert.ok(originalB.every((cell) => typeof cell === "string" && !cell.startsWith("=")));
  const memberA = originalA[1];
  const memberB = originalB[1];
  const suffix = randomUUID().slice(0, 8);
  const conflictB = [...originalB];
  conflictB[nameIndex] = `C2 conflict ${suffix}`;
  const targetB = [...originalB];
  targetB[nameIndex] = `C2 target ${suffix}`;
  const memberPatch = (batchId, items) => bridge("cloudflarePatchMemberSheet", batchId,
    { season_id: seasonId, batch_id: batchId,
      spreadsheet_id: beforeMembers.spreadsheet_id, tab_id: beforeMembers.tab_id, items });
  const batchId = (label) => `c2_partial_${label}_${randomUUID().replaceAll("-", "")}`;
  const partialId = batchId("replay");
  const partialItems = [
    { member_id: memberA, expected: originalA, target: originalA },
    { member_id: memberB, expected: originalB, target: targetB }
  ];
  try {
    await memberPatch(batchId("conflict"),
      [{ member_id: memberB, expected: originalB, target: conflictB }]);
    await assert.rejects(memberPatch(partialId, partialItems), /SHEET_PATCH_CONFLICT/u);
    const conflicted = await inspectMembers();
    assert.deepEqual(conflicted.rows[1].cells, conflictB);
    await memberPatch(batchId("restore_before_retry"),
      [{ member_id: memberB, expected: conflictB, target: originalB }]);
    const recovered = await memberPatch(partialId, partialItems);
    assert.equal(recovered.status, "verified");
    assert.deepEqual(recovered.verified_member_ids, [memberA, memberB]);
    assert.deepEqual(await memberPatch(partialId, partialItems), recovered);
    partialRecovered = true;
  } finally {
    const current = await inspectMembers();
    const rowB = current.rows.find((entry) => entry.cells[1] === memberB)?.cells;
    assert.ok(rowB, "The isolated test member disappeared during recovery.");
    if (JSON.stringify(rowB) !== JSON.stringify(originalB)) {
      await memberPatch(batchId("final_restore"),
        [{ member_id: memberB, expected: rowB, target: originalB }]);
    }
    const restored = await inspectMembers();
    assert.deepEqual(restored.rows[0].cells, originalA);
    assert.deepEqual(restored.rows[1].cells, originalB);
  }
}
console.log(JSON.stringify({ status: "passed", batch_id: operationId,
  no_business_change: true, receipt_replayed: true, partial_recovered: partialRecovered }));
