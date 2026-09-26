import { BRIDGE_PROTOCOL, callGoogleBridge } from "./bridge";
import { ApiError } from "./http";
import { isRecord } from "./c1-support";

export const SHEET_SCOPES = {
  SEASON: { tab: "Seasons", headers: ["season_id", "name", "start_date", "end_date", "timezone",
    "season_ends_at", "status", "form_id", "form_url", "runtime_spreadsheet_id",
    "response_sheet_id", "response_sheet_name", "field_mapping_json", "schema_fingerprint",
    "binding_version", "season_version", "roster_version", "initialization_status", "trigger_id",
    "last_sync_at", "activated_at", "completed_at", "archived_at", "created_by", "created_at", "updated_at"] },
  MEMBER: { tab: "Members", headers: ["season_id", "member_id", "source_key", "source_row_number",
    "source_display_name", "display_name_override", "status", "default_preference", "member_version",
    "created_at", "updated_at"] },
  SIGNUP: { tab: "SignupsCurrent", headers: ["season_id", "practice_id", "member_id", "preference",
    "status", "queue_at", "queue_sequence", "updated_at", "last_request_id"] },
  PRACTICE: { tab: "Practices", headers: ["season_id", "practice_id", "week_id", "template_id",
    "generation_key", "start_at", "end_at", "timezone", "location", "address", "map_url",
    "left_capacity", "right_capacity", "signup_cutoff_at", "practice_version", "cancelled_at",
    "cancelled_by", "schedule_published_at", "schedule_published_by", "created_at", "updated_at"] },
  SEAT_PLAN_DRAFT: { tab: "SeatPlanState", headers: ["season_id", "practice_id", "seat_plan_version",
    "coach_member_id", "steerer_member_id", "published_revision", "frozen_revision", "frozen_at",
    "updated_by", "updated_at"] }
} as const;

export const SEAT_CELL_HEADERS = ["season_id", "practice_id", "row_number", "side", "member_id",
  "seat_plan_version", "updated_by", "updated_at"] as const;

export type SheetScope = keyof typeof SHEET_SCOPES;
export interface SheetRow { row_number: number; cells: string[]; }
export interface SheetPage {
  entity_type: SheetScope;
  spreadsheet_id: string;
  tab_name: string;
  tab_id: string;
  read_at_ms: number;
  headers: string[];
  rows: SheetRow[];
  secondary?: { tab_name: string; tab_id: string; headers: string[]; rows: SheetRow[] };
}

function invalid(): never {
  throw new ApiError("BRIDGE_INVALID_RESPONSE", "The Sheet bridge returned an invalid inspection.", 502, true);
}

function consumeCells(cells: string[], budget: { cells: number; characters: number }): void {
  budget.cells += cells.length;
  if (budget.cells > 100_000) invalid();
  for (const cell of cells) {
    budget.characters += cell.length;
    if (budget.characters > 2_000_000) invalid();
  }
}

function parseRows(headers: string[], raw: unknown, maximum: number,
  budget: { cells: number; characters: number }): SheetRow[] {
  if (!Array.isArray(raw) || raw.length > maximum) invalid();
  const rows: SheetRow[] = [];
  for (const [index, row] of raw.entries()) {
    if (!isRecord(row) || row.row_number !== index + 2 || !Array.isArray(row.cells) ||
        row.cells.length !== headers.length ||
        !row.cells.every((cell: unknown) => typeof cell === "string" && cell.length <= 10_000)) invalid();
    consumeCells(row.cells as string[], budget);
    rows.push({ row_number: row.row_number as number, cells: row.cells as string[] });
  }
  return rows;
}

export async function readGoogleSheet(env: Env, input: {
  request_id: string; operation_id: string; season_id: string; entity_type: SheetScope;
  binding_version: number; runtime_spreadsheet_id: string;
}): Promise<SheetPage> {
  const bridge = await callGoogleBridge(env, {
    action: "cloudflareReadSheetRecords", request_id: input.request_id,
    operation_id: input.operation_id, season_id: input.season_id,
    binding_version: input.binding_version,
    payload: { season_id: input.season_id, entity_type: input.entity_type }
  });
  const page = bridge.data;
  if (page.protocol_version !== BRIDGE_PROTOCOL || page.team_id !== env.TEAM_ID ||
      page.season_id !== input.season_id || page.entity_type !== input.entity_type ||
      page.binding_version !== input.binding_version || page.writer_epoch !== Number(env.WRITER_EPOCH) ||
      page.operation_id !== input.operation_id || page.payload_digest !== bridge.payload_digest ||
      typeof page.spreadsheet_id !== "string" || !/^[A-Za-z0-9_-]{10,256}$/u.test(page.spreadsheet_id) ||
      input.entity_type !== "SEASON" && page.spreadsheet_id !== input.runtime_spreadsheet_id ||
      page.tab_name !== SHEET_SCOPES[input.entity_type].tab ||
      typeof page.tab_id !== "string" || !/^(?:0|[1-9]\d{0,15})$/u.test(page.tab_id) ||
      !Number.isSafeInteger(page.read_at_ms) || Number(page.read_at_ms) < 0 ||
      !Array.isArray(page.headers) || page.headers.length > 50 ||
      !page.headers.every((cell: unknown) => typeof cell === "string" && cell.length <= 200) ||
      !Array.isArray(page.rows) || page.rows.length > 5000) invalid();
  const headers = page.headers as string[];
  const budget = { cells: 0, characters: 0 };
  consumeCells(headers, budget);
  const rows = parseRows(headers, page.rows, 5000, budget);
  let secondary: SheetPage["secondary"];
  if (input.entity_type === "SEAT_PLAN_DRAFT") {
    const extra = page.secondary;
    if (!isRecord(extra) || extra.tab_name !== "SeatPlanCurrent" ||
        typeof extra.tab_id !== "string" || !/^(?:0|[1-9]\d{0,15})$/u.test(extra.tab_id) ||
        !Array.isArray(extra.headers) || extra.headers.length > 50 ||
        !extra.headers.every((cell: unknown) => typeof cell === "string" && cell.length <= 200)) invalid();
    consumeCells(extra.headers as string[], budget);
    secondary = { tab_name: extra.tab_name as string, tab_id: extra.tab_id as string,
      headers: extra.headers as string[], rows: parseRows(extra.headers as string[], extra.rows, 5000, budget) };
  } else if (page.secondary != null) invalid();
  return { entity_type: input.entity_type, spreadsheet_id: page.spreadsheet_id as string,
    tab_name: page.tab_name as string, tab_id: page.tab_id as string,
    read_at_ms: page.read_at_ms as number, headers, rows, secondary };
}
