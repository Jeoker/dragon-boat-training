import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, chmod, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openPrivateHost, readHostConfig } from "../backend/source-journal/host.mjs";
import { readPrivateText, assertPrivatePath } from "../backend/source-journal/private-paths.mjs";
import { sourceModel } from "./source-reader-model.mjs";
import { sha, sourceCanonical } from "./source-journal-test-runtime.mjs";
import { buildPrivateHost } from "../backend/source-journal/build-host.mjs";

await buildPrivateHost();
const { C2_CONTRACT_VERSION } = await import("../backend/.private-host/backend/source-journal/host-runtime.js");

async function privateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "dbt-private-host-"));
  if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference='Stop'; $p=$env:DBT_TEST_PRIVATE_DIRECTORY;
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid);
    $acl.SetAccessRuleProtection($true,$false);
    foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
      $identity=New-Object System.Security.Principal.SecurityIdentifier($s);
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
      $acl.AddAccessRule($rule)
    }; Set-Acl -LiteralPath $p -AclObject $acl
  `], { env: { ...process.env, PSModulePath: undefined, DBT_TEST_PRIVATE_DIRECTORY: directory }, windowsHide: true });
  return directory;
}

async function fixture(directory) {
  const source = sourceModel();
  const core = { format: "c2-source-authority-pin-v1", state: "SERVER_AUTHORITY_PIN_ONLY", actor_id: "fixture_coach",
    source: source.context.source, known_sources: source.context.known_sources,
    response_tab_title: source.context.response_tab_title, census_scope: "DATABASE_KNOWN_IDENTITIES_ONLY",
    pinned_at: source.input.observed_start_at, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
  const pin = { ...core, authority_digest: await sha("c2-source-authority-pin-v1\n" + sourceCanonical(core)) };
  const config = { format: "c2-private-host-v1", server: { origin: "https://fictional-worker.invalid", team_id: core.source.team_id,
    backend_instance: "fictional_instance", backend_generation: core.source.backend_generation, writer_epoch: core.source.writer_epoch },
    request_id: "fixture_host_pin_001", season_id: core.source.season_id, credentials_file: join(directory, "credentials.json"),
    store_directory: join(directory, "records"), oauth: { project_id: "fictional-project", client_file: join(directory, "client.json"), token_file: join(directory, "token.json") } };
  await mkdir(config.store_directory, { mode: 0o700 });
  const files = { "config.json": config, "credentials.json": { transport_key: "PRIVATE_KEY_SENTINEL", session_token: "PRIVATE_SESSION_SENTINEL" },
    "client.json": {}, "token.json": {}, "target.json": { source_operation_id: core.source.source_operation_id,
      attempt_id: "fixture_host_attempt", api_user_permission_id: source.context.api_user_permission_id,
      owner_permission_id: source.context.api_user_permission_id, journal_spreadsheet_id: "fictional_private_journal", journal_sheet_id: 23456 } };
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  const state = { denied: false, pins: 0 };
  const fetchServer = async (_url, init) => {
    state.pins++;
    assert.equal(init.headers.Authorization, "Bearer PRIVATE_KEY_SENTINEL");
    if (state.denied) throw Error("PRIVATE_SERVER_SENTINEL");
    return new Response(JSON.stringify({ ok: true, data: { pin }, meta: { contract_version: C2_CONTRACT_VERSION, request_id: config.request_id,
      environment: "staging", ...config.server, server_time: "2026-10-03T20:00:00Z" } }), { headers: { "content-type": "application/json" } });
  };
  const ports = { fetchServer, fetchGoogle: source.fetch, oauthToken: source.token };
  return { config, pin, source, state, ports, path: join(directory, "config.json"), target: join(directory, "target.json"),
    host: () => openPrivateHost(join(directory, "config.json"), ports) };
}
async function withFixture(fn) {
  const directory = await privateDirectory();
  try { await fn(await fixture(directory), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("host validates current server identity and registers one immutable target without Google reads", async () => {
  await withFixture(async f => {
    const host = await f.host();
    assert.equal((await host.run("validate")).status, "PRIVATE_HOST_CONFIG_AND_AUTHORITY_READY");
    assert.equal((await host.run("register", f.target)).status, "TARGET_REGISTERED");
    assert.equal((await (await f.host()).run("register", f.target)).status, "TARGET_REGISTERED");
    assert.equal(f.source.state.calls.length, 0);
    const changed = JSON.parse(await readFile(f.target)); changed.journal_sheet_id++;
    await writeFile(f.target, JSON.stringify(changed));
    await assert.rejects(host.run("register", f.target), /PRIVATE_HOST_UNCONFIRMED/u);
  });
});

test("compiled host persists capture across recreation and rejects revoked server credentials", async () => {
  await withFixture(async f => {
    const host = await f.host(); await host.run("register", f.target);
    const first = await host.run("capture"), reads = f.source.state.listReads;
    const second = await (await f.host()).run("capture");
    assert.equal(first.phase, "CANDIDATE_DURABLE"); assert.deepEqual(second, first);
    assert.equal(f.source.state.listReads, reads); assert.equal(first.annual_export_authorized, false);
    assert.ok(!JSON.stringify(first).includes("PRIVATE") && !JSON.stringify(first).includes("Fictional"));
    const script = `import {openPrivateHost} from ${JSON.stringify(new URL("../backend/source-journal/host.mjs", import.meta.url).href)};
      let text=''; for await(const part of process.stdin) text+=part;
      const {path,pin,config,version}=JSON.parse(text);
      const host=await openPrivateHost(path,{fetchServer:async()=>new Response(JSON.stringify({ok:true,data:{pin},meta:{
        contract_version:version,request_id:config.request_id,environment:'staging',...config.server}}),{headers:{'content-type':'application/json'}}),
        fetchGoogle:async()=>{throw Error('unexpected Google read')},oauthToken:async()=>{throw Error('unexpected OAuth read')}});
      console.log(JSON.stringify(await host.run('capture')));`;
    const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", input: JSON.stringify({ path: f.path, pin: f.pin, config: f.config, version: C2_CONTRACT_VERSION }), timeout: 30_000,
    }));
    assert.deepEqual(restarted, first);
    f.state.denied = true;
    await assert.rejects((await f.host()).run("capture"), /PRIVATE_HOST_UNCONFIRMED/u);
    assert.equal(f.source.state.listReads, reads);
  });
});

test("a preexisting host lock is retained and stops all server and Google calls", async () => {
  await withFixture(async f => {
    await writeFile(join(f.config.store_directory, "host.lock"), "original", { mode: 0o600 });
    await assert.rejects((await f.host()).run("validate"), /PRIVATE_HOST_UNCONFIRMED/u);
    assert.equal(await readFile(join(f.config.store_directory, "host.lock"), "utf8"), "original");
    assert.equal(f.state.pins, 0); assert.equal(f.source.state.calls.length, 0);
  });
});

test("a lock cleanup failure cannot disclose filesystem paths or leave the in-process busy state stuck", async () => {
  await withFixture(async f => {
    const fetchServer = f.ports.fetchServer, path = join(f.config.store_directory, "host.lock"); let disrupt = true;
    f.ports.fetchServer = async (...args) => {
      const response = await fetchServer(...args);
      if (disrupt) {
        await rename(path, join(f.config.store_directory, "original-lock"));
        await mkdir(path, { mode: 0o700 });
      }
      return response;
    };
    const host = await f.host();
    await assert.rejects(host.run("validate"), error => error.message === "PRIVATE_HOST_UNCONFIRMED" && !error.message.includes(path));
    await rm(path, { recursive: true });
    disrupt = false;
    assert.equal((await host.run("validate")).status, "PRIVATE_HOST_CONFIG_AND_AUTHORITY_READY");
  });
});

test("private config rejects unknown fields, credential collisions and oversized files without disclosure", async () => {
  await withFixture(async (f, directory) => {
    for (const changed of [{ ...f.config, browser_pin: "PRIVATE_SENTINEL" }, { ...f.config, credentials_file: f.config.oauth.token_file }]) {
      await writeFile(f.path, JSON.stringify(changed));
      await assert.rejects(readHostConfig(f.path), /PRIVATE_HOST_UNCONFIRMED/u);
    }
    const large = join(directory, "large.json"); await writeFile(large, "PRIVATE_SENTINEL".repeat(5000), { mode: 0o600 });
    await assert.rejects(readPrivateText(large), /PRIVATE_HOST_PATH_UNCONFIRMED/u);
    await writeFile(f.path, JSON.stringify(f.config).replace('"format":', '"format":"duplicate","format":'));
    await assert.rejects(readHostConfig(f.path), /PRIVATE_HOST_UNCONFIRMED/u);
  });
});

test("ACL checks observe newly broadened permissions and refuse private input without a cached grant", async () => {
  const directory = await privateDirectory(), file = join(directory, "input.json");
  try {
    await writeFile(file, "{}", { mode: 0o600 }); await assertPrivatePath(file);
    if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference='Stop'; $p=$env:DBT_TEST_PRIVATE_FILE; $acl=Get-Acl -LiteralPath $p;
      $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545');
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow');
      $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl
    `], { env: { ...process.env, PSModulePath: undefined, DBT_TEST_PRIVATE_FILE: file }, windowsHide: true });
    else await chmod(file, 0o644);
    await assert.rejects(assertPrivatePath(file), /PRIVATE_HOST_PATH_UNCONFIRMED/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pin export stays in a private new file and cannot overwrite existing metadata", async () => {
  await withFixture(async (f, directory) => {
    const host = await f.host(), output = join(directory, "pin.json");
    assert.equal((await host.run("pin-export", output)).status, "PRIVATE_PIN_EXPORTED");
    assert.deepEqual(JSON.parse(await readFile(output)), f.pin);
    await assert.rejects(host.run("pin-export", output), /PRIVATE_HOST_UNCONFIRMED/u);
    assert.deepEqual(JSON.parse(await readFile(output)), f.pin); assert.equal(f.source.state.calls.length, 0);
  });
});

test("private host path checks reject repository files and filesystem aliases", async () => {
  const directory = await privateDirectory();
  try {
    await assert.rejects(assertPrivatePath(new URL("../package.json", import.meta.url).pathname), /PRIVATE_HOST_PATH_UNCONFIRMED/u);
    await writeFile(join(directory, "original.json"), "{}", { mode: 0o600 });
    if (process.platform === "win32") {
      await symlink(new URL("../", import.meta.url), join(directory, "alias"), "junction");
      await assert.rejects(assertPrivatePath(join(directory, "alias", "package.json")), /PRIVATE_HOST_PATH_UNCONFIRMED/u);
    } else {
      await symlink(join(directory, "original.json"), join(directory, "alias.json"));
      await assert.rejects(assertPrivatePath(join(directory, "alias.json")), /PRIVATE_HOST_PATH_UNCONFIRMED/u);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("host config errors and missing write acknowledgements return only fixed CLI diagnostics", () => {
  for (const args of [["stage", "PRIVATE_PATH_SENTINEL"], ["review-append", "PRIVATE_PATH_SENTINEL", "PRIVATE_COMMAND_SENTINEL"]]) {
    try { execFileSync(process.execPath, ["backend/source-journal/host.mjs", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); assert.fail(); }
    catch (error) { assert.equal(error.stdout, ""); assert.equal(error.stderr.trim(), '{"status":"PRIVATE_HOST_UNCONFIRMED"}'); }
  }
});
