import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

const modules = new Map();
function moduleUrl(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  let code = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  code = code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu, (_, start, path, end) =>
    start + moduleUrl(new URL(path.endsWith(".ts") ? path : `${path}.ts`, url)) + end);
  const result = `data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${url.href}`).toString("base64")}`;
  modules.set(url.href, result); return result;
}
export const { PrivateSourceJournal, SourceJournalError, JOURNAL_LIMITS, journalParts } =
  await import(moduleUrl(new URL("../backend/source-journal/service.ts", import.meta.url)));
export const { GoogleSourceJournalStore } =
  await import(moduleUrl(new URL("../backend/source-journal/google-store.ts", import.meta.url)));
export const { GoogleSourceReader } =
  await import(moduleUrl(new URL("../backend/source-journal/source-reader.ts", import.meta.url)));
export const { PrivateSourceOperation } =
  await import(moduleUrl(new URL("../backend/source-journal/operation.ts", import.meta.url)));
export const { PrivateSourceReadAttempt } =
  await import(moduleUrl(new URL("../backend/source-journal/read-attempt.ts", import.meta.url)));
export const { bindSourceAuthorityContext, createAuthorizedSourceOperation } =
  await import(moduleUrl(new URL("../backend/source-journal/authority-context.ts", import.meta.url)));
export const { SourceServerAuthorityClient } = await import(moduleUrl(new URL("../backend/source-journal/server-authority-client.ts", import.meta.url)));
export const { PrivateSourceTargetRegistry } = await import(moduleUrl(new URL("../backend/source-journal/target-registry.ts", import.meta.url)));
export const { createPrivateSourceRuntime } = await import(moduleUrl(new URL("../backend/source-journal/private-runtime.ts", import.meta.url)));
export const { PrivateSourceReview } = await import(moduleUrl(new URL("../backend/source-journal/private-review.ts", import.meta.url)));
export const { PrivateGoogleClient } =
  await import(moduleUrl(new URL("../backend/source-journal/google-client.ts", import.meta.url)));
export const { sourceCanonical, SourceModelError } = await import(moduleUrl(new URL("../shared/c2-source-capture-contract.ts", import.meta.url)));
export const { buildLocalSourcePlan } = await import(moduleUrl(new URL("../shared/c2-source-capture-projection.ts", import.meta.url)));
export const goldens = JSON.parse(readFileSync(new URL("fixtures/c2-source-plan-v1/goldens.json", import.meta.url), "utf8"));
export const sha = async text => createHash("sha256").update(text).digest("base64url");
export function contextFor(fixture = goldens.cases[0], overrides = {}) {
  return { plan: { source: fixture.pinned, source_format: "c2-source-plan-v1",
    source_plan_digest: createHash("sha256").update("c2-source-review-source-v1\n" + fixture.core_text).digest("base64url") },
  attempt_id: "fictional_attempt_01", actor_id: "fictional_coach_01", spreadsheet_id: "fictional_private_journal",
  sheet_id: 24681357, owner_permission_id: "fictional_owner", ...overrides };
}
export function model() {
  const state = { rows: null, writes: 0, reads: 0, privacyChecks: 0, failCreate: false,
    lostReply: false, privacy: true, failRead: false, onRead: null, onCreate: null };
  const store = {
    async assertPrivate() { state.privacyChecks++; if (!state.privacy) throw new Error("PRIVATE_ERROR_SENTINEL"); },
    async read() {
      state.reads++;
      if (state.failRead) throw new Error("PRIVATE_ERROR_SENTINEL");
      state.onRead?.(state); return state.rows && [...state.rows];
    },
    async create(_context, rows) {
      state.writes++; state.onCreate?.(state);
      if (state.failCreate || state.rows) throw new Error("PRIVATE_ERROR_SENTINEL");
      state.rows = [...rows];
      if (state.lostReply) throw new Error("PRIVATE_ERROR_SENTINEL");
    },
  };
  return { state, store };
}
// A deterministic REST server model: atomic AddSheet+UpdateCells, fixed IDs,
// Drive ACL pagination and grid readback. It is not a real Google acceptance.
export function googleModel() {
  const state = { sheets: new Map(), calls: [], owner: "fictional_owner", lostReply: false, parentShared: false,
    shared: false, published: false, permissionPages: false, folder: false, formula: false, failGet: false,
    metadataOverride: {}, afterWrite: null };
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const property = (id, rows) => ({ sheetId: id, title: `c2_source_${id}`, sheetType: "GRID",
    gridProperties: { rowCount: rows.length, columnCount: 1 }, ...state.metadataOverride });
  const fetch = async (url, init) => {
    const parsed = new URL(url), body = init.body && JSON.parse(init.body);
    state.calls.push({ url: parsed, init, body });
    if (parsed.pathname.endsWith("/about")) return response({ user: { permissionId: state.owner } });
    if (parsed.pathname.endsWith("/permissions")) {
      const parent = parsed.pathname.includes("fictional_folder"), page = parsed.searchParams.get("pageToken");
      const permissions = [{ id: "fictional_owner", type: "user", role: "owner" }];
      if ((parent && state.parentShared) || (!parent && state.shared)) permissions.push({ id: "other", type: "user", role: "reader" });
      if (state.published) permissions.push({ id: "public", type: "anyone", role: "reader", view: "published" });
      if (state.permissionPages && !page) return response({ permissions, nextPageToken: "page_2" });
      if (page) return response({ permissions: [{ id: "group", type: "group", role: "reader" }] });
      return response({ permissions });
    }
    if (parsed.hostname === "www.googleapis.com") {
      const parent = parsed.pathname.includes("fictional_folder");
      return response({ id: parent ? "fictional_folder" : "fictional_private_journal", trashed: false,
        mimeType: parent ? "application/vnd.google-apps.folder" : "application/vnd.google-apps.spreadsheet",
        owners: [{ permissionId: "fictional_owner" }], ...(state.folder && !parent ? { parents: ["fictional_folder"] } : {}) });
    }
    if (parsed.pathname.endsWith(":batchUpdate")) {
      const id = body.requests[0].addSheet.properties.sheetId;
      if (state.sheets.has(id)) return response({ error: { message: "PRIVATE_ERROR_SENTINEL" } }, 400);
      // Apply the entire batch in one synchronous state transition.
      state.sheets.set(id, body.requests[1].updateCells.rows.map(row => row.values[0].userEnteredValue.stringValue));
      state.afterWrite?.(state);
      if (state.lostReply) throw new Error("PRIVATE_ERROR_SENTINEL");
      return response({ spreadsheetId: "fictional_private_journal", replies: [{}, {}] });
    }
    if (state.failGet) return response({ error: { message: "PRIVATE_ERROR_SENTINEL" } }, 404);
    if (parsed.pathname.endsWith(":getByDataFilter")) {
      const id = body.dataFilters[0].gridRange.sheetId, rows = state.sheets.get(id);
      return response({ spreadsheetId: "fictional_private_journal", sheets: [{ properties: property(id, rows),
        data: [{ rowData: rows.map(text => ({ values: [{ userEnteredValue: state.formula ? { formulaValue: text } : { stringValue: text } }] })) }] }] });
    }
    return response({ spreadsheetId: "fictional_private_journal", sheets: [...state.sheets].map(([id, rows]) => ({ properties: property(id, rows) })) });
  };
  return { state, fetch };
}
