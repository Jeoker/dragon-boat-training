import { SOURCE_LIMITS, SourceModelError, parseSourceJson, sourceArray, sourceBytes, sourceCanonical, sourceInstant,
  sourceObject, sourcePinnedContext, sourceText, type SourceJson, type SourceObject, type SourcePinnedContext }
  from "../../shared/c2-source-capture-contract";
import { buildLocalSourcePlan } from "../../shared/c2-source-capture-projection";
import { PrivateGoogleClient, googleObject as object, googleArray as array } from "./google-client";
import { SourceJournalError, sanitizeJournalError, journalAssert } from "./service";

export interface SourceReadContext {
  source: SourcePinnedContext;
  known_sources: SourceObject[];
  declared_mappings: SourceObject[];
  api_user_permission_id: string;
  response_tab_title: string;
}
/** Raw checkpoints require private durable storage. Request callbacks are only
 * invoked after their immutable request marker has been saved. */
export interface SourceReadCheckpointPort {
  open(context: SourceReadContext, start: string): Promise<{
    observed_start_at: string;
    observed_end_at: string | null;
    request(url: string, body: unknown | undefined, read: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>>;
    finish(end: string): Promise<string>;
  }>;
}
const canonical = (value: unknown) => sourceCanonical(value as SourceJson);
const READ_LIMITS = Object.freeze({ pages: 128, range_rows: 100, duration_ms: 15 * 60 * 1000 });
const MODEL_DIAGNOSTICS = new Set(["STRING_REQUIRED", "STRING_BOUNDS", "INVALID_TIMESTAMP", "OBSERVED_INTERVAL_INVALID",
  "RECORD_BYTES_EXCEEDED", "RECORD_COUNT_EXCEEDED", "TOTAL_BYTES_EXCEEDED", "UNSUPPORTED_LATE_RESPONSE"]);

export function readSourceContext(value: unknown): SourceReadContext {
  try {
    // Canonical serialization rejects accessors, cycles and non-JSON authority declarations.
    const input = sourceObject(parseSourceJson(canonical(value)));
    journalAssert(Object.keys(input).length === 5 && Object.keys(input).every(key =>
      ["source", "known_sources", "declared_mappings", "api_user_permission_id", "response_tab_title"].includes(key)),
      "SOURCE_READ_CONTEXT_INVALID");
    const source = sourcePinnedContext(input.source);
    journalAssert(/^[A-Za-z0-9_-]{1,512}$/u.test(source.form_id) &&
      /^[A-Za-z0-9_-]{1,512}$/u.test(source.spreadsheet_id), "SOURCE_READ_CONTEXT_INVALID");
    return { source, known_sources: sourceArray(input.known_sources).map(sourceObject),
      declared_mappings: sourceArray(input.declared_mappings).map(sourceObject),
      api_user_permission_id: sourceText(input.api_user_permission_id, 1, 128),
      response_tab_title: sourceText(input.response_tab_title, 1, 512) };
  } catch { throw new SourceJournalError("SOURCE_READ_CONTEXT_INVALID"); }
}

/** Complete bounded REST reads. Output remains a local, unverified plan.
 * Optional checkpoints retain the original attempt; binding lookup, source
 * authentication and source receipts remain the caller's responsibility. */
export class GoogleSourceReader {
  constructor(private readonly contextPort: () => unknown, private readonly token: () => Promise<string>,
    private readonly fetchPort: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly checkpoint?: SourceReadCheckpointPort) {}

  private context(): SourceReadContext {
    try { return readSourceContext(this.contextPort()); }
    catch { throw new SourceJournalError("SOURCE_READ_CONTEXT_INVALID"); }
  }

  async read() {
    try { return await this.readPrivate(); }
    catch (error) {
      let modelDiagnostic: string | undefined;
      try {
        if (error instanceof SourceModelError) {
          // Dependency ports can throw a model error too. Never evaluate an error
          // code getter or echo arbitrary exception text as a diagnostic.
          const code = Object.getOwnPropertyDescriptor(error, "code");
          if (code && Object.hasOwn(code, "value") && typeof code.value === "string" && MODEL_DIAGNOSTICS.has(code.value))
            modelDiagnostic = `SOURCE_READ_${code.value}`;
        }
      } catch { /* Invalid diagnostic reflection uses the fixed fallback. */ }
      throw sanitizeJournalError(modelDiagnostic ? new SourceJournalError(modelDiagnostic) : error, "SOURCE_READ_INPUT_UNSUPPORTED");
    }
  }
  private async readPrivate() {
    const context = this.context(), initial = canonical(context);
    const requestedStart = sourceText(this.now(), 1, 64);
    const checkpoint = await this.checkpoint?.open(context, requestedStart);
    const start = checkpoint?.observed_start_at ?? requestedStart, startInstant = sourceInstant(start);
    const fresh = () => {
      journalAssert(canonical(this.context()) === initial, "SOURCE_READ_OWNERSHIP_CHANGED");
      const instant = sourceInstant(checkpoint?.observed_end_at ?? sourceText(this.now(), 1, 64));
      journalAssert(instant >= startInstant && instant - startInstant <= BigInt(READ_LIMITS.duration_ms) * 1_000_000n,
        "SOURCE_READ_TIME_BUDGET_EXCEEDED");
    };
    // A single OAuth token fixes the API user for both passes and revision comparisons.
    let token: string;
    try { token = await this.token(); } catch { throw new SourceJournalError("JOURNAL_OAUTH_UNAVAILABLE"); }
    fresh();
    const client = new PrivateGoogleClient(async () => token, this.fetchPort);
    const get = async (url: string, body?: unknown) => {
      fresh();
      const read = () => client.request(url, body === undefined ? "GET" : "POST", body, SOURCE_LIMITS.input_bytes, true);
      const result = checkpoint ? await checkpoint.request(url, body, read) : await read();
      fresh(); return result;
    };
    const identity = async () => {
      const result = await get("https://www.googleapis.com/drive/v3/about?fields=user(permissionId)");
      journalAssert(object(result.user).permissionId === context.api_user_permission_id, "SOURCE_READ_API_USER_CHANGED");
    };
    // A cached identity is historical evidence. Recheck the new token's API
    // principal live before replaying any private checkpoint after restart.
    if (checkpoint) {
      const currentUser = await client.request("https://www.googleapis.com/drive/v3/about?fields=user(permissionId)", "GET",
        undefined, SOURCE_LIMITS.input_bytes, true);
      fresh();
      journalAssert(object(currentUser.user).permissionId === context.api_user_permission_id, "SOURCE_READ_API_USER_CHANGED");
    }
    const pass = async () => {
      await identity();
      const formUrl = `https://forms.googleapis.com/v1/forms/${encodeURIComponent(context.source.form_id)}`;
      const form = await get(formUrl);
      journalAssert(form.formId === context.source.form_id && form.linkedSheetId === context.source.spreadsheet_id &&
        typeof form.revisionId === "string" && form.revisionId.length > 0, "SOURCE_READ_BINDING_UNPROVEN");
      const responses: SourceObject[] = [], ids = new Set<string>(), tokens = new Set<string>();
      let pageToken: string | undefined, bytes = sourceBytes(canonical(form));
      for (let page = 0; ; page++) {
        journalAssert(page < READ_LIMITS.pages, "SOURCE_READ_PAGE_BUDGET_EXCEEDED");
        const result = await get(formUrl + "/responses?pageSize=100" +
          (pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`));
        journalAssert(Object.keys(result).every(key => ["responses", "nextPageToken"].includes(key)), "SOURCE_READ_PAGE_SHAPE_INVALID");
        for (const value of result.responses === undefined ? [] : array(result.responses)) {
          const response = sourceObject(value as SourceJson), id = sourceText(response.responseId, 1, 512);
          journalAssert(!ids.has(id), "SOURCE_READ_DUPLICATE_RESPONSE"); ids.add(id);
          bytes += sourceBytes(canonical(response));
          journalAssert(bytes <= SOURCE_LIMITS.input_bytes && responses.length < SOURCE_LIMITS.records,
            "SOURCE_READ_BUDGET_EXCEEDED");
          responses.push(response);
        }
        if (result.nextPageToken === undefined || result.nextPageToken === "") break;
        journalAssert(typeof result.nextPageToken === "string" && result.nextPageToken.length <= 2048 &&
          !tokens.has(result.nextPageToken), "SOURCE_READ_PAGE_TOKEN_INVALID");
        pageToken = result.nextPageToken; tokens.add(pageToken);
      }
      // Response order/page boundaries are not source identities.
      responses.sort((a, b) => String(a.responseId) < String(b.responseId) ? -1 : String(a.responseId) > String(b.responseId) ? 1 : 0);
      const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(context.source.spreadsheet_id)}`;
      const metadataUrl = sheetUrl + "?fields=" + encodeURIComponent("spreadsheetId,properties(locale,timeZone),sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)))");
      const metadata = await get(metadataUrl);
      journalAssert(metadata.spreadsheetId === context.source.spreadsheet_id, "SOURCE_READ_BINDING_UNPROVEN");
      const matched = array(metadata.sheets).filter(sheet => object(object(sheet).properties).sheetId === context.source.sheet_id);
      journalAssert(matched.length === 1, "SOURCE_READ_BINDING_UNPROVEN");
      const properties = object(object(matched[0]).properties), grid = object(properties.gridProperties);
      const sheetIdentity = (value: unknown) => {
        const row = object(value), dimensions = object(row.gridProperties);
        return { sheetId: row.sheetId, title: row.title, sheetType: row.sheetType,
          gridProperties: { rowCount: dimensions.rowCount, columnCount: dimensions.columnCount } };
      };
      const localeIdentity = (value: unknown) => {
        const row = object(value); return { locale: row.locale, timeZone: row.timeZone };
      };
      const rows = grid.rowCount, columns = grid.columnCount;
      journalAssert(properties.sheetType === "GRID" && properties.title === context.response_tab_title &&
        typeof rows === "number" && Number.isSafeInteger(rows) && rows >= 1 && rows <= SOURCE_LIMITS.records &&
        typeof columns === "number" && Number.isSafeInteger(columns) && columns >= 1 && rows * columns <= SOURCE_LIMITS.cells,
        "SOURCE_READ_GRID_BUDGET_EXCEEDED");
      const cells: SourceObject[][] = [];
      for (let offset = 0; offset < rows; offset += READ_LIMITS.range_rows) {
        const end = Math.min(rows, offset + READ_LIMITS.range_rows);
        // No CellData field mask: preserve every returned field, including unsupported constructs.
        const result = await get(sheetUrl + ":getByDataFilter", { dataFilters: [{ gridRange: {
          sheetId: context.source.sheet_id, startRowIndex: offset, endRowIndex: end,
          startColumnIndex: 0, endColumnIndex: columns } }], includeGridData: true });
        journalAssert(result.spreadsheetId === metadata.spreadsheetId && canonical(localeIdentity(result.properties)) === canonical(localeIdentity(metadata.properties)),
          "SOURCE_READ_DRIFT");
        const sheets = array(result.sheets);
        journalAssert(sheets.length === 1 && canonical(sheetIdentity(object(sheets[0]).properties)) === canonical(sheetIdentity(properties)), "SOURCE_READ_DRIFT");
        const data = array(object(sheets[0]).data);
        journalAssert(data.length === 1, "SOURCE_READ_GRID_INCOMPLETE");
        const block = object(data[0]), rawRows = block.rowData === undefined ? [] : array(block.rowData);
        journalAssert((block.startRow ?? 0) === offset && (block.startColumn ?? 0) === 0 && rawRows.length <= end - offset,
          "SOURCE_READ_GRID_INCOMPLETE");
        // Sheets omits trailing empty rowData/values; retain their fixed coordinates as {}.
        for (let i = 0; i < end - offset; i++) {
          const values = rawRows[i] === undefined || object(rawRows[i]).values === undefined ? [] : array(object(rawRows[i]).values);
          journalAssert(values.length <= columns, "SOURCE_READ_GRID_INCOMPLETE");
          const row = Array.from({ length: columns }, (_, col) => sourceObject((values[col] ?? {}) as SourceJson));
          bytes += sourceBytes(canonical(row));
          journalAssert(bytes <= SOURCE_LIMITS.input_bytes, "SOURCE_READ_BUDGET_EXCEEDED"); cells.push(row);
        }
      }
      const after = await get(formUrl);
      journalAssert(canonical(after) === canonical(form), "SOURCE_READ_DRIFT");
      await identity();
      const spreadsheetProperties = object(metadata.properties);
      return { form_schema: form, form_responses: responses,
        sheet_schema: { spreadsheetId: context.source.spreadsheet_id, sheetId: context.source.sheet_id,
          title: properties.title, locale: spreadsheetProperties.locale, timeZone: spreadsheetProperties.timeZone,
          rowCount: rows, columnCount: columns, headerRowIndex: 0, headers: cells[0] },
        sheet_rows: cells.slice(1).map((cells, index) => ({ row_index: index + 1, cells })) };
    };
    const first = await pass(), second = await pass();
    journalAssert(canonical(first) === canonical(second), "SOURCE_READ_DRIFT");
    fresh();
    const end = checkpoint ? await checkpoint.finish(checkpoint.observed_end_at ?? sourceText(this.now(), 1, 64)) : sourceText(this.now(), 1, 64);
    fresh();
    const input = canonical({ format: "c2-source-input-v1", observed_start_at: start, observed_end_at: end,
      ...first, known_sources: context.known_sources, declared_mappings: context.declared_mappings });
    const plan = buildLocalSourcePlan(input, context.source); fresh();
    return { plan, observation: { format: "c2-source-observation-v1", state: "TWO_READS_MATCHED_NOT_ATOMIC",
      observed_start_at: start, observed_end_at: end, passes: 2, source_status: "SOURCE_NOT_VERIFIED",
      annual_export_authorized: false, response_tab_link_evidence: "SERVER_BINDING_DECLARATION_ONLY" } };
  }
}
