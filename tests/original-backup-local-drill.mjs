// Test-only local workerd/SQLite operator drill. Never sends remote requests.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { backupPrivatePath, readBackupPrivateJson, writeBackupPrivateJson, verifyBackupFile } from "../backend/backup/cli.mjs";

const [bundlePath, expectedDigest, receiptPath, targetDirectory] = process.argv.slice(2);
let worker;
try {
  if (process.argv.slice(2).length !== 4) throw Error();
  const verified = await verifyBackupFile(bundlePath, expectedDigest);
  const receipt = await readBackupPrivateJson(receiptPath,64_000);
  if (receipt.format !== "c2-business-backup-trusted-receipt-v1" || receipt.bundle_file !== bundlePath ||
      receipt.expected_content_digest !== expectedDigest || receipt.verification !== "OFFLINE_INTEGRITY_ONLY") throw Error();
  for (const field of ["snapshot_id","schema_version","table_count","record_count","chunk_count","captured_at"])
    if (receipt[field] !== verified[field]) throw Error();
  await backupPrivatePath(targetDirectory,true);
  if ((await readdir(targetDirectory)).length !== 0) throw Error();
  const bundle = await readBackupPrivateJson(bundlePath);
  const compiled = await build({entryPoints:["cloudflare/test/original-backup-local-drill-worker.ts"],bundle:true,write:false,
    format:"esm",target:"es2022",external:["cloudflare:workers"],logLevel:"silent"});
  const persistence = join(targetDirectory,"sqlite"); await mkdir(persistence,{mode:0o700});
  await backupPrivatePath(persistence,true);
  let attemptedOutbound = 0;
  worker = new Miniflare(convertV4MiniflareOptions({name:"original-backup-local-drill",modules:true,script:compiled.outputFiles[0].text,
    compatibilityDate:"2026-09-19",log:new Log(LogLevel.NONE),durableObjects:{LOCAL_DRILL:{className:"OriginalBackupLocalDrill",useSQLite:true}},
    durableObjectsPersist:persistence,cachePersist:join(targetDirectory,"cache"),
    outboundService:()=>{ attemptedOutbound++; return new Response("LOCAL_NETWORK_FORBIDDEN",{status:403}); }}));
  const response = await worker.dispatchFetch("https://local-drill.invalid/restore",{method:"POST",body:JSON.stringify({bundle,expectedDigest}),headers:{"content-type":"application/json"}});
  const result = await response.json();
  if (!response.ok || result.status!=="ORIGINAL_BUSINESS_BACKUP_LOCAL_SQLITE_DRILL_PASSED" || attemptedOutbound !== 0) throw Error();
  await worker.dispose(); worker=null;
  const summary={...verified,...result,outbound_requests:attemptedOutbound,sqlite_directory:persistence,
    verification_scope:"REAL_ORIGINAL_REMOTE_BUNDLE_LOCAL_PRODUCTION_RESTORE_NO_CLOUD_AUTHORITY_ACTIVATION"};
  await writeBackupPrivateJson(join(targetDirectory,"redacted-summary.json"),summary,64_000);
  console.log(JSON.stringify(summary));
} catch { process.stderr.write("ORIGINAL_BACKUP_LOCAL_DRILL_UNCONFIRMED\n"); process.exitCode=1; }
finally { await worker?.dispose().catch(()=>{}); }
