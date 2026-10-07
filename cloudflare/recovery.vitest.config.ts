import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { buildSync } from "esbuild";
import { RECOVERY_WIRE_TARGET, RECOVERY_WIRE_DIGEST } from "./source-private/test/recovery-wire-fixture";

const business = buildSync({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, write: false,
  format: "esm", target: "es2022", external: ["cloudflare:workers"] }).outputFiles[0].text;
const businessName = "recovery-business-fixture";
const poolName = "vitest-plugin-runner-isolated-recovery";
const teamId = "private-source-fixture-team";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./cloudflare/recovery.wrangler.jsonc" }, miniflare: {
    bindings: { SOURCE_TEAM_ID: teamId, SOURCE_BACKEND_GENERATION: "private-source-fixture-generation", SOURCE_WRITER_EPOCH: "0",
      RECOVERY_TARGET_NAME: RECOVERY_WIRE_TARGET, RECOVERY_BUSINESS_DIGEST: RECOVERY_WIRE_DIGEST },
    durableObjects: { TEST_RECOVERY_STATE: { className: "RecoveryState", useSQLite: true } },
    serviceBindings: { BUSINESS_SOURCE_AUTHORITY: { name: businessName, entrypoint: "SourceAuthority" },
      TEST_BUSINESS_API: businessName, TEST_RECOVERY_RPC: { name: "dragon-boat-training-recovery-test", entrypoint: "RecoveryRuntime" } },
    workers: [{ name: businessName, modules: true, script: business, compatibilityDate: "2026-09-19",
      bindings: { ENVIRONMENT: "staging", SERVICE_VERSION: "recovery-fixture", CONTRACT_VERSION: "2026-09-19.c0",
        BACKEND_INSTANCE: "private-source-fixture", BACKEND_GENERATION: "private-source-fixture-generation", WRITER_EPOCH: "0", TEAM_ID: teamId,
        C1_TEST_KEY: "local-c1-test-key", C2_TEST_KEY: "local-c2-test-key", COACH_CODE_SECRET: "local-c1-coach-secret",
        SESSION_SECRET: "local-c1-session-secret", COACH_SESSION_TTL_SECONDS: "28800",
        C2_FORM_POLL_ENABLED: "false", C2_EXPORT_POLL_ENABLED: "false" },
      durableObjects: { TEAM_STATE: { className: "TeamState", useSQLite: true } },
      serviceBindings: { ISOLATED_RECOVERY_RUNTIME: { name: poolName, entrypoint: "RecoveryRuntime" } } }]
  } })],
  test: { name: "isolated-recovery", include: ["cloudflare/source-private/test/recovery-entry.test.ts"], testTimeout: 45_000 }
});
