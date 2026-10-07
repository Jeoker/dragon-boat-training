import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateSourceEnv } from "../src/index";
import { sourceObjectName } from "../src/runtime";
import { seedBusiness, googleModel, target, fixtureEnv } from "./entrypoint-fixture";
import type { SourceAuthorityPin } from "../../../shared/c2-source-authority-contract";
import { sha256Base64Url } from "../../src/crypto";
import { sourceCanonical, type SourceJson } from "../../../shared/c2-source-capture-contract";

const denied = { ok: false, code: "SOURCE_PRIVATE_RUNTIME_UNCONFIRMED" };
const privateEnv = env as unknown as PrivateSourceEnv;
async function setup(name: string) {
  const f = await seedBusiness(`native_capture_${name}`);
  const pin = (await f.call("/internal/c2/pin-source-authority", f.command)).pin as SourceAuthorityPin;
  const stub = privateEnv.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin)), model = googleModel(pin);
  expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
  const records = async () => {
    const keys = await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec<{ key: string }>(
      "SELECT key FROM source_private_records ORDER BY key").toArray());
    const values: any[] = [];
    for (const { key } of keys) {
      const result = await stub.readRecord(key);
      try { expect(result.ok).toBe(true); if (result.ok && "value" in result) values.push(structuredClone(result.value)); }
      finally { (result as typeof result & { [Symbol.dispose]?: () => void })[Symbol.dispose]?.(); }
    }
    return values;
  };
  return { ...f, pin, stub, model, records };
}
afterEach(() => vi.restoreAllMocks());

describe("native relationship proof in a real named private capture", () => {
  it("persists one original signed observation, binds the candidate and replays it after SQLite eviction", async () => {
    const f = await setup("durable"), result = await f.run("capture-native");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw Error();
    expect(result.data).toMatchObject({ phase: "CANDIDATE_DURABLE", source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false });
    expect(f.model.state.nativeCalls).toBe(1);
    const original = await f.records(), candidate = original.find(row => row.candidate !== undefined && row.candidate !== null);
    expect(candidate).toBeDefined();
    const observation = JSON.parse(candidate.candidate.observation_text);
    expect(observation.format).toBe("c2-source-observation-v2");
    expect(observation.response_tab_link_evidence).toBe("GOOGLE_NATIVE_TAB_LINK_OBSERVED");
    expect(JSON.stringify(observation)).toContain(f.pin.authority_digest);
    expect(JSON.stringify(original)).toContain("c2-native-tab-proof-v1");
    expect(JSON.stringify(original)).not.toMatch(/FICTIONAL_ACCESS_TOKEN|FICTIONAL_REFRESH_TOKEN|FICTIONAL_CLIENT_SECRET|fixture-native-bridge-secret|session_token/);
    const sourceReads = f.model.state.sourceReads, calls = f.model.spy.mock.calls.length;
    await evictDurableObject(f.stub);
    expect(await f.run("capture-native")).toEqual(result);
    expect(await f.records()).toEqual(original);
    expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBe(sourceReads);
    expect(f.model.spy.mock.calls.length).toBe(calls);
    f.model.state.loseWriteReply = true;
    const staged = await f.run("stage", { confirm_private_journal: true }); expect(staged.ok).toBe(true);
    await evictDurableObject(f.stub);
    expect(await f.run("resume")).toEqual(staged);
    expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBe(sourceReads);
    expect((await f.records()).find(row => row.candidate)?.candidate).toEqual(candidate.candidate);
    const viewed = await f.run("review-view"); expect(viewed.ok).toBe(true);
    if (!viewed.ok) throw Error();
    const view = viewed.data, command_text = JSON.stringify({ request_id: "native_capture_review_request",
      local_snapshot_id: view.result.anchor.local_snapshot_id, row_index: 1, response_id: "fixture_response",
      expected_sheet_digest: view.result.sheet_records[0].content_digest, expected_form_digest: view.result.form_records[0].content_digest,
      decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" });
    expect((await f.run("review-append", { command_text })).ok).toBe(true);
    const backup = await f.run("backup", { confirm_private_backup: true }); expect(backup.ok).toBe(true);
    if (!backup.ok) throw Error();
    expect((await f.records()).find(row => row.candidate)?.candidate).toEqual(candidate.candidate);
    const pieces = backup.data.chunks.filter((chunk: any) => chunk.key === candidate.key).sort((a: any, b: any) => a.chunk_index - b.chunk_index);
    const bytes = Uint8Array.from(pieces.flatMap((chunk: any) => [...atob(chunk.bytes_base64)].map(ch => ch.charCodeAt(0))));
    const savedCandidateText = new TextDecoder().decode(bytes);
    expect(JSON.parse(savedCandidateText).candidate).toEqual(candidate.candidate);
    expect(await sha256Base64Url(savedCandidateText)).toBe(backup.data.manifest.records.find((row: any) => row.key === candidate.key).digest);
    expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBe(sourceReads);
  });

  it("returns an already durable low-grade candidate unchanged without observing or retroactively upgrading it", async () => {
    const f = await setup("legacy_durable"), legacy = await f.run("capture"); expect(legacy.ok).toBe(true);
    const before = await f.records(), calls = f.model.spy.mock.calls.length;
    expect(await f.run("capture-native")).toEqual(legacy);
    expect(await f.records()).toEqual(before); expect(f.model.spy.mock.calls.length).toBe(calls);
    expect(JSON.stringify(before)).toContain("SERVER_BINDING_DECLARATION_ONLY");
    expect(JSON.stringify(before)).not.toContain("GOOGLE_NATIVE_TAB_LINK_OBSERVED");
  });

  it("refuses to reinterpret a legacy unknown request checkpoint as a native capture", async () => {
    const f = await setup("legacy_pending"); f.model.state.failSource = true;
    expect(await f.run("capture")).toEqual(denied);
    const before = await f.records(); expect(JSON.stringify(before)).toContain('"pending":');
    await evictDurableObject(f.stub); f.model.state.failSource = false;
    expect(await f.run("capture-native")).toEqual(denied);
    expect(await f.records()).toEqual(before); expect(f.model.state.nativeCalls).toBe(0); expect(f.model.state.sourceReads).toBe(1);
  });

  it("never reissues a native observation whose original network reply was lost", async () => {
    const f = await setup("native_unknown"); f.model.state.failNative = true;
    expect(await f.run("capture-native")).toEqual(denied);
    const before = await f.records(); expect(JSON.stringify(before)).toContain('"pending":');
    expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBe(0);
    await evictDurableObject(f.stub); f.model.state.failNative = false;
    expect(await f.run("capture-native")).toEqual(denied);
    expect(await f.run("capture")).toEqual(denied);
    expect(await f.records()).toEqual(before); expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBe(0);
    expect(JSON.stringify(before)).not.toContain("PRIVATE_NATIVE_NETWORK_SENTINEL");
  });

  it.each(["nonce", "authority_digest", "sheet_id", "observed_at_ms"])("refuses a signed but wrong %s before source reads or candidate durability", async field => {
    const f = await setup(`wrong_${field}`);
    f.model.state.nativeTransform = proof => { proof[field] = typeof proof[field] === "number" ? Number(proof[field]) + 60_000 : `wrong_${field}`; };
    expect(await f.run("capture-native")).toEqual(denied);
    expect(f.model.state.sourceReads).toBe(0); expect(f.model.state.nativeCalls).toBe(1);
    expect((await f.records()).every(row => row.candidate === null || row.candidate === undefined)).toBe(true);
  });

  it("checks actual current Coach authorization after the native response and refuses later source requests", async () => {
    const f = await setup("native_logout"); f.model.state.afterNative = f.logout;
    expect(await f.run("capture-native")).toEqual(denied);
    const before = await f.records();
    expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBe(0);
    await evictDurableObject(f.stub);
    expect(await f.run("capture-native")).toEqual(denied);
    expect(await f.records()).toEqual(before); expect(f.model.state.nativeCalls).toBe(1);
  });

  it("rejects browser-supplied native evidence before the named runtime can write or observe", async () => {
    const f = await setup("forged"), before = await f.records();
    expect(await f.run("capture-native", { proof: { evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED" } })).toEqual(denied);
    expect(await f.run("capture", { native_tab_evidence: {} })).toEqual(denied);
    expect(await f.records()).toEqual(before); expect(f.model.spy.mock.calls).toHaveLength(0);
  });

  it("rejects a current binding replacement while the signed native response is awaited", async () => {
    const f = await setup("binding_changed"); f.model.state.afterNative = f.rebind;
    expect(await f.run("capture-native")).toEqual(denied);
    const before = await f.records();
    expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBe(0);
    await evictDurableObject(f.stub);
    expect(await f.run("capture-native")).toEqual(denied);
    expect(await f.records()).toEqual(before); expect(f.model.state.nativeCalls).toBe(1);
  });

  it("refuses an old correctly signed native response for another pinned operation", async () => {
    const first = await setup("replay_old"); expect((await first.run("capture-native")).ok).toBe(true);
    const prior = structuredClone(first.model.state.nativeReply); first.model.spy.mockRestore();
    const second = await setup("replay_new"); second.model.state.nativeReply = prior; second.model.state.replayNative = true;
    expect(await second.run("capture-native")).toEqual(denied);
    expect(second.model.state.nativeCalls).toBe(1); expect(second.model.state.sourceReads).toBe(0);
    expect((await second.records()).every(row => row.candidate === null || row.candidate === undefined)).toBe(true);
  });

  it("keeps the native receipt across a quota yield and consumes confirmed source pages without re-observing", async () => {
    const f = await setup("paged_budget"); f.model.state.responsePages = 20; f.model.state.nativeRedirect = true;
    expect(await f.run("capture-native")).toEqual(denied);
    const firstCalls = f.model.spy.mock.calls.length, first = await f.records();
    expect(firstCalls).toBeLessThanOrEqual(40); expect(f.model.state.nativeCalls).toBe(1);
    const transcript = first.find(row => row.format === "c2-private-source-read-v1");
    expect(transcript.pending).toBe(null); expect(transcript.entries[0].response_text).toContain("c2-native-tab-proof-v1");
    expect(transcript.entries).toHaveLength(32); // native + 31 newly started REST requests
    expect(f.model.state.nativeRedirectCalls).toBe(1); // both actual bridge requests fall inside the command bound
    const originalProof = structuredClone(transcript.entries[0]);
    await evictDurableObject(f.stub);
    expect((await f.run("capture-native")).ok).toBe(true);
    expect(f.model.spy.mock.calls.length - firstCalls).toBeLessThanOrEqual(40);
    expect(f.model.state.nativeCalls).toBe(1);
    expect(f.model.state.nativeRedirectCalls).toBe(1);
    expect((await f.records()).find(row => row.format === "c2-private-source-read-v1").entries[0]).toEqual(originalProof);
    expect([...f.model.state.sourceUrls].every(([url, count]) => count === (url.includes("/responses?") ? 2 : 4))).toBe(true);
  });

  it("refuses corrupted durable proof bytes after eviction without silently fetching a replacement", async () => {
    const f = await setup("proof_corrupt"); f.model.state.responsePages = 20;
    expect(await f.run("capture-native")).toEqual(denied);
    const read = (await f.records()).find(row => row.format === "c2-private-source-read-v1");
    await runInDurableObject(f.stub, (_instance, ctx) => ctx.storage.sql.exec(
      "UPDATE source_private_chunks SET bytes=? WHERE key=? AND chunk_index=0", new TextEncoder().encode("corrupt-native-checkpoint").buffer, read.key).toArray());
    await evictDurableObject(f.stub);
    expect(await f.run("capture-native")).toEqual(denied);
    expect(f.model.state.nativeCalls).toBe(1);
  });

  it("dispatches capture-native through the actual business HTTP gate and rejects client proof fields there", async () => {
    const f = await setup("http_native"), before = await f.records();
    const forged = await fixtureEnv.TEST_BUSINESS_API.fetch("https://business.test/internal/c2/private-source-run", {
      method: "POST", headers: { authorization: "Bearer local-c2-test-key", "content-type": "application/json" },
      body: JSON.stringify({ ...f.command, action: "capture-native", proof: { evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED" } }) });
    expect(forged.status).toBe(409); expect(await f.records()).toEqual(before); expect(f.model.state.nativeCalls).toBe(0);
    const response = await f.call("/internal/c2/private-source-run", { ...f.command, action: "capture-native" });
    expect(response.result).toMatchObject({ phase: "CANDIDATE_DURABLE", response_tab_link_evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED",
      source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false });
    expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBeGreaterThan(0);
    expect((await f.records()).some(row => row.candidate !== undefined && row.candidate !== null)).toBe(true);
  });

  it("rejects a structurally rehashed checkpoint proof identity before any later REST read", async () => {
    const f = await setup("rehashed_checkpoint"); f.model.state.failSource = true;
    expect(await f.run("capture-native")).toEqual(denied);
    const transcript = (await f.records()).find(row => row.format === "c2-private-source-read-v1");
    const entry = transcript.entries[0], evidence = JSON.parse(entry.response_text);
    evidence.proof.sheet_id++;
    entry.response_text = sourceCanonical(evidence);
    entry.digest = await sha256Base64Url("c2-private-source-read-entry-v1\n" + sourceCanonical([
      0, entry.request_text, entry.response_text, entry.observed_start_at, entry.observed_end_at]));
    const text = sourceCanonical(transcript as SourceJson), bytes = new TextEncoder().encode(text), digest = await sha256Base64Url(text);
    await runInDurableObject(f.stub, (_instance, ctx) => ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec("DELETE FROM source_private_chunks WHERE key=?", transcript.key);
      for (let offset = 0; offset < bytes.length; offset += 64_000)
        ctx.storage.sql.exec("INSERT INTO source_private_chunks VALUES (?,?,?)", transcript.key, offset / 64_000, bytes.slice(offset, offset + 64_000).buffer);
      ctx.storage.sql.exec("UPDATE source_private_records SET digest=?,byte_count=?,chunk_count=? WHERE key=?",
        digest, bytes.length, Math.ceil(bytes.length / 64_000), transcript.key);
    }));
    const sourceReads = f.model.state.sourceReads;
    await evictDurableObject(f.stub); f.model.state.failSource = false;
    expect(await f.run("capture-native")).toEqual(denied);
    expect(f.model.state.nativeCalls).toBe(1); expect(f.model.state.sourceReads).toBe(sourceReads);
  });
});
