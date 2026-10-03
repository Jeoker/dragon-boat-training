import test from "node:test";
import assert from "node:assert/strict";
import { assertFinalMemberRow, drainDisposition } from "./c2-action-required-recovery.mjs";

const headers = ["season_id", "member_id", "display_name_override", "member_version", "updated_at"];
const original = ["season_isolated_001", "member_isolated_001", "", "3", "2026-09-30T12:00:00.000Z"];
const saved = { phase: "DRAINING", original, member_version_before: 3 };
const overview = {
  export_control: { status: "RUNNING", pause_requested: false, retry: null },
  counts: { pending_batches: 0, pending_outbox: 0, open_conflicts: 0 }
};

test("a completed remote event can recover only from a clean rearmed or draining state", () => {
  assert.equal(drainDisposition(saved, overview), "VERIFY_FINAL");
  assert.equal(drainDisposition({ ...saved, phase: "REARMED" }, overview), "VERIFY_FINAL");
  assert.equal(drainDisposition(saved, { ...overview, counts: {
    ...overview.counts, pending_outbox: 1 } }), "POLL");
  for (const changed of [
    { counts: { ...overview.counts, pending_batches: 1 } },
    { counts: { ...overview.counts, open_conflicts: 1 } },
    { counts: { ...overview.counts, pending_outbox: 2 } },
    { export_control: { ...overview.export_control, status: "ACTION_REQUIRED" } },
    { export_control: { ...overview.export_control, pause_requested: true } },
    { export_control: { ...overview.export_control, retry: { action_required: true } } },
    { export_control: { ...overview.export_control, retry: { failure_count: 1, last_error: "BRIDGE_UNAVAILABLE" } } }
  ]) assert.throws(() => drainDisposition(saved, { ...overview, ...changed }));
  assert.throws(() => drainDisposition({ ...saved, phase: "RESTORED" }, overview));
});

test("remote completion proof rejects a marker, skipped version, or invalid timestamp", () => {
  const final = [...original];
  final[3] = "4";
  final[4] = "2026-09-30T12:01:00.000Z";
  assert.doesNotThrow(() => assertFinalMemberRow(saved, final, headers));
  for (const [index, value] of [[2, "C2.5 transient conflict"], [3, "5"],
    [4, "2026-09-30T11:59:00.000Z"], [4, "not-a-time"]]) {
    const changed = [...final];
    changed[index] = value;
    assert.throws(() => assertFinalMemberRow(saved, changed, headers));
  }
});
