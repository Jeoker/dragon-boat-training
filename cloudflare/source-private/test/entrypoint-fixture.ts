import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { hmacSha256Base64Url, legacyCredentialDigest } from "../../src/crypto";
import { bridgeSignatureInput } from "../../src/bridge";
import type { SourceAuthorityPin } from "../../../shared/c2-source-authority-contract";

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/forms.responses.readonly", "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.metadata.readonly"].join(" ");
export const fixtureEnv = env as unknown as {
  TEST_BUSINESS_API: Fetcher;
  PRIVATE_RUNTIME_TEST: { run(command: unknown): Promise<{ ok: true; data: any } | { ok: false; code: string }> };
};

export async function seedBusiness(name: string) {
  const season = `private_season_${name}`, coach = `private_coach_${name}`, at = "2020-09-01T12:00:00.000Z";
  const call = async (path: string, data: unknown, key = "local-c2-test-key") => {
    const response = await fixtureEnv.TEST_BUSINESS_API.fetch(`https://business.test${path}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(data) });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.data;
  };
  await call("/internal/c1/import-core", { request_id: `core_private_${name}`, source_snapshot_id: `snapshot_private_${name}`,
    settings_version: 1, default_season_id: null,
    coaches: [{ coach_id: coach, display_name: "Fictional Coach", code_salt: "local_salt",
      code_digest: await legacyCredentialDigest("local_salt", `local-code-${name}`, "local-c1-coach-secret"),
      credential_version: 1, active: true, created_at: at, updated_at: at }],
    seasons: [{ season_id: season, name: "Fictional Season", start_date: "2020-09-01", end_date: "2020-09-20",
      timezone: "America/New_York", season_ends_at: "2020-09-21T04:00:00.000Z", status: "COMPLETED", binding_version: 1,
      season_version: 1, roster_version: 1, created_by: coach, created_at: at, updated_at: at }], members: [] }, "local-c1-test-key");
  await call("/internal/c2/import-sync-foundation", { request_id: `binding_private_${name}`, source_snapshot_id: `bindings_private_${name}`,
    bindings: [{ season_id: season, binding_version: 1, form_id: `private_form_${name}`, runtime_spreadsheet_id: `private_sheet_${name}`,
      response_sheet_id: "31", response_sheet_name: "Responses", field_mapping: { display_name_header: "Name" },
      schema_fingerprint: "sha256_v1:fictional_schema", export_paused: true, last_pull_at: null, last_push_at: null,
      created_at: at, updated_at: at }], baselines: [], source_imports: [] });
  const login = await call("/internal/c1/coach-login", { request_id: `login_private_${name}`, coach_code: `local-code-${name}` }, "local-c1-test-key");
  const command = { request_id: `source_private_${name}`, season_id: season, session_token: login.result.session_token as string };
  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    const result = await fixtureEnv.PRIVATE_RUNTIME_TEST.run({ ...command, action, ...extra });
    try { return structuredClone(result); }
    finally { (result as typeof result & { [Symbol.dispose]?: () => void })[Symbol.dispose]?.(); }
  };
  const logout = () => call("/internal/c1/coach-logout", { request_id: `logout_private_${name}`, session_token: command.session_token }, "local-c1-test-key");
  const rebind = async () => {
    await call("/internal/c1/import-core", { request_id: `recore_private_${name}`, source_snapshot_id: `resnapshot_private_${name}`,
      settings_version: 1, default_season_id: null, coaches: [], members: [],
      seasons: [{ season_id: season, name: "Fictional Season", start_date: "2020-09-01", end_date: "2020-09-20",
        timezone: "America/New_York", season_ends_at: "2020-09-21T04:00:00.000Z", status: "COMPLETED", binding_version: 2,
        season_version: 2, roster_version: 1, created_by: coach, created_at: at, updated_at: "2020-09-02T12:00:00.000Z" }] }, "local-c1-test-key");
    await call("/internal/c2/import-sync-foundation", { request_id: `rebind_private_${name}`, source_snapshot_id: `rebindings_private_${name}`,
      bindings: [{ season_id: season, binding_version: 2, form_id: `private_form_new_${name}`, runtime_spreadsheet_id: `private_sheet_new_${name}`,
        response_sheet_id: "32", response_sheet_name: "Responses", field_mapping: { display_name_header: "Name" },
        schema_fingerprint: "sha256_v1:fictional_schema", export_paused: true, last_pull_at: null, last_push_at: null,
        created_at: at, updated_at: "2020-09-02T12:00:00.000Z" }], baselines: [], source_imports: [] });
  };
  return { command, run, logout, rebind, call, coach, season };
}

// Transport-only Google model: actual Worker/DO code performs OAuth, two-pass
// checkpointing, journal write/readback and current business authority checks.
export function googleModel(pin: SourceAuthorityPin) {
  const state = { sourceReads: 0, journalWrites: 0, refreshes: 0, nativeCalls: 0, rows: null as string[] | null,
    loseWriteReply: false, failSource: false, responsePages: 1, journalParent: false, publicJournal: false,
    failNative: false, replayNative: false, nativeReply: null as null | Record<string, unknown>,
    nativeRedirect: false, nativeRedirectCalls: 0,
    nativeTransform: null as null | ((proof: Record<string, unknown>) => void),
    afterNative: null as null | (() => Promise<unknown>),
    sourceUrls: new Map<string, number>(),
    revokeOnSource: null as null | (() => Promise<unknown>) };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "script.googleusercontent.com") {
      state.nativeRedirectCalls++;
      expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
      return Response.json(state.nativeReply);
    }
    if (url.hostname === "script.google.com") {
      state.nativeCalls++;
      const request = JSON.parse(String(init?.body)), payload = JSON.parse(request.payload_json);
      const secret = "fixture-native-bridge-secret";
      expect(request.action).toBe("cloudflareReadNativeTabProof");
      expect(request.signature).toBe(await hmacSha256Base64Url(bridgeSignatureInput(request), secret));
      if (state.failNative) throw Error("PRIVATE_NATIVE_NETWORK_SENTINEL");
      if (state.replayNative && state.nativeReply) return Response.json(state.nativeReply);
      const proof: Record<string, unknown> = { format: "c2-native-tab-proof-v1", evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED",
        action: "READ_NATIVE_TAB_LINK", direction: "GOOGLE_TO_CLOUDFLARE_NATIVE_TAB", request_id: payload.request_id,
        nonce: payload.nonce, team_id: payload.team_id, backend_generation: payload.backend_generation, writer_epoch: payload.writer_epoch,
        season_id: payload.season_id, binding_version: payload.binding_version, source_operation_id: payload.source_operation_id,
        authority_digest: payload.authority_digest, form_id: payload.form_id, spreadsheet_id: payload.spreadsheet_id,
        sheet_id: payload.sheet_id, observed_at_ms: Date.now() };
      state.nativeTransform?.(proof);
      const proof_text = JSON.stringify(proof);
      state.nativeReply = { ok: true, meta: { request_id: request.request_id }, data: { proof_text,
        signature: await hmacSha256Base64Url(`c2-native-tab-proof-v1\n${proof_text}`, secret) } };
      await state.afterNative?.();
      if (state.nativeRedirect) return new Response(null, { status: 302,
        headers: { location: "https://script.googleusercontent.com/macros/echo?user_content_key=fictional" } });
      return Response.json(state.nativeReply);
    }
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      state.refreshes++;
      return Response.json({ access_token: "FICTIONAL_ACCESS_TOKEN", token_type: "Bearer", expires_in: 3600, scope: GOOGLE_SCOPES });
    }
    if (url.pathname.includes("tokeninfo")) return Response.json({ aud: "fictional-client.apps.googleusercontent.com", scope: GOOGLE_SCOPES, expires_in: "3600" });
    expect(init?.headers).toBeDefined();
    if (url.pathname.endsWith("/about")) return Response.json({ user: { permissionId: "fixture_owner" } });
    if (url.hostname === "forms.googleapis.com") {
      state.sourceReads++;
      const request = url.pathname + url.search;
      state.sourceUrls.set(request, (state.sourceUrls.get(request) ?? 0) + 1);
      if (state.revokeOnSource) await state.revokeOnSource();
      if (state.failSource) throw Error("PRIVATE_NETWORK_SENTINEL");
      const page = Number(url.searchParams.get("pageToken") ?? "0");
      return Response.json(url.pathname.endsWith("/responses") ? { responses: [{ responseId: page === 0 ? "fixture_response" : `fixture_response_${page}`,
        createTime: "2020-09-02T12:00:00Z", lastSubmittedTime: "2020-09-02T12:00:00Z", answers: {} }],
        ...(page + 1 < state.responsePages ? { nextPageToken: String(page + 1) } : {}) } :
        { formId: pin.source.form_id, linkedSheetId: pin.source.spreadsheet_id, revisionId: "fixture_revision", info: { title: "Fictional" }, items: [] });
    }
    if (url.hostname === "www.googleapis.com") {
      if (url.pathname.endsWith("/permissions")) return Response.json({ permissions: state.publicJournal ?
        [{ id: "anyone", type: "anyone", role: "reader" }] : [{ id: "fixture_owner", type: "user", role: "owner" }] });
      const folder = url.pathname.endsWith("/fixture_folder");
      return Response.json({ id: folder ? "fixture_folder" : "fixture_journal", trashed: false,
        mimeType: folder ? "application/vnd.google-apps.folder" : "application/vnd.google-apps.spreadsheet",
        owners: [{ permissionId: "fixture_owner" }], ...(!folder && state.journalParent ? { parents: ["fixture_folder"] } : {}) });
    }
    if (url.hostname !== "sheets.googleapis.com") throw Error("UNEXPECTED_EXTERNAL_REQUEST");
    const journal = url.pathname.includes("fixture_journal");
    if (journal && url.pathname.endsWith(":batchUpdate")) {
      if (state.rows) return Response.json({}, { status: 400 });
      const body = JSON.parse(String(init?.body));
      state.rows = body.requests[1].updateCells.rows.map((row: any) => row.values[0].userEnteredValue.stringValue);
      state.journalWrites++;
      if (state.loseWriteReply) throw Error("PRIVATE_LOST_REPLY_SENTINEL");
      return Response.json({ spreadsheetId: "fixture_journal", replies: [{}, {}] });
    }
    const properties = { sheetId: journal ? 13579 : pin.source.sheet_id, title: journal ? "c2_source_13579" : "Responses",
      sheetType: "GRID", gridProperties: { rowCount: journal ? state.rows?.length ?? 1 : 2, columnCount: 1 } };
    return Response.json({ spreadsheetId: journal ? "fixture_journal" : pin.source.spreadsheet_id,
      properties: { locale: "en_US", timeZone: "America/New_York" }, sheets: journal && !state.rows ? [] : [{ properties,
        ...(url.pathname.endsWith(":getByDataFilter") ? { data: [{ rowData: journal ?
          state.rows!.map(text => ({ values: [{ userEnteredValue: { stringValue: text } }] })) : [{ values: [{}] }, { values: [{}] }] }] } : {}) }] });
  });
  return { state, spy };
}

export function target(pin: SourceAuthorityPin) {
  return { source_operation_id: pin.source.source_operation_id, attempt_id: "fixture_attempt",
    api_user_permission_id: "fixture_owner", owner_permission_id: "fixture_owner", journal_spreadsheet_id: "fixture_journal", journal_sheet_id: 13579 };
}
