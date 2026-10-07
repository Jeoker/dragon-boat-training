import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { privateDirectory, target } from "./backup-cli-test-runtime.mjs";
import { assertPrivatePath } from "../backend/source-journal/private-paths.mjs";

const setupScript = join(process.cwd(), "backend", "backup", "setup-private-config.ps1");
assert.match(await readFile("backend/backup/README.md", "utf8"), /setup-private-config\.ps1/u);
const mock = `
Add-Type -TypeDefinition @'
public sealed class SetupTestHttpResponse : System.Net.WebResponse {
  public static int ResponseReads = 0;
  public System.Net.HttpStatusCode StatusCode { get; set; }
  public override System.IO.Stream GetResponseStream() {
    ResponseReads++;
    return new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes("INJECTED-HTTP-SECRET-BODY-SENTINEL"));
  }
}
'@
$global:setupTestPrompts = 0
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  $global:setupTestPrompts++
  if (-not $AsSecureString) { throw 'TEST_INPUT_NOT_SECURE' }
  if ($Prompt -eq 'Existing isolated C1_TEST_KEY') { return ConvertTo-SecureString 'SETUP-TEST-TRANSPORT-SENTINEL' -AsPlainText -Force }
  if ($Prompt -eq 'Isolated Coach Code') { return ConvertTo-SecureString 'SETUP-TEST-CODE-SENTINEL' -AsPlainText -Force }
  throw 'TEST_UNEXPECTED_INPUT'
}
$global:setupTestCalls = 0
function Invoke-RestMethod {
  param($Method, $Uri, $Headers, $ContentType, $Body, $MaximumRedirection, $TimeoutSec)
  $global:setupTestCalls++
  if ($Method -ne 'Post' -or $Headers.Authorization -ne 'Bearer SETUP-TEST-TRANSPORT-SENTINEL' -or
      $ContentType -ne 'application/json' -or $MaximumRedirection -ne 0 -or $TimeoutSec -ne 30) { throw 'TEST_UNEXPECTED_HTTP' }
  $request = $Body | ConvertFrom-Json
  if (-not ($request.request_id -is [string]) -or $request.request_id.Length -lt 16) { throw 'TEST_BAD_REQUEST_ID' }
  $meta = @{ request_id=$request.request_id; contract_version='2026-09-21.c1.5'; environment='staging';
    backend_instance='dragon-boat-training-c2-test'; backend_generation='cf-c2-isolated-1'; writer_epoch=0; service_version='0.17.0-c2-associated-export' }
  $token = 'SETUP-TEST-SESSION-SENTINEL-AT-LEAST-32-CHARACTERS'
  if ($env:SETUP_TEST_MODE -in @('http401','http403')) {
    $testResponse = New-Object SetupTestHttpResponse
    $testResponse.StatusCode = [System.Net.HttpStatusCode]([int]$env:SETUP_TEST_MODE.Substring(4))
    throw (New-Object System.Net.WebException('INJECTED-HTTP-SECRET-MESSAGE-SENTINEL',$null,[System.Net.WebExceptionStatus]::ProtocolError,$testResponse))
  }
  switch ($Uri) {
    'https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/internal/c1/coach-login' {
      if ($global:setupTestCalls -ne 1 -or $request.coach_code -ne 'SETUP-TEST-CODE-SENTINEL') { throw 'TEST_BAD_LOGIN' }
      $data = @{ result=@{ coach_id='coach_setup_test'; session_token=$token } }
    }
    'https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/internal/c1/coach-bootstrap' {
      if ($global:setupTestCalls -ne 2 -or $request.session_token -ne $token) { throw 'TEST_BAD_BOOTSTRAP' }
      $data = @{ coach=@{ coach_id='coach_setup_test' } }
    }
    'https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/internal/c1/get-operations' {
      if ($global:setupTestCalls -ne 3 -or $request.session_token -ne $token) { throw 'TEST_BAD_OPERATIONS' }
      $data = @{ schema_version=16 }
    }
    default { throw 'TEST_NETWORK_FORBIDDEN' }
  }
  if ($env:SETUP_TEST_BAD_META -eq '1') { $meta.backend_instance='UNTRUSTED-SETUP-INSTANCE' }
  if ($env:SETUP_TEST_MODE -eq 'actor' -and $global:setupTestCalls -eq 2) { $data.coach.coach_id='UNTRUSTED-SETUP-ACTOR' }
  if ($env:SETUP_TEST_MODE -eq 'schema' -and $global:setupTestCalls -eq 3) { $data.schema_version=17 }
  if ($env:SETUP_TEST_MODE -eq 'version' -and $global:setupTestCalls -eq 3) { $meta.service_version='UNTRUSTED-SETUP-VERSION' }
  if ($env:SETUP_TEST_MODE -eq 'envelope') { return @{ ok=$false; meta=$meta; error=@{ code='INJECTED-UNTRUSTED-ERROR-CODE-SENTINEL' } } }
  if ($env:SETUP_TEST_MODE -eq 'writeconfig' -and $global:setupTestCalls -eq 3) {
    [IO.File]::WriteAllText((Join-Path $env:SETUP_TEST_ROOT 'config.json'),'TEST-DO-NOT-OVERWRITE-CONFIG')
  }
  return @{ ok=$true; meta=$meta; data=$data }
}
`;
async function run(script, root, extra = {}) {
  return new Promise(resolve => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
      windowsHide: true, env: { ...process.env, PSModulePath: undefined, SETUP_TEST_ROOT: root, SETUP_TEST_SCRIPT: setupScript, ...extra }, stdio: ["ignore", "pipe", "pipe"]
    });
    let output = ""; child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
test("actual operator setup file runs real Windows ACL/JSON with secure test input and rejects unsafe paths before prompts or HTTP", { skip: process.platform !== "win32" }, async () => {
  const directory = await privateDirectory(), root = join(directory, "fresh-setup"), script = join(directory, "guide.ps1");
  try {
    await writeFile(script, mock + `
try { & $env:SETUP_TEST_SCRIPT -PrivateDirectory $env:SETUP_TEST_ROOT }
finally {
  if ([SetupTestHttpResponse]::ResponseReads -ne 0) { [Console]::Error.WriteLine('TEST_UNEXPECTED_RESPONSE_BODY_READ'); exit 97 }
  if ($env:SETUP_TEST_EXPECT_NO_PROMPTS -eq '1' -and ($global:setupTestPrompts -ne 0 -or $global:setupTestCalls -ne 0)) {
    [Console]::Error.WriteLine('TEST_UNEXPECTED_INPUT_OR_NETWORK'); exit 99
  }
}
`);
    const result = await run(script, root);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.output.trim(), "PRIVATE_BACKUP_CONFIG_READY");
    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    const credentialsText = await readFile(join(root, "credentials.json"), "utf8");
    assert.deepEqual(config.server, target);
    assert.equal(config.schema_version, 16);
    assert.match(config.request_id, /^backup_[a-f0-9]{32}$/u);
    assert.equal(config.credentials_file, join(root, "credentials.json"));
    assert.equal(config.store_directory, join(root, "checkpoint"));
    assert.equal(config.output_file, join(root, "output", "protected-backup.json"));
    assert.deepEqual(JSON.parse(credentialsText), { transport_key: "SETUP-TEST-TRANSPORT-SENTINEL", session_token: "SETUP-TEST-SESSION-SENTINEL-AT-LEAST-32-CHARACTERS" });
    assert.ok(!credentialsText.includes("SETUP-TEST-CODE-SENTINEL"));
    for (const path of [root, config.store_directory, join(root, "output")]) await assertPrivatePath(path, true);
    for (const path of [config.credentials_file, join(root, "config.json")]) await assertPrivatePath(path);
    assert.deepEqual(await readdir(config.store_directory), []);
    const original = await readFile(join(root, "config.json"));
    const repeat = await run(script, root, { SETUP_TEST_EXPECT_NO_PROMPTS: "1" });
    assert.notEqual(repeat.code, 0); assert.match(repeat.output, /BACKUP_SETUP_UNCONFIRMED/u);
    assert.match(repeat.output, /phase=PATH reason=EXISTING_DIRECTORY/u);
    assert.notEqual(repeat.code, 99); assert.ok(!repeat.output.includes("TEST_UNEXPECTED_INPUT_OR_NETWORK"));
    assert.deepEqual(await readFile(join(root, "config.json")), original);
    const badRoot = join(directory, "bad-setup"), failed = await run(script, badRoot, { SETUP_TEST_BAD_META: "1" });
    assert.notEqual(failed.code, 0); assert.match(failed.output, /BACKUP_SETUP_UNCONFIRMED/u);
    assert.match(failed.output, /phase=LOGIN reason=IDENTITY_MISMATCH field=backend_instance/u);
    assert.deepEqual((await readdir(badRoot)).sort(), ["checkpoint", "output"]);
    for (const invalidRoot of ["relative-private-backup-test", join(process.cwd(), "test-private-backup-directory")]) {
      const denied = await run(script, invalidRoot, { SETUP_TEST_EXPECT_NO_PROMPTS: "1" });
      assert.notEqual(denied.code, 0); assert.notEqual(denied.code, 99); assert.match(denied.output, /BACKUP_SETUP_UNCONFIRMED/u);
      assert.ok(!denied.output.includes("TEST_UNEXPECTED_INPUT_OR_NETWORK"));
    }
    for (const [mode, diagnostic] of [
      ["http401", "phase=LOGIN reason=HTTP_FAILURE status=401"], ["http403", "phase=LOGIN reason=HTTP_FAILURE status=403"],
      ["envelope", "phase=LOGIN reason=RESPONSE_NOT_CONFIRMED"], ["actor", "phase=ACTOR_SCHEMA reason=ACTOR_MISMATCH field=coach_id"],
      ["schema", "phase=ACTOR_SCHEMA reason=SCHEMA_MISMATCH field=schema_version"], ["version", "phase=ACTOR_SCHEMA reason=SERVICE_VERSION_MISMATCH field=service_version"],
      ["writeconfig", "phase=WRITE_CONFIG reason=LOCAL_OPERATION_FAILED"]
    ]) {
      const caseRoot = join(directory, `diagnostic-${mode}`), denied = await run(script, caseRoot, { SETUP_TEST_MODE: mode });
      assert.notEqual(denied.code, 0); assert.notEqual(denied.code, 97); assert.ok(denied.output.includes(diagnostic), denied.output);
      for (const value of ["SETUP-TEST-TRANSPORT-SENTINEL", "SETUP-TEST-CODE-SENTINEL", "SETUP-TEST-SESSION-SENTINEL", "INJECTED-HTTP-SECRET", "INJECTED-UNTRUSTED-ERROR-CODE", "UNTRUSTED-SETUP-ACTOR", "UNTRUSTED-SETUP-VERSION"])
        assert.ok(!denied.output.includes(value));
      assert.ok(!denied.output.includes("TEST_UNEXPECTED_RESPONSE_BODY_READ"));
      if (mode === "writeconfig") assert.equal(await readFile(join(caseRoot, "config.json"), "utf8"), "TEST-DO-NOT-OVERWRITE-CONFIG");
      else assert.deepEqual((await readdir(caseRoot)).sort(), ["checkpoint", "output"]);
    }
    for (const response of [result, repeat, failed]) for (const value of ["SETUP-TEST-TRANSPORT-SENTINEL", "SETUP-TEST-CODE-SENTINEL", "SETUP-TEST-SESSION-SENTINEL", "UNTRUSTED-SETUP-INSTANCE"])
      assert.ok(!response.output.includes(value));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
