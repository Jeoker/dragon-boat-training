// Trusted single-machine operator entry. No public listener and no automatic retries.
import { createHash } from "node:crypto";
import { open, unlink, realpath, lstat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPrivatePath, readPrivateText } from "./private-paths.mjs";
import { createPrivateFileOperationStore } from "./private-file-store.mjs";
import { authorizedClient } from "./oauth-local.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loadRuntime = () => import(pathToFileURL(resolve(here, "../.private-host/backend/source-journal/host-runtime.js")));
const parsePrivate = async text => (await loadRuntime()).parseSourceJson(text);
const hash = async text => createHash("sha256").update(text).digest("base64url");
const fail = () => new Error("PRIVATE_HOST_UNCONFIRMED");
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) throw fail();
  return value;
}

export async function readHostConfig(path) {
  try {
    const row = exact(await parsePrivate(await readPrivateText(path)), ["format", "server", "request_id", "season_id",
      "credentials_file", "store_directory", "oauth"]);
    if (row.format !== "c2-private-host-v1" || !/^[A-Za-z0-9_-]{8,128}$/u.test(row.request_id) ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(row.season_id)) throw fail();
    exact(row.server, ["origin", "team_id", "backend_instance", "backend_generation", "writer_epoch"]);
    const oauth = exact(row.oauth, ["project_id", "client_file", "token_file"]);
    if (typeof oauth.project_id !== "string" || !/^[a-z][a-z0-9-]{4,62}$/u.test(oauth.project_id)) throw fail();
    const paths = await Promise.all([path, row.credentials_file, oauth.client_file, oauth.token_file].map(path => assertPrivatePath(path)));
    const directory = await assertPrivatePath(row.store_directory, true);
    const identity = path => process.platform === "win32" ? path.toLowerCase() : path;
    if (new Set(paths.map(identity)).size !== 4) throw fail();
    return { ...row, store_directory: directory };
  } catch { throw fail(); }
}

export async function openPrivateHost(configPath, ports = {}) {
  try {
    const config = await readHostConfig(configPath);
    const runtime = ports.runtime ?? await loadRuntime();
    const credentials = async () => {
      const value = exact(await parsePrivate(await readPrivateText(config.credentials_file)), ["transport_key", "session_token"]);
      if (![value.transport_key, value.session_token].every(item => typeof item === "string" && item.length > 0 && item.length <= 16_000 && !/[\r\n]/u.test(item))) throw fail();
      return value;
    };
    await credentials();
    const client = new runtime.SourceServerAuthorityClient(config.server, credentials, hash, ports.fetchServer);
    const pin = () => client.pin(config.request_id, config.season_id);
    const directory = config.store_directory, rawStore = await createPrivateFileOperationStore(directory);
    const checkRecord = async key => {
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(key)) throw fail();
      const file = join(directory, `${key}.json`);
      try { await lstat(file); } catch (error) { if (error.code === "ENOENT") return; throw fail(); }
      await assertPrivatePath(file);
    };
    const store = {
      async read(key) { await assertPrivatePath(directory, true); await checkRecord(key); return rawStore.read(key); },
      async compareAndSet(key, revision, row) {
        await assertPrivatePath(directory, true); await checkRecord(key);
        const saved = await rawStore.compareAndSet(key, revision, row); await checkRecord(key); return saved;
      },
    };
    const registry = new runtime.PrivateSourceTargetRegistry(config.server.team_id, store, hash);
    let auth;
    const token = async () => {
      if (ports.oauthToken) return ports.oauthToken();
      await assertPrivatePath(config.oauth.client_file); await assertPrivatePath(config.oauth.token_file);
      auth ??= await authorizedClient(config.oauth.client_file, config.oauth.token_file, config.oauth.project_id);
      const result = await auth.getAccessToken(); if (!result.token) throw fail(); return result.token;
    };
    let busy = false;
    const publishPrivate = async (argument, value) => {
      if (typeof argument !== "string") throw fail();
      const parent = await assertPrivatePath(dirname(argument), true), output = resolve(parent, argument.split(/[\\/]/u).at(-1));
      if (resolve(argument) !== output) throw fail();
      const text = JSON.stringify(value); if (Buffer.byteLength(text) > 2_000_000) throw fail();
      let file;
      try {
        file = await open(output, "wx", 0o600); await assertPrivatePath(output);
        await file.writeFile(text); await file.sync();
      } finally { await file?.close(); }
    };
    return {
      async run(action, argument) {
        if (busy) throw fail(); busy = true;
        const lockPath = join(directory, "host.lock"); let lock;
        try {
          await assertPrivatePath(directory, true);
          if (await realpath(config.store_directory) !== directory) throw fail();
          lock = await open(lockPath, "wx", 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
          await assertPrivatePath(lockPath);
          // Current credentials are reloaded on every server authorization call.
          const serverPin = await pin();
          if (action === "validate") return { status: "PRIVATE_HOST_CONFIG_AND_AUTHORITY_READY", source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
          if (action === "pin-export") {
            await publishPrivate(argument, serverPin);
            return { status: "PRIVATE_PIN_EXPORTED", source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
          }
          if (action === "register") {
            await registry.register(serverPin, await parsePrivate(await readPrivateText(argument)));
            // Verify current authority after registration too; an unconfirmed immutable record may remain.
            if (JSON.stringify(await pin()) !== JSON.stringify(serverPin)) throw fail();
            return { status: "TARGET_REGISTERED", source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false };
          }
          const operation = await runtime.createPrivateSourceRuntime({ authorize: pin,
            registeredTarget: id => registry.get(id), store, hash, oauthToken: token, fetchGoogle: ports.fetchGoogle });
          if (["capture", "stage", "resume"].includes(action)) {
            const result = await operation[action]();
            return { status: "OPERATION_CONFIRMED", phase: result.phase, revision: result.revision,
              source_status: result.source_status, annual_export_authorized: result.annual_export_authorized };
          }
          const review = new runtime.PrivateSourceReview(operation, store, hash);
          if (action === "review-export") {
            const result = await review.view();
            await publishPrivate(argument, result);
            return { status: "PRIVATE_REVIEW_EXPORTED", source_status: result.source_status, annual_export_authorized: false };
          }
          if (action === "review-append") {
            const result = await review.append(await readPrivateText(argument, 32_000));
            return { status: "PRIVATE_REVIEW_CONFIRMED", ledger_version: result.ledger_version,
              source_status: result.source_status, annual_export_authorized: result.annual_export_authorized };
          }
          throw fail();
        } catch { throw fail(); }
        finally {
          try { if (lock) { await lock.close(); await unlink(lockPath); } }
          catch { throw fail(); }
          finally { busy = false; }
        }
      },
    };
  } catch { throw fail(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, configPath, argument, acknowledgement, ...extra] = process.argv.slice(2);
  try {
    const arity = { validate: 2, "pin-export": 3, register: 3, capture: 2, stage: 3, resume: 2, "review-export": 3, "review-append": 4 };
    if (!Object.hasOwn(arity, action) || process.argv.slice(2).length !== arity[action] || extra.length ||
      (action === "stage" && argument !== "--write-private-journal") ||
      (action === "review-append" && acknowledgement !== "--append-private-review")) throw fail();
    const host = await openPrivateHost(configPath);
    console.log(JSON.stringify(await host.run(action, action === "stage" ? undefined : argument)));
  } catch { console.error(JSON.stringify({ status: "PRIVATE_HOST_UNCONFIRMED" })); process.exitCode = 1; }
}
