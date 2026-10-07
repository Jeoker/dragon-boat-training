// Explicit isolated operator tool. No secret discovery, login, deployment or automatic retry.
import { createHash, randomUUID } from "node:crypto";
import { open, lstat, realpath, link, unlink, readdir } from "node:fs/promises";
import { resolve, dirname, basename, isAbsolute, parse as parsePath, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPrivatePath, readPrivateText } from "../source-journal/private-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = () => import(pathToFileURL(resolve(here, "../.backup-tool/runtime.mjs")));
export const ISOLATED_BACKUP_ORIGIN = "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev";
const LIMIT = 30_000_000, RESPONSE_LIMIT = 2_000_000;
const failure = () => new Error("BUSINESS_BACKUP_UNCONFIRMED");
const sha = text => createHash("sha256").update(text).digest("base64url");
const equalPath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const exact = (value, fields) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw failure();
  return value;
};
const identity = value => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
const timestamp = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw failure();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw failure();
  return time;
};

/** Existing source-host checks enforce private ACLs/outside repository. This
 * additional wrapper rejects ALL ancestor aliases, reparse links and hardlinks. */
export async function backupPrivatePath(path, directory = false) {
  try {
    if (!isAbsolute(path) || !equalPath(resolve(path), path)) throw failure();
    const actual = await assertPrivatePath(path, directory);
    if (!equalPath(actual, resolve(path))) throw failure();
    let current = resolve(path), root = parsePath(current).root;
    for (;;) {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1) ||
        (current !== root && /[<>:"|?*\x00-\x1f]|[. ]$/u.test(basename(current)))) throw failure();
      if (current === root) break;
      current = dirname(current);
    }
    return actual;
  } catch { throw failure(); }
}
async function outputPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || !equalPath(resolve(path), path) ||
    /[<>:"|?*\x00-\x1f]|[. ]$/u.test(basename(path))) throw failure();
  const parent = await backupPrivatePath(dirname(path), true);
  if (!equalPath(join(parent, basename(path)), path)) throw failure();
  return path;
}
async function absent(path) {
  try { await lstat(path); throw failure(); }
  catch (error) { if (error.code !== "ENOENT") throw failure(); }
}
async function readJson(path, bytes = LIMIT) {
  await backupPrivatePath(path); const text = await readPrivateText(path, bytes); await backupPrivatePath(path);
  return (await runtime()).parseBusinessBackupJson(text, bytes);
}
async function existing(path, bytes = LIMIT) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw failure(); }
  return readJson(path, bytes);
}

// The self-rotation tool shares the same reviewed private/no-replace boundary.
export { readJson as readBackupPrivateJson, writeNew as writeBackupPrivateJson,
  outputPath as backupPrivateOutputPath, existing as existingBackupPrivateJson };
async function removeOwned(path, owned) {
  if (!owned) return;
  await backupPrivatePath(dirname(path), true);
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw failure();
  await unlink(path);
}
/** Atomic no-replace publication. A crash may leave a private temp/hardlink;
 * such a path remains unconfirmed and is never silently repaired or overwritten. */
async function writeNew(path, value, maxBytes = LIMIT) {
  await outputPath(path); await absent(path);
  const text = JSON.stringify(value), size = Buffer.byteLength(text);
  if (size > maxBytes) throw failure();
  const temp = join(dirname(path), `.backup-${randomUUID()}.tmp`); let handle, owned;
  try {
    handle = await open(temp, "wx", 0o600); owned = await handle.stat(); await backupPrivatePath(temp);
    await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
    await backupPrivatePath(temp); await outputPath(path);
    await link(temp, path); // link is atomic and cannot replace an existing path.
    await removeOwned(temp, owned); await backupPrivatePath(path);
    const actual = await readPrivateText(path, maxBytes);
    if (actual !== text) throw failure();
  } catch { throw failure(); }
  finally { await handle?.close().catch(() => {}); await removeOwned(temp, owned).catch(() => {}); }
}

export async function readBackupConfig(path) {
  try {
    const value = exact(await readJson(path, 64_000), ["format", "server", "schema_version", "request_id", "credentials_file", "store_directory", "output_file"]);
    if (value.format !== "c2-isolated-business-backup-v1" || ![14, 16].includes(value.schema_version) || !identity(value.request_id)) throw failure();
    const server = exact(value.server, ["origin", "team_id", "backend_instance", "backend_generation", "writer_epoch"]);
    if (server.origin !== ISOLATED_BACKUP_ORIGIN || server.team_id !== "pentasus-c2-test" ||
      server.backend_instance !== "dragon-boat-training-c2-test" || !identity(server.backend_generation) ||
      !Number.isSafeInteger(server.writer_epoch) || server.writer_epoch < 0) throw failure();
    await backupPrivatePath(value.credentials_file); await backupPrivatePath(value.store_directory, true); await outputPath(value.output_file);
    if ([path, value.credentials_file].some(item => equalPath(item, value.output_file)) ||
      equalPath(dirname(value.output_file), value.store_directory)) throw failure();
    return value;
  } catch { throw failure(); }
}

function summary(status, manifest) {
  return { status, snapshot_id: manifest.snapshot_id, captured_at: manifest.created_at, schema_version: manifest.schema_version, table_count: manifest.table_count,
    record_count: manifest.record_count, chunk_count: manifest.chunk_count, content_digest: manifest.content_digest,
    verification: "OFFLINE_INTEGRITY_ONLY" };
}

export async function verifyBackupFile(path, expectedDigest) {
  try {
    if (typeof expectedDigest !== "string" || !/^sha256_v1:[A-Za-z0-9_-]{43}$/u.test(expectedDigest)) throw failure();
    const checked = await (await runtime()).verifyBusinessBackup(await readJson(path));
    timestamp(checked.manifest.created_at);
    if (checked.manifest.content_digest !== expectedDigest) throw failure();
    return summary("BUSINESS_BACKUP_OFFLINE_VERIFIED", checked.manifest);
  } catch { throw failure(); }
}

export async function downloadBusinessBackup(configPath, mode, ports = {}) {
  let lock, lockPath;
  try {
    if (!["download", "resume"].includes(mode)) throw failure();
    const config = await readBackupConfig(configPath), r = await runtime(), configText = r.canonicalJson(config);
    const directory = config.store_directory;
    lockPath = join(directory, "download.lock");
    await backupPrivatePath(directory, true); lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync(); await backupPrivatePath(lockPath);
    const headerPath = join(directory, "header.json"); let header = await existing(headerPath, 64_000);
    if (header) {
      exact(header, ["format", "config_text", "actor_id", "snapshot_id", "service_version", "capture_not_before"]);
      if (mode !== "resume" || header.format !== "c2-business-backup-download-v1" || header.config_text !== configText ||
        !identity(header.actor_id) || typeof header.service_version !== "string") throw failure();
      timestamp(header.capture_not_before);
    } else {
      if (mode !== "download" || (await readdir(directory)).some(name => name !== "download.lock")) throw failure();
      await absent(config.output_file);
    }
    let serviceVersion = header?.service_version, serverTime;
    const credentials = async () => {
      const values = exact(await readJson(config.credentials_file, 64_000), ["transport_key", "session_token"]);
      if (Object.values(values).some(v => typeof v !== "string" || !v || v.length > 16_000 || /[\r\n\0]/u.test(v))) throw failure();
      return values;
    };
    const fetchJson = async (action, extra, secret) => {
      await backupPrivatePath(directory, true); await backupPrivatePath(configPath);
      // Recheck fixed configuration; changing credentials contents is allowed,
      // but currentactor must remain the original authenticated actor.
      if (r.canonicalJson(await readBackupConfig(configPath)) !== configText) throw failure();
      const url = `${config.server.origin}/internal/c1/${action}`, controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000); let response;
      try {
        response = await (ports.fetchServer ?? fetch)(url, { method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
          headers: { authorization: `Bearer ${secret.transport_key}`, "content-type": "application/json" },
          body: JSON.stringify({ request_id: config.request_id, session_token: secret.session_token, ...extra }) });
        if (response.status !== 200 || response.redirected || response.url && response.url !== url ||
          !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") || !response.body) throw failure();
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > RESPONSE_LIMIT)) throw failure();
        const reader = response.body.getReader(), parts = []; let size = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; if (size > RESPONSE_LIMIT) throw failure(); parts.push(Buffer.from(next.value)); }
        } finally { try { await reader.cancel().catch(() => {}); } finally { reader.releaseLock(); } }
        const body = exact(r.parseBusinessBackupJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)), RESPONSE_LIMIT), ["ok", "data", "meta"]);
        const meta = body.meta;
        if (body.ok !== true || !meta || meta.contract_version !== r.C1_CONTRACT_VERSION || meta.request_id !== config.request_id ||
          meta.environment !== "staging" || meta.backend_instance !== config.server.backend_instance ||
          meta.backend_generation !== config.server.backend_generation || meta.writer_epoch !== config.server.writer_epoch ||
          typeof meta.service_version !== "string" || !meta.service_version) throw failure();
        timestamp(meta.server_time);
        if (header && timestamp(meta.server_time) < timestamp(header.capture_not_before)) throw failure();
        serverTime = meta.server_time;
        serviceVersion ??= meta.service_version;
        if (meta.service_version !== serviceVersion) throw failure();
        return body.data;
      } catch { throw failure(); }
      finally { clearTimeout(timer); await response?.body?.cancel().catch(() => {}); }
    };
    const bootstrap = async secret => {
      const data = await fetchJson("coach-bootstrap", {}, secret), actor = data?.coach?.coach_id;
      if (!identity(actor) || header && actor !== header.actor_id) throw failure();
      return actor;
    };
    const call = async (action, extra = {}) => {
      const secret = await credentials(); await bootstrap(secret);
      const result = await fetchJson(action, extra, secret);
      await bootstrap(secret); return result;
    };
    const secret = await credentials(), actor = await bootstrap(secret);
    // A new download must not silently replay a snapshot created before its
    // first authenticated server observation. Resume preserves this boundary.
    const captureNotBefore = header?.capture_not_before ?? serverTime;
    const operations = await call("get-operations");
    if (operations.schema_version !== config.schema_version) throw failure();
    const expectedSnapshot = `backup_${("req_v2_" + sha(`${config.server.team_id}\n${actor}\ncreateBackupSnapshot\n${config.request_id}`)).slice(-32)}`;
    if (!header) {
      header = { format: "c2-business-backup-download-v1", config_text: configText, actor_id: actor, snapshot_id: expectedSnapshot,
        service_version: serviceVersion, capture_not_before: captureNotBefore };
      await writeNew(headerPath, header, 64_000);
    }
    if (header.snapshot_id !== expectedSnapshot) throw failure();
    const validateCapturedManifest = async value => {
      await validateManifest(value, config.schema_version, header.snapshot_id, r);
      const captured = timestamp(value.created_at);
      if (captured < timestamp(header.capture_not_before) || captured > timestamp(serverTime)) throw failure();
    };
    const manifestPath = join(directory, "manifest.json"); let manifest = await existing(manifestPath, RESPONSE_LIMIT);
    if (!manifest) {
      const created = await call("create-backup-snapshot");
      if (created.result?.snapshot_id !== header.snapshot_id || created.result?.manifest?.snapshot_id !== header.snapshot_id ||
        created.operation?.action !== "createBackupSnapshot" || created.operation?.request_id !== config.request_id) throw failure();
      manifest = created.result.manifest; await validateCapturedManifest(manifest);
      await writeNew(manifestPath, manifest, RESPONSE_LIMIT);
    }
    await validateCapturedManifest(manifest);
    const checkRemote = async () => {
      const data = await call("verify-backup-snapshot", { snapshot_id: header.snapshot_id, content_digest: manifest.content_digest });
      if (data.snapshot_id !== header.snapshot_id || data.verified !== true || data.expected_content_digest !== manifest.content_digest ||
        data.chunk_count !== manifest.chunk_count || data.record_count !== manifest.record_count) throw failure();
    };
    await checkRemote();
    const chunks = []; let totalBytes = Buffer.byteLength(JSON.stringify({ manifest, chunks: [] }));
    for (let index = 0; index < manifest.chunk_count; index++) {
      const path = join(directory, `chunk-${String(index).padStart(6, "0")}.json`); let chunk = await existing(path, RESPONSE_LIMIT);
      if (!chunk) {
        const data = await call("get-backup-chunk", { snapshot_id: header.snapshot_id, chunk_index: index });
        if (data.snapshot_id !== header.snapshot_id || r.canonicalJson(data.manifest) !== r.canonicalJson(manifest)) throw failure();
        chunk = data.chunk; await validateChunk(chunk, manifest.chunks[index], r);
        await writeNew(path, chunk, RESPONSE_LIMIT);
      }
      await validateChunk(chunk, manifest.chunks[index], r);
      totalBytes += Buffer.byteLength(JSON.stringify(chunk)) + 1;
      if (totalBytes > LIMIT) throw failure(); chunks.push(chunk);
    }
    const bundle = { manifest, chunks };
    await r.verifyBusinessBackup(bundle); await checkRemote();
    if ((await call("get-operations")).schema_version !== config.schema_version) throw failure();
    const old = await existing(config.output_file);
    if (old !== null) {
      if (mode !== "resume" || r.canonicalJson(old) !== r.canonicalJson(bundle)) throw failure();
      await r.verifyBusinessBackup(old);
    } else await writeNew(config.output_file, bundle);
    await backupPrivatePath(directory, true);
    return summary("BUSINESS_BACKUP_DOWNLOADED", manifest);
  } catch { throw failure(); }
  finally {
    if (lock) {
      try {
        await backupPrivatePath(lockPath);
        const owned = await lock.stat(), current = await lstat(lockPath);
        if (owned.dev !== current.dev || owned.ino !== current.ino) throw failure();
        await lock.close(); lock = null; await unlink(lockPath);
      } catch { await lock?.close().catch(() => {}); }
    }
  }
}

async function validateManifest(manifest, schema, snapshot, r) {
  exact(manifest, ["snapshot_id", "schema_version", "format", "created_at", "tables", "table_count", "record_count", "chunk_count", "chunks", "content_digest"]);
  const tables = schema === 14 ? r.BACKUP_TABLES.slice(0, 47) : r.BACKUP_TABLES;
  if (manifest.snapshot_id !== snapshot || manifest.schema_version !== schema || manifest.format !== "sqlite-json-chunks-v1" ||
    !Number.isFinite(Date.parse(manifest.created_at)) || manifest.table_count !== tables.length || !Array.isArray(manifest.tables) ||
    manifest.tables.length !== tables.length || !Array.isArray(manifest.chunks) || manifest.chunk_count !== manifest.chunks.length ||
    manifest.chunk_count > 10_000 || !Number.isSafeInteger(manifest.record_count) || manifest.record_count < 0) throw failure();
  const { content_digest, ...core } = manifest;
  if (content_digest !== `sha256_v1:${sha(r.canonicalJson(core))}`) throw failure();
  let ordinal = 0, count = 0;
  for (const [index, name] of tables.entries()) {
    const table = exact(manifest.tables[index], ["name", "row_count", "chunk_indices"]);
    if (table.name !== name || !Number.isSafeInteger(table.row_count) || table.row_count < 0 || !Array.isArray(table.chunk_indices) ||
      table.chunk_indices.length !== Math.ceil(table.row_count / 100)) throw failure();
    for (let offset = 0; offset < table.row_count; offset += 100) {
      const descriptor = exact(manifest.chunks[ordinal], ["chunk_index", "table_name", "row_offset", "row_count", "payload_digest"]);
      if (table.chunk_indices[offset / 100] !== ordinal || descriptor.chunk_index !== ordinal || descriptor.table_name !== name ||
        descriptor.row_offset !== offset || descriptor.row_count !== Math.min(100, table.row_count - offset) ||
        !/^sha256_v1:[A-Za-z0-9_-]{43}$/u.test(descriptor.payload_digest)) throw failure(); ordinal++;
    }
    count += table.row_count;
  }
  if (ordinal !== manifest.chunk_count || count !== manifest.record_count) throw failure();
}
async function validateChunk(chunk, descriptor, r) {
  exact(chunk, ["chunk_index", "table_name", "row_offset", "row_count", "payload_digest", "payload"]);
  const { payload, ...actual } = chunk;
  exact(payload, ["table", "row_offset", "rows"]);
  if (r.canonicalJson(actual) !== r.canonicalJson(descriptor) || payload.table !== descriptor.table_name || payload.row_offset !== descriptor.row_offset ||
    !Array.isArray(payload.rows) || payload.rows.length !== descriptor.row_count ||
    chunk.payload_digest !== `sha256_v1:${sha(r.canonicalJson(payload))}`) throw failure();
  for (const row of payload.rows) {
    exact(row, r.BUSINESS_BACKUP_COLUMNS[descriptor.table_name]);
    if (Object.values(row).some(v => v !== null && typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v)))) throw failure();
  }
}

export async function runBackupCli(args) {
  const [action, path, extra] = args;
  if (action === "verify" && args.length === 3) return verifyBackupFile(path, extra);
  if (action === "download" && args.length === 3 && extra === "--create-protected-snapshot") return downloadBusinessBackup(path, action);
  if (action === "resume" && args.length === 2) return downloadBusinessBackup(path, action);
  throw failure();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runBackupCli(process.argv.slice(2)))); }
  catch { console.error("BUSINESS_BACKUP_UNCONFIRMED"); process.exitCode = 1; }
}
