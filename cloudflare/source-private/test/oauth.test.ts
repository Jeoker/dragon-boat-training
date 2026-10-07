import { describe, expect, it } from "vitest";
import { GoogleRefreshTokenProvider } from "../src/oauth";

const secrets = { SOURCE_GOOGLE_OAUTH_CLIENT_ID: "fictional-client.apps.googleusercontent.com",
  SOURCE_GOOGLE_OAUTH_CLIENT_SECRET: "PRIVATE_CLIENT_SENTINEL", SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN: "PRIVATE_REFRESH_SENTINEL" };
const valid = () => Response.json({ access_token: "PRIVATE_ACCESS_SENTINEL", token_type: "Bearer", expires_in: 3600 });
const fixedError = "SOURCE_GOOGLE_OAUTH_UNCONFIRMED";

describe("platform-secret Google OAuth adapter", () => {
  it("single-flights concurrent refreshes, caches only until expiry safety margin and pins the transport", async () => {
    let calls = 0, time = 1_000, release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    const provider = new GoogleRefreshTokenProvider(secrets, async (url, init) => {
      calls++;
      expect(url).toBe("https://oauth2.googleapis.com/token");
      expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
      expect(new URL(url).search).toBe("");
      const body = new URLSearchParams(String(init.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_secret")).toBe(secrets.SOURCE_GOOGLE_OAUTH_CLIENT_SECRET);
      expect(body.get("refresh_token")).toBe(secrets.SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN);
      return calls === 1 ? response : valid();
    }, () => time);
    const first = provider.token(), concurrent = provider.token();
    expect(calls).toBe(1); release(valid());
    expect(await Promise.all([first, concurrent])).toEqual(["PRIVATE_ACCESS_SENTINEL", "PRIVATE_ACCESS_SENTINEL"]);
    time += 3_569_999; expect(await provider.token()).toBe("PRIVATE_ACCESS_SENTINEL"); expect(calls).toBe(1);
    time++; expect(await provider.token()).toBe("PRIVATE_ACCESS_SENTINEL"); expect(calls).toBe(2);
  });

  it.each([400, 401, 429, 500])("stops HTTP %s without retry or exposing dependency errors and secrets", async status => {
    let calls = 0;
    const provider = new GoogleRefreshTokenProvider(secrets, async () => { calls++;
      return Response.json({ error: "PRIVATE_ERROR_SENTINEL", refresh_token: secrets.SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN }, { status }); });
    try { await provider.token(); expect.fail("must reject"); }
    catch (error) { expect((error as Error).message).toBe(fixedError); expect(String(error)).not.toContain("PRIVATE_"); }
    expect(calls).toBe(1);
  });

  it.each(["redirect", "wrong-url", "content-type", "declared-size", "stream-size", "malformed-json", "invalid-utf8", "invalid-token", "invalid-expiry"])
    ("rejects %s OAuth responses with a fixed failure", async mode => {
      const provider = new GoogleRefreshTokenProvider(secrets, async () => {
        if (mode === "content-type") return new Response("PRIVATE_BODY_SENTINEL", { headers: { "content-type": "text/html" } });
        if (mode === "declared-size") return new Response("{}", { headers: { "content-type": "application/json", "content-length": "32001" } });
        if (mode === "stream-size") return new Response(" ".repeat(32_001), { headers: { "content-type": "application/json" } });
        if (mode === "malformed-json") return new Response("PRIVATE_JSON_SENTINEL", { headers: { "content-type": "application/json" } });
        if (mode === "invalid-utf8") return new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } });
        if (mode === "invalid-token") return Response.json({ access_token: "PRIVATE_ACCESS\nSENTINEL", token_type: "Bearer", expires_in: 3600 });
        if (mode === "invalid-expiry") return Response.json({ access_token: "PRIVATE_ACCESS_SENTINEL", token_type: "Bearer", expires_in: 30 });
        const response = valid();
        Object.defineProperty(response, mode === "redirect" ? "redirected" : "url", { value: mode === "redirect" ? true : "https://private.invalid/token" });
        return response;
      });
      await expect(provider.token()).rejects.toThrow(new RegExp(`^${fixedError}$`, "u"));
    });

  it("rejects incomplete platform secrets and invalid clocks before any request", async () => {
    let requests = 0;
    const fetch = async () => { requests++; return valid(); };
    await expect(new GoogleRefreshTokenProvider({ ...secrets, SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN: undefined }, fetch).token()).rejects.toThrow(fixedError);
    await expect(new GoogleRefreshTokenProvider({ ...secrets, SOURCE_GOOGLE_OAUTH_CLIENT_ID: "https://private.invalid" }, fetch).token()).rejects.toThrow(fixedError);
    await expect(new GoogleRefreshTokenProvider(secrets, fetch, () => NaN).token()).rejects.toThrow(fixedError);
    expect(requests).toBe(0);
  });

  it("sanitizes an unknown network refresh result without automatically repeating it", async () => {
    let requests = 0;
    const provider = new GoogleRefreshTokenProvider(secrets, async () => { requests++; throw Error("PRIVATE_NETWORK_SENTINEL"); });
    await expect(provider.token()).rejects.toThrow(new RegExp(`^${fixedError}$`, "u"));
    expect(requests).toBe(1);
  });

  it("does not reuse cached access credentials when the platform refresh secret changes or disappears", async () => {
    const mutable = { ...secrets }; let requests = 0;
    const provider = new GoogleRefreshTokenProvider(mutable, async (_url, init) => {
      requests++;
      return Response.json({ access_token: `FICTIONAL_ACCESS_${new URLSearchParams(String(init.body)).get("refresh_token")}`,
        token_type: "Bearer", expires_in: 3600 });
    });
    const first = await provider.token(); mutable.SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN = "ROTATED_REFRESH_SENTINEL";
    expect(await provider.token()).not.toBe(first); expect(requests).toBe(2);
    mutable.SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN = "";
    await expect(provider.token()).rejects.toThrow(fixedError); expect(requests).toBe(2);
  });

  it("rejects an in-flight platform secret rotation and permits a fresh call using the new grant", async () => {
    const mutable = { ...secrets }; let requests = 0, release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const provider = new GoogleRefreshTokenProvider(mutable, async () => { requests++; return requests === 1 ? pending : valid(); });
    const first = provider.token(); mutable.SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN = "ROTATED_REFRESH_SENTINEL"; release(valid());
    await expect(first).rejects.toThrow(fixedError);
    expect(await provider.token()).toBe("PRIVATE_ACCESS_SENTINEL"); expect(requests).toBe(2);
  });
});
