// Explicit isolated self-rotation. A persisted attempt is never submitted again.
import { createHash } from "node:crypto";
import { open, lstat, unlink, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ISOLATED_BACKUP_ORIGIN, backupPrivatePath, backupPrivateOutputPath,
  readBackupPrivateJson, writeBackupPrivateJson, existingBackupPrivateJson } from "../backup/cli.mjs";
const fail=()=>new Error("COACH_CODE_ROTATION_UNCONFIRMED");
const runtime=()=>import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)),"../.backup-tool/runtime.mjs")));
const samePath=(a,b)=>process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;
const identity=v=>typeof v==="string" && /^[A-Za-z0-9_-]{8,128}$/u.test(v);
const digest=v=>typeof v==="string" && /^sha256_v1:[A-Za-z0-9_-]{43}$/u.test(v);
const loginRequestId=(c,payload)=>"rotation_login_"+createHash("sha256").update(`${c.coach_id}\n${c.request_id}\n${payload}`).digest("base64url");
const exact=(v,keys)=>{
  if(!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).length!==keys.length || keys.some(k=>!Object.hasOwn(v,k)))throw fail();
  return v;
};
const time=v=>{
  if(typeof v!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString()!==v)throw fail();
};
export async function readCoachRotationConfig(path){
  const c=exact(await readBackupPrivateJson(path,64_000),["format","server","schema_version","coach_id","expected_credential_version","request_id",
    "credentials_file","new_code_file","protection_file","protection_digest","store_directory","output_credentials_file"]);
  if(c.format!=="c1-self-coach-rotation-v1" || !identity(c.coach_id) || !identity(c.request_id) || ![14,16].includes(c.schema_version) ||
    !Number.isSafeInteger(c.expected_credential_version) || c.expected_credential_version<1 || c.expected_credential_version>=Number.MAX_SAFE_INTEGER || !digest(c.protection_digest))throw fail();
  const s=exact(c.server,["origin","team_id","backend_instance","backend_generation","writer_epoch"]);
  if(s.origin!==ISOLATED_BACKUP_ORIGIN || s.team_id!=="pentasus-c2-test" || s.backend_instance!=="dragon-boat-training-c2-test" ||
    !identity(s.backend_generation) || !Number.isSafeInteger(s.writer_epoch) || s.writer_epoch<0)throw fail();
  for(const key of ["credentials_file","new_code_file","protection_file"])await backupPrivatePath(c[key]);
  await backupPrivatePath(c.store_directory,true);await backupPrivateOutputPath(c.output_credentials_file);
  if([path,c.credentials_file,c.new_code_file,c.protection_file].some(p=>samePath(p,c.output_credentials_file)) || samePath(dirname(c.output_credentials_file),c.store_directory))throw fail();
  return c;
}
export async function runCoachRotation(configPath,mode,ports={}){
  let lock,lockPath;
  try{
    if(!["prepare","rotate","resume"].includes(mode))throw fail();
    const c=await readCoachRotationConfig(configPath),r=await runtime(),configText=r.canonicalJson(c);
    const protection=await r.verifyBusinessBackup(await readBackupPrivateJson(c.protection_file));
    if(protection.manifest.content_digest!==c.protection_digest || protection.sourceSchemaVersion!==c.schema_version ||
      protection.tables.get("coaches")?.filter(row=>row.coach_id===c.coach_id && row.credential_version===c.expected_credential_version && row.active===1).length!==1)throw fail();
    lockPath=resolve(c.store_directory,"rotation.lock");lock=await open(lockPath,"wx",0o600);
    await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.sync();await backupPrivatePath(lockPath);
    const headerPath=resolve(c.store_directory,"header.json");let header=await existingBackupPrivateJson(headerPath,64_000);
    if(header){
      exact(header,["format","config_text","actor_id","credential_version","payload_digest","service_version","login_request_id"]);
      if(mode!=="resume" || header.format!=="c1-self-coach-rotation-attempt-v1" || header.config_text!==configText || header.actor_id!==c.coach_id ||
        header.credential_version!==c.expected_credential_version || !digest(header.payload_digest) || header.login_request_id!==loginRequestId(c,header.payload_digest) ||
        typeof header.service_version!=="string" || !header.service_version)throw fail();
    }else if(mode==="resume" || (await readdir(c.store_directory)).some(name=>name!=="rotation.lock") || await existingBackupPrivateJson(c.output_credentials_file,64_000)!==null)throw fail();
    let serviceVersion=header?.service_version;
    let invocationCode;
    const newCode=async()=>{
      const v=exact(await readBackupPrivateJson(c.new_code_file,64_000),["new_code"]);
      if(typeof v.new_code!=="string" || !/^[\x21-\x7e]{16,128}$/u.test(v.new_code) || invocationCode!==undefined && v.new_code!==invocationCode)throw fail();
      invocationCode??=v.new_code;return v.new_code;
    };
    const credentials=async()=>{
      const v=exact(await readBackupPrivateJson(c.credentials_file,64_000),["transport_key","session_token"]);
      if(Object.values(v).some(x=>typeof x!=="string" || !x || x.length>16_000 || /[\r\n\0]/u.test(x)))throw fail();return v;
    };
    const fetchC1=async(action,body,secret,requestId=c.request_id)=>{
      if(r.canonicalJson(await readCoachRotationConfig(configPath))!==configText)throw fail();await backupPrivatePath(c.store_directory,true);
      const url=`${c.server.origin}/internal/c1/${action}`,controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),30_000);let response;
      try{
        response=await (ports.fetchServer??fetch)(url,{method:"POST",redirect:"error",cache:"no-store",signal:controller.signal,
          headers:{authorization:`Bearer ${secret.transport_key}`,"content-type":"application/json"},body:JSON.stringify({request_id:requestId,...body})});
        if(response.status!==200 || response.redirected || response.url && response.url!==url || !response.body ||
          !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type")??""))throw fail();
        const length=response.headers.get("content-length");if(length!==null && (!/^\d+$/u.test(length) || Number(length)>100_000))throw fail();
        const reader=response.body.getReader(),parts=[];let size=0;
        try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>100_000)throw fail();parts.push(Buffer.from(p.value));}}
        finally{try{await reader.cancel().catch(()=>{});}finally{reader.releaseLock();}}
        const v=exact(r.parseBusinessBackupJson(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts)),100_000),["ok","data","meta"]),m=v.meta;
        if(v.ok!==true || !m || m.request_id!==requestId || m.contract_version!==r.C1_CONTRACT_VERSION || m.environment!=="staging" ||
          m.backend_instance!==c.server.backend_instance || m.backend_generation!==c.server.backend_generation || m.writer_epoch!==c.server.writer_epoch ||
          typeof m.service_version!=="string" || !m.service_version)throw fail();
        time(m.server_time);serviceVersion??=m.service_version;if(m.service_version!==serviceVersion)throw fail();return v.data;
      }finally{clearTimeout(timer);await response?.body?.cancel().catch(()=>{});}
    };
    const bootstrap=async(secret,version)=>{
      const v=await fetchC1("coach-bootstrap",{session_token:secret.session_token},secret);
      if(v.coach?.coach_id!==c.coach_id || v.coach.credential_version!==version)throw fail();
    };
    const original=await credentials();
    if(!header){
      await bootstrap(original,c.expected_credential_version);
      const operations=await fetchC1("get-operations",{session_token:original.session_token},original);
      if(operations.schema_version!==c.schema_version)throw fail();
      const prepared=await fetchC1("prepare-coach-code-rotation",{session_token:original.session_token,expected_credential_version:c.expected_credential_version,new_code:await newCode()},original);
      await bootstrap(original,c.expected_credential_version);exact(prepared,["coach_id","expected_credential_version","payload_digest"]);
      if(prepared.coach_id!==c.coach_id || prepared.expected_credential_version!==c.expected_credential_version || !digest(prepared.payload_digest))throw fail();
      if(mode==="prepare"){
        const counts=operations.counts;
        if(!counts || [counts.outbox_pending,counts.jobs_pending].some(v=>!Number.isSafeInteger(v) || v<0))throw fail();
        time(protection.manifest.created_at);time(operations.generated_at);await newCode();
        // Preparation has no durable attempt: every explicit rotate repeats the checks.
        return{status:"COACH_CODE_ROTATION_PREPARED",rotation_submitted:false,coach_id:c.coach_id,request_id:c.request_id,
          expected_credential_version:c.expected_credential_version,next_credential_version:c.expected_credential_version+1,
          schema_version:c.schema_version,server:c.server,service_version:serviceVersion,payload_digest:prepared.payload_digest,
          protection_digest:c.protection_digest,protection_captured_at:protection.manifest.created_at,
          operations_observed_at:operations.generated_at,outbox_pending:counts.outbox_pending,jobs_pending:counts.jobs_pending,
          verification:"PROTECTION_AND_CURRENT_COACH_ONLY"};
      }
      const loginId=loginRequestId(c,prepared.payload_digest);
      header={format:"c1-self-coach-rotation-attempt-v1",config_text:configText,actor_id:c.coach_id,credential_version:c.expected_credential_version,
        payload_digest:prepared.payload_digest,service_version:serviceVersion,login_request_id:loginId};
      // Even a failed transport attempt remains UNKNOWN. Never resubmit it.
      await writeBackupPrivateJson(headerPath,header,64_000);
      await fetchC1("rotate-coach-code",{session_token:original.session_token,expected_credential_version:c.expected_credential_version,
        new_code:await newCode(),expected_payload_digest:header.payload_digest},original);
    }
    const logged=await fetchC1("coach-login",{coach_code:await newCode()},original,header.login_request_id);
    if(logged.result?.coach_id!==c.coach_id || typeof logged.result?.session_token!=="string" || logged.result.session_token.length<32)throw fail();
    const current={transport_key:original.transport_key,session_token:logged.result.session_token};
    await bootstrap(current,c.expected_credential_version+1);
    const confirmed=await fetchC1("get-coach-rotation-receipt",{session_token:current.session_token,rotation_request_id:c.request_id,
      expected_credential_version:c.expected_credential_version,new_code:await newCode(),expected_payload_digest:header.payload_digest},current);
    exact(confirmed,["operation","result"]);
    const receipt=exact(confirmed.result,["coach_id","previous_credential_version","credential_version","rotated_at","payload_digest"]),
      operation=exact(confirmed.operation,["action","request_id","committed_at"]);
    if(operation?.action!=="rotateCoachCode" || operation.request_id!==c.request_id || receipt?.coach_id!==c.coach_id ||
      receipt.previous_credential_version!==c.expected_credential_version || receipt.credential_version!==c.expected_credential_version+1 ||
      receipt.payload_digest!==header.payload_digest || operation.committed_at!==receipt.rotated_at)throw fail();
    time(receipt.rotated_at);await bootstrap(current,c.expected_credential_version+1);
    if((await fetchC1("get-operations",{session_token:current.session_token},current)).schema_version!==c.schema_version)throw fail();
    await newCode(); // Recheck private input before publishing confirmation.
    const receiptPath=resolve(c.store_directory,"receipt.json"),priorReceipt=await existingBackupPrivateJson(receiptPath,64_000);
    if(priorReceipt!==null){if(r.canonicalJson(priorReceipt)!==r.canonicalJson(confirmed))throw fail();}else await writeBackupPrivateJson(receiptPath,confirmed,64_000);
    const priorCredentials=await existingBackupPrivateJson(c.output_credentials_file,64_000);
    if(priorCredentials!==null){if(mode!=="resume" || r.canonicalJson(priorCredentials)!==r.canonicalJson(current))throw fail();}else await writeBackupPrivateJson(c.output_credentials_file,current,64_000);
    return{status:"COACH_CODE_ROTATION_CONFIRMED",coach_id:c.coach_id,request_id:c.request_id,previous_credential_version:c.expected_credential_version,
      credential_version:c.expected_credential_version+1,rotated_at:receipt.rotated_at};
  }catch{throw fail();}
  finally{if(lock)try{await backupPrivatePath(lockPath);const owned=await lock.stat(),current=await lstat(lockPath);if(owned.dev!==current.dev || owned.ino!==current.ino)throw fail();
    await lock.close();lock=null;await unlink(lockPath);}catch{await lock?.close().catch(()=>{});}}
}
export async function runCoachRotationCli(args){
  const[action,path,flag]=args;
  if(action==="prepare" && args.length===2)return runCoachRotation(path,action);
  if(action==="rotate" && args.length===3 && flag==="--rotate-own-coach-code")return runCoachRotation(path,action);
  if(action==="resume" && args.length===2)return runCoachRotation(path,action);throw fail();
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await runCoachRotationCli(process.argv.slice(2))));}
  catch{console.error("COACH_CODE_ROTATION_UNCONFIRMED");process.exitCode=1;}
}
