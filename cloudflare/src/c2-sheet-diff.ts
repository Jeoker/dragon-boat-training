import { canonicalJson } from "../../shared/c1-rules";
import { SYNC_FIELD_DEFINITIONS, compareSyncGroup, type SyncGroupDecision } from "../../shared/c2-sync-rules";
import { SEAT_CELL_HEADERS, SHEET_SCOPES, type SheetPage, type SheetScope } from "./c2-sheet-bridge";

export interface SheetBaseline {
  entity_id: string;
  dependency_group: string;
  baseline: Record<string, unknown>;
}
export interface SheetFinding extends SyncGroupDecision {
  entity_id: string;
  row_number: number | null;
}

function identity(scope: SheetScope, row: Record<string, string>): string {
  if (scope === "SEASON") return row.season_id || "";
  if (scope === "MEMBER") return row.member_id || "";
  if (scope === "SIGNUP") return row.practice_id && row.member_id ? `${row.practice_id}:${row.member_id}` : "";
  return row.practice_id || "";
}

function googleRecord(scope: SheetScope, row: Record<string, string>,
  seats: Array<{ side: string; row_number: number; member_id: string }> = []): Record<string, unknown> {
  if (scope === "PRACTICE") return { ...row, cancelled: !!row.cancelled_at };
  if (scope === "SEAT_PLAN_DRAFT") return { ...row, seats };
  return row;
}

function finding(entityId: string, rowNumber: number | null, group: string,
  outcome: SheetFinding["outcome"], reason: string,
  values: { baseline?: Record<string, unknown>; cloudflare?: Record<string, unknown>;
    google?: Record<string, unknown> } = {}): SheetFinding {
  return { entity_id: entityId, row_number: rowNumber, dependency_group: group, outcome,
    reason, fields: Object.keys(values.google || values.baseline || {}),
    baseline: values.baseline || {}, cloudflare: values.cloudflare || {}, google: values.google || {} };
}

export function analyzeSheetPage(input: {
  season_id: string; page: SheetPage; baselines: SheetBaseline[];
  cloud_rows: Array<Record<string, unknown>>; max_findings?: number;
  expected_binding?: { form_id: string; runtime_spreadsheet_id: string;
    response_sheet_id: string; binding_version: number };
}): { status: "OK" | "STRUCTURE_INVALID"; compared: number; findings_count: number;
  findings: SheetFinding[]; truncated: boolean } {
  const { page, season_id: seasonId } = input;
  const scope = page.entity_type;
  const findings: SheetFinding[] = [];
  const maximum = input.max_findings ?? 100;
  let findingsCount = 0;
  const push = (value: SheetFinding) => {
    findingsCount += 1;
    if (findings.length < maximum) findings.push(value);
  };
  const expectedHeaders = SHEET_SCOPES[scope].headers;
  if (canonicalJson(page.headers) !== canonicalJson(expectedHeaders)) {
    push(finding(seasonId, null, "SHEET_STRUCTURE", "REVIEW_REQUIRED",
      "The registered tab header or column order changed; no business comparison was attempted.",
      { google: { headers: page.headers, sample_rows: page.rows.slice(0, 3) } }));
    return { status: "STRUCTURE_INVALID", compared: 0, findings_count: findingsCount,
      findings, truncated: false };
  }

  const seatsByPractice = new Map<string, Array<{ side: string; row_number: number; member_id: string }>>();
  let seatStructureInvalid = false;
  if (scope === "SEAT_PLAN_DRAFT") {
    const secondary = page.secondary;
    if (!secondary || canonicalJson(secondary.headers) !== canonicalJson(SEAT_CELL_HEADERS)) {
      push(finding(seasonId, null, "SHEET_STRUCTURE", "REVIEW_REQUIRED",
        "The registered seat-cell tab is missing or its columns changed.",
        { google: { headers: secondary?.headers ?? null, sample_rows: secondary?.rows.slice(0, 3) ?? [] } }));
      return { status: "STRUCTURE_INVALID", compared: 0, findings_count: findingsCount,
        findings, truncated: false };
    }
    const seenSeats = new Set<string>();
    for (const source of secondary.rows) {
      const row = Object.fromEntries(secondary.headers.map((header, index) => [header, source.cells[index]]));
      const rowNumber = Number(row.row_number);
      const key = `${row.practice_id}:${row.side}:${row.row_number}`;
      if (row.season_id !== seasonId || !/^[A-Za-z0-9_.:-]{8,512}$/u.test(row.practice_id) ||
          !["LEFT", "RIGHT"].includes(row.side) || !Number.isSafeInteger(rowNumber) || rowNumber < 1 ||
          seenSeats.has(key)) {
        seatStructureInvalid = true;
        push(finding(row.practice_id || seasonId, source.row_number, "SHEET_STRUCTURE", "REVIEW_REQUIRED",
          "A seat row has an invalid or duplicate stable seat identity.", { google: row }));
        continue;
      }
      seenSeats.add(key);
      const seats = seatsByPractice.get(row.practice_id) ?? [];
      seats.push({ side: row.side, row_number: rowNumber, member_id: row.member_id });
      seatsByPractice.set(row.practice_id, seats);
    }
    for (const seats of seatsByPractice.values()) seats.sort((left, right) =>
      left.side.localeCompare(right.side) || left.row_number - right.row_number);
  }

  const google = new Map<string, { record: Record<string, unknown>; row_number: number }>();
  let invalidStructure = false;
  for (const source of page.rows) {
    const row = Object.fromEntries(page.headers.map((header, index) => [header, source.cells[index]]));
    if (scope !== "SEASON" && row.season_id !== seasonId) {
      invalidStructure = true;
      push(finding(seasonId, source.row_number, "SHEET_STRUCTURE", "REVIEW_REQUIRED",
        "A runtime row belongs to a different season or has no season ID.", { google: row }));
      continue;
    }
    if (scope === "SEASON" && row.season_id !== seasonId) continue;
    if (scope === "SEASON" && input.expected_binding && (
      row.form_id !== input.expected_binding.form_id ||
      row.runtime_spreadsheet_id !== input.expected_binding.runtime_spreadsheet_id ||
      row.response_sheet_id !== input.expected_binding.response_sheet_id ||
      row.binding_version !== String(input.expected_binding.binding_version))) {
      invalidStructure = true;
      push(finding(seasonId, source.row_number, "BINDING_IDENTITY", "REVIEW_REQUIRED",
        "The system Sheet binding identity no longer matches the registered season binding.",
        { google: { form_id: row.form_id, runtime_spreadsheet_id: row.runtime_spreadsheet_id,
          response_sheet_id: row.response_sheet_id, binding_version: row.binding_version } }));
    }
    const id = identity(scope, row);
    if (!id || !/^[A-Za-z0-9_.:-]{8,512}$/u.test(id)) {
      invalidStructure = true;
      push(finding(id || seasonId, source.row_number, "ROW_IDENTITY", "REVIEW_REQUIRED",
        "A Sheet row has a missing or invalid stable ID.", { google: row }));
      continue;
    }
    if (google.has(id)) {
      invalidStructure = true;
      push(finding(id, source.row_number, "ROW_IDENTITY", "REVIEW_REQUIRED",
        "The Sheet contains a duplicate stable ID.",
        { google: { first_row_number: google.get(id)!.row_number, duplicate_row: row } }));
      continue;
    }
    google.set(id, { record: googleRecord(scope, row, seatsByPractice.get(id)), row_number: source.row_number });
  }
  if (scope === "SEAT_PLAN_DRAFT") {
    for (const practiceId of seatsByPractice.keys()) {
      if (google.has(practiceId)) continue;
      seatStructureInvalid = true;
      push(finding(practiceId, null, "SHEET_STRUCTURE", "REVIEW_REQUIRED",
        "Seat cells exist without a matching seat-plan state row.",
        { google: { seats: seatsByPractice.get(practiceId) } }));
    }
    for (const source of page.secondary!.rows) {
      const row = Object.fromEntries(page.secondary!.headers.map((header, index) => [header, source.cells[index]]));
      const state = google.get(row.practice_id);
      if (state && row.seat_plan_version === String(state.record.seat_plan_version)) continue;
      seatStructureInvalid = true;
      push(finding(row.practice_id || seasonId, source.row_number, "SHEET_STRUCTURE", "REVIEW_REQUIRED",
        "A seat cell version does not match its seat-plan state.", { google: row }));
    }
  }
  if (invalidStructure || seatStructureInvalid) return { status: "STRUCTURE_INVALID", compared: 0,
    findings_count: findingsCount, findings, truncated: findingsCount > findings.length };

  const baselineByEntity = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of input.baselines) {
    const groups = baselineByEntity.get(row.entity_id) ?? new Map();
    groups.set(row.dependency_group, row.baseline);
    baselineByEntity.set(row.entity_id, groups);
  }
  const cloud = new Map(input.cloud_rows.map((row) => [identity(scope,
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? "")]))), row]));
  const entityIds = new Set([...baselineByEntity.keys(), ...cloud.keys(), ...google.keys()]);
  let compared = 0;
  const requiredGroups = new Set(SYNC_FIELD_DEFINITIONS[scope].map((definition) => definition.dependency_group));
  for (const entityId of [...entityIds].sort()) {
    const groups = baselineByEntity.get(entityId);
    const cloudRow = cloud.get(entityId) ?? null;
    const googleRow = google.get(entityId) ?? null;
    if (!groups) {
      push(finding(entityId, googleRow?.row_number ?? null, "ROW_IDENTITY",
        cloudRow && !googleRow ? "EXPORT" : "REVIEW_REQUIRED",
        "This record has no confirmed B baseline; no Sheet edit is imported or overwritten.",
        { cloudflare: cloudRow || {}, google: googleRow?.record || {} }));
      continue;
    }
    compared += 1;
    if (!cloudRow || !googleRow) {
      push(finding(entityId, googleRow?.row_number ?? null, "ROW_IDENTITY", "REVIEW_REQUIRED",
        cloudRow ? "The Google row was deleted; deletion is not cancellation." :
          "The Cloudflare record is missing; Sheet data cannot recreate it automatically.",
        { cloudflare: cloudRow || {}, google: googleRow?.record || {} }));
      continue;
    }
    const missing = [...requiredGroups].filter((group) => !groups.has(group));
    if (missing.length) push(finding(entityId, googleRow.row_number, "BASELINE_INCOMPLETE", "REVIEW_REQUIRED",
      "Some dependency groups have no confirmed B baseline; those groups were not compared.",
      { google: { missing_groups: missing } }));
    for (const [group, baseline] of groups) {
      if (group === "SYSTEM_VERSION") {
        const edited = Object.entries(baseline).filter(([field, value]) =>
          Object.hasOwn(googleRow.record, field) && String(googleRow.record[field]) !== String(value));
        if (edited.length) push(finding(entityId, googleRow.row_number, group, "REJECTED",
          "A Sheet system-version cell was edited; version is not a business command.",
          { baseline, cloudflare: cloudRow, google: googleRow.record }));
        continue;
      }
      let googleComparable = googleRow.record;
      if (scope === "SEAT_PLAN_DRAFT" && group === "SEATING_DRAFT" && Array.isArray(baseline.seats)) {
        const supplied = new Map((googleRow.record.seats as Array<{ side: string; row_number: number;
          member_id: string }>).map((seat) => [`${seat.side}:${seat.row_number}`, seat.member_id]));
        const baselineSeats = baseline.seats as Array<{ side: string; row_number: number; member_id: string }>;
        const expected = new Set(baselineSeats.map((seat) => `${seat.side}:${seat.row_number}`));
        const extra = [...supplied.keys()].filter((key) => !expected.has(key));
        if (extra.length) {
          push(finding(entityId, googleRow.row_number, "SHEET_STRUCTURE", "REVIEW_REQUIRED",
            "Seat cells extend beyond the confirmed baseline layout; capacity must be reviewed.",
            { baseline, cloudflare: cloudRow, google: googleRow.record }));
          continue;
        }
        googleComparable = { ...googleRow.record, seats: baselineSeats.map((seat) => ({
          side: seat.side, row_number: seat.row_number,
          member_id: supplied.get(`${seat.side}:${seat.row_number}`) ?? ""
        })) };
      }
      const decision = compareSyncGroup({ entity_type: scope, baseline,
        cloudflare: cloudRow, google: googleComparable }, group);
      if (decision.outcome !== "NO_CHANGE") push({ entity_id: entityId,
        row_number: googleRow.row_number, ...decision });
    }
  }
  return { status: "OK", compared, findings_count: findingsCount,
    findings, truncated: findingsCount > findings.length };
}
