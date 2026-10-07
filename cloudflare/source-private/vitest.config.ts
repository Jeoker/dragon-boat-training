import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { buildSync } from "esbuild";

// Real business Worker/TeamState and named authority RPC; only Google is modeled.
// Keep the fixture bundle in memory so it cannot be confused with a deploy artifact.
const business = buildSync({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, write: false,
  format: "esm", target: "es2022", external: ["cloudflare:workers"] }).outputFiles[0].text;
const privateName = "dragon-boat-training-source-private-test";
// Vitest renames the main Worker; its own loopback binding is rewritten by the
// plugin, while the auxiliary Worker must use the stable, explicitly named pool.
const poolName = "vitest-plugin-runner-private-source";
const businessName = "private-source-business-fixture";
const teamId = "private-source-fixture-team";

export default defineConfig({
  plugins: [cloudflareTest({ main: "./cloudflare/source-private/test/worker-entrypoint.ts",
    wrangler: { configPath: "./cloudflare/source-private/wrangler.jsonc" },
    miniflare: {
      bindings: { SOURCE_TEAM_ID: teamId, SOURCE_BACKEND_GENERATION: "private-source-fixture-generation", SOURCE_WRITER_EPOCH: "0",
        SOURCE_GOOGLE_OAUTH_CLIENT_ID: "fictional-client.apps.googleusercontent.com", SOURCE_GOOGLE_OAUTH_CLIENT_SECRET: "FICTIONAL_CLIENT_SECRET",
        SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN: "FICTIONAL_REFRESH_TOKEN" },
      serviceBindings: { BUSINESS_SOURCE_AUTHORITY: { name: businessName, entrypoint: "SourceAuthority" },
        TEST_BUSINESS_API: businessName, PRIVATE_RUNTIME_TEST: { name: privateName, entrypoint: "SourceRuntime" } },
      workers: [{ name: businessName, modules: true, script: business, compatibilityDate: "2026-09-19",
        outboundService: { name: poolName, entrypoint: "TestGoogleTransport" },
        bindings: { ENVIRONMENT: "staging", SERVICE_VERSION: "private-runtime-fixture", CONTRACT_VERSION: "2026-09-19.c0",
          BACKEND_INSTANCE: "private-source-fixture", BACKEND_GENERATION: "private-source-fixture-generation", WRITER_EPOCH: "0", TEAM_ID: teamId,
          C1_TEST_KEY: "local-c1-test-key", C2_TEST_KEY: "local-c2-test-key", COACH_CODE_SECRET: "local-c1-coach-secret",
          SESSION_SECRET: "local-c1-session-secret", COACH_SESSION_TTL_SECONDS: "28800",
          GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/fixture-native/exec", GOOGLE_BRIDGE_SECRET: "fixture-native-bridge-secret",
          C2_FORM_POLL_ENABLED: "false", C2_EXPORT_POLL_ENABLED: "false" },
        durableObjects: { TEAM_STATE: { className: "TeamState", useSQLite: true } },
        serviceBindings: { PRIVATE_SOURCE_RUNTIME: { name: poolName, entrypoint: "SourceRuntime" } } }]
    } })],
  test: { name: "private-source", include: ["cloudflare/source-private/test/**/*.test.ts"],
    exclude: ["cloudflare/source-private/test/recovery-entry.test.ts"], testTimeout: 45_000 }
});
