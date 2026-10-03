// Local private operation backend only. Contains raw source content; never
// connect this directory to public artifacts, Worker/DO storage or Git.
import { open, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const MAX_BYTES = 14_000_000;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const error = () => new Error("Private operation storage is unavailable.");
const outside = (root, target) => {
  const path = relative(root, target);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
};

export async function createPrivateFileOperationStore(directory) {
  if (!directory || !isAbsolute(directory) || !outside(repository, resolve(directory))) throw error();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  if (!outside(await realpath(repository), root)) throw error();
  const pathFor = (key, suffix) => {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(key)) throw error();
    return join(root, key + suffix);
  };
  const read = async key => {
    let handle;
    try {
      try { handle = await open(pathFor(key, ".json"), "r"); }
      catch (cause) { if (cause.code === "ENOENT") return null; throw cause; }
      if ((await handle.stat()).size > MAX_BYTES) throw error();
      const chunks = [], buffer = Buffer.alloc(64_000);
      let total = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead; if (total > MAX_BYTES) throw error();
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
      return JSON.parse(text);
    } catch { throw error(); }
    finally { await handle?.close(); }
  };
  return {
    read,
    async compareAndSet(key, revision, value) {
      const lockFile = pathFor(key, ".lock"), temporary = pathFor(key, `.${randomUUID()}.tmp`);
      let lock, output;
      try {
        try { lock = await open(lockFile, "wx", 0o600); }
        catch (cause) { if (cause.code === "EEXIST") return false; throw cause; }
        await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
        const current = await read(key);
        if ((current?.revision ?? null) !== revision) return false;
        if (value.key !== key || value.revision !== (revision ?? 0) + 1) throw error();
        const text = JSON.stringify(value) + "\n";
        if (Buffer.byteLength(text) > MAX_BYTES) throw error();
        output = await open(temporary, "wx", 0o600);
        await output.writeFile(text); await output.sync(); await output.close(); output = null;
        await rename(temporary, pathFor(key, ".json")); return true;
      } catch { throw error(); }
      finally {
        await output?.close(); await unlink(temporary).catch(() => {});
        if (lock) { await lock.close(); await unlink(lockFile); }
      }
    },
  };
}
