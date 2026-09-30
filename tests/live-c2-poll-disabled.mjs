// Verify the disposable c2test poll switch has been restored remotely.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
assert.equal(config.env.c2test.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.deepEqual(config.env.c2test.triggers.crons, []);
assert.equal(config.vars.C2_EXPORT_POLL_ENABLED, "false");
assert.equal(config.env.production.vars.C2_EXPORT_POLL_ENABLED, "false");
const base = new URL(process.env.C2_TEST_URL || "");
assert.equal(base.href, "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/");
const key = process.env.C2_TEST_KEY;
assert.ok(key);
const healthResponse = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(20_000) });
const health = await healthResponse.json();
assert.equal(healthResponse.status, 200);
assert.equal(health.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(health.meta?.service_version, "0.16.1-c2-associated-export");
assert.equal(health.meta?.writer_epoch, 0);
const response = await fetch(new URL("/internal/c2/poll-due-exports", base), {
  method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ request_id: `c25_disabled_${randomUUID().replaceAll("-", "")}` }),
  signal: AbortSignal.timeout(30_000)
});
const body = await response.json();
assert.equal(body.meta?.backend_instance, "dragon-boat-training-c2-test");
assert.equal(response.status, 409);
assert.equal(body.ok, false);
assert.equal(body.error?.code, "EXPORT_POLL_DISABLED");
console.log(JSON.stringify({ c2test_poll_disabled: true, remote_status: 409,
  error_code: body.error.code, service_version: health.meta.service_version }));
