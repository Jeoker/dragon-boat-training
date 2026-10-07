// Offline verification. Explicit private inputs and independently kept digests.
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBackupPrivateJson } from "./cli.mjs";

export async function reconcileBackupFiles(before, beforeDigest, after, afterDigest, contextFile) {
  const context = await readBackupPrivateJson(contextFile, 64_000);
  if (!context || Object.keys(context).sort().join() !== "actor_id,backup_request_id,generation,writer_epoch") throw Error("BOOTSTRAP_RECONCILIATION_UNCONFIRMED");
  const runtime = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../.backup-tool/runtime.mjs")));
  return runtime.reconcileBootstrapBackups(await readBackupPrivateJson(before), beforeDigest,
    await readBackupPrivateJson(after), afterDigest, context);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).length !== 5) throw Error();
    console.log(JSON.stringify(await reconcileBackupFiles(...process.argv.slice(2))));
  } catch { console.error("BOOTSTRAP_RECONCILIATION_UNCONFIRMED"); process.exitCode = 1; }
}
