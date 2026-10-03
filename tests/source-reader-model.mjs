import { GoogleSourceReader, goldens } from "./source-journal-test-runtime.mjs";

export function sourceModel() {
  const fixture = goldens.cases[0], input = JSON.parse(fixture.input_text);
  input.form_schema.revisionId = "fictional_revision";
  const context = { source: fixture.pinned, known_sources: input.known_sources,
    declared_mappings: input.declared_mappings, api_user_permission_id: "fictional_owner", response_tab_title: "Responses" };
  const state = { formReads: 0, listReads: 0, tokenReads: 0, calls: [], failPage: false,
    duplicate: false, tokenCycle: false, lateDrift: false, schemaDrift: false, cellDrift: false,
    shuffled: false, extraBlankRows: false, oversized: false, onCall: null };
  const now = () => "2026-10-01T04:02:00Z";
  const response = value => new Response(JSON.stringify(value));
  const fetch = async (url, init) => {
    const parsed = new URL(url), body = init.body && JSON.parse(init.body);
    state.calls.push({ url: parsed, body, init }); state.onCall?.(state, parsed);
    if (parsed.pathname.endsWith("/about")) return response({ user: { permissionId: "fictional_owner" } });
    if (parsed.hostname === "forms.googleapis.com") {
      if (!parsed.pathname.endsWith("/responses")) {
        state.formReads++;
        return response({ ...input.form_schema, ...(state.schemaDrift && state.formReads >= 3 ? { revisionId: "changed" } : {}) });
      }
      state.listReads++;
      if (state.failPage) return new Response("PRIVATE_SOURCE_SENTINEL", { status: 403 });
      const page = parsed.searchParams.get("pageToken"), responses = structuredClone(input.form_responses);
      if (state.lateDrift && state.formReads >= 3) responses[1].answers.q.textAnswers.answers[0].value = "Changed late answer";
      if (state.shuffled && state.formReads >= 3) responses.reverse();
      if (state.duplicate && page) responses[1].responseId = responses[0].responseId;
      if (state.oversized) responses[0].answers.q.textAnswers.answers[0].value = "x".repeat(2_000_001);
      return response({ responses: page ? responses.slice(1) : responses.slice(0, 1),
        ...(!page || state.tokenCycle ? { nextPageToken: "fictional_page_2" } : {}) });
    }
    const sourceProperties = { locale: input.sheet_schema.locale, timeZone: input.sheet_schema.timeZone, title: "Ignored display title" };
    const properties = { sheetId: fixture.pinned.sheet_id, title: "Responses", sheetType: "GRID", index: 0,
      gridProperties: { rowCount: state.extraBlankRows ? 6 : 4, columnCount: 2, frozenRowCount: 1 } };
    if (parsed.pathname.endsWith(":getByDataFilter")) {
      const rows = [input.sheet_schema.headers, ...input.sheet_rows.map(row => row.cells)];
      if (state.cellDrift && state.formReads >= 3) rows[1] = [{ userEnteredValue: { boolValue: true } }, {}];
      return response({ spreadsheetId: fixture.pinned.spreadsheet_id, properties: sourceProperties,
        sheets: [{ properties, data: [{ rowData: rows.map(cells => ({ values: cells })) }] }] });
    }
    return response({ spreadsheetId: fixture.pinned.spreadsheet_id, properties: sourceProperties, sheets: [{ properties }] });
  };
  const token = async () => { state.tokenReads++; return "FICTIONAL_SOURCE_TOKEN"; };
  const reader = () => new GoogleSourceReader(() => context, token, fetch, now);
  return { state, context, input, reader, fetch, token, now };
}
