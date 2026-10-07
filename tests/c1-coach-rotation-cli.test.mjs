import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fixture, target } from "./backup-cli-test-runtime.mjs";
import { assertPrivatePath } from "../backend/source-journal/private-paths.mjs";

const newCode = "PRIVATE-FICTIONAL-ROTATION-CODE-SENTINEL";
const route = "/internal/c1/rotate-coach-code", entrypoint = "backend/coach/cli.mjs";
async function setup() {
  const f = await fixture();
  try {
    const protectedDownload = await f.child(["download", f.configPath, "--create-protected-snapshot"]);
    assert.equal(protectedDownload.code, 0, protectedDownload.output);
    const protection = JSON.parse(await readFile(f.config.output_file, "utf8"));
    const rows = (await f.invoke("/__fixture/rows", undefined, false)).body;
    const actor = rows.coaches[0].coach_id;
    const configPath = join(f.directory, "rotation-config.json"), codePath = join(f.directory, "new-code.json"), store = join(f.directory, "rotation-store");
    await mkdir(store, { mode: 0o700 }); await writeFile(codePath, JSON.stringify({ new_code: newCode }), { mode: 0o600 });
    const config = { format: "c1-self-coach-rotation-v1", server: target, schema_version: 16, coach_id: actor,
      expected_credential_version: 1, request_id: "private_rotation_cli_001", credentials_file: f.credentials, new_code_file: codePath,
      protection_file: f.config.output_file, protection_digest: protection.manifest.content_digest, store_directory: store,
      output_credentials_file: join(f.directory, "rotated-credentials.json") };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    f.state.calls.length = 0; // Observe only rotation RPCs, after the real protection download.
    const child = args => f.child(args, {}, entrypoint);
    return { ...f, rotationConfig: config, rotationConfigPath: configPath, codePath, store, before: rows,
      saveRotation: () => writeFile(configPath, JSON.stringify(config)), rotate: () => child(["rotate", configPath, "--rotate-own-coach-code"]),
      resume: () => child(["resume", configPath]), rotationChild: child,
      rows: async () => (await f.invoke("/__fixture/rows", undefined, false)).body };
  } catch (error) { await f.close(); throw error; }
}
function noSecrets(result) {
  for (const privateValue of [newCode, "fixture-cli-code", "PRIVATE_BACKUP_KEY_SENTINEL", "fixture-backup-coach-secret", "session_token", "code_salt", "code_digest"])
    assert.ok(!result.output.includes(privateValue), `CLI must not print ${privateValue}`);
}
async function noOutput(f) { await assert.rejects(access(f.rotationConfig.output_credentials_file)); }
function rotations(rows) { return rows.system_requests.filter(row => row.action === "rotateCoachCode"); }
function rotateCalls(f) { return f.state.calls.filter(call => call.path === route); }

test("real 51-table protected backup authorizes a private child CLI self rotation and original receipt; old sessions revoke and business bytes persist", async () => {
  const f = await setup();
  try {
    // Exercise rotation + confirmation login after object initialization, with actual overdue maintenance available.
    assert.equal((await f.invoke("/__fixture/rotation-maintenance", undefined, false)).status, 200);
    f.before = await f.rows();
    assert.deepEqual(f.before.scheduled_jobs, []); assert.deepEqual(f.before.usage_snapshots, []);
    const result = await f.rotate(); assert.equal(result.code, 0, result.output); noSecrets(result);
    assert.deepEqual(JSON.parse(result.output), { status: "COACH_CODE_ROTATION_CONFIRMED", coach_id: f.rotationConfig.coach_id,
      request_id: f.rotationConfig.request_id, previous_credential_version: 1, credential_version: 2,
      rotated_at: JSON.parse(result.output).rotated_at });
    const headerText = await readFile(join(f.store, "header.json"), "utf8"), receiptText = await readFile(join(f.store, "receipt.json"), "utf8");
    const receipt = JSON.parse(receiptText), header = JSON.parse(headerText), credentials = JSON.parse(await readFile(f.rotationConfig.output_credentials_file, "utf8"));
    assert.equal(receipt.result.coach_id, f.rotationConfig.coach_id); assert.equal(receipt.result.credential_version, 2);
    assert.equal(receipt.result.payload_digest, header.payload_digest);
    assert.equal(receipt.operation.request_id, f.rotationConfig.request_id);
    assert.equal(credentials.transport_key, "PRIVATE_BACKUP_KEY_SENTINEL"); assert.notEqual(credentials.session_token, f.session_token);
    await assertPrivatePath(f.rotationConfig.output_credentials_file);
    const rows = await f.rows();
    for (const [table, original] of Object.entries(f.before)) if (!["coaches", "coach_sessions", "system_requests", "audit_events"].includes(table)) assert.deepEqual(rows[table], original, table);
    assert.equal(rotations(rows).length, 1); assert.equal(rows.audit_events.filter(row => row.action === "rotateCoachCode").length, 1);
    assert.ok(rows.coach_sessions.filter(row => row.credential_version === 1 && row.coach_id === f.rotationConfig.coach_id).every(row => row.revoked_at));
    assert.ok(!(JSON.stringify(rows) + headerText + receiptText).includes(newCode));
    assert.ok(!(headerText + JSON.stringify(rows.system_requests)).includes(createHash("sha256").update(newCode).digest("base64url")));
    const old = await f.invoke("/internal/c1/coach-bootstrap", { request_id: "cli_rotated_old_session", session_token: f.session_token }); assert.notEqual(old.status, 200);
    const denied = await f.invoke("/internal/c1/coach-login", { request_id: "cli_rotated_old_code", coach_code: "fixture-cli-code" }); assert.equal(denied.body.error.code, "COACH_CODE_INVALID");
    const current = await f.invoke("/internal/c1/coach-bootstrap", { request_id: "cli_rotated_new_session", session_token: credentials.session_token });
    assert.equal(current.status, 200); assert.equal(current.body.data.coach.credential_version, 2);
    const outputBytes = await readFile(f.rotationConfig.output_credentials_file);
    const resumed = await f.resume(); assert.equal(resumed.code, 0, resumed.output); noSecrets(resumed);
    assert.deepEqual(await readFile(f.rotationConfig.output_credentials_file), outputBytes);
    assert.equal(await readFile(join(f.store, "header.json"), "utf8"), headerText);
    assert.equal(await readFile(join(f.store, "receipt.json"), "utf8"), receiptText);
    assert.equal(rotateCalls(f).length, 1);
  } finally { await f.close(); }
});

test("lost actual rotation response resumes only the original receipt with new Code login and never rotates again", async () => {
  const f = await setup();
  try {
    let committed;
    f.state.hook = async ({ path, body, response, invoke }) => { if (path !== route) return false;
      committed = await invoke(path, body); assert.equal(committed.status, 200); response.destroy(); return true; };
    const unknown = await f.rotate(); assert.notEqual(unknown.code, 0); assert.match(unknown.output, /COACH_CODE_ROTATION_UNCONFIRMED/u); noSecrets(unknown); await noOutput(f);
    const originalHeader = await readFile(join(f.store, "header.json"));
    assert.equal(rotations(await f.rows()).length, 1);
    f.state.hook = null;
    const restored = await f.resume(); assert.equal(restored.code, 0, restored.output); noSecrets(restored);
    assert.deepEqual(JSON.parse(await readFile(join(f.store, "receipt.json"), "utf8")), committed.body.data);
    assert.deepEqual(await readFile(join(f.store, "header.json")), originalHeader);
    assert.equal(rotateCalls(f).length, 1); assert.equal(rotations(await f.rows()).length, 1);
    assert.equal((await f.rows()).coaches[0].credential_version, 2);
    assert.equal(f.state.calls.filter(call => call.path === "/internal/c1/coach-login").every(call => call.body.coach_code === newCode), true);
  } finally { await f.close(); }
});

test("a prepared but uncommitted attempt cannot be resumed into an automatic rotation", async () => {
  const f = await setup();
  try {
    f.state.hook = async ({ path, response }) => { if (path !== route) return false; response.destroy(); return true; };
    const failed = await f.rotate(); assert.notEqual(failed.code, 0); noSecrets(failed); await noOutput(f);
    assert.equal(rotations(await f.rows()).length, 0);
    const header = await readFile(join(f.store, "header.json")); f.state.hook = null;
    const resumed = await f.resume(); assert.notEqual(resumed.code, 0); noSecrets(resumed); await noOutput(f);
    assert.deepEqual(await readFile(join(f.store, "header.json")), header); assert.equal(rotateCalls(f).length, 1);
    assert.equal((await f.rows()).coaches[0].credential_version, 1);
  } finally { await f.close(); }
});

test("lost new-Code login reply reuses its original login ID/session and a later revoked fixed login cannot mint a replacement", async () => {
  const f = await setup();
  try {
    let committedLogin;
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (path !== "/internal/c1/coach-login") return false;
      committedLogin = await invoke(path, body); assert.equal(committedLogin.status, 200); response.destroy(); return true;
    };
    const unknown = await f.rotate(); assert.notEqual(unknown.code, 0); noSecrets(unknown); await noOutput(f);
    const header = await readFile(join(f.store, "header.json")), before = await f.rows();
    assert.equal(rotations(before).length, 1); f.state.hook = null;
    const confirmed = await f.resume(); assert.equal(confirmed.code, 0, confirmed.output); noSecrets(confirmed);
    const credentials = JSON.parse(await readFile(f.rotationConfig.output_credentials_file, "utf8"));
    assert.equal(credentials.session_token, committedLogin.body.data.result.session_token);
    assert.deepEqual(await readFile(join(f.store, "header.json")), header);
    assert.equal((await f.rows()).coach_sessions.length, before.coach_sessions.length);
    const loginCalls = f.state.calls.filter(call => call.path === "/internal/c1/coach-login");
    assert.equal(new Set(loginCalls.map(call => call.body.request_id)).size, 1); assert.equal(rotateCalls(f).length, 1);
    const logout = await f.invoke("/internal/c1/coach-logout", { request_id: "rotation_fixed_login_logout", session_token: credentials.session_token });
    assert.equal(logout.status, 200); const revoked = await f.rows(), output = await readFile(f.rotationConfig.output_credentials_file);
    const refused = await f.resume(); assert.notEqual(refused.code, 0); noSecrets(refused);
    assert.deepEqual(await f.rows(), revoked); assert.deepEqual(await readFile(f.rotationConfig.output_credentials_file), output);
    assert.equal(rotateCalls(f).length, 1);
    const corrupted = JSON.parse(header.toString("utf8")); corrupted.login_request_id = "rotation_forged_login_request_001";
    await writeFile(join(f.store, "header.json"), JSON.stringify(corrupted));
    const callsBefore = f.state.calls.length;
    const rejected = await f.resume(); assert.notEqual(rejected.code, 0); noSecrets(rejected);
    assert.equal(f.state.calls.length, callsBefore); // Local header corruption cannot mint a new session.
    assert.deepEqual(await f.rows(), revoked); assert.deepEqual(await readFile(f.rotationConfig.output_credentials_file), output);
  } finally { await f.close(); }
});

test("original unknown attempt cannot be reinterpreted with a new request or replaced Code on resume", async () => {
  const f = await setup();
  try {
    f.state.hook = async ({ path, body, response, invoke }) => { if (path !== route) return false; await invoke(path, body); response.destroy(); return true; };
    assert.notEqual((await f.rotate()).code, 0); f.state.hook = null;
    const count = f.state.calls.length, original = f.rotationConfig.request_id;
    f.rotationConfig.request_id = "rotation_changed_request"; await f.saveRotation();
    const changed = await f.resume(); assert.notEqual(changed.code, 0); noSecrets(changed); await noOutput(f); assert.equal(f.state.calls.length, count);
    f.rotationConfig.request_id = original; await f.saveRotation();
    await writeFile(f.codePath, JSON.stringify({ new_code: "CHANGED-PRIVATE-ROTATION-CREDENTIAL" }));
    const wrongCode = await f.resume(); assert.notEqual(wrongCode.code, 0); noSecrets(wrongCode); await noOutput(f);
    assert.equal(rotateCalls(f).length, 1); assert.equal(rotations(await f.rows()).length, 1);
  } finally { await f.close(); }
});

test("independently pinned protection digest and original Coach version gate rotation before any write", async () => {
  const f = await setup();
  try {
    const originalDigest = f.rotationConfig.protection_digest;
    f.rotationConfig.protection_digest = "sha256_v1:" + "a".repeat(43); await f.saveRotation();
    const wrongDigest = await f.rotate(); assert.notEqual(wrongDigest.code, 0); noSecrets(wrongDigest); assert.equal(f.state.calls.length, 0);
    f.rotationConfig.protection_digest = originalDigest; f.rotationConfig.expected_credential_version = 2; await f.saveRotation();
    const wrongVersion = await f.rotate(); assert.notEqual(wrongVersion.code, 0); noSecrets(wrongVersion);
    assert.equal(rotateCalls(f).length, 0); assert.equal(rotations(await f.rows()).length, 0); await noOutput(f);
  } finally { await f.close(); }
});

for (const mode of ["revoked", "disabled"]) test(`actual ${mode} current Coach cannot rotate through the CLI`, async () => {
  const f = await setup();
  try {
    if (mode === "revoked") assert.equal((await f.invoke("/internal/c1/coach-logout", { request_id: "cli_rotation_logout", session_token: f.session_token })).status, 200);
    else await f.invoke("/__fixture/disable-coach", undefined, false);
    const before = await f.rows(), result = await f.rotate(); assert.notEqual(result.code, 0); noSecrets(result); await noOutput(f);
    assert.equal(rotateCalls(f).length, 0); assert.deepEqual(await f.rows(), before);
  } finally { await f.close(); }
});

test("a current session belonging to another real Coach cannot use the original protection to rotate", async () => {
  const f = await setup();
  try {
    await f.invoke("/__fixture/second-coach", undefined, false);
    const login = await f.invoke("/internal/c1/coach-login", { request_id: "rotation_other_coach_login", coach_code: "fixture-second-code" });
    assert.equal(login.status, 200);
    await writeFile(f.credentials, JSON.stringify({ transport_key: "PRIVATE_BACKUP_KEY_SENTINEL", session_token: login.body.data.result.session_token }));
    const before = await f.rows(), denied = await f.rotate();
    assert.notEqual(denied.code, 0); noSecrets(denied); await noOutput(f);
    assert.equal(rotateCalls(f).length, 0); assert.deepEqual(await f.rows(), before);
  } finally { await f.close(); }
});

test("a Code file changed after preparation is refused without a commit or plaintext checkpoint", async () => {
  const f = await setup();
  try {
    f.state.hook = async ({ path, body, response, invoke }) => { if (path !== "/internal/c1/prepare-coach-code-rotation") return false;
      const reply = await invoke(path, body); await writeFile(f.codePath, JSON.stringify({ new_code: "REPLACED-PRIVATE-CODE-CREDENTIAL" }));
      response.writeHead(reply.status, { "content-type": "application/json" }); response.end(JSON.stringify(reply.body)); return true; };
    const result = await f.rotate(); assert.notEqual(result.code, 0); noSecrets(result); await noOutput(f);
    assert.equal(rotateCalls(f).length, 0); assert.equal(rotations(await f.rows()).length, 0);
    for (const name of await readdir(f.store)) assert.ok(!(await readFile(join(f.store, name), "utf8")).includes(newCode));
  } finally { await f.close(); }
});

test("fixed target, output overwrite and repository Code paths fail before any credential leaves the process", async () => {
  const f = await setup();
  try {
    for (const origin of ["http://127.0.0.1:8080", "https://attacker.invalid", target.origin + "/path"]) {
      f.rotationConfig.server = { ...target, origin }; await f.saveRotation();
      const denied = await f.rotate(); assert.notEqual(denied.code, 0); noSecrets(denied); assert.equal(f.state.calls.length, 0);
    }
    f.rotationConfig.server = target;
    const originalPath = f.rotationConfig.new_code_file; f.rotationConfig.new_code_file = join(process.cwd(), "package.json"); await f.saveRotation();
    assert.notEqual((await f.rotate()).code, 0); assert.equal(f.state.calls.length, 0);
    f.rotationConfig.new_code_file = originalPath; await f.saveRotation();
    await writeFile(f.rotationConfig.output_credentials_file, "DO-NOT-OVERWRITE-TEST-SENTINEL");
    const denied = await f.rotate(); assert.notEqual(denied.code, 0); noSecrets(denied); assert.equal(f.state.calls.length, 0);
    assert.equal(await readFile(f.rotationConfig.output_credentials_file, "utf8"), "DO-NOT-OVERWRITE-TEST-SENTINEL");
  } finally { await f.close(); }
});

test("oversized remote response stays unconfirmed with no automatic retry and no dependency body in logs", async () => {
  const f = await setup();
  try {
    f.state.hook = async ({ path, response }) => { if (path !== route) return false;
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ secret: newCode, padding: "x".repeat(2_000_001) })); return true; };
    const result = await f.rotate(); assert.notEqual(result.code, 0); noSecrets(result); await noOutput(f);
    assert.equal(rotateCalls(f).length, 1); assert.equal(rotations(await f.rows()).length, 0);
  } finally { await f.close(); }
});

for (const location of ["data", "operation", "result"]) test(`sensitive unexpected receipt ${location} fields cannot pollute durable checkpoints or success`, async () => {
  const f = await setup();
  try {
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (path !== "/internal/c1/get-coach-rotation-receipt") return false;
      const reply = await invoke(path, body);
      const container = location === "data" ? reply.body.data : reply.body.data[location];
      container.new_code = newCode; container.session_token = "INJECTED-RECEIPT-SESSION-TOKEN-SENTINEL";
      reply.body.meta.new_code = newCode;
      response.writeHead(reply.status, { "content-type": "application/json" }); response.end(JSON.stringify(reply.body)); return true;
    };
    const denied = await f.rotate(); assert.notEqual(denied.code, 0); noSecrets(denied); await noOutput(f);
    assert.ok(!denied.output.includes("INJECTED-RECEIPT-SESSION-TOKEN-SENTINEL"));
    await assert.rejects(access(join(f.store, "receipt.json")));
    assert.equal(rotations(await f.rows()).length, 1);
    for (const name of await readdir(f.store)) {
      const text = await readFile(join(f.store, name), "utf8");
      assert.ok(!text.includes(newCode)); assert.ok(!text.includes("INJECTED-RECEIPT-SESSION-TOKEN-SENTINEL"));
    }
    f.state.hook = null;
    const resumed = await f.resume(); assert.equal(resumed.code, 0, resumed.output); noSecrets(resumed);
    assert.equal(rotateCalls(f).length, 1); assert.equal(rotations(await f.rows()).length, 1);
  } finally { await f.close(); }
});

for (const rights of ["ChangePermissions", "TakeOwnership", "Delete", "WriteAttributes"]) test(`actual Windows untrusted ${rights} Code-file ACE rejects rotation and original private-host guard before HTTP`, { skip: process.platform !== "win32" }, async () => {
  const f = await setup();
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:ROTATION_TEST_CODE_FILE;
      $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545');
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,$env:ROTATION_TEST_RIGHTS,'Allow');
      $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:ROTATION_TEST_CODE_FILE -AclObject $acl
    `], { windowsHide: true, env: { ...process.env, PSModulePath: undefined, ROTATION_TEST_CODE_FILE: f.codePath, ROTATION_TEST_RIGHTS: rights } });
    const result = await f.rotate(); assert.notEqual(result.code, 0); noSecrets(result); await noOutput(f);
    assert.equal(f.state.calls.length, 0); assert.equal(rotations(await f.rows()).length, 0);
    await assert.rejects(assertPrivatePath(f.codePath), /PRIVATE_HOST_PATH_UNCONFIRMED/u);
  } finally { await f.close(); }
});
