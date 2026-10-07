import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const target = { origin: "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev",
  team_id: "pentasus-c2-test", backend_instance: "dragon-boat-training-c2-test", backend_generation: "cf-c2-isolated-1", writer_epoch: 0 };
export const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ?
  `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
export const hash = text => "sha256_v1:" + createHash("sha256").update(text).digest("base64url");
export function reseal(bundle) {
  for (const chunk of bundle.chunks) {
    chunk.payload_digest = hash(canonical(chunk.payload));
    Object.assign(bundle.manifest.chunks[chunk.chunk_index], { payload_digest: chunk.payload_digest });
  }
  const { content_digest: _, ...core } = bundle.manifest;
  bundle.manifest.content_digest = hash(canonical(core)); return bundle;
}
export function legacyBundle(current) {
  const bundle = structuredClone(current), names = bundle.manifest.tables.slice(0, 47).map(table => table.name);
  bundle.manifest.schema_version = 14; bundle.manifest.tables = bundle.manifest.tables.slice(0, 47);
  bundle.manifest.table_count = 47; bundle.chunks = bundle.chunks.filter(chunk => names.includes(chunk.table_name));
  bundle.manifest.chunk_count = bundle.chunks.length; bundle.manifest.chunks = bundle.manifest.chunks.slice(0, bundle.chunks.length);
  bundle.manifest.record_count = bundle.manifest.tables.reduce((sum, table) => sum + table.row_count, 0);
  bundle.chunks.find(chunk => chunk.table_name === "app_meta").payload.rows.find(row => row.key === "schema_version").value = "14";
  return reseal(bundle);
}
export async function privateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "dbt-business-backup-test-"));
  if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference='Stop'; $p=$env:DBT_BACKUP_TEST_DIRECTORY;
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid);
    $acl.SetAccessRuleProtection($true,$false);
    foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
      $id=New-Object System.Security.Principal.SecurityIdentifier($s);
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
      $acl.AddAccessRule($rule)
    }; Set-Acl -LiteralPath $p -AclObject $acl
  `], { env: { ...process.env, PSModulePath: undefined, DBT_BACKUP_TEST_DIRECTORY: directory }, windowsHide: true });
  return directory;
}
const compiled = await build({ entryPoints: ["cloudflare/test/backup-cli-fixture-worker.ts"], bundle: true, write: false,
  format: "esm", target: "es2022", external: ["cloudflare:workers"] });
export async function fixture() {
  const directory = await privateDirectory(), configPath = join(directory, "config.json"), credentials = join(directory, "credentials.json");
  const worker = new Miniflare(convertV4MiniflareOptions({ name: "backup-cli-fixture", modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate: "2026-09-19", bindings: { ENVIRONMENT: "staging", SERVICE_VERSION: "0.17.0-c2-associated-export",
      CONTRACT_VERSION: "2026-09-19.c0", TEAM_ID: target.team_id, BACKEND_INSTANCE: target.backend_instance,
      BACKEND_GENERATION: target.backend_generation, WRITER_EPOCH: "0", COACH_CODE_SECRET: "fixture-backup-coach-secret", SESSION_SECRET: "fixture-session-secret",
      COACH_SESSION_TTL_SECONDS: "28800", C1_TEST_KEY: "PRIVATE_BACKUP_KEY_SENTINEL", C2_TEST_KEY: "fixture-c2-key",
      C2_FORM_POLL_ENABLED: "false", C2_EXPORT_POLL_ENABLED: "false" },
    durableObjects: { TEAM_STATE: { className: "BackupFixtureState", useSQLite: true }, FIXTURE_RECOVERY: { className: "BackupFixtureRecovery", useSQLite: true } } }));
  const invoke = async (path, body, auth = true) => {
    const response = await worker.dispatchFetch("https://fixture.test" + path, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer PRIVATE_BACKUP_KEY_SENTINEL" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try { return { status: response.status, body: await response.json() }; }
    catch { throw Error(`FIXTURE_BODY_FAILED:${path}:${response.status}`); }
  };
  const seeded = (await invoke("/__fixture/seed", undefined, false)).body;
  const login = await invoke("/internal/c1/coach-login", { request_id: "backup_fixture_login", coach_code: "fixture-cli-code" });
  if (!login.body.ok) { await worker.dispose(); await rm(directory, { recursive: true, force: true }); throw Error(`FIXTURE_LOGIN_FAILED:${login.body.error?.code}`); }
  const session_token = login.body.data.result.session_token;
  const config = { format: "c2-isolated-business-backup-v1", server: target, schema_version: 16,
    request_id: "business_backup_cli_request_001", credentials_file: credentials, store_directory: join(directory, "checkpoints"),
    output_file: join(directory, "protected-backup.json") };
  await mkdir(config.store_directory, { mode: 0o700 });
  await writeFile(credentials, JSON.stringify({ transport_key: "PRIVATE_BACKUP_KEY_SENTINEL", session_token }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const state = { calls: [], hook: null, deny: false, snapshot: null };
  const server = createServer(async (request, response) => {
    try {
      let text = ""; for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : undefined, path = new URL(request.url, "http://localhost").pathname;
      state.calls.push({ path, body, auth: request.headers.authorization });
      const call = { path, body, request, response, invoke };
      if (state.hook && await state.hook(call)) return;
      const result = state.deny ? { status: 403, body: { ok: false, error: { code: "PRIVATE_SERVER_DENIED_SENTINEL" } } } : await invoke(path, body);
      response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(result.body));
    } catch { response.writeHead(500); response.end("PRIVATE_FIXTURE_SERVER_SENTINEL"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const preload = join(directory, "test-transport.mjs");
  await writeFile(preload, `const real=globalThis.fetch;globalThis.fetch=async(url,init)=>{
    const remote=new URL(url);if(remote.origin!==${JSON.stringify(target.origin)})throw Error('TEST_NETWORK_FORBIDDEN');
    const response=await real(${JSON.stringify(localOrigin)}+remote.pathname+remote.search,init);
    Object.defineProperty(response,'url',{value:remote.href});return response;};`, { mode: 0o600 });
  const child = async (args, extra = {}, entrypoint = "backend/backup/cli.mjs") => new Promise(resolve => {
    const processChild = spawn(process.execPath, ["--import", pathToFileURL(preload).href, entrypoint, ...args], {
      windowsHide: true, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; processChild.stdout.on("data", chunk => { output += chunk; }); processChild.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => processChild.kill(), 60_000);
    processChild.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  return { directory, configPath, config, credentials, session_token, seeded, state, invoke, child,
    saveConfig: async () => writeFile(configPath, JSON.stringify(config)),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await worker.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
