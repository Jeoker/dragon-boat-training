import { open, realpath, lstat } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWindowsAcl } from "./windows-acl.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const privatePathFailure = () => new Error("PRIVATE_HOST_PATH_UNCONFIRMED");
const outside = (root, target) => {
  const local = relative(root, target);
  return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local);
};

// These checks deliberately do not change an operator's permissions.
export async function assertPrivatePath(path, directory = false) {
  try {
    if (typeof path !== "string" || !isAbsolute(path)) throw privatePathFailure();
    const resolved = resolve(path), actual = await realpath(resolved), root = await realpath(repository);
    const stat = await lstat(resolved);
    if (!outside(repository, resolved) || !outside(root, actual) || stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile())) throw privatePathFailure();
    if (process.platform === "win32") {
      await checkWindowsAcl(actual);
    } else if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw privatePathFailure();
    return actual;
  } catch { throw privatePathFailure(); }
}

export async function readPrivateText(path, limit = 64_000) {
  let handle;
  try {
    const actual = await assertPrivatePath(path);
    handle = await open(actual, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw privatePathFailure();
    const chunks = []; let total = 0;
    for await (const chunk of handle.readableWebStream()) {
      total += chunk.byteLength; if (total > limit) throw privatePathFailure();
      chunks.push(Buffer.from(chunk));
    }
    await assertPrivatePath(path);
    if (actual !== await realpath(path)) throw privatePathFailure();
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch { throw privatePathFailure(); }
  finally { await handle?.close().catch(() => {}); }
}
