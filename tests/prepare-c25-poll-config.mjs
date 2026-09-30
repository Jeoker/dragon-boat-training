// Creates an ignored Wrangler config for the disposable c2test manual-poll trial.
// Never edits the tracked config or deploys a Worker.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";

assert.ok(process.argv.includes("--prepare-isolated-poll"),
  "Explicit --prepare-isolated-poll is required.");
const sourceUrl = new URL("../cloudflare/wrangler.jsonc", import.meta.url);
const targetDir = new URL("../cloudflare/.acceptance-artifacts/", import.meta.url);
const targetUrl = new URL("wrangler-c25-poll.jsonc", targetDir);
const config = JSON.parse(readFileSync(sourceUrl, "utf8"));
assert.equal(config.name, "dragon-boat-training-api-staging");
assert.equal(config.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.equal(config.env.production.name, "dragon-boat-training-api");
assert.equal(config.env.production.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.deepEqual(config.env.production.triggers.crons, []);
assert.equal(config.env.c2test.name, "dragon-boat-training-api-c2-test");
assert.equal(config.env.c2test.vars.BACKEND_INSTANCE, "dragon-boat-training-c2-test");
assert.equal(config.env.c2test.vars.TEAM_ID, "pentasus-c2-test");
assert.equal(config.env.c2test.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.equal(config.env.c2test.vars.C2_FORM_POLL_ENABLED, "false");
assert.deepEqual(config.env.c2test.triggers.crons, []);
assert.equal(config.main, "src/index.ts");
assert.equal(config.$schema, "../node_modules/wrangler/config-schema.json");
config.main = "../src/index.ts";
config.$schema = "../../node_modules/wrangler/config-schema.json";
config.env.c2test.vars.C2_EXPORT_POLL_ENABLED = "true";
mkdirSync(targetDir, { recursive: true });
writeFileSync(targetUrl, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ temporary_config: "cloudflare/.acceptance-artifacts/wrangler-c25-poll.jsonc",
  c2test_name: config.env.c2test.name,
  c2test_poll: config.env.c2test.vars.C2_EXPORT_POLL_ENABLED,
  c2test_crons: config.env.c2test.triggers.crons,
  staging_poll: config.vars.C2_EXPORT_POLL_ENABLED,
  production_poll: config.env.production.vars.C2_EXPORT_POLL_ENABLED }));
