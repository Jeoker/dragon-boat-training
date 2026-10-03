import { OAuth2Client } from "google-auth-library";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, rename, unlink, realpath } from "node:fs/promises";
import { resolve, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
]);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const failure = code => Object.assign(new Error(code), { code });
const outside = (root, path) => {
  const local = relative(root, path);
  return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local);
};

async function privateFile(path) {
  if (!path || !isAbsolute(path)) throw failure("OAUTH_ABSOLUTE_PATH_REQUIRED");
  const resolved = resolve(path), root = await realpath(repository), parent = await realpath(dirname(resolved));
  if (!outside(repository, resolved) || !outside(root, parent))
    throw failure("OAUTH_PRIVATE_PATH_REQUIRED");
  let actual;
  try { actual = await realpath(resolved); }
  catch (error) { if (error.code !== "ENOENT") throw error; actual = resolve(parent, basename(resolved)); }
  if (!outside(root, actual)) throw failure("OAUTH_PRIVATE_PATH_REQUIRED");
  return actual;
}

async function privateFiles(clientPath, tokenPath) {
  const paths = privatePaths(clientPath, tokenPath), actual = await Promise.all(paths.map(privateFile));
  const identity = path => process.platform === "win32" ? path.toLowerCase() : path;
  if (identity(actual[0]) === identity(actual[1])) throw failure("OAUTH_PATH_COLLISION");
  return paths;
}

export function privatePaths(clientPath, tokenPath) {
  const paths = [clientPath, tokenPath].map(value => {
    if (!value || !isAbsolute(value)) throw failure("OAUTH_ABSOLUTE_PATH_REQUIRED");
    const path = resolve(value), local = relative(repository, path);
    if (!local || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))) throw failure("OAUTH_PRIVATE_PATH_REQUIRED");
    return path;
  });
  if (paths[0].toLowerCase() === paths[1].toLowerCase()) throw failure("OAUTH_PATH_COLLISION");
  return paths;
}

export function validateClient(json, projectId) {
  const client = json?.installed;
  if (!projectId || client?.project_id !== projectId || !client.client_id || !client.client_secret ||
      client.auth_uri !== "https://accounts.google.com/o/oauth2/auth" ||
      client.token_uri !== "https://oauth2.googleapis.com/token") throw failure("OAUTH_CLIENT_INVALID");
  return client;
}

export function validateGrant(info, clientId) {
  if (info?.aud !== clientId || !Array.isArray(info.scopes) || SOURCE_SCOPES.some(scope => !info.scopes.includes(scope)))
    throw failure("OAUTH_GRANT_INCOMPLETE");
}

export function callbackResult(url, state) {
  if (url.pathname !== "/callback") return { status: 404 };
  if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state)
    return { status: 400 };
  if (url.searchParams.has("error")) return { status: 403, denied: true };
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) return { status: 400 };
  return { status: 200, code: codes[0] };
}

export async function saveGrant(path, client, tokens) {
  if (!tokens.refresh_token) throw failure("OAUTH_REFRESH_TOKEN_MISSING");
  await privateFile(path);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ format: "dbt-source-oauth-v1", project_id: client.project_id,
      client_id: client.client_id, tokens }) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function loadClient(clientPath, projectId) {
  return validateClient(JSON.parse(await readFile(clientPath, "utf8")), projectId);
}

export async function authorizedClient(clientPath, tokenPath, projectId) {
  const [clientFile, tokenFile] = await privateFiles(clientPath, tokenPath);
  const client = await loadClient(clientFile, projectId);
  const saved = JSON.parse(await readFile(tokenFile, "utf8"));
  if (saved.format !== "dbt-source-oauth-v1" || saved.client_id !== client.client_id ||
      saved.project_id !== projectId || !saved.tokens?.refresh_token) throw failure("OAUTH_SAVED_GRANT_INVALID");
  const auth = new OAuth2Client(client.client_id, client.client_secret);
  auth.setCredentials(saved.tokens);
  const token = (await auth.getAccessToken()).token;
  if (!token) throw failure("OAUTH_ACCESS_TOKEN_MISSING");
  validateGrant(await auth.getTokenInfo(token), client.client_id);
  return auth;
}

export async function login(clientPath, tokenPath, projectId) {
  const [clientFile, tokenFile] = await privateFiles(clientPath, tokenPath);
  const client = await loadClient(clientFile, projectId);
  const state = randomBytes(32).toString("base64url");
  let auth, verifier, authorizationUrl, claimed = false, timeout;
  let complete, reject;
  const done = new Promise((yes, no) => { complete = yes; reject = no; });
  const server = createServer(async (request, response) => {
    const reply = (status, message) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'" });
      response.end(message);
    };
    if (!authorizationUrl) return reply(503, "Authorization is starting.");
    if (request.method !== "GET" || typeof request.url !== "string" || request.url.length > 8192)
      return reply(400, "Invalid request.");
    let url;
    try { url = new URL(request.url, "http://127.0.0.1"); }
    catch { return reply(400, "Invalid request."); }
    if (url.pathname === "/authorize") {
      if (claimed) return reply(409, "Authorization already received.");
      response.writeHead(302, { Location: authorizationUrl, "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer" }); response.end(); return;
    }
    const result = callbackResult(url, state);
    if (result.denied) { reply(403, "Authorization declined. You can close this page."); reject(failure("OAUTH_USER_DENIED")); return; }
    if (result.status !== 200) return reply(result.status, "Invalid authorization callback.");
    if (claimed) return reply(409, "Authorization already received.");
    claimed = true;
    try {
      const { tokens } = await auth.getToken({ code: result.code, codeVerifier: verifier });
      auth.setCredentials(tokens);
      if (!tokens.access_token) throw failure("OAUTH_ACCESS_TOKEN_MISSING");
      validateGrant(await auth.getTokenInfo(tokens.access_token), client.client_id);
      await saveGrant(tokenFile, client, tokens);
      reply(200, "Dragon Boat authorization saved. You can close this page.");
      complete();
    } catch { reply(500, "Authorization could not be saved. No credentials are shown on this page."); reject(failure("OAUTH_LOGIN_UNCONFIRMED")); }
  });
  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
    const redirect = `http://127.0.0.1:${server.address().port}/callback`;
    auth = new OAuth2Client(client.client_id, client.client_secret, redirect);
    const pkce = await auth.generateCodeVerifierAsync(); verifier = pkce.codeVerifier;
    authorizationUrl = auth.generateAuthUrl({ access_type: "offline", prompt: "consent select_account",
      scope: SOURCE_SCOPES, state, code_challenge: pkce.codeChallenge, code_challenge_method: "S256" });
    timeout = setTimeout(() => reject(failure("OAUTH_LOGIN_TIMEOUT")), 15 * 60 * 1000);
    console.log(JSON.stringify({ status: "WAITING_FOR_USER_CONSENT", project_id: projectId,
      login_url: `http://127.0.0.1:${server.address().port}/authorize` }));
    await done;
    console.log(JSON.stringify({ status: "OAUTH_AUTHORIZED", project_id: projectId, required_scopes: SOURCE_SCOPES.length }));
  } finally { clearTimeout(timeout); server.close(); server.closeAllConnections(); }
}

export async function probe(auth) {
  const endpoints = [
    ["forms", "https://forms.googleapis.com/v1/forms/c2_source_capability_probe_nonexistent"],
    ["sheets", "https://sheets.googleapis.com/v4/spreadsheets/c2_source_capability_probe_nonexistent"],
    ["drive", "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)"],
  ];
  const result = [];
  for (const [api, url] of endpoints) {
    try { await auth.request({ url, method: "GET", timeout: 30_000, retry: false }); result.push({ api, status: 200 }); }
    catch (error) {
      const reasons = error.response?.data?.error?.details?.map(detail => detail.reason).filter(reason =>
        ["SERVICE_DISABLED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "API_KEY_SERVICE_BLOCKED"].includes(reason)) ?? [];
      result.push({ api, status: Number(error.response?.status) || 0, reasons });
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, clientPath, tokenPath, projectId] = process.argv.slice(2);
    if (mode === "login") await login(clientPath, tokenPath, projectId);
    else if (mode === "probe") console.log(JSON.stringify({ status: "OAUTH_GRANT_CHECKED",
      project_id: projectId, probes: await probe(await authorizedClient(clientPath, tokenPath, projectId)) }));
    else throw failure("OAUTH_COMMAND_INVALID");
  } catch (error) {
    console.error(JSON.stringify({ status: "OAUTH_FAILED", code: /^OAUTH_[A-Z_]+$/u.test(error.code ?? "") ? error.code : "OAUTH_OPERATION_UNCONFIRMED" }));
    process.exitCode = 1;
  }
}
