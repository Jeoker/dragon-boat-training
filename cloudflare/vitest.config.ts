import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./cloudflare/wrangler.jsonc" },
      miniflare: {
        bindings: {
          C0_TEST_KEY: "local-c0-test-key",
          C1_TEST_KEY: "local-c1-test-key",
          C2_TEST_KEY: "local-c2-test-key",
          COACH_CODE_SECRET: "local-c1-coach-secret",
          SESSION_SECRET: "local-c1-session-secret",
          COACH_SESSION_TTL_SECONDS: "28800",
          GOOGLE_BRIDGE_URL: "https://script.google.com/macros/s/local-fixture/exec",
          GOOGLE_BRIDGE_SECRET: "local-test-bridge-secret",
          C2_MEMBER_EXPORT_ENABLED: "true",
          C2_SCHEDULE_EXPORT_ENABLED: "true",
          C2_ASSOCIATED_EXPORT_ENABLED: "true",
          C2_EXPORT_POLL_ENABLED: "true"
        }
      }
    })
  ],
  test: {
    include: ["cloudflare/test/**/*.test.ts"],
    testTimeout: 45_000
  }
});
