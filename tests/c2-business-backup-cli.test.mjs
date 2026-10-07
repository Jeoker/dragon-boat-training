import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, readdir, access, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildBusinessBackupTool } from "../backend/backup/build.mjs";
import { fixture, legacyBundle, reseal, canonical, hash } from "./backup-cli-test-runtime.mjs";
import { assertPrivatePath } from "../backend/source-journal/private-paths.mjs";

await buildBusinessBackupTool();
const { BUSINESS_BACKUP_COLUMNS } = await import("../backend/.backup-tool/runtime.mjs");
const absent = path => assert.rejects(access(path), error => error.code === "ENOENT");
const noSecrets = (f, result) => {
  assert.doesNotMatch(result.output, /PRIVATE_BACKUP_KEY_SENTINEL|PRIVATE_SERVER_DENIED_SENTINEL|PRIVATE_FIXTURE_SERVER_SENTINEL|fixture-cli-code/u);
  assert.ok(!result.output.includes(f.session_token)); assert.ok(!result.output.includes(f.credentials));
};
const withFixture = async fn => { const f = await fixture(); try { return await fn(f); } finally { await f.close(); } };
const download = f => f.child(["download", f.configPath, "--create-protected-snapshot"]);

test("actual CLI downloads all 51 nonempty tables from current Coach/real SQLite APIs, verifies offline and restores full rows", async () => {
  await withFixture(async f => {
    const result = await download(f); assert.equal(result.code, 0, result.output); noSecrets(f, result);
    const summary = JSON.parse(result.output); assert.equal(summary.status, "BUSINESS_BACKUP_DOWNLOADED");
    assert.equal(summary.table_count, 51); assert.equal(summary.verification, "OFFLINE_INTEGRITY_ONLY");
    const bundle = JSON.parse(await readFile(f.config.output_file));
    assert.equal(summary.captured_at, bundle.manifest.created_at);
    assert.ok(bundle.manifest.tables.every(table => table.row_count > 0));
    assert.deepEqual(Object.keys(BUSINESS_BACKUP_COLUMNS).sort(), Object.keys(f.seeded.columns).sort());
    for (const table of bundle.manifest.tables) {
      assert.deepEqual([...BUSINESS_BACKUP_COLUMNS[table.name]].sort(), [...f.seeded.columns[table.name]].sort(), `PRAGMA column oracle: ${table.name}`);
      for (const row of bundle.chunks.filter(chunk => chunk.table_name === table.name).flatMap(chunk => chunk.payload.rows))
        assert.deepEqual(Object.keys(row).sort(), [...f.seeded.columns[table.name]].sort());
    }
    const recovered = await f.invoke("/__fixture/recover", bundle, false);
    assert.equal(recovered.status, 200); assert.equal(recovered.body.result.state, "ISOLATED_RESTORED");
    for (const table of bundle.manifest.tables) {
      const expected = bundle.chunks.filter(chunk => chunk.table_name === table.name).flatMap(chunk => chunk.payload.rows);
      assert.deepEqual(recovered.body.restored[table.name], expected);
    }
    const calls = f.state.calls.length, offline = await f.child(["verify", f.config.output_file, summary.content_digest]);
    assert.equal(offline.code, 0, offline.output); noSecrets(f, offline);
    assert.equal(JSON.parse(offline.output).status, "BUSINESS_BACKUP_OFFLINE_VERIFIED"); assert.equal(f.state.calls.length, calls);
    const original = await readFile(f.config.output_file);
    assert.notEqual((await download(f)).code, 0); assert.deepEqual(await readFile(f.config.output_file), original);
    assert.equal(f.state.calls.filter(call => call.path.endsWith("create-backup-snapshot")).length, 1);
  });
});

test("lost creation reply resumes only the original authenticated request and snapshot without duplicating server facts", async () => {
  await withFixture(async f => {
    let first = true;
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (path.endsWith("create-backup-snapshot") && first) {
        first = false; f.state.snapshot = (await invoke(path, body)).body.data.result; response.destroy(); return true;
      }
      return false;
    };
    const initial = await download(f); assert.notEqual(initial.code, 0); noSecrets(f, initial); await absent(f.config.output_file);
    const header = JSON.parse(await readFile(join(f.config.store_directory, "header.json")));
    assert.equal(header.snapshot_id, f.state.snapshot.snapshot_id);
    assert.ok(Date.parse(f.state.snapshot.manifest.created_at) >= Date.parse(header.capture_not_before));
    const resumed = await f.child(["resume", f.configPath]); assert.equal(resumed.code, 0, resumed.output); noSecrets(f, resumed);
    const calls = f.state.calls.filter(call => call.path.endsWith("create-backup-snapshot"));
    assert.equal(calls.length, 2); assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(JSON.parse(resumed.output).snapshot_id, f.state.snapshot.snapshot_id);
    assert.deepEqual(JSON.parse(await readFile(join(f.config.store_directory, "header.json"))), header);
    const after = await f.invoke("/__fixture/facts", undefined, false);
    assert.deepEqual(after.body, { backups: 1, backup_requests: 1, backup_audits: 1 });
  });
});

test("a new empty local download refuses an old legitimately replayed server snapshot for the same actor and request", async () => {
  await withFixture(async f => {
    const old = await f.invoke("/internal/c1/create-backup-snapshot", { request_id: f.config.request_id, session_token: f.session_token });
    assert.equal(old.status, 200); const original = old.body.data.result;
    assert.deepEqual(await readdir(f.config.store_directory), []);
    const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result); await absent(f.config.output_file);
    const header = JSON.parse(await readFile(join(f.config.store_directory, "header.json")));
    assert.equal(header.snapshot_id, original.snapshot_id);
    assert.ok(Date.parse(header.capture_not_before) > Date.parse(original.manifest.created_at));
    assert.ok(!(await readdir(f.config.store_directory)).some(name => name.startsWith("chunk-") || name === "manifest.json"));
    assert.equal(f.state.calls.filter(call => call.path.endsWith("create-backup-snapshot")).length, 1);
    assert.deepEqual((await f.invoke("/__fixture/facts", undefined, false)).body, { backups: 1, backup_requests: 1, backup_audits: 1 });
    const before = await readFile(join(f.config.store_directory, "header.json"));
    assert.notEqual((await f.child(["resume", f.configPath])).code, 0); await absent(f.config.output_file);
    assert.deepEqual(await readFile(join(f.config.store_directory, "header.json")), before);
    assert.deepEqual((await f.invoke("/__fixture/facts", undefined, false)).body, { backups: 1, backup_requests: 1, backup_audits: 1 });
  });
});

test("missing or non-contract server time cannot fall back to the operator clock or initialize a capture header", async () => {
  for (const mode of ["missing", "non-iso"]) await withFixture(async f => {
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (!path.endsWith("coach-bootstrap")) return false;
      const result = await invoke(path, body);
      if (mode === "missing") delete result.body.meta.server_time;
      else result.body.meta.server_time = "2026-10-04";
      response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(result.body)); return true;
    };
    const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result); await absent(f.config.output_file);
    assert.deepEqual(await readdir(f.config.store_directory), []);
    assert.equal(f.state.calls.filter(call => call.path.endsWith("create-backup-snapshot")).length, 0);
  });
});

test("a future creation time with a correctly recomputed manifest digest fails the trusted server-time fence", async () => {
  await withFixture(async f => {
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (!path.endsWith("create-backup-snapshot")) return false;
      const result = await invoke(path, body), manifest = result.body.data.result.manifest;
      manifest.created_at = "2099-01-01T00:00:00.000Z";
      const { content_digest: _, ...core } = manifest; manifest.content_digest = hash(canonical(core));
      response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(result.body)); return true;
    };
    const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result); await absent(f.config.output_file);
    assert.equal(f.state.calls.filter(call => call.path.endsWith("get-backup-chunk")).length, 0);
    assert.ok(!(await readdir(f.config.store_directory)).includes("manifest.json"));
  });
});

test("lost chunk response resumes the same immutable ordinal and never publishes a partial bundle", async () => {
  await withFixture(async f => {
    let first = true;
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (path.endsWith("get-backup-chunk") && body.chunk_index === 2 && first) {
        first = false; await invoke(path, body); response.destroy(); return true;
      }
      return false;
    };
    assert.notEqual((await download(f)).code, 0); await absent(f.config.output_file);
    const files = await readdir(f.config.store_directory); assert.ok(files.includes("chunk-000000.json")); assert.ok(!files.includes("chunk-000002.json"));
    const firstBytes = await readFile(join(f.config.store_directory, "chunk-000000.json"));
    const resumed = await f.child(["resume", f.configPath]); assert.equal(resumed.code, 0, resumed.output);
    assert.deepEqual(await readFile(join(f.config.store_directory, "chunk-000000.json")), firstBytes);
    assert.equal(f.state.calls.filter(call => call.path.endsWith("create-backup-snapshot")).length, 1);
    const repeats = f.state.calls.filter(call => call.path.endsWith("get-backup-chunk") && call.body.chunk_index === 2);
    assert.equal(repeats.length, 2); assert.deepEqual(repeats[0].body, repeats[1].body);
  });
});

test("offline verification independently rejects recomputed wrong columns/schema/count/order and forged expected digest", async () => {
  await withFixture(async f => {
    const result = await download(f); assert.equal(result.code, 0, result.output);
    const original = JSON.parse(await readFile(f.config.output_file)), calls = f.state.calls.length;
    for (const mode of ["unknown-column", "missing-column", "schema", "schema-meta", "count", "order", "digest", "missing-chunk"]) {
      const bundle = structuredClone(original), row = bundle.chunks.find(chunk => chunk.table_name === "coaches").payload.rows[0];
      if (mode === "unknown-column") row.injected_secret = "PRIVATE_BACKUP_KEY_SENTINEL";
      if (mode === "missing-column") delete row.display_name;
      if (mode === "schema") bundle.manifest.schema_version = 15;
      if (mode === "schema-meta") bundle.chunks[0].payload.rows.find(record => record.key === "schema_version").value = "14";
      if (mode === "count") bundle.manifest.record_count++;
      if (mode === "order") [bundle.chunks[0], bundle.chunks[1]] = [bundle.chunks[1], bundle.chunks[0]];
      if (mode === "missing-chunk") bundle.chunks.pop();
      if (!["digest", "missing-chunk", "order"].includes(mode)) reseal(bundle);
      if (mode === "digest") bundle.chunks[0].payload.rows[0].value = "CHANGED";
      const path = join(f.directory, `${mode}.json`); await writeFile(path, JSON.stringify(bundle), { mode: 0o600 });
      const rejected = await f.child(["verify", path, bundle.manifest.content_digest]); assert.notEqual(rejected.code, 0, mode); noSecrets(f, rejected);
    }
    const wrong = await f.child(["verify", f.config.output_file, "sha256_v1:" + "a".repeat(43)]); assert.notEqual(wrong.code, 0);
    const duplicate = join(f.directory, "duplicate-keys.json");
    await writeFile(duplicate, JSON.stringify(original).replace('"schema_version":16', '"schema_version":16,"schema_version":16'), { mode: 0o600 });
    assert.notEqual((await f.child(["verify", duplicate, original.manifest.content_digest])).code, 0);
    const oversized = join(f.directory, "oversized-offline.json"); await writeFile(oversized, " ".repeat(30_000_001), { mode: 0o600 });
    assert.notEqual((await f.child(["verify", oversized, original.manifest.content_digest])).code, 0);
    assert.equal(f.state.calls.length, calls);
  });
});

test("legacy schema14 compatibility uses all real previous 47 table rows and restores additively without claiming a remote14 run", async () => {
  await withFixture(async f => {
    let legacy;
    // This is an explicit legacy HTTP format model. Its complete nonempty
    // rows originate in actual current SQL/API export, not fabricated empty
    // manifests; it does not claim to run the old remote14 Worker binary.
    f.config.schema_version = 14; await f.saveConfig();
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (!["get-operations", "create-backup-snapshot", "get-backup-chunk", "verify-backup-snapshot"].some(action => path.endsWith(action))) return false;
      const result = await invoke(path, body);
      if (path.endsWith("get-operations")) result.body.data.schema_version = 14;
      if (path.endsWith("create-backup-snapshot")) {
        const manifest = result.body.data.result.manifest, chunks = [];
        for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index++) {
          const part = await invoke("/internal/c1/get-backup-chunk", { ...body, snapshot_id: manifest.snapshot_id, chunk_index });
          chunks.push(part.body.data.chunk);
        }
        legacy = legacyBundle({ manifest, chunks }); result.body.data.result.manifest = legacy.manifest;
      }
      if (path.endsWith("get-backup-chunk")) { result.body.data.manifest = legacy.manifest; result.body.data.chunk = legacy.chunks[body.chunk_index]; }
      if (path.endsWith("verify-backup-snapshot")) Object.assign(result.body.data, { verified: true,
        expected_content_digest: legacy.manifest.content_digest, chunk_count: legacy.manifest.chunk_count, record_count: legacy.manifest.record_count });
      response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(result.body)); return true;
    };
    const downloaded = await download(f); assert.equal(downloaded.code, 0, downloaded.output);
    assert.deepEqual(JSON.parse(await readFile(f.config.output_file)), legacy);
    const path = join(f.directory, "legacy47.json");
    assert.equal(legacy.manifest.table_count, 47); assert.ok(legacy.manifest.tables.every(table => table.row_count > 0));
    await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
    const result = await f.child(["verify", path, legacy.manifest.content_digest]); assert.equal(result.code, 0, result.output);
    const recovered = await f.invoke("/__fixture/recover", legacy, false); assert.equal(recovered.status, 200);
    assert.equal(recovered.body.result.source_schema_version, 14); assert.equal(recovered.body.result.schema_version, 16);
    for (const table of legacy.manifest.tables.filter(table => table.name !== "app_meta"))
      assert.deepEqual(recovered.body.restored[table.name], legacy.chunks.filter(chunk => chunk.table_name === table.name).flatMap(chunk => chunk.payload.rows));
    for (const table of Object.keys(recovered.body.restored).slice(47)) assert.deepEqual(recovered.body.restored[table], []);
  });
});

test("changed target and request identity cannot reuse partial state or redirect its credentials", async () => {
  await withFixture(async f => {
    const origin = f.config.server.origin;
    for (const bad of ["https://wrong.invalid", "http://127.0.0.1:1", origin + "/path"]) {
      f.config.server.origin = bad; await f.saveConfig(); const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result);
    }
    assert.equal(f.state.calls.length, 0); f.config.server.origin = origin; await f.saveConfig();
    f.state.deny = true; assert.notEqual((await download(f)).code, 0); f.state.deny = false;
    f.state.hook = async ({ path, response }) => { if (path.endsWith("get-backup-chunk")) { response.destroy(); return true; } return false; };
    assert.notEqual((await download(f)).code, 0);
    const before = await readdir(f.config.store_directory); f.config.request_id = "replacement_backup_request"; await f.saveConfig();
    const result = await f.child(["resume", f.configPath]); assert.notEqual(result.code, 0); noSecrets(f, result);
    assert.deepEqual(await readdir(f.config.store_directory), before); await absent(f.config.output_file);
  });
});

test("current Coach revocation after chunk response prevents its checkpoint and all later calls", async () => {
  await withFixture(async f => {
    let revoked = false;
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (path.endsWith("get-backup-chunk") && !revoked) {
        const result = await invoke(path, body); revoked = true;
        await invoke("/internal/c1/coach-logout", { request_id: "fixture_revoke_download", session_token: f.session_token });
        response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(result.body)); return true;
      }
      return false;
    };
    const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result); await absent(f.config.output_file);
    assert.ok(!(await readdir(f.config.store_directory)).some(name => name.startsWith("chunk-")));
    const calls = f.state.calls.filter(call => call.path.endsWith("get-backup-chunk")); assert.equal(calls.length, 1);
    assert.notEqual((await f.child(["resume", f.configPath])).code, 0); assert.equal(f.state.calls.filter(call => call.path.endsWith("get-backup-chunk")).length, 1);
  });
});

test("oversized or malformed server bodies stop bounded download with fixed errors and no output", async () => {
  await withFixture(async f => {
    f.state.hook = async ({ path, response }) => {
      if (path.endsWith("create-backup-snapshot")) { response.writeHead(200); response.end("PRIVATE_BACKUP_KEY_SENTINEL".repeat(100_000)); return true; }
      return false;
    };
    const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result); await absent(f.config.output_file);
    assert.equal(f.state.calls.filter(call => call.path.endsWith("get-backup-chunk")).length, 0);
  });
});

test("replacing the credential file with another real Coach cannot move the original snapshot across actors", async () => {
  await withFixture(async f => {
    await f.invoke("/__fixture/second-coach", undefined, false);
    const logged = await f.invoke("/internal/c1/coach-login", { request_id: "fixture_second_login", coach_code: "fixture-second-code" });
    assert.equal(logged.status, 200); const other = logged.body.data.result.session_token; let swapped = false;
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (path.endsWith("get-backup-chunk") && !swapped) {
        const result = await invoke(path, body); swapped = true;
        await writeFile(f.credentials, JSON.stringify({ transport_key: "PRIVATE_BACKUP_KEY_SENTINEL", session_token: other }));
        response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(result.body)); return true;
      }
      return false;
    };
    const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result); assert.ok(!result.output.includes(other));
    await absent(f.config.output_file);
    const originalHeader = await readFile(join(f.config.store_directory, "header.json"));
    assert.equal(f.state.calls.filter(call => call.path.endsWith("get-backup-chunk")).length, 1);
    assert.notEqual((await f.child(["resume", f.configPath])).code, 0);
    assert.deepEqual(await readFile(join(f.config.store_directory, "header.json")), originalHeader);
    assert.equal(f.state.calls.filter(call => call.path.endsWith("create-backup-snapshot")).length, 1);
  });
});

test("a schema change after full chunk download prevents publication despite the original valid server verification", async () => {
  await withFixture(async f => {
    let operations = 0;
    f.state.hook = async ({ path, body, response, invoke }) => {
      if (path.endsWith("get-operations") && ++operations === 2) {
        const result = await invoke(path, body); result.body.data.schema_version = 14;
        response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(result.body)); return true;
      }
      return false;
    };
    const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result); await absent(f.config.output_file);
    assert.equal(f.state.calls.filter(call => call.path.endsWith("create-backup-snapshot")).length, 1);
    assert.ok((await readdir(f.config.store_directory)).filter(name => name.startsWith("chunk-")).length >= 51);
  });
});

test("private output never overwrites an existing file and rejects linked or broadened credential paths before HTTP", async () => {
  await withFixture(async f => {
    await writeFile(f.config.output_file, "ORIGINAL_PRIVATE_OUTPUT", { mode: 0o600 });
    assert.notEqual((await download(f)).code, 0); assert.equal(await readFile(f.config.output_file, "utf8"), "ORIGINAL_PRIVATE_OUTPUT");
    assert.equal(f.state.calls.length, 0);
  });
  await withFixture(async f => {
    const alias = join(f.directory, "alias"); await symlink(f.config.store_directory, alias, process.platform === "win32" ? "junction" : "dir");
    f.config.store_directory = alias; await f.saveConfig(); assert.notEqual((await download(f)).code, 0); assert.equal(f.state.calls.length, 0);
  });
  await withFixture(async f => {
    if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$p=$env:DBT_TEST_OPEN_CREDENTIAL;$acl=Get-Acl -LiteralPath $p;$sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0');$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl"],
    { env: { ...process.env, PSModulePath: undefined, DBT_TEST_OPEN_CREDENTIAL: f.credentials }, windowsHide: true });
    else await chmod(f.credentials, 0o644);
    assert.notEqual((await download(f)).code, 0); assert.equal(f.state.calls.length, 0);
  });
});

for (const rights of ["ChangePermissions", "TakeOwnership", "Delete", "WriteAttributes"]) {
  test(`untrusted Windows ${rights}-only ACE blocks the actual CLI and existing private-host path guard before HTTP`,
    { skip: process.platform !== "win32" }, async () => {
      await withFixture(async f => {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
          $ErrorActionPreference='Stop';$p=$env:DBT_TEST_OPEN_CREDENTIAL;$acl=Get-Acl -LiteralPath $p;
          $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545');
          $rights=[System.Security.AccessControl.FileSystemRights]$env:DBT_TEST_UNTRUSTED_RIGHTS;
          $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,$rights,'Allow');
          $acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl`], {
          env: { ...process.env, PSModulePath: undefined, DBT_TEST_OPEN_CREDENTIAL: f.credentials, DBT_TEST_UNTRUSTED_RIGHTS: rights }, windowsHide: true });
        await assert.rejects(assertPrivatePath(f.credentials), /PRIVATE_HOST_PATH_UNCONFIRMED/u);
        const result = await download(f); assert.notEqual(result.code, 0); noSecrets(f, result);
        assert.equal(f.state.calls.length, 0); await absent(f.config.output_file);
      });
    });
}
