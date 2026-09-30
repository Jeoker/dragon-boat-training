import { canonicalJson } from "../../shared/c1-rules";
import { sha256Base64Url } from "./crypto";
import { SHEET_SCOPES, type AssociatedSheetScope, type SheetPage, type SheetRow } from "./c2-sheet-bridge";

export interface PhysicalBaseline {
  scope: AssociatedSheetScope;
  row_id: string;
  cells_json: string;
  cells_digest: string;
}

export interface PhysicalFinding {
  scope: AssociatedSheetScope;
  tab_name: string;
  row_id: string | null;
  google_row_number: number | null;
  type: "HEADER_CHANGED" | "ROW_ID_INVALID" | "ROW_ID_DUPLICATE" | "SEASON_MISMATCH" |
    "BASELINE_MISSING" | "GOOGLE_ROW_MISSING" | "CELL_CHANGED" | "BASELINE_INVALID" |
    "BASELINE_NOT_ESTABLISHED";
  changed_columns: string[];
  baseline_digest: string | null;
  google_digest: string | null;
}

export interface PhysicalIntegrity {
  scope: AssociatedSheetScope;
  status: "OK" | "DRIFT" | "INCOMPLETE" | "STRUCTURE_INVALID";
  read_at: string | null;
  rows_read: number;
  baselines_checked: number;
  coverage: "complete" | "bounded_limit" | "failed";
  findings_count: number;
  finding_types: Record<string, number>;
  truncated: boolean;
  findings: PhysicalFinding[];
}

const MAX_FINDINGS = 100;
const idPattern = /^[A-Za-z0-9_-]{8,128}$/u;

function rowId(scope: AssociatedSheetScope, cells: string[]): string | null {
  if (!idPattern.test(cells[1])) return null;
  if (scope === "SIGNUP") return idPattern.test(cells[2]) ? `${cells[1]}:${cells[2]}` : null;
  if (scope === "SEAT_PLAN_CURRENT") return /^[1-9]\d*$/u.test(cells[2]) &&
    ["LEFT", "RIGHT"].includes(cells[3]) ? `${cells[1]}:${cells[2]}:${cells[3]}` : null;
  if (scope === "SEAT_PLAN_REVISION") return /^[1-9]\d*$/u.test(cells[2]) ?
    `${cells[1]}:${cells[2]}` : null;
  return cells[1];
}

function hasExpectedHeaders(actual: string[], scope: AssociatedSheetScope): boolean {
  return canonicalJson(actual) === canonicalJson(SHEET_SCOPES[scope].headers);
}

function digest(cells: string[]): Promise<string> {
  return sha256Base64Url(canonicalJson(cells)).then((value) => `sha256_v1:${value}`);
}

export function scanLimitIntegrity(scope: AssociatedSheetScope): PhysicalIntegrity {
  return { scope, status: "INCOMPLETE", read_at: null, rows_read: 0, baselines_checked: 0,
    coverage: "bounded_limit", findings_count: 0, finding_types: {}, truncated: false, findings: [] };
}

export async function analyzePhysicalPage(input: {
  season_id: string;
  scope: AssociatedSheetScope;
  page: SheetPage;
  baselines: PhysicalBaseline[];
  baseline_limited?: boolean;
}): Promise<PhysicalIntegrity> {
  const { scope, page } = input;
  const tabs: Array<{ scope: AssociatedSheetScope; headers: string[]; rows: SheetRow[] }> = [
    { scope, headers: page.headers, rows: page.rows }
  ];
  if (scope === "SEAT_PLAN_DRAFT") tabs.push({ scope: "SEAT_PLAN_CURRENT",
    headers: page.secondary?.headers ?? [], rows: page.secondary?.rows ?? [] });
  if (input.baseline_limited) {
    const invalid = tabs.filter((tab) => !hasExpectedHeaders(tab.headers, tab.scope));
    return { ...scanLimitIntegrity(scope), status: invalid.length ? "STRUCTURE_INVALID" : "INCOMPLETE",
      read_at: new Date(page.read_at_ms).toISOString(),
      rows_read: tabs.reduce((total, tab) => total + tab.rows.length, 0),
      findings_count: invalid.length,
      finding_types: invalid.length ? { HEADER_CHANGED: invalid.length } : {},
      findings: invalid.map((tab) => ({ scope: tab.scope, tab_name: SHEET_SCOPES[tab.scope].tab,
        row_id: null, google_row_number: null, type: "HEADER_CHANGED" as const,
        changed_columns: [], baseline_digest: null, google_digest: null })) };
  }
  const findings: PhysicalFinding[] = [];
  const findingTypes: Record<string, number> = {};
  let findingsCount = 0;
  let structureInvalid = false;
  let incomplete = Boolean(input.baseline_limited);
  let drift = false;
  const add = (value: PhysicalFinding) => {
    findingsCount += 1;
    findingTypes[value.type] = (findingTypes[value.type] ?? 0) + 1;
    if (findings.length < MAX_FINDINGS) { findings.push(value); return; }
    const priority = (type: PhysicalFinding["type"]) =>
      ["HEADER_CHANGED", "ROW_ID_INVALID", "ROW_ID_DUPLICATE", "SEASON_MISMATCH",
        "BASELINE_INVALID"].includes(type) ? 2 : 1;
    if (priority(value.type) === 2) {
      const replace = findings.findIndex((item) => priority(item.type) < 2);
      if (replace >= 0) findings[replace] = value;
    }
  };
    const baseFinding = (part: AssociatedSheetScope, type: PhysicalFinding["type"],
    id: string | null = null, number: number | null = null): PhysicalFinding => ({
      scope: part, tab_name: SHEET_SCOPES[part].tab, row_id: id, google_row_number: number, type,
      changed_columns: [], baseline_digest: null, google_digest: null
    });
  let checked = 0;
  for (const tab of tabs) {
    if (!hasExpectedHeaders(tab.headers, tab.scope)) {
      structureInvalid = true;
      add(baseFinding(tab.scope, "HEADER_CHANGED"));
      continue;
    }
    const present = new Map<string, { row_number: number; cells: string[] }>();
    for (const source of tab.rows) {
      if (source.cells[0] !== input.season_id) {
        structureInvalid = true;
        add(baseFinding(tab.scope, "SEASON_MISMATCH", null, source.row_number));
        continue;
      }
      const id = rowId(tab.scope, source.cells);
      if (!id) {
        structureInvalid = true;
        add(baseFinding(tab.scope, "ROW_ID_INVALID", null, source.row_number));
        continue;
      }
      if (present.has(id)) {
        structureInvalid = true;
        add(baseFinding(tab.scope, "ROW_ID_DUPLICATE", id, source.row_number));
        continue;
      }
      present.set(id, source);
    }
    const baselineRows = input.baselines.filter((baseline) => baseline.scope === tab.scope);
    if (!baselineRows.length && !tab.rows.length) {
      incomplete = true;
      add(baseFinding(tab.scope, "BASELINE_NOT_ESTABLISHED"));
    }
    const baselineIds = new Set<string>();
    for (const baseline of baselineRows) {
      checked += 1;
      baselineIds.add(baseline.row_id);
      let cells: unknown;
      try { cells = JSON.parse(baseline.cells_json); } catch { cells = null; }
      if (!Array.isArray(cells) || cells.length !== tab.headers.length ||
          !cells.every((cell) => typeof cell === "string") ||
          cells[0] !== input.season_id || rowId(tab.scope, cells) !== baseline.row_id ||
          await digest(cells) !== baseline.cells_digest) {
        incomplete = true;
        add({ ...baseFinding(tab.scope, "BASELINE_INVALID", baseline.row_id),
          baseline_digest: baseline.cells_digest });
        continue;
      }
      const google = present.get(baseline.row_id);
      if (!google) {
        drift = true;
        add({ ...baseFinding(tab.scope, "GOOGLE_ROW_MISSING", baseline.row_id),
          baseline_digest: baseline.cells_digest });
        continue;
      }
      if (canonicalJson(cells) !== canonicalJson(google.cells)) {
        drift = true;
        add({ ...baseFinding(tab.scope, "CELL_CHANGED", baseline.row_id, google.row_number),
          changed_columns: tab.headers.filter((_header, index) => cells[index] !== google.cells[index]),
          baseline_digest: baseline.cells_digest, google_digest: await digest(google.cells) });
      }
    }
    for (const [id, google] of present) {
      if (baselineIds.has(id)) continue;
      incomplete = true;
      add({ ...baseFinding(tab.scope, "BASELINE_MISSING", id, google.row_number),
        google_digest: await digest(google.cells) });
    }
  }
  return { scope, status: structureInvalid ? "STRUCTURE_INVALID" : incomplete ? "INCOMPLETE" :
      drift ? "DRIFT" : "OK",
    read_at: new Date(page.read_at_ms).toISOString(),
    rows_read: tabs.reduce((total, tab) => total + tab.rows.length, 0),
    baselines_checked: checked, coverage: input.baseline_limited ? "bounded_limit" :
      structureInvalid ? "failed" : "complete",
    findings_count: findingsCount, finding_types: findingTypes,
    truncated: findingsCount > findings.length, findings };
}
