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
        backend_generation: "cf-c0-staging-1",
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
});
