import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { hmacSha256Base64Url, legacyCredentialDigest } from "../src/crypto";
import { bridgeSignatureInput } from "../src/bridge";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const secret = "fixture-native-bridge-secret";
async function setup(name: string) {
  const stub = env.TEAM_STATE.getByName(`native-proof-${name}`);
  // Isolate actual SQL while preserving the configured DO server identity.
  const testEnv = { ...env, TEAM_STATE: { getByName: () => stub }, GOOGLE_BRIDGE_SECRET: secret,
    GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/native-fixture/exec" } as unknown as Env;
  const season_id = "season_native_proof", coach_id = "coach_native_proof", at = "2020-09-01T12:00:00.000Z";
  const call = async (path: string, input: unknown, c1 = false, key?: string, method = "POST") => {
    const response = await worker.fetch(new IncomingRequest(`https://example.test${path}`, { method,
      headers: { authorization: `Bearer ${key ?? `local-c${c1 ? 1 : 2}-test-key`}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}) }), testEnv);
    return { status: response.status, body: await response.json() as any };
  };
  const ok = (result: Awaited<ReturnType<typeof call>>) => { expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body.data; };
  ok(await call("/internal/c1/import-core", { request_id: `native_import_${name}`, source_snapshot_id: `native_snapshot_${name}`,
    settings_version: 1, default_season_id: null,
    coaches: [{ coach_id, display_name: "Fictional Coach", code_salt: "native_salt",
      code_digest: await legacyCredentialDigest("native_salt", "fixture-native-code", "local-c1-coach-secret"), credential_version: 1,
      active: true, created_at: at, updated_at: at }],
    seasons: [{ season_id, name: "Fictional", start_date: "2020-09-01", end_date: "2020-09-20", timezone: "America/New_York",
      season_ends_at: "2020-09-21T04:00:00.000Z", status: "COMPLETED", binding_version: 1, season_version: 1,
      roster_version: 1, created_by: coach_id, created_at: at, updated_at: at }], members: [] }, true));
  ok(await call("/internal/c2/import-sync-foundation", { request_id: `native_bind_${name}`, source_snapshot_id: `native_binding_${name}`,
    bindings: [{ season_id, binding_version: 1, form_id: "form_native_fixture", runtime_spreadsheet_id: "sheet_native_fixture",
      response_sheet_id: "31", response_sheet_name: "Responses", field_mapping: { display_name_header: "Name" },
      schema_fingerprint: "sha256_v1:fixture", export_paused: true, last_pull_at: null, last_push_at: null, created_at: at, updated_at: at }],
    baselines: [], source_imports: [] }));
  const session_token = ok(await call("/internal/c1/coach-login", { request_id: `native_login_${name}`, coach_code: "fixture-native-code" }, true)).result.session_token;
  const command = { request_id: `native_source_${name}`, season_id, session_token };
  const pin = ok(await call("/internal/c2/pin-source-authority", command)).pin;
  const stored = () => runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM source_authority_pins").toArray());
  return { call, command, pin, stub, stored, testEnv, ok,
    logout: () => call("/internal/c1/coach-logout", { request_id: `native_logout_${name}`, session_token }, true) };
}
function model(transform: (proof: any) => void = () => {}, afterGoogle?: () => Promise<unknown>, signatureInvalid = false) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), input = JSON.parse(request.payload_json);
    expect(request.action).toBe("cloudflareReadNativeTabProof");
    expect(request.signature).toBe(await hmacSha256Base64Url(bridgeSignatureInput(request), secret));
    const proof = { format: "c2-native-tab-proof-v1", evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED", action: "READ_NATIVE_TAB_LINK",
      direction: "GOOGLE_TO_CLOUDFLARE_NATIVE_TAB", request_id: input.request_id, nonce: input.nonce,
      team_id: input.team_id, backend_generation: input.backend_generation, writer_epoch: input.writer_epoch,
      season_id: input.season_id, binding_version: input.binding_version, source_operation_id: input.source_operation_id,
      authority_digest: input.authority_digest, form_id: input.form_id, spreadsheet_id: input.spreadsheet_id,
      sheet_id: input.sheet_id, observed_at_ms: Date.now() };
    transform(proof); const proof_text = JSON.stringify(proof);
    await afterGoogle?.();
    return Response.json({ ok: true, meta: { request_id: request.request_id }, data: { proof_text,
      signature: signatureInvalid ? "a".repeat(43) : await hmacSha256Base64Url(`c2-native-tab-proof-v1\n${proof_text}`, secret) } });
  });
}
afterEach(() => vi.restoreAllMocks());

describe("current authenticated native Tab proof consumption", () => {
  it("consumes a signed fresh native proof through the real business HTTP gate without rewriting the original pin", async () => {
    const f = await setup("valid"), before = await f.stored(), google = model();
    const response = f.ok(await f.call("/internal/c2/native-tab-proof", f.command));
    expect(response.result.proof.evidence).toBe("GOOGLE_NATIVE_TAB_LINK_OBSERVED");
    expect(response.result.proof.authority_digest).toBe(f.pin.authority_digest);
    expect(response.result).toMatchObject({ source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false });
    expect(await f.stored()).toEqual(before); expect(google).toHaveBeenCalledTimes(1);
    const firstNonce = response.result.proof.nonce;
    const next = f.ok(await f.call("/internal/c2/native-tab-proof", f.command));
    expect(next.result.proof.nonce).not.toBe(firstNonce); expect(google).toHaveBeenCalledTimes(2);
  });

  it.each(["form_id", "spreadsheet_id", "sheet_id", "binding_version", "authority_digest", "source_operation_id", "nonce", "request_id", "direction", "action", "observed_at_ms", "signature"])(
    "rejects correctly signed but wrong %s observations instead of upgrading source eligibility", async field => {
      const f = await setup(`wrong_${field}`), before = await f.stored();
      model(proof => { if (field !== "signature") proof[field] = typeof proof[field] === "number" ? proof[field] +
        (field === "observed_at_ms" ? 60_000 : 1) : `wrong_${field}`; }, undefined, field === "signature");
      const response = await f.call("/internal/c2/native-tab-proof", f.command);
      expect(response.status).toBe(409); expect(response.body.error.code).toBe("NATIVE_TAB_PROOF_UNCONFIRMED");
      expect(response.body.data).toBeUndefined(); expect(await f.stored()).toEqual(before);
    });

  it.each(["logout", "binding"])("refuses the proof when %s changes while Google is awaited", async mode => {
    const f = await setup(`mid_${mode}`), before = await f.stored();
    model(() => {}, async () => { if (mode === "logout") await f.logout();
      else await runInDurableObject(f.stub, (_instance, ctx) => ctx.storage.sql.exec("UPDATE sync_bindings SET form_id='changed_form'").toArray()); });
    const result = await f.call("/internal/c2/native-tab-proof", f.command);
    expect(result.status).toBe(409); expect(result.body.error.code).toBe("NATIVE_TAB_PROOF_UNCONFIRMED");
    expect(await f.stored()).toEqual(before);
  });

  it("enforces transport/session/method/body limits before Google and rejects browser proof fields", async () => {
    const f = await setup("gates"), google = model(), before = await f.stored();
    expect((await f.call("/internal/c2/native-tab-proof", f.command, false, "wrong-key")).status).toBe(403);
    expect((await f.call("/internal/c2/native-tab-proof", f.command, false, undefined, "GET")).status).toBe(405);
    expect((await f.call("/internal/c2/native-tab-proof", { ...f.command, session_token: "forged.token" })).status).toBe(409);
    expect((await f.call("/internal/c2/native-tab-proof", { ...f.command, proof: { evidence: "GOOGLE_NATIVE_TAB_LINK_OBSERVED" } })).status).toBe(409);
    let cancelled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(10_001)); }, cancel() { cancelled = true; } });
    const response = await worker.fetch(new IncomingRequest("https://example.test/internal/c2/native-tab-proof", { method: "POST",
      headers: { authorization: "Bearer local-c2-test-key" }, body: stream }), f.testEnv);
    expect(response.status).toBe(409); expect(cancelled).toBe(true); expect(google).not.toHaveBeenCalled();
    expect(await f.stored()).toEqual(before);
  });

  it("cancels an oversized streaming Google response before parsing it", async () => {
    const f = await setup("oversize_response"), before = await f.stored(); let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(8_001)); }, cancel() { cancelled = true; }
    }), { headers: { "content-type": "application/json" } }));
    expect((await f.call("/internal/c2/native-tab-proof", f.command)).status).toBe(409);
    expect(cancelled).toBe(true); expect(await f.stored()).toEqual(before);
  });

  it("rejects replay of a valid old signature when a new command has a fresh nonce", async () => {
    const f = await setup("replay"), before = await f.stored(); let previous: Response | undefined;
    const google = model();
    const normal = google.getMockImplementation()!;
    google.mockImplementation(async (...args) => { previous = (await normal(...args)).clone(); return previous.clone(); });
    f.ok(await f.call("/internal/c2/native-tab-proof", f.command));
    google.mockImplementation(async () => previous!.clone());
    expect((await f.call("/internal/c2/native-tab-proof", f.command)).status).toBe(409);
    expect(await f.stored()).toEqual(before);
  });

  it.each([302, 303])("allows one ContentService %s hop as an unsigned GET and keeps the signed proof body", async status => {
    const f = await setup(`redirect_${status}`), google = model(), normal = google.getMockImplementation()!;
    let final: Response | undefined;
    google.mockImplementation(async (url, init) => {
      if (google.mock.calls.length === 1) {
        expect(init?.redirect).toBe("manual"); final = await normal(url, init);
        return new Response(null, { status, headers: { location: "https://script.googleusercontent.com/macros/echo?user_content_key=fixture" } });
      }
      expect(String(url)).toContain("script.googleusercontent.com/macros/echo");
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(init?.body).toBeUndefined(); expect(init?.headers).toBeUndefined();
      return final!;
    });
    const result = f.ok(await f.call("/internal/c2/native-tab-proof", f.command));
    expect(result.result.proof.evidence).toBe("GOOGLE_NATIVE_TAB_LINK_OBSERVED"); expect(google).toHaveBeenCalledTimes(2);
  });

  it.each(["https://wrong.example/macros/echo", "http://script.googleusercontent.com/macros/echo",
    "https://script.googleusercontent.com/wrong", "https://fixture:secret@script.googleusercontent.com/macros/echo"])(
    "cancels and refuses forbidden redirect %s before contacting it", async location => {
      const f = await setup(`bad_redirect_${location.includes("wrong") ? "wrong" : "credentials"}`); let cancelled = false;
      const google = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { status: 302, headers: { location } }));
      expect((await f.call("/internal/c2/native-tab-proof", f.command)).status).toBe(409);
      expect(cancelled).toBe(true); expect(google).toHaveBeenCalledTimes(1);
    });

  it("cancels a second redirect without a third network request", async () => {
    const f = await setup("second_redirect"); let cancelled = false;
    const google = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/macros/echo?first" } }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { status: 303, headers: { location: "https://script.googleusercontent.com/macros/echo?second" } }));
    expect((await f.call("/internal/c2/native-tab-proof", f.command)).status).toBe(409);
    expect(cancelled).toBe(true); expect(google).toHaveBeenCalledTimes(2);
  });

  it("uses one deadline across the native bridge request and aborts an unresolved fetch", async () => {
    const f = await setup("deadline"), before = await f.stored();
    let announce!: () => void; const started = new Promise<void>(resolve => { announce = resolve; });
    vi.useFakeTimers();
    try {
      const google = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("PRIVATE_NATIVE_DEADLINE_SENTINEL")), { once: true }); announce();
      }));
      const pending = f.call("/internal/c2/native-tab-proof", f.command);
      await started; await vi.advanceTimersByTimeAsync(20_000);
      expect((await pending).status).toBe(409); expect(google).toHaveBeenCalledTimes(1); expect(await f.stored()).toEqual(before);
    } finally { vi.useRealTimers(); }
  });
});
