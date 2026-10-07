// Local release preparation only. This tool never deploys or reads credentials.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const artifactDirectory = resolve(root, "cloudflare/.bootstrap-c2test");
export const configFile = resolve(artifactDirectory, "wrangler.json");
const fail = () => { throw new Error("C2_BOOTSTRAP_CONFIG_UNCONFIRMED"); };
const digest = text => `sha256_v1:${createHash("sha256").update(text).digest("base64url")}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
}

export function bootstrapConfig(source) {
  // Explicit allowlists make new deployment capabilities require review rather
  // than silently inheriting a route, migration, build hook or secret variable.
  keys(source, ["$schema", "name", "main", "compatibility_date", "workers_dev", "triggers", "observability", "vars", "durable_objects", "exports", "env"]);
  const isolated = source.env?.c2test;
  keys(isolated, ["name", "services", "triggers", "vars", "durable_objects"]);
  if (source.main !== "src/index.ts" || isolated.name !== "dragon-boat-training-api-c2-test" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(source.compatibility_date) || source.workers_dev !== true ||
      !same(source.exports, { TeamState: { type: "durable-object", storage: "sqlite" } }) ||
      !same(isolated.durable_objects, { bindings: [{ name: "TEAM_STATE", class_name: "TeamState" }] }) ||
      !same(isolated.triggers, { crons: [] })) fail();
  const vars = isolated.vars;
  const identities = { ENVIRONMENT: "staging", BACKEND_INSTANCE: "dragon-boat-training-c2-test",
    BACKEND_GENERATION: "cf-c2-isolated-1", WRITER_EPOCH: "0", TEAM_ID: "pentasus-c2-test" };
  const flags = ["C2_FORM_POLL_ENABLED", "C2_MEMBER_EXPORT_ENABLED", "C2_SCHEDULE_EXPORT_ENABLED",
    "C2_ASSOCIATED_EXPORT_ENABLED", "C2_EXPORT_POLL_ENABLED"];
  keys(vars, [...Object.keys(identities), "SERVICE_VERSION", "CONTRACT_VERSION", ...flags]);
  if (Object.entries(identities).some(([key, value]) => vars[key] !== value) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+-c2-[a-z0-9-]+$/u.test(vars.SERVICE_VERSION) ||
      vars.CONTRACT_VERSION !== "2026-09-19.c0" || flags.some(key => !["true", "false"].includes(vars[key])) ||
      vars.C2_FORM_POLL_ENABLED !== "false" || vars.C2_EXPORT_POLL_ENABLED !== "false") fail();
  const allowedServices = {
    PRIVATE_SOURCE_RUNTIME: { binding: "PRIVATE_SOURCE_RUNTIME", service: "dragon-boat-training-source-private-test", entrypoint: "SourceRuntime" },
    ISOLATED_RECOVERY_RUNTIME: { binding: "ISOLATED_RECOVERY_RUNTIME", service: "dragon-boat-training-recovery-test", entrypoint: "RecoveryRuntime" }
  };
  if (!Array.isArray(isolated.services ?? [])) fail();
  const seen = new Set();
  for (const service of isolated.services ?? []) {
    if (!same(service, allowedServices[service.binding]) || seen.has(service.binding)) fail();
    seen.add(service.binding);
  }
  // Flatten ONLY c2test. No staging/production environments or inherited cron.
  return { "$schema": "../../node_modules/wrangler/config-schema.json", name: isolated.name,
    main: "../src/index.ts", compatibility_date: source.compatibility_date,
    workers_dev: true, preview_urls: false, routes: [], triggers: { crons: [] },
    observability: { enabled: false }, vars: { ...vars },
    durable_objects: structuredClone(isolated.durable_objects), exports: structuredClone(source.exports), services: [] };
}

export async function prepareBootstrap() {
  const input = await readFile(resolve(root, "cloudflare/wrangler.jsonc"), "utf8");
  const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", input);
  if (parsed.error) fail();
  const config = bootstrapConfig(parsed.config);
  const schema = await readFile(resolve(root, "cloudflare/src/schema.ts"), "utf8");
  if (!/export const APPLICATION_SCHEMA_VERSION = 16;/u.test(schema)) fail();
  const text = JSON.stringify(config, null, 2) + "\n";
  const manifest = { format: "c2-bootstrap-config-v1", status: "LOCAL_CONFIG_ONLY", schema_version: 16,
    worker: config.name, source_config_digest: digest(input), generated_config_digest: digest(text),
    service_version: config.vars.SERVICE_VERSION, automatic_polling: false, crons: [], runtime_services: [],
    remote_gates: ["CURRENT_AUTHENTICATED_IDENTITY_AND_QUEUE", "FRESH_PROTECTED_BACKUP_AND_INDEPENDENT_DIGEST",
      "ORIGINAL_BACKUP_SQLITE_DRILL", "ACCOUNT_NAMESPACE_AND_SECRETS", "POST_DEPLOY_SCHEMA_AND_DATA_RECONCILIATION"] };
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(configFile, text);
  await writeFile(resolve(artifactDirectory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export function dryRunArguments() {
  return [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", configFile,
    "--env=", "--dry-run", "--outdir", resolve(artifactDirectory, "bundle")];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...extra] = process.argv.slice(2);
    if (!["prepare", "dry-run"].includes(mode) || extra.length) fail();
    const manifest = await prepareBootstrap();
    console.log(JSON.stringify(manifest));
    if (mode === "dry-run") {
      const status = await new Promise((done, reject) => {
        const child = spawn(process.execPath, dryRunArguments(), { cwd: root, stdio: "inherit", shell: false, windowsHide: true,
          env: { ...process.env, WRANGLER_LOG_PATH: resolve(artifactDirectory, "wrangler.log"), WRANGLER_SEND_METRICS: "false" } });
        child.on("error", reject); child.on("exit", code => done(code ?? 1));
      });
      if (status !== 0) fail();
      const bundle = await readFile(resolve(artifactDirectory, "bundle/index.js"), "utf8");
      if (!/export\s*\{[^}]*\bSourceAuthority\b[^}]*\bTeamState\b[^}]*\}/su.test(bundle)) fail();
      const packaged = { ...manifest, status: "LOCAL_BUNDLE_READY", bundle_digest: digest(bundle), bundle_bytes: Buffer.byteLength(bundle),
        named_source_authority_exported: true };
      await writeFile(resolve(artifactDirectory, "manifest.json"), JSON.stringify(packaged, null, 2) + "\n");
      console.log(JSON.stringify(packaged));
    }
  } catch { console.error("C2_BOOTSTRAP_CONFIG_UNCONFIRMED"); process.exitCode = 1; }
}
