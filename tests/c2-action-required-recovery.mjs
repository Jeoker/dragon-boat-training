import assert from "node:assert/strict";

export function drainDisposition(saved, overview) {
  assert.ok(["REARMED", "DRAINING"].includes(saved.phase),
    "Only a rearmed or draining run can finish export recovery.");
  assert.equal(overview.export_control.status, "RUNNING");
  assert.equal(overview.export_control.pause_requested, false);
  assert.equal(overview.counts.pending_batches, 0);
  assert.equal(overview.counts.open_conflicts, 0);
  assert.equal(overview.export_control.retry?.action_required ?? false, false);
  assert.equal(overview.export_control.retry?.failure_count ?? 0, 0);
  assert.equal(overview.export_control.retry?.last_error ?? "", "");
  if (overview.counts.pending_outbox === 1) return "POLL";
  assert.equal(overview.counts.pending_outbox, 0,
    "An unexpected number of pending events cannot prove this run completed.");
  return "VERIFY_FINAL";
}

export function assertFinalMemberRow(saved, finalCells, headers) {
  assert.equal(finalCells.length, headers.length);
  assert.equal(saved.original.length, headers.length);
  const versionIndex = headers.indexOf("member_version");
  const updatedIndex = headers.indexOf("updated_at");
  assert.ok(versionIndex >= 0 && updatedIndex >= 0);
  for (let index = 0; index < headers.length; index += 1) {
    if (index === versionIndex || index === updatedIndex) continue;
    assert.equal(finalCells[index], saved.original[index],
      `Member field ${headers[index]} changed unexpectedly.`);
  }
  assert.equal(finalCells[versionIndex], String(saved.member_version_before + 1));
  const originalTime = Date.parse(saved.original[updatedIndex]);
  const finalTime = Date.parse(finalCells[updatedIndex]);
  assert.ok(Number.isFinite(originalTime) && Number.isFinite(finalTime) &&
    finalTime >= originalTime, "The exported member update time is invalid.");
}
