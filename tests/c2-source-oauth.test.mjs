import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_SCOPES, validateClient, validateGrant, callbackResult, privatePaths, probe, saveGrant, authorizedClient } from "../backend/source-journal/oauth-local.mjs";
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("dedicated desktop OAuth requires the intended project and Google endpoints", () => {
  const installed = { project_id: "test-project", client_id: "test-client", client_secret: "PRIVATE_SENTINEL",
    auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token" };
  assert.equal(validateClient({ installed }, "test-project"), installed);
  for (const candidate of [{ web: installed }, { installed: { ...installed, project_id: "other" } },
    { installed: { ...installed, token_uri: "https://example.com/token" } }])
    assert.throws(() => validateClient(candidate, "test-project"), /OAUTH_CLIENT_INVALID/);
});

test("grant checks audience and every required scope", () => {
  validateGrant({ aud: "client", scopes: [...SOURCE_SCOPES] }, "client");
  for (const info of [{ aud: "other", scopes: [...SOURCE_SCOPES] },
    { aud: "client", scopes: SOURCE_SCOPES.slice(1) }, { aud: "client", scopes: "bad" }])
    assert.throws(() => validateGrant(info, "client"), /OAUTH_GRANT_INCOMPLETE/);
});

test("callbacks reject forged state, duplicate parameters and missing codes", () => {
  const read = query => callbackResult(new URL(`http://127.0.0.1/callback?${query}`), "expected");
  assert.deepEqual(read("state=expected&code=one"), { status: 200, code: "one" });
  for (const query of ["state=wrong&code=one", "state=expected&state=expected&code=one",
    "state=expected&code=one&code=two", "state=expected&code="])
    assert.equal(read(query).status, 400);
  assert.deepEqual(read("state=expected&error=access_denied"), { status: 403, denied: true });
});

test("credentials cannot be stored in the repository or overwrite the client", () => {
  assert.throws(() => privatePaths("relative.json", "tokens.json"), /OAUTH_ABSOLUTE_PATH_REQUIRED/);
  const local = new URL("../local-secret.json", import.meta.url);
  const path = process.platform === "win32" ? decodeURIComponent(local.pathname.slice(1)).replaceAll("/", "\\") : local.pathname;
  assert.throws(() => privatePaths(path, path), /OAUTH_PRIVATE_PATH_REQUIRED/);
  const external = process.platform === "win32" ? "D:\\private\\client.json" : "/tmp/private/client.json";
  assert.throws(() => privatePaths(external, external), /OAUTH_PATH_COLLISION/);
});

test("OAuth resolves parent junctions before saving and rejects aliased client/token paths before network access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbt-oauth-private-path-"));
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const target = join(repository, "fictional-oauth-path-test.json");
  try {
    const linked = join(directory, "repository-link"); await symlink(repository, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(saveGrant(join(linked, "fictional-oauth-path-test.json"), {}, { refresh_token: "FICTIONAL_TOKEN" }), /OAUTH_PRIVATE_PATH_REQUIRED/);
    await assert.rejects(access(target));
    const privateDirectory = join(directory, "private"); await mkdir(privateDirectory);
    const client = join(privateDirectory, "client.json"); await writeFile(client, "fictional client contents");
    const alias = join(directory, "private-link"); await symlink(privateDirectory, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(authorizedClient(client, join(alias, "client.json"), "fictional_project"), /OAUTH_PATH_COLLISION/);
    assert.equal(await readFile(client, "utf8"), "fictional client contents");
    const tokens = join(privateDirectory, "tokens.json");
    await saveGrant(tokens, { project_id: "fictional_project", client_id: "fictional_client" }, { refresh_token: "FICTIONAL_TOKEN" });
    assert.equal(JSON.parse(await readFile(tokens, "utf8")).tokens.refresh_token, "FICTIONAL_TOKEN");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("capability probes never read real source IDs or disclose API error contents", async () => {
  const calls = [];
  const probes = await probe({ async request(options) {
    calls.push(options);
    if (options.url.includes("/about")) return { data: { user: { permissionId: "PRIVATE_SENTINEL" } } };
    throw { response: { status: 403, data: { error: { message: "PRIVATE_SENTINEL", details: [{ reason: "SERVICE_DISABLED" }] } } } };
  } });
  assert.equal(probes.length, 3);
  assert.equal(JSON.stringify(probes).includes("PRIVATE_SENTINEL"), false);
  assert.ok(calls.slice(0, 2).every(call => call.url.endsWith("c2_source_capability_probe_nonexistent") && call.method === "GET"));
  assert.deepEqual(probes[0], { api: "forms", status: 403, reasons: ["SERVICE_DISABLED"] });
});
