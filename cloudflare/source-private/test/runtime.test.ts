import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type PrivateSourceEnv } from "../src/index";
import { PrivateSourceRpcStore } from "../src/rpc-store";
import { sha256Base64Url } from "../../src/crypto";
import { sourceAuthorityText, type SourceAuthorityPinCore } from "../../../shared/c2-source-authority-contract";
import { PrivateSourceTargetRegistry } from "../../../backend/source-journal/target-registry";
import { createPrivateSourceRuntime } from "../../../backend/source-journal/private-runtime";
import { PrivateSourceReview } from "../../../backend/source-journal/private-review";

// Google and current authority are explicit models; storage and DO eviction are real.
async function fixture(name: string) {
  const stub = (env as unknown as PrivateSourceEnv).PRIVATE_SOURCE_STATE.getByName(name);
  const store = new PrivateSourceRpcStore(stub), at = "2026-10-03T20:00:00Z";
  const core: SourceAuthorityPinCore = { format: "c2-source-authority-pin-v1", state: "SERVER_AUTHORITY_PIN_ONLY",
    actor_id: "fixture_coach", source: { source_operation_id: "fixture_operation", team_id: "fixture_team",
      season_id: "fixture_season", binding_version: 1, backend_generation: "fixture_generation", writer_epoch: 0,
      form_id: "fixture_form", spreadsheet_id: "fixture_source_sheet", sheet_id: 31, season_ends_at: "2026-10-01T04:00:00Z" },
    known_sources: [], response_tab_title: "Responses", census_scope: "DATABASE_KNOWN_IDENTITIES_ONLY",
    pinned_at: at, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
  const pin = { ...core, authority_digest: await sha256Base64Url("c2-source-authority-pin-v1\n" + sourceAuthorityText(core)) };
  const target = { source_operation_id: core.source.source_operation_id, attempt_id: "fixture_attempt",
    api_user_permission_id: "fixture_owner", owner_permission_id: "fixture_owner",
    journal_spreadsheet_id: "fixture_journal", journal_sheet_id: 13579 };
  const registry = new PrivateSourceTargetRegistry(core.source.team_id, store, sha256Base64Url);
  await registry.register(pin, target);
  const state = { denied: false, failSource: false, lostWriteReply: false, sourceReads: 0, journalWrites: 0, rows: null as string[] | null };
  const fetchGoogle = async (url: string, init: RequestInit) => {
    const parsed = new URL(url), source = core.source;
    if (parsed.pathname.endsWith("/about")) return Response.json({ user: { permissionId: "fixture_owner" } });
    if (parsed.hostname === "forms.googleapis.com") {
      state.sourceReads++;
      if (state.failSource) throw Error("PRIVATE_DEPENDENCY_SENTINEL");
      return Response.json(parsed.pathname.endsWith("/responses") ? { responses: [{ responseId: "fixture_response",
        createTime: "2026-09-30T12:00:00Z", lastSubmittedTime: "2026-09-30T12:00:00Z", answers: {} }] } :
        { formId: source.form_id, linkedSheetId: source.spreadsheet_id, revisionId: "fixture_revision", info: { title: "Fictional" }, items: [] });
    }
    if (parsed.hostname === "www.googleapis.com") {
      if (parsed.pathname.endsWith("/permissions")) return Response.json({ permissions: [{ id: "fixture_owner", type: "user", role: "owner" }] });
      return Response.json({ id: "fixture_journal", trashed: false, mimeType: "application/vnd.google-apps.spreadsheet",
        owners: [{ permissionId: "fixture_owner" }] });
    }
    const isJournal = parsed.pathname.includes("fixture_journal");
    if (isJournal && parsed.pathname.endsWith(":batchUpdate")) {
      if (state.rows) return Response.json({}, { status: 400 });
      const body = JSON.parse(String(init.body));
      expect(body.requests[0].addSheet.properties.sheetId).toBe(target.journal_sheet_id);
      state.rows = body.requests[1].updateCells.rows.map((row: { values: { userEnteredValue: { stringValue: string } }[] }) => row.values[0].userEnteredValue.stringValue);
      state.journalWrites++;
      if (state.lostWriteReply) throw Error("PRIVATE_DEPENDENCY_SENTINEL");
      return Response.json({ spreadsheetId: "fixture_journal", replies: [{}, {}] });
    }
    const property = { sheetId: isJournal ? target.journal_sheet_id : source.sheet_id,
      title: isJournal ? `c2_source_${target.journal_sheet_id}` : "Responses", sheetType: "GRID",
      gridProperties: { rowCount: isJournal ? state.rows?.length ?? 1 : 2, columnCount: 1 } };
    const filtered = parsed.pathname.endsWith(":getByDataFilter");
    return Response.json({ spreadsheetId: isJournal ? "fixture_journal" : source.spreadsheet_id,
      properties: { locale: "en_US", timeZone: "America/New_York" },
      sheets: isJournal && !state.rows ? [] : [{ properties: property, ...(filtered ? { data: [{ rowData: isJournal ?
        state.rows!.map(text => ({ values: [{ userEnteredValue: { stringValue: text } }] })) : [{ values: [{}] }, { values: [{}] }] }] } : {}) }] });
  };
  const operation = () => createPrivateSourceRuntime({ authorize: async () => {
    if (state.denied) throw Error("PRIVATE_AUTHORITY_SENTINEL"); return pin;
  }, registeredTarget: id => registry.get(id), store, hash: sha256Base64Url, oauthToken: async () => "FICTIONAL_TOKEN",
  fetchGoogle, now: () => at });
  return { stub, store, registry, pin, target, state, operation, at };
}

describe("existing private runtime on actual DO storage", () => {
  it("recovers the fixed capture/journal/review across eviction without source rereads or duplicate writes", async () => {
    const f = await fixture("runtime-recovery"), first = await f.operation();
    expect((await first.capture()).phase).toBe("CANDIDATE_DURABLE");
    f.state.lostWriteReply = true;
    expect((await first.stage()).phase).toBe("JOURNAL_READBACK_CONFIRMED");
    const reads = f.state.sourceReads;
    const review = new PrivateSourceReview(first, f.store, sha256Base64Url, () => f.at), view = await review.view();
    const command = JSON.stringify({ request_id: "fixture_review", local_snapshot_id: view.result.anchor.local_snapshot_id,
      row_index: 1, response_id: "fixture_response", expected_sheet_digest: view.result.sheet_records[0].content_digest,
      expected_form_digest: view.result.form_records[0].content_digest, decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" });
    const result = await review.append(command);
    expect(result.ledger_version).toBe(1); expect(result.annual_export_authorized).toBe(false);
    expect(JSON.parse(result.result.evidence_text).actor_id).toBe("fixture_coach");
    await evictDurableObject(f.stub);
    const resumed = await f.operation();
    expect((await resumed.resume()).phase).toBe("JOURNAL_READBACK_CONFIRMED");
    expect((await new PrivateSourceReview(resumed, f.store, sha256Base64Url, () => f.at).append(command)).result.evidence_text)
      .toBe(result.result.evidence_text);
    expect(f.state.sourceReads).toBe(reads); expect(f.state.journalWrites).toBe(1);
    const before = await runInDurableObject(f.stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM source_private_records ORDER BY key").toArray());
    f.state.denied = true;
    await expect(review.view()).rejects.toMatchObject({ code: "SOURCE_PRIVATE_REVIEW_UNCONFIRMED" });
    await expect(review.append(command)).rejects.toMatchObject({ code: "SOURCE_PRIVATE_REVIEW_UNCONFIRMED" });
    expect(await runInDurableObject(f.stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM source_private_records ORDER BY key").toArray())).toEqual(before);
    expect(f.state.sourceReads).toBe(reads); expect(f.state.journalWrites).toBe(1);
  });

  it("retains a pending source request across eviction and refuses a replacement live read", async () => {
    const f = await fixture("runtime-unresolved"); f.state.failSource = true;
    await expect((await f.operation()).capture()).rejects.toThrow(); expect(f.state.sourceReads).toBe(1);
    await evictDurableObject(f.stub);
    f.state.failSource = false;
    await expect((await f.operation()).capture()).rejects.toThrow();
    expect(f.state.sourceReads).toBe(1); expect(f.state.journalWrites).toBe(0);
    const texts = await runInDurableObject(f.stub, (_instance, ctx) => ctx.storage.sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM source_private_chunks").toArray()
      .map(row => new TextDecoder().decode(row.bytes)).join(""));
    expect(texts).toContain("c2-private-source-read-v1"); expect(texts).not.toContain("FICTIONAL_TOKEN");
  });
});
