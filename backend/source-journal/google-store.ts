import { sourceBytes } from "../../shared/c2-source-capture-contract";
import { JOURNAL_LIMITS, journalAssert, type JournalContext, type JournalStore } from "./service";
import { PrivateGoogleClient, googleObject as object, googleArray as array, type GoogleObject as JsonObject } from "./google-client";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
const DRIVE = "https://www.googleapis.com/drive/v3/";
const MIME = "application/vnd.google-apps.spreadsheet";
const TITLE = (context: JournalContext) => `c2_source_${context.sheet_id}`;
const fields = (url: string, mask: string) => `${url}${url.includes("?") ? "&" : "?"}fields=${encodeURIComponent(mask)}`;

/** Server-side OAuth transport. No credentials are stored or returned by this adapter.
 * Google API enablement/scopes and durable command pins are deployment prerequisites. */
export class GoogleSourceJournalStore implements JournalStore {
  private readonly client: PrivateGoogleClient;
  constructor(token: () => Promise<string>, fetchPort?: (url: string, init: RequestInit) => Promise<Response>) {
    this.client = new PrivateGoogleClient(token, fetchPort);
  }
  private request(url: string, method: "GET" | "POST", body?: unknown, limit = 64_000): Promise<JsonObject> {
    return this.client.request(url, method, body, limit);
  }

  async assertPrivate(context: JournalContext): Promise<void> {
    const identity = await this.request(fields(DRIVE + "about", "user(permissionId)"), "GET");
    journalAssert(object(identity.user).permissionId === context.owner_permission_id, "JOURNAL_PRIVACY_UNPROVEN");
    const visited = new Set<string>();
    let id: string | undefined = context.spreadsheet_id;
    for (let depth = 0; id !== undefined; depth++) {
      journalAssert(depth < 8 && !visited.has(id), "JOURNAL_PRIVACY_UNPROVEN"); visited.add(id);
      const metadata = await this.request(fields(DRIVE + `files/${encodeURIComponent(id)}`,
        "id,mimeType,trashed,driveId,owners(permissionId),parents"), "GET");
      journalAssert(metadata.id === id && metadata.trashed === false && !metadata.driveId &&
        metadata.mimeType === (depth === 0 ? MIME : "application/vnd.google-apps.folder"), "JOURNAL_PRIVACY_UNPROVEN");
      const owners = array(metadata.owners);
      journalAssert(owners.length === 1 && object(owners[0]).permissionId === context.owner_permission_id,
        "JOURNAL_PRIVACY_UNPROVEN");
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      let permissions = 0;
      for (let page = 0; ; page++) {
        journalAssert(page < 8, "JOURNAL_PRIVACY_UNPROVEN");
        const url = DRIVE + `files/${encodeURIComponent(id)}/permissions?pageSize=100&includePermissionsForView=published` +
          (pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`);
        const result = await this.request(fields(url, "permissions(id,type,role,deleted,view),nextPageToken"), "GET");
        for (const entry of array(result.permissions)) {
          const permission = object(entry);
          journalAssert(permission.id === context.owner_permission_id && permission.type === "user" &&
            permission.role === "owner" && permission.deleted !== true && !permission.view, "JOURNAL_PRIVACY_UNPROVEN");
          permissions++;
          journalAssert(permissions === 1, "JOURNAL_PRIVACY_UNPROVEN");
        }
        if (result.nextPageToken === undefined || result.nextPageToken === "") break;
        journalAssert(typeof result.nextPageToken === "string" && result.nextPageToken.length <= 2048 &&
          !seenTokens.has(result.nextPageToken), "JOURNAL_PRIVACY_UNPROVEN");
        pageToken = result.nextPageToken; seenTokens.add(pageToken);
      }
      journalAssert(permissions === 1, "JOURNAL_PRIVACY_UNPROVEN");
      const parents = metadata.parents === undefined ? [] : array(metadata.parents);
      journalAssert(parents.length <= 1 && parents.every(parent => typeof parent === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/u.test(parent)), "JOURNAL_PRIVACY_UNPROVEN");
      id = parents[0] as string | undefined;
    }
  }

  async read(context: JournalContext): Promise<string[] | null> {
    const url = SHEETS + encodeURIComponent(context.spreadsheet_id);
    const metadata = await this.request(fields(url,
      "spreadsheetId,sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)))"), "GET");
    journalAssert(metadata.spreadsheetId === context.spreadsheet_id, "JOURNAL_GOOGLE_SHAPE_INVALID");
    const sheets = array(metadata.sheets);
    journalAssert(sheets.length <= 1024, "JOURNAL_BUDGET_EXCEEDED");
    const candidates = sheets.filter(sheet => object(object(sheet).properties).sheetId === context.sheet_id);
    journalAssert(candidates.length <= 1, "JOURNAL_GOOGLE_SHAPE_INVALID");
    if (candidates.length === 0) return null;
    const properties = object(object(candidates[0]).properties);
    const grid = object(properties.gridProperties);
    journalAssert(properties.title === TITLE(context) && properties.sheetType === "GRID" && grid.columnCount === 1 &&
      typeof grid.rowCount === "number" && Number.isSafeInteger(grid.rowCount) && grid.rowCount >= 2 &&
      grid.rowCount <= JOURNAL_LIMITS.parts + 1, "JOURNAL_LAYOUT_INVALID");
    // Numeric sheetId avoids title/A1 injection. Include only literal entered values.
    const result = await this.request(fields(url + ":getByDataFilter",
      "spreadsheetId,sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue))))"),
    "POST", { dataFilters: [{ gridRange: { sheetId: context.sheet_id, startRowIndex: 0, endRowIndex: grid.rowCount,
      startColumnIndex: 0, endColumnIndex: 1 } }], includeGridData: true }, 14_000_000);
    journalAssert(result.spreadsheetId === context.spreadsheet_id, "JOURNAL_GOOGLE_SHAPE_INVALID");
    const selected = array(result.sheets);
    journalAssert(selected.length === 1, "JOURNAL_LAYOUT_INVALID");
    const sheet = object(selected[0]), reread = object(sheet.properties), rereadGrid = object(reread.gridProperties);
    journalAssert(reread.sheetId === context.sheet_id && reread.title === TITLE(context) && reread.sheetType === "GRID" &&
      rereadGrid.rowCount === grid.rowCount && rereadGrid.columnCount === 1, "JOURNAL_READ_DRIFT");
    const data = array(sheet.data);
    journalAssert(data.length === 1, "JOURNAL_LAYOUT_INVALID");
    const block = object(data[0]);
    journalAssert((block.startRow ?? 0) === 0 && (block.startColumn ?? 0) === 0, "JOURNAL_LAYOUT_INVALID");
    const rows = array(block.rowData);
    journalAssert(rows.length === grid.rowCount, "JOURNAL_LAYOUT_INVALID");
    return rows.map((row, index) => {
      const values = array(object(row).values);
      journalAssert(values.length === 1, "JOURNAL_LAYOUT_INVALID");
      const entered = object(object(values[0]).userEnteredValue);
      journalAssert(Object.keys(entered).length === 1 && typeof entered.stringValue === "string" &&
        entered.stringValue.length > 0 && sourceBytes(entered.stringValue) <=
          (index === 0 ? JOURNAL_LIMITS.control_bytes : JOURNAL_LIMITS.part_bytes), "JOURNAL_LAYOUT_INVALID");
      return entered.stringValue;
    });
  }

  async create(context: JournalContext, rows: readonly string[]): Promise<void> {
    journalAssert(rows.length >= 2 && rows.length <= JOURNAL_LIMITS.parts + 1 && rows.every((text, index) =>
      typeof text === "string" && text.length > 0 && sourceBytes(text) <=
        (index === 0 ? JOURNAL_LIMITS.control_bytes : JOURNAL_LIMITS.part_bytes)), "JOURNAL_BUDGET_EXCEEDED");
    await this.request(SHEETS + encodeURIComponent(context.spreadsheet_id) + ":batchUpdate", "POST", {
      requests: [
        { addSheet: { properties: { sheetId: context.sheet_id, title: TITLE(context), sheetType: "GRID",
          gridProperties: { rowCount: rows.length, columnCount: 1 } } } },
        { updateCells: { start: { sheetId: context.sheet_id, rowIndex: 0, columnIndex: 0 },
          rows: rows.map(text => ({ values: [{ userEnteredValue: { stringValue: text } }] })), fields: "userEnteredValue" } },
      ], includeSpreadsheetInResponse: false,
    });
  }
}
