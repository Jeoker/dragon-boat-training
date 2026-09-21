import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Cloudflare C0 Worker", () => {
  it("reports the backend instance and generation", async () => {
    const response = await worker.fetch(
      new IncomingRequest("https://example.test/health"),
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { status: "available" },
      meta: {
        contract_version: "2026-09-19.c0",
        backend_instance: "dragon-boat-training-staging",
      backend_generation: "cf-c1-staging-2",
        writer_epoch: 0,
        environment: "staging"
      }
    });
  });

  it("protects C0 internal routes", async () => {
    const response = await worker.fetch(
      new IncomingRequest("https://example.test/internal/c0/state"),
      env
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "C0_ACCESS_DENIED" }
    });
  });

  it("returns the same metadata on Worker, DO and validation responses", async () => {
    const call = (path: string, init?: RequestInit<IncomingRequestCfProperties>) => worker.fetch(new IncomingRequest(`https://example.test${path}`, init), env);
    const cases = [
      await call("/health?request_id=health_request_01"),
      await call("/internal/c0/state?request_id=state_request_01", { headers: { authorization: "Bearer local-c0-test-key" } }),
      await call("/internal/c0/commit", { method: "POST", headers: { authorization: "Bearer local-c0-test-key" },
        body: JSON.stringify({ request_id: "invalid_amount_01", actor_scope: "test", action: "test", amount: false }) }),
      await call("/internal/c0/bridge-probe", { method: "POST", headers: { authorization: "Bearer local-c0-test-key" },
        body: JSON.stringify({ request_id: "invalid_scenario_01", challenge: "test", scenario: null }) })
    ];
    for (const [index, response] of cases.entries()) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        ok: index < 2,
        meta: { contract_version: env.CONTRACT_VERSION, backend_instance: env.BACKEND_INSTANCE,
          backend_generation: env.BACKEND_GENERATION, writer_epoch: 0,
          request_id: ["health_request_01", "state_request_01", "invalid_amount_01", "invalid_scenario_01"][index] }
      });
    }
  });

  it("normalizes a rejected DO fetch and hides all internal routes in production", async () => {
    const brokenEnv = { ...env, TEAM_STATE: { getByName() { return { fetch: async () => { throw new Error("private diagnostic"); } }; } } } as unknown as Env;
    const response = await worker.fetch(new IncomingRequest("https://example.test/internal/c0/state", {
      headers: { authorization: "Bearer local-c0-test-key" }
    }), brokenEnv);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("private diagnostic");
    expect(JSON.parse(body)).toMatchObject({ error: { code: "INTERNAL_ERROR", retryable: true }, meta: { contract_version: env.CONTRACT_VERSION } });
    for (const path of ["state", "commit", "bridge-probe"]) {
      const hidden = await worker.fetch(new IncomingRequest(`https://example.test/internal/c0/${path}`, {
        method: "POST", headers: { authorization: "Bearer local-c0-test-key" }
      }), { ...env, ENVIRONMENT: "production" } as Env);
      expect(hidden.status).toBe(404);
    }
  });
});
