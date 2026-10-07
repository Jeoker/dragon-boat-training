import { WorkerEntrypoint } from "cloudflare:workers";
export { default, PrivateSourceState, SourceRuntime } from "../src/index";

/** Test-only outbound transport for the auxiliary business Worker. The real
 * SourceAuthority still verifies bridge HMAC/nonces and real TeamState. Only
 * Google HTTP is forwarded into this test isolate's deterministic fetch model. */
export class TestGoogleTransport extends WorkerEntrypoint {
  async fetch(request: Request) {
    try {
      return await fetch(request.url, { method: request.method, headers: request.headers,
        redirect: "manual", ...(request.method === "GET" ? {} : { body: await request.text() }) });
    } catch { return new Response(null, { status: 503 }); }
  }
}
