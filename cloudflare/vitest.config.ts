import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./cloudflare/wrangler.jsonc" },
      miniflare: {
        bindings: {
          C0_TEST_KEY: "local-c0-test-key"
        }
      }
    })
  ],
  test: {
    include: ["cloudflare/test/**/*.test.ts"],
    testTimeout: 45_000
  }
});
