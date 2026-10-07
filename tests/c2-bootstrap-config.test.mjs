import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { bootstrapConfig, dryRunArguments } from "../cloudflare/tools/c2-bootstrap.mjs";

const original = ts.parseConfigFileTextToJson("wrangler.jsonc",
  await readFile(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8")).config;

test("first release targets the existing c2test Worker/SQLite with no runtime dependency or inherited staging cron", () => {
  const before = JSON.stringify(original), config = bootstrapConfig(original);
  assert.equal(config.name, "dragon-boat-training-api-c2-test");
  assert.deepEqual(config.vars, original.env.c2test.vars);
  assert.deepEqual(config.durable_objects, original.env.c2test.durable_objects);
  assert.deepEqual(config.exports, original.exports);
  assert.deepEqual(config.services, []);
  assert.deepEqual(config.triggers, { crons: [] });
  assert.deepEqual(config.routes, []);
  assert.equal(config.observability.enabled, false);
  assert.equal(config.preview_urls, false);
  assert.equal(Object.hasOwn(config, "env"), false);
  assert.equal(Object.hasOwn(config, "migrations"), false);
  assert.equal(JSON.stringify(original), before);
});

test("both known runtime bindings can be omitted together without changing identity or manual export controls", () => {
  const input = structuredClone(original);
  input.env.c2test.services.push({ binding: "ISOLATED_RECOVERY_RUNTIME", service: "dragon-boat-training-recovery-test", entrypoint: "RecoveryRuntime" });
  assert.deepEqual(bootstrapConfig(input).services, []);
  assert.equal(bootstrapConfig(input).vars.C2_ASSOCIATED_EXPORT_ENABLED, "true");
});

for (const [name, mutate] of [
  ["production target", v => { v.env.c2test.name = v.env.production.name; }],
  ["changed namespace", v => { v.env.c2test.durable_objects.bindings[0].script_name = "other-worker"; }],
  ["namespace transfer", v => { v.exports.TeamState.state = "expecting-transfer"; }],
  ["changed generation", v => { v.env.c2test.vars.BACKEND_GENERATION = "unreviewed-generation"; }],
  ["changed writer epoch", v => { v.env.c2test.vars.WRITER_EPOCH = "1"; }],
  ["automatic export", v => { v.env.c2test.vars.C2_EXPORT_POLL_ENABLED = "true"; }],
  ["automatic import", v => { v.env.c2test.vars.C2_FORM_POLL_ENABLED = "true"; }],
  ["missing explicit polling flag", v => { delete v.env.c2test.vars.C2_EXPORT_POLL_ENABLED; }],
  ["isolated cron", v => { v.env.c2test.triggers.crons.push("* * * * *"); }],
  ["unknown runtime binding", v => { v.env.c2test.services.push({ binding: "OTHER", service: "unreviewed" }); }],
  ["wrong source service", v => { v.env.c2test.services[0].service = "source-production"; }],
  ["duplicate runtime binding", v => { v.env.c2test.services.push(v.env.c2test.services[0]); }],
  ["secret in vars", v => { v.env.c2test.vars.C1_TEST_KEY = "PRIVATE_SENTINEL"; }],
  ["build hook", v => { v.build = { command: "unreviewed-command" }; }],
  ["new route", v => { v.env.c2test.routes = ["example.com/*"]; }],
  ["imperative migration", v => { v.migrations = [{ tag: "delete", deleted_classes: ["TeamState"] }]; }]
]) test(`bootstrap refuses ${name} rather than silently flattening it`, () => {
  const input = structuredClone(original); mutate(input);
  assert.throws(() => bootstrapConfig(input), /^Error: C2_BOOTSTRAP_CONFIG_UNCONFIRMED$/u);
});

test("the only Wrangler invocation is a fixed dry-run with no environment or target override", () => {
  const args = dryRunArguments();
  assert.ok(args.includes("--dry-run"));
  assert.ok(args.includes("--env="));
  assert.equal(args.includes("--env production"), false);
  assert.equal(args.includes("--name"), false);
});
