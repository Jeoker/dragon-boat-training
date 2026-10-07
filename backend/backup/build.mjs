import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
export async function buildBusinessBackupTool() {
  await build({ entryPoints: [resolve(here, "runtime.ts")], outfile: resolve(here, "../.backup-tool/runtime.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildBusinessBackupTool(); console.log(JSON.stringify({ status: "BACKUP_TOOL_BUILD_READY" })); }
  catch { console.error("BUSINESS_BACKUP_UNCONFIRMED"); process.exitCode = 1; }
}
