import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateSourceEnv } from "../src/index";
import { sourceObjectName } from "../src/runtime";
import { fixtureEnv, seedBusiness, googleModel, target } from "./entrypoint-fixture";
import type { SourceAuthorityPin } from "../../../shared/c2-source-authority-contract";
import { PrivateSourceOperation } from "../../../backend/source-journal/operation";

const denied = { ok: false, code: "SOURCE_PRIVATE_RUNTIME_UNCONFIRMED" };
const privateEnv = env as unknown as PrivateSourceEnv;
const pinOf = async (fixture: Awaited<ReturnType<typeof seedBusiness>>) => {
  // Obtain the real business pin without constructing the private DO: its
  // OAuth provider captures fetch at construction, after our Google model starts.
  const result = await fixture.call("/internal/c2/pin-source-authority", fixture.command);
  return result.pin as SourceAuthorityPin;
};
const snapshot = (stub: ReturnType<PrivateSourceEnv["PRIVATE_SOURCE_STATE"]["getByName"]>) =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM source_private_records ORDER BY key").toArray());
const savedText = (stub: ReturnType<PrivateSourceEnv["PRIVATE_SOURCE_STATE"]["getByName"]>) =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM source_private_chunks ORDER BY key,chunk_index").toArray()
    .map(row => new TextDecoder().decode(row.bytes)).join(""));

afterEach(() => vi.restoreAllMocks());

describe("real private Worker entrypoint with business authority and SQLite DO", () => {
  it("captures, recovers a lost journal reply and idempotent review across eviction with no new source read", async () => {
    const f = await seedBusiness("entry_recovery"), pin = await pinOf(f), stub = privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin));
    expect(pin.actor_id).toBe(f.coach); expect(pin.source.season_id).toBe(f.season);
    expect(pin.source.season_ends_at).toBe("2020-09-21T04:00:00.000Z"); expect(pin.known_sources).toEqual([]);
    const model = googleModel(pin);
    expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    const captured = await f.run("capture"); expect(captured.ok, JSON.stringify(captured)).toBe(true);
    if (!captured.ok) throw Error(); expect(captured.data.phase).toBe("CANDIDATE_DURABLE");
    model.state.loseWriteReply = true;
    const staged = await f.run("stage", { confirm_private_journal: true }); expect(staged.ok, JSON.stringify(staged)).toBe(true);
    if (!staged.ok) throw Error(); expect(staged.data.phase).toBe("JOURNAL_READBACK_CONFIRMED");
    const viewed = await f.run("review-view"); expect(viewed.ok).toBe(true);
    if (!viewed.ok) throw Error(); const view = viewed.data;
    const command_text = JSON.stringify({ request_id: "entrypoint_review_request", local_snapshot_id: view.result.anchor.local_snapshot_id,
      row_index: 1, response_id: "fixture_response", expected_sheet_digest: view.result.sheet_records[0].content_digest,
      expected_form_digest: view.result.form_records[0].content_digest, decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" });
    const first = await f.run("review-append", { command_text }); expect(first.ok).toBe(true);
    const sourceReads = model.state.sourceReads;
    await evictDurableObject(stub);
    const recovered = await f.run("resume"); expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw Error(); expect(recovered.data).toEqual(staged.data);
    const replayed = await f.run("review-append", { command_text }); expect(replayed.ok).toBe(true);
    if (!first.ok || !replayed.ok) throw Error();
    expect(replayed.data.ledger_digest).toBe(first.data.ledger_digest);
    expect(replayed.data.ledger_version).toBe(first.data.ledger_version);
    expect(replayed.data.result.evidence_text).toBe(first.data.result.evidence_text);
    expect(replayed.data.result.ledger_text).toBe(first.data.result.ledger_text);
    expect(replayed.data.result.append_required).toBe(false);
    expect(model.state.sourceReads).toBe(sourceReads); expect(model.state.journalWrites).toBe(1);
    const text = await savedText(stub);
    expect(text).not.toMatch(/FICTIONAL_ACCESS_TOKEN|FICTIONAL_REFRESH_TOKEN|FICTIONAL_CLIENT_SECRET|session_token/);
    expect(text).toContain(f.coach); expect(text).toContain("SOURCE_NOT_VERIFIED");
    const before = await snapshot(stub), googleCalls = model.spy.mock.calls.length;
    await f.logout();
    for (const action of ["capture", "resume", "review-view"]) expect(await f.run(action)).toEqual(denied);
    expect(await f.run("review-append", { command_text })).toEqual(denied);
    expect(await snapshot(stub)).toEqual(before); expect(model.spy.mock.calls.length).toBe(googleCalls);
  });

  it("fails a request revoked while Google is awaited and leaves its pending checkpoint unresolved after eviction", async () => {
    const f = await seedBusiness("entry_mid_revoke"), pin = await pinOf(f), stub = privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin));
    const model = googleModel(pin); expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    model.state.revokeOnSource = f.logout;
    expect(await f.run("capture")).toEqual(denied); expect(model.state.sourceReads).toBe(1);
    expect(await savedText(stub)).toContain('"pending":');
    await evictDurableObject(stub);
    expect(await f.run("capture")).toEqual(denied); expect(model.state.sourceReads).toBe(1);
    expect(model.state.journalWrites).toBe(0);
  });

  it("never repeats an unknown started Google request after a private DO eviction", async () => {
    const f = await seedBusiness("entry_unknown"), pin = await pinOf(f), stub = privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin));
    const model = googleModel(pin); expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    model.state.failSource = true;
    expect(await f.run("capture")).toEqual(denied); expect(model.state.sourceReads).toBe(1);
    await evictDurableObject(stub); model.state.failSource = false;
    const before = model.spy.mock.calls.length;
    expect(await f.run("capture")).toEqual(denied);
    expect(model.spy.mock.calls.slice(before).every(([input]) => String(input).includes("/token") || String(input).includes("/about"))).toBe(true);
    expect(model.state.sourceReads).toBe(1); expect(model.state.journalWrites).toBe(0);
    expect(await savedText(stub)).not.toContain("PRIVATE_NETWORK_SENTINEL");
  });

  it("slices a paginated source before STARTED, resumes confirmed pages and counts OAuth in the external-call budget", async () => {
    const f = await seedBusiness("entry_budget"), pin = await pinOf(f), stub = privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin));
    const model = googleModel(pin); model.state.responsePages = 20;
    expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    expect(await f.run("capture")).toEqual(denied);
    const firstCalls = model.spy.mock.calls.length;
    expect(firstCalls).toBeLessThanOrEqual(50); expect(model.state.refreshes).toBe(1);
    expect(model.state.sourceReads).toBeGreaterThan(20);
    const firstText = await savedText(stub);
    expect(firstText).toContain('"pending":null');
    await evictDurableObject(stub);
    const second = await f.run("capture"); expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) throw Error(); expect(second.data.phase).toBe("CANDIDATE_DURABLE");
    expect(model.spy.mock.calls.length - firstCalls).toBeLessThanOrEqual(50);
    expect(model.state.refreshes).toBe(2); // eviction discards only the in-memory OAuth cache
    expect([...model.state.sourceUrls].every(([url, count]) => count === (url.includes("/responses?") ? 2 : 4))).toBe(true);
    expect(model.state.sourceUrls.size).toBe(21); // schema before/after each pass, twenty pages once per pass
    const before = model.spy.mock.calls.length;
    expect((await f.run("capture")).ok).toBe(true); expect(model.spy.mock.calls.length).toBe(before);
  });

  it("rejects browser authority and target replacement while isolating season and operation storage", async () => {
    const f = await seedBusiness("entry_scope"), pin = await pinOf(f), stub = privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin));
    const model = googleModel(pin);
    expect(await f.run("pin", { actor_id: "PRIVATE_BROWSER_ACTOR", pin, known_sources: [] })).toEqual(denied);
    expect(await f.run("pin", { session_token: "PRIVATE_FORGED_SESSION" })).toEqual(denied);
    expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    const before = await snapshot(stub);
    expect(await f.run("register", { target: { ...target(pin), source_operation_id: "foreign_operation" } })).toEqual(denied);
    expect(await f.run("register", { target: { ...target(pin), journal_sheet_id: 24680 } })).toEqual(denied);
    expect(await f.run("pin", { season_id: "foreign_season", request_id: f.command.request_id })).toEqual(denied);
    expect(await f.run("pin", { request_id: "replacement_operation_request" })).toEqual(denied);
    expect(await snapshot(stub)).toEqual(before); expect(model.spy.mock.calls).toHaveLength(0);
    const second = await seedBusiness("entry_other_season"), otherPin = await pinOf(second);
    expect(sourceObjectName(otherPin)).not.toBe(sourceObjectName(pin));
    expect(await snapshot(privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(otherPin)))).toEqual([]);
  });

  it("protects the business HTTP operation gateway before forwarding to the private named entrypoint", async () => {
    const f = await seedBusiness("entry_http_gate"), model = googleModel(await pinOf(f));
    const call = async (key: string, method = "POST", extra = {}) => {
      const response = await fixtureEnv.TEST_BUSINESS_API.fetch("https://business.test/internal/c2/private-source-run", {
        method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ ...f.command, action: "pin", ...extra }) } : {}) });
      return { status: response.status, body: await response.json() as any };
    };
    expect((await call("wrong-key")).status).toBe(403);
    expect((await call("local-c2-test-key", "GET")).status).toBe(405);
    const forged = await call("local-c2-test-key", "POST", { actor_id: "PRIVATE_FORGED_ACTOR" });
    expect(JSON.stringify(forged.body)).not.toContain("PRIVATE_FORGED_ACTOR");
    expect((await call("local-c2-test-key")).status).toBe(200);
    expect(model.spy.mock.calls).toHaveLength(0);
  });

  it.each([false, true])("validates root/parent=%s journal in a bounded first view and append, with fresh proof in each command", async parent => {
    const f = await seedBusiness(`entry_review_parent_${parent}`), pin = await pinOf(f), model = googleModel(pin);
    const stub = privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin)); model.state.journalParent = parent;
    expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    expect((await f.run("capture")).ok).toBe(true);
    expect((await f.run("stage", { confirm_private_journal: true })).ok).toBe(true);
    await evictDurableObject(stub); // first review must include a fresh OAuth token request
    const beforeView = model.spy.mock.calls.length, viewed = await f.run("review-view");
    expect(viewed.ok).toBe(true); const viewCalls = model.spy.mock.calls.length - beforeView;
    expect(viewCalls).toBeGreaterThan(0); expect(viewCalls).toBeLessThanOrEqual(40);
    if (!viewed.ok) throw Error(); const view = viewed.data;
    const command_text = JSON.stringify({ request_id: `private_parent_review_${parent}`, local_snapshot_id: view.result.anchor.local_snapshot_id,
      row_index: 1, response_id: "fixture_response", expected_sheet_digest: view.result.sheet_records[0].content_digest,
      expected_form_digest: view.result.form_records[0].content_digest, decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" });
    const beforeAppend = model.spy.mock.calls.length;
    expect((await f.run("review-append", { command_text })).ok).toBe(true);
    const appendCalls = model.spy.mock.calls.length - beforeAppend;
    expect(appendCalls).toBeGreaterThan(0); expect(appendCalls).toBeLessThanOrEqual(40);
    expect(viewCalls).toBe(parent ? 20 : 14); // actual privacy/readback calls + OAuth refresh
    expect(appendCalls).toBe(parent ? 19 : 13);
    console.info(`private journal parent=${parent}: first view=${viewCalls}, first append=${appendCalls} external calls`);
    const before = await snapshot(stub), sourceReads = model.state.sourceReads;
    model.state.publicJournal = true;
    expect(await f.run("review-view")).toEqual(denied);
    expect(await f.run("review-append", { command_text })).toEqual(denied);
    model.state.publicJournal = false;
    model.state.rows![0] = "PRIVATE_JOURNAL_CHANGED_SENTINEL";
    expect(await f.run("review-view")).toEqual(denied);
    expect(await snapshot(stub)).toEqual(before); expect(model.state.sourceReads).toBe(sourceReads);
  });

  it("rejects same-command review reuse when the real Coach session is revoked after its first complete proof", async () => {
    const f = await seedBusiness("entry_cached_revoke"), pin = await pinOf(f), model = googleModel(pin);
    const stub = privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin));
    expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    expect((await f.run("capture")).ok).toBe(true);
    expect((await f.run("stage", { confirm_private_journal: true })).ok).toBe(true);
    const original = PrivateSourceOperation.prototype.assertReviewSource; let proofs = 0;
    vi.spyOn(PrivateSourceOperation.prototype, "assertReviewSource").mockImplementation(async function (this: PrivateSourceOperation, source) {
      const proof = await original.call(this, source); proofs++;
      if (proofs === 1) await f.logout();
      return proof;
    });
    expect(await f.run("review-view")).toEqual(denied); expect(proofs).toBe(1);
    expect(model.state.journalWrites).toBe(1);
    expect(await savedText(stub)).not.toContain("c2-private-source-review-ledger-v1");
  });
});
