import { expect, it } from "vitest";
import { assertAssociatedCapacity, associatedCells, parseAssociatedEvent } from "../src/c2-associated-projection";

const season = "season_associated_2026";
const practice = "practice_associated_01";
const member = "member_associated_001";
const at = "2026-09-30T12:00:00.000Z";
const signup = { season_id: season, practice_id: practice, member_id: member,
  preference: "LEFT", status: "CONFIRMED", queue_at: at, queue_sequence: 1,
  updated_at: at, last_request_id: "request_associated_01" };
const state = { season_id: season, practice_id: practice, seat_plan_version: 1,
  published_revision: 1, coach_member_id: "", steerer_member_id: "",
  updated_by: member, updated_at: at };
const revision = { season_id: season, practice_id: practice,
  revision_number: 1, revision_id: "seat_revision_associated_01", source: "SYSTEM_CANCELSIGNUP",
  seat_plan_version: 1, coach_member_id: "", steerer_member_id: "",
  seats: [{ row_number: 1, side: "LEFT", member_id: member }],
  names: [{ member_id: member, display_name: "Original name" }],
  published_by: member, published_at: at, request_id: "request_associated_01" };

it("orders captured signup, full draft cells, immutable revision and state", () => {
  const event = parseAssociatedEvent("SIGNUPS_CHANGED", JSON.stringify({ action: "cancelSignup",
    entity: { season_id: season, practice_id: practice, snapshot_schema: 2,
      practice_version: 1, signup_version: 1, signup_rows: [signup],
      seat_plan_version: 1, published_revision: 1,
      seating_snapshot: { state, draft_seats: [
        { row_number: 1, side: "LEFT", member_id: member },
        { row_number: 1, side: "RIGHT", member_id: "" }], revision } } }), season);
  expect(event.stages.map((stage) => stage.entity_type)).toEqual([
    "SIGNUP", "SEAT_PLAN_CURRENT", "SEAT_PLAN_CURRENT", "SEAT_PLAN_REVISION", "SEAT_PLAN_DRAFT"]);
  expect(event.stages[0].row_id).toBe(`${practice}:${member}`);
  expect(event.stages[3].values.names_json).toBe(JSON.stringify(revision.names));
  expect(associatedCells(event.stages[4], null)[6]).toBe("0");
  expect(() => assertAssociatedCapacity(event, { season_id: season, practice_id: practice,
    practice_version: 1, left_capacity: 1, right_capacity: 1 })).not.toThrow();
  expect(() => assertAssociatedCapacity(event, { season_id: season, practice_id: practice,
    practice_version: 1, left_capacity: 2, right_capacity: 1 })).toThrow();
});

it("does not invent a draft or revision for null snapshot parts", () => {
  const event = parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({ action: "publishSeatPlan",
    entity: { season_id: season, practice_id: practice, snapshot_schema: 1,
      practice_version: 1, signup_version: 2, seat_plan_version: 1,
      published_revision: 1,
      seating_snapshot: { state, draft_seats: null, revision } } }), season);
  expect(event.stages.map((stage) => stage.entity_type)).toEqual([
    "SEAT_PLAN_REVISION", "SEAT_PLAN_DRAFT"]);
  expect(associatedCells(event.stages[1], [season, practice, "0", "", "", "0", "2", at,
    member, at])[6]).toBe("2");
});

it("exports a pending legacy draft without a top-level revision but rejects missing publication revision", () => {
  const draftSeats = [{ row_number: 1, side: "LEFT", member_id: member },
    { row_number: 1, side: "RIGHT", member_id: "" }];
  const draftEntity = { season_id: season, practice_id: practice, snapshot_schema: 1,
    practice_version: 1, signup_version: 1, seat_plan_version: 1,
    seating_snapshot: { state: { ...state, published_revision: 0 },
      draft_seats: draftSeats, revision: null } };
  const legacy = parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({
    action: "saveSeatPlanDraft", entity: draftEntity }), season);
  expect(legacy.published_revision).toBe(0);
  expect(legacy.stages.filter((stage) => stage.entity_type === "SEAT_PLAN_CURRENT")).toHaveLength(2);
  expect(() => parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({
    action: "publishSeatPlan", entity: draftEntity }), season)).toThrow();
  expect(() => parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({
    action: "saveSeatPlanDraft", entity: { ...draftEntity, published_revision: 1 } }), season)).toThrow();
  expect(() => parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({
    action: "saveSeatPlanDraft", entity: { ...draftEntity,
      seating_snapshot: { ...draftEntity.seating_snapshot, revision } } }), season)).toThrow();
});

it("rejects old and contradictory snapshots before any write", () => {
  const old = { action: "createSignup", entity: { season_id: season, practice_id: practice,
    practice_version: 1, signup_version: 1, signup_rows: [signup] } };
  expect(() => parseAssociatedEvent("SIGNUPS_CHANGED", JSON.stringify(old), season)).toThrow();
  const duplicate = { action: "createSignup", entity: { ...old.entity, snapshot_schema: 2,
    signup_rows: [signup, signup] } };
  expect(() => parseAssociatedEvent("SIGNUPS_CHANGED", JSON.stringify(duplicate), season)).toThrow();
  const changed = { action: "createSignup", entity: { ...old.entity, snapshot_schema: 2,
    signup_rows: [signup], seat_plan_version: 2, published_revision: 1,
    seating_snapshot: { state, draft_seats: null, revision: null } } };
  expect(() => parseAssociatedEvent("SIGNUPS_CHANGED", JSON.stringify(changed), season)).toThrow();
  const wrongRevision = { action: "publishSeatPlan", entity: {
    season_id: season, practice_id: practice, snapshot_schema: 1, practice_version: 1,
    signup_version: 1, seat_plan_version: 1, published_revision: 1,
    seating_snapshot: { state, draft_seats: null,
      revision: { ...revision, seat_plan_version: 2 } } } };
  expect(() => parseAssociatedEvent("SEATING_CHANGED", JSON.stringify(wrongRevision), season)).toThrow();
});

it("allows one member to be both Coach and Steerer without assigning them a paddle seat", () => {
  const paddler = "member_associated_002";
  const dualRoleState = { ...state, coach_member_id: member, steerer_member_id: member };
  const draft = [{ row_number: 1, side: "LEFT", member_id: paddler },
    { row_number: 1, side: "RIGHT", member_id: "" }];
  const draftEvent = parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({ action: "saveSeatPlanDraft",
    entity: { season_id: season, practice_id: practice, snapshot_schema: 1,
      practice_version: 1, signup_version: 1, seat_plan_version: 1, published_revision: 1,
      seating_snapshot: { state: dualRoleState, draft_seats: draft, revision: null } } }), season);
  const practiceRow = { season_id: season, practice_id: practice,
    practice_version: 1, left_capacity: 1, right_capacity: 1 };
  expect(() => assertAssociatedCapacity(draftEvent, practiceRow)).not.toThrow();

  const dualRoleRevision = { ...revision, coach_member_id: member, steerer_member_id: member,
    seats: [draft[0]], names: [{ member_id: member, display_name: "Dual role" },
      { member_id: paddler, display_name: "Paddler" }] };
  const publishedEvent = parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({ action: "publishSeatPlan",
    entity: { season_id: season, practice_id: practice, snapshot_schema: 1,
      practice_version: 1, signup_version: 1, seat_plan_version: 1, published_revision: 1,
      seating_snapshot: { state: dualRoleState, draft_seats: null, revision: dualRoleRevision } } }), season);
  expect(() => assertAssociatedCapacity(publishedEvent, practiceRow)).not.toThrow();

  const occupiedDraft = parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({ action: "saveSeatPlanDraft",
    entity: { season_id: season, practice_id: practice, snapshot_schema: 1,
      practice_version: 1, signup_version: 1, seat_plan_version: 1, published_revision: 1,
      seating_snapshot: { state: dualRoleState,
        draft_seats: [{ ...draft[0], member_id: member }, draft[1]], revision: null } } }), season);
  expect(() => assertAssociatedCapacity(occupiedDraft, practiceRow)).toThrow();
  const occupiedRevision = parseAssociatedEvent("SEATING_CHANGED", JSON.stringify({ action: "publishSeatPlan",
    entity: { season_id: season, practice_id: practice, snapshot_schema: 1,
      practice_version: 1, signup_version: 1, seat_plan_version: 1, published_revision: 1,
      seating_snapshot: { state: dualRoleState, draft_seats: null,
        revision: { ...dualRoleRevision, seats: [{ ...draft[0], member_id: member }] } } } }), season);
  expect(() => assertAssociatedCapacity(occupiedRevision, practiceRow)).toThrow();
});
