import { C2ArchiveStorage, proveStoredArchiveBudget, type ArchiveStorageContext } from "../src/c2-archive-storage";
import { applySchema, APPLICATION_SCHEMA_VERSION } from "../src/schema";
import { sha256Base64Url } from "../src/crypto";
import { indexExportEvent } from "../src/c2-export-lanes";
import { canonicalJson } from "../../shared/c1-rules";
import {env} from "cloudflare:workers";
import {runInDurableObject,evictDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import worker from "../src/index";
import {TeamState} from "../src/team-state";
import {C1HistoryService} from "../src/c1-history-service";
import {C1Service} from "../src/c1-service";
import {legacyCredentialDigest} from "../src/crypto";
import {archiveCanonical} from "../../shared/c2-archive-contract";

const IncomingRequest=Request<unknown,IncomingRequestCfProperties>;
async function setup(name:string,formal=false,freeze=true){
  const testEnv={...env,TEAM_ID:`archive-capture-${name}`} as unknown as Env;
  const sid=`season_capture_${name}`,pid=`practice_capture_${name}`,mid="member_capture_001",coach="coach_capture_001",at="2020-09-01T12:00:00.000Z";
  const call=async(path:string,payload:Record<string,unknown>)=>{const response=await worker.fetch(new IncomingRequest(`https://example.test${path}`,{method:"POST",
    headers:{authorization:"Bearer local-c1-test-key","content-type":"application/json"},body:JSON.stringify(payload)}),testEnv);
    const body:any=await response.json();expect(response.status,JSON.stringify(body)).toBe(200);return body.data;};
  await call("/internal/c1/import-core",{request_id:`core_capture_${name}`,source_snapshot_id:`source_core_${name}`,settings_version:1,default_season_id:sid,
    coaches:[{coach_id:coach,display_name:"Coach",code_salt:"capture_local_salt",code_digest:await legacyCredentialDigest("capture_local_salt","local-test-coach-code","local-c1-coach-secret"),credential_version:1,active:true,created_at:at,updated_at:at}],
    seasons:[{season_id:sid,name:"年度本地SQL",start_date:"2020-09-01",end_date:"2020-09-20",timezone:"America/New_York",season_ends_at:"2020-09-21T04:00:00.000Z",
      status:"OPEN",binding_version:1,season_version:1,roster_version:1,created_by:coach,created_at:at,updated_at:at}],
    members:[{season_id:sid,member_id:mid,source_key:`capture-source-${name}`,source_display_name:"冻结中文😀",display_name_override:"",status:"ACTIVE",
      default_preference:"AMBIENT",member_version:1,created_at:at,updated_at:at}]});
  const login=await call("/internal/c1/coach-login",{request_id:`login_capture_${name}`,coach_code:"local-test-coach-code"});
  await call("/internal/c1/import-schedule",{request_id:`schedule_capture_${name}`,source_snapshot_id:`source_schedule_${name}`,templates:[],
    weeks:[{season_id:sid,week_id:"week_capture_001",week_start_date:"2020-09-14",scheduled_open_at:at,status:"OPENED",week_version:1,confirmed_version:1,
      confirmed_by:coach,confirmed_at:at,published_at:at,created_at:at,updated_at:at}],
    practices:[{season_id:sid,practice_id:pid,week_id:"week_capture_001",template_id:null,generation_key:null,start_at:"2020-09-17T22:00:00.000Z",end_at:"2020-09-18T00:00:00.000Z",
      timezone:"America/New_York",location:"River",address:"Dock",map_url:"",left_capacity:1,right_capacity:1,signup_cutoff_at:"2020-09-17T20:00:00.000Z",practice_version:1,
      cancelled_at:null,cancelled_by:null,schedule_published_at:at,schedule_published_by:coach,created_at:at,updated_at:at}]});
  if(formal)await call("/internal/c1/import-seating",{request_id:`seating_capture_${name}`,source_snapshot_id:`source_seating_${name}`,
    states:[{season_id:sid,practice_id:pid,seat_plan_version:1,published_revision:1,coach_member_id:"",steerer_member_id:"",updated_by:coach,updated_at:at}],
    draft_seats:[{season_id:sid,practice_id:pid,seat_plan_version:1,side:"LEFT",row_number:1,member_id:mid},{season_id:sid,practice_id:pid,seat_plan_version:1,side:"RIGHT",row_number:1,member_id:""}],
    revisions:[{season_id:sid,practice_id:pid,revision_number:1,revision_id:`revision_capture_${name}`,source:"MANUAL",seat_plan_version:1,coach_member_id:"",steerer_member_id:"",
      seats:[{side:"LEFT",row_number:1,member_id:mid}],names:[{member_id:mid,display_name:"原始冻结姓名😀"}],published_by:coach,published_at:at,request_id:`publish_capture_${name}`}]});
  const stub=testEnv.TEAM_STATE.getByName(testEnv.TEAM_ID);
  if(freeze)await runInDurableObject(stub,async(_instance:TeamState,ctx)=>{
    const history=new C1HistoryService(ctx,testEnv),payload={season_id:sid,practice_id:pid,backend_generation:testEnv.BACKEND_GENERATION,writer_epoch:Number(testEnv.WRITER_EPOCH)};
    await history.processScheduledJob("FREEZE_PRACTICE_HISTORY",payload);
    await history.processScheduledJob("COMPLETE_SEASON",payload);
  });
  const command={request_id:`capture_request_${name}`,snapshot_id:`capture_snapshot_${name}`,kind:"SEASON",practice_id:null,season_id:sid,binding_version:1};
  const identity={team_id:testEnv.TEAM_ID,backend_generation:testEnv.BACKEND_GENERATION,writer_epoch:Number(testEnv.WRITER_EPOCH)};
  return {stub,sid,pid,mid,coach,at,testEnv,command,identity,token:login.result.session_token};
}
async function inSql<T>(fixture:Awaited<ReturnType<typeof setup>>,fn:(ctx:DurableObjectState)=>T|Promise<T>){
  return runInDurableObject(fixture.stub,(_instance:TeamState,ctx)=>fn(ctx));
}

function storageCommand(f:Awaited<ReturnType<typeof setup>>,extra:Record<string,unknown>={}) { const {snapshot_id,...command}=f.command;return {...command,...extra}; }
function storageContext(f:Awaited<ReturnType<typeof setup>>):ArchiveStorageContext { return {...f.identity,actor_scope:f.coach}; }
function watched(storage:DurableObjectStorage,after?:(query:string)=>void,forbidLive=false){
  let materialize=0,live=0;
  const sql=new Proxy(storage.sql,{get(target,key){if(key==="exec")return(query:string,...args:SqlStorageValue[])=>{
    if(query.includes("/* annual materialize"))materialize++;
    if(!query.includes("/* annual ownership */")&&(query.includes("/* archive materialize")||/\bFROM (seasons|members|audit_events|practices)\b/iu.test(query))){live++;if(forbidLive)throw Error("Unexpected live read");}
    const result=target.exec(query,...args);after?.(query);return result;
  };const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
  return {wrapped:{sql,transactionSync:<T>(fn:()=>T)=>storage.transactionSync(fn)},materialize:()=>materialize,live:()=>live};
}
class InterleavedArchive extends C2ArchiveStorage {
  private once=false;
  constructor(storage:DurableObjectStorage,context:ArchiveStorageContext,private readonly interleave:()=>void|Promise<void>){super(storage,context);}
  protected override async digest(text:string){if(!this.once){this.once=true;await this.interleave();}return sha256Base64Url(text);}
}
const counts=(ctx:DurableObjectState)=>["annual_archive_plans","annual_archive_chunks","annual_archive_requests"].map(table=>
  ctx.storage.sql.exec<{n:number}>(`SELECT COUNT(*) n FROM ${table}`).one().n);
describe("annual archive stage2 durable local SQLite",()=>{
it("rejects an incompatible preexisting annual table instead of silently accepting or rebuilding it on additive migration",async()=>{
  const f=await setup("incompatible_schema");await inSql(f,ctx=>{
    const sql=ctx.storage.sql;sql.exec("DROP TABLE annual_archive_requests;DROP TABLE annual_archive_chunks;DROP TABLE annual_archive_plans;");
    sql.exec("CREATE TABLE annual_archive_plans(snapshot_id TEXT PRIMARY KEY);UPDATE app_meta SET value='14' WHERE key='schema_version';");
    expect(()=>applySchema(ctx.storage)).toThrow();
    expect(sql.exec<{value:string}>("SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe("14");
    expect(sql.exec<{name:string}>("PRAGMA table_info(annual_archive_plans)").toArray().map(row=>row.name)).toEqual(["snapshot_id"]);
    expect(sql.exec<{n:number}>("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('annual_archive_chunks','annual_archive_requests')").one().n).toBe(0);
  });
});
it("rolls back the entire multi-chunk collection when the last INSERT or UPDATE has already executed",async()=>{
  const f=await setup("many_chunks");await inSql(f,async ctx=>{
    const core=new C1Service(ctx,f.testEnv);
    for(let index=0;index<105;index++){
      const id="many_chunk_audit_"+index,details={season_id:f.sid,member_id:f.mid,member_version:1};
      const identity=await core.createRequestIdentity(f.coach,"updateMember",id,details);
      ctx.storage.transactionSync(()=>core.recordRequest(identity,f.coach,"updateMember",id,{fixture:true},details,new Date().toISOString()));
    }
    const command=storageCommand(f),context=storageContext(f);let inserted=0;
    const captureFault=watched(ctx.storage,query=>{if(query.startsWith("INSERT INTO annual_archive_chunks")&&++inserted===2)throw Error("Second chunk inserted fault");});
    await expect(new C2ArchiveStorage(captureFault.wrapped,context).capture(command)).rejects.toThrow("Second chunk");
    expect(inserted).toBe(2);expect(counts(ctx)).toEqual([0,0,0]);
    const first=await new C2ArchiveStorage(ctx.storage,context).capture(command);expect(first.plan.chunks.length).toBe(2);
    let updated=0;
    const finalizeFault=watched(ctx.storage,query=>{if(query.startsWith("UPDATE annual_archive_chunks")&&++updated===first.plan.chunks.length)throw Error("Last chunk updated fault");});
    await expect(new C2ArchiveStorage(finalizeFault.wrapped,context).finalize(command)).rejects.toThrow("Last chunk");
    expect(updated).toBe(2);expect(ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM annual_archive_chunks WHERE payload_digest IS NOT NULL").one().n).toBe(0);
    expect((await new C2ArchiveStorage(ctx.storage,context).resume(command)).plan).toEqual(first.plan);
  });
});
it("bounds replay by the current request pin even when many real scope aliases are persisted",async()=>{
  const f=await setup("many_aliases");await inSql(f,async ctx=>{
    const command=storageCommand(f),context=storageContext(f),first=await new C2ArchiveStorage(ctx.storage,context).capture(command);
    const observer=watched(ctx.storage,undefined,true),service=new C2ArchiveStorage(observer.wrapped,context);
    for(let index=0;index<75;index++)expect((await service.capture({...command,request_id:"persisted_alias_"+index})).plan).toEqual(first.plan);
    expect(counts(ctx)[2]).toBe(76);
    expect(ctx.storage.sql.exec<{n:number}>("SELECT SUM(LENGTH(CAST(command_text AS BLOB))) n FROM annual_archive_requests").one().n).toBeGreaterThan(8192);
    expect((await service.resume(command)).plan).toEqual(first.plan);expect(observer.live()).toBe(0);
  });
});
it("resumes CAPTURED and replays READY after actual Durable Object eviction, never recapturing live values",async()=>{
  const f=await setup("do_restart"),command=storageCommand(f),context=storageContext(f);
  const first=await inSql(f,ctx=>new C2ArchiveStorage(ctx.storage,context).capture(command));
  await evictDurableObject(f.stub);
  const ready=await inSql(f,async ctx=>{
    ctx.storage.sql.exec("UPDATE members SET source_display_name='After DO eviction' WHERE season_id=?",f.sid);
    const watcher=watched(ctx.storage,undefined,true);const result=await new C2ArchiveStorage(watcher.wrapped,context).resume(command);
    expect(watcher.live()).toBe(0);return result;
  });
  expect(ready.plan).toEqual(first.plan);await evictDurableObject(f.stub);
  expect(await inSql(f,ctx=>new C2ArchiveStorage(ctx.storage,context).resume(command))).toEqual(ready);
});
  it("commits CAPTURED atomically and replays original unknown reply through a new service without any live read",async()=>{
    const f=await setup("stored_unknown");await inSql(f,async ctx=>{
      const command=storageCommand(f),context=storageContext(f),first=await new C2ArchiveStorage(ctx.storage,context).capture(command);
      expect(first.state).toBe("CAPTURED");expect(first.content_digest).toBeNull();
      ctx.storage.sql.exec("UPDATE members SET source_display_name='Later private name' WHERE season_id=?",f.sid);
      const observation=watched(ctx.storage,undefined,true),restarted=new C2ArchiveStorage(observation.wrapped,context);
      const replay=await restarted.capture(command);expect(replay).toEqual(first);expect(observation.live()).toBe(0);
      const ready=await restarted.resume(command);expect(ready.state).toBe("LOCAL_DIGEST_READY");expect(ready.plan).toEqual(first.plan);
      expect(ready.proof).toEqual(first.proof);expect(ready.plan.source_status).toBe("SOURCE_NOT_YET_VERIFIED");expect(observation.live()).toBe(0);
      expect(await new C2ArchiveStorage(observation.wrapped,context).resume(command)).toEqual(ready);
    });
  });
  it("pins same-scope aliases to the first artifact before mutable data, while rejecting command and ownership changes",async()=>{
    const f=await setup("stored_alias");await inSql(f,async ctx=>{
      const command=storageCommand(f),context=storageContext(f),first=await new C2ArchiveStorage(ctx.storage,context).capture(command);
      ctx.storage.sql.exec("UPDATE audit_events SET action='UNKNOWN_AFTER_CAPTURE' WHERE action='importCoreSnapshot'");
      const observation=watched(ctx.storage,undefined,true),aliasCommand=storageCommand(f,{request_id:"annual_alias_request_001"});
      const alias=await new C2ArchiveStorage(observation.wrapped,{...context,actor_scope:"coach_alias_0001"}).capture(aliasCommand);
      expect(alias.plan).toEqual(first.plan);expect(alias.proof.captured_at).toBe(first.proof.captured_at);expect(counts(ctx)[0]).toBe(1);
      await expect(new C2ArchiveStorage(observation.wrapped,context).capture(storageCommand(f,{kind:"PRACTICE",practice_id:f.pid}))).rejects.toThrow();
      for(const changed of [{backend_generation:"different_generation"},{writer_epoch:context.writer_epoch+1},{team_id:"different_team_001"}])
        await expect(new C2ArchiveStorage(observation.wrapped,{...context,...changed}).capture(command)).rejects.toThrow();
      await expect(new C2ArchiveStorage(observation.wrapped,context).capture(storageCommand(f,{binding_version:2}))).rejects.toThrow();
      await expect(new C2ArchiveStorage(observation.wrapped,context).capture(storageCommand(f,{request_id:"annual_alias_changed_002",binding_version:2}))).rejects.toThrow();
      expect(counts(ctx)[2]).toBe(2);expect(observation.live()).toBe(0);
      const ready=await new C2ArchiveStorage(observation.wrapped,context).resume(command);
      const aliasReady=await new C2ArchiveStorage(observation.wrapped,{...context,actor_scope:"coach_alias_0001"}).capture(aliasCommand);
      expect(aliasReady.plan).toEqual(ready.plan);expect(aliasReady.content_digest).toBe(ready.content_digest);
    });
  });
  it("serializes simultaneous same-ID capture and finalize into one artifact and immutable result",async()=>{
    const f=await setup("stored_race");await inSql(f,async ctx=>{
      const command=storageCommand(f),context=storageContext(f);
      const captured=await Promise.all([new C2ArchiveStorage(ctx.storage,context).capture(command),new C2ArchiveStorage(ctx.storage,context).capture(command)]);
      expect(captured[0]).toEqual(captured[1]);expect(counts(ctx)[0]).toBe(1);expect(counts(ctx)[2]).toBe(1);
      const ready=await Promise.all([new C2ArchiveStorage(ctx.storage,context).finalize(command),new C2ArchiveStorage(ctx.storage,context).finalize(command)]);
      expect(ready[0]).toEqual(ready[1]);expect(ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM annual_archive_requests WHERE saved_result_text IS NOT NULL").one().n).toBe(1);
    });
  });
  it("fixes captured private state even when members and history corrections advance during actual SHA awaits",async()=>{
    const f=await setup("stored_live_change");await inSql(f,async ctx=>{
      await new C1HistoryService(ctx,f.testEnv).processScheduledJob("ARCHIVE_SEASON_HISTORY",{season_id:f.sid,backend_generation:f.testEnv.BACKEND_GENERATION,writer_epoch:Number(f.testEnv.WRITER_EPOCH)});
      const command=storageCommand(f),context=storageContext(f),capture=await new C2ArchiveStorage(ctx.storage,context).capture(command);
      const service=new InterleavedArchive(ctx.storage,context,async()=>{
        ctx.storage.sql.exec("UPDATE members SET source_display_name='Changed during digest' WHERE season_id=?",f.sid);
        await new C1HistoryService(ctx,f.testEnv).handle("/internal/c1/append-history-correction",{request_id:"after_capture_correction_001",session_token:f.token,season_id:f.sid,practice_id:f.pid,history_version:1,note:"Later correction"});
      });
      const ready=await service.resume(command);expect(ready.plan).toEqual(capture.plan);expect(ready.proof).toEqual(capture.proof);
      expect(ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM history_corrections").one().n).toBe(1);
    });
  });
  it("rejects every capture phase post-write fault and rolls back plan, all chunks and request pin",async()=>{
    for(const phase of ["annual_archive_plans","annual_archive_chunks","annual_archive_requests"]){
      const f=await setup("capture_fault_"+phase.slice(-8));await inSql(f,async ctx=>{
        const observer=watched(ctx.storage,query=>{if(query.startsWith("INSERT INTO "+phase))throw Error("Injected post-write fault");});
        await expect(new C2ArchiveStorage(observer.wrapped,storageContext(f)).capture(storageCommand(f))).rejects.toThrow("Injected");
        expect(counts(ctx)).toEqual([0,0,0]);
        expect((await new C2ArchiveStorage(ctx.storage,storageContext(f)).capture(storageCommand(f))).state).toBe("CAPTURED");
      });
    }
  });
  it("rolls back every finalize phase and resumes the same capture after a fresh service instance",async()=>{
    for(const phase of ["annual_archive_chunks","annual_archive_plans","annual_archive_requests"]){
      const f=await setup("final_fault_"+phase.slice(-8));await inSql(f,async ctx=>{
        const command=storageCommand(f),context=storageContext(f),capture=await new C2ArchiveStorage(ctx.storage,context).capture(command);
        const observer=watched(ctx.storage,query=>{if(query.startsWith("UPDATE "+phase))throw Error("Injected finalize post-write fault");});
        await expect(new C2ArchiveStorage(observer.wrapped,context).finalize(command)).rejects.toThrow("Injected");
        expect(ctx.storage.sql.exec<{status:string;manifest_text:string|null}>("SELECT status,manifest_text FROM annual_archive_plans").one()).toEqual({status:"CAPTURED",manifest_text:null});
        expect(ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM annual_archive_chunks WHERE payload_digest IS NOT NULL").one().n).toBe(0);
        expect(ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM annual_archive_requests WHERE saved_result_text IS NOT NULL").one().n).toBe(0);
        expect((await new C2ArchiveStorage(ctx.storage,context).resume(command)).plan).toEqual(capture.plan);
      });
    }
  });
  it("CAS rejects changed metadata/proof/identity and deleted, added or changed chunks during digest",async()=>{
    const mutations=[
      "UPDATE annual_archive_plans SET metadata_text=replace(metadata_text,'SOURCE_NOT_YET_VERIFIED','SOURCE_TAMPERED')",
      "UPDATE annual_archive_plans SET capture_proof_text=replace(capture_proof_text,'annual-capture-proof-v1','different-proof')",
      "UPDATE annual_archive_plans SET writer_epoch=writer_epoch+1",
      "DELETE FROM annual_archive_chunks WHERE chunk_index=0",
      "INSERT INTO annual_archive_chunks(snapshot_id,chunk_index,row_offset,row_count,payload_text,utf8_bytes) SELECT snapshot_id,999,0,1,'{}',2 FROM annual_archive_plans",
      "UPDATE annual_archive_chunks SET payload_text=payload_text||' '",
      "UPDATE annual_archive_requests SET created_at='2020-01-01T00:00:00.000Z'"
    ];
    for(const [index,mutation] of mutations.entries()){
      const f=await setup("cas_drift_"+index);await inSql(f,async ctx=>{
        const command=storageCommand(f),context=storageContext(f);await new C2ArchiveStorage(ctx.storage,context).capture(command);
        await expect(new InterleavedArchive(ctx.storage,context,()=>{ctx.storage.sql.exec(mutation);}).finalize(command)).rejects.toThrow();
        expect(ctx.storage.sql.exec<{status:string}>("SELECT status FROM annual_archive_plans").one().status).toBe("CAPTURED");
        expect(ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM annual_archive_chunks WHERE payload_digest IS NOT NULL").one().n).toBe(0);
      });
    }
  });
  it("already READY rejects completed time and coherent saved result drift during digest, without overwriting it",async()=>{
    const f=await setup("ready_time_drift");await inSql(f,async ctx=>{
      const command=storageCommand(f),context=storageContext(f);await new C2ArchiveStorage(ctx.storage,context).capture(command);await new C2ArchiveStorage(ctx.storage,context).resume(command);
      const changed="2026-01-01T00:00:00.000Z";
      let signal!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{signal=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      class GatedArchive extends C2ArchiveStorage { private first=true;protected override async digest(text:string){const result=await sha256Base64Url(text);
        if(this.first){this.first=false;signal();await gate;}return result;} }
      const pending=new GatedArchive(ctx.storage,context).resume(command);await started;
        ctx.storage.sql.exec("UPDATE annual_archive_plans SET completed_at=?",changed);
        const row=ctx.storage.sql.exec<{saved_result_text:string}>("SELECT saved_result_text FROM annual_archive_requests").one();
        ctx.storage.sql.exec("UPDATE annual_archive_requests SET saved_result_text=?",archiveCanonical({...JSON.parse(row.saved_result_text),completed_at:changed}));
      release();await expect(pending).rejects.toThrow();
      expect(ctx.storage.sql.exec<{completed_at:string}>("SELECT completed_at FROM annual_archive_plans").one().completed_at).toBe(changed);
    });
  });
  it("proves saved text/count bounds before large corrupted plan/chunks/pin materialization and ignores unrelated alias volume",async()=>{
    for(const [index,mutation] of [
      ()=>["UPDATE annual_archive_plans SET canonical_plan_text=?","x".repeat(2_000_001)],
      ()=>["UPDATE annual_archive_chunks SET payload_text=?","x".repeat(64_001)],
      ()=>["UPDATE annual_archive_requests SET command_text=?","x".repeat(8193)],
      ()=>["UPDATE annual_archive_plans SET record_count=?","x".repeat(2_000_001)],
      ()=>["UPDATE annual_archive_chunks SET row_count=?","x".repeat(2_000_001)]
    ].entries()){
      const f=await setup("saved_limit_"+index);await inSql(f,async ctx=>{
        const command=storageCommand(f),context=storageContext(f);await new C2ArchiveStorage(ctx.storage,context).capture(command);
        const [query,value]=mutation();ctx.storage.sql.exec(query,value);const observer=watched(ctx.storage);
        await expect(new C2ArchiveStorage(observer.wrapped,context).resume(command)).rejects.toThrow();
        // A small pin may be loaded; no large plan or chunk text is ever materialized.
        expect(observer.materialize()).toBe(index===2?0:1);
      });
    }
    expect(()=>proveStoredArchiveBudget({plans:1,plan_bytes:1,pin_bytes:1,chunks:5001,payload_bytes:1,chunk_bytes:1})).toThrow();
  });
it("rejects current season/sync binding changes on original and alias replay and at SHA commit",async()=>{
  const f=await setup("binding_drift");await inSql(f,async ctx=>{
    const command=storageCommand(f),context=storageContext(f);await new C2ArchiveStorage(ctx.storage,context).capture(command);
    ctx.storage.sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id=?",f.sid);
    for(const request_id of [command.request_id,"binding_alias_request_001"])
      await expect(new C2ArchiveStorage(ctx.storage,context).capture({...command,request_id})).rejects.toThrow();
    await expect(new C2ArchiveStorage(ctx.storage,context).resume(command)).rejects.toThrow();
    ctx.storage.sql.exec("UPDATE seasons SET binding_version=1 WHERE season_id=?",f.sid);
    await expect(new InterleavedArchive(ctx.storage,context,()=>{ctx.storage.sql.exec("UPDATE seasons SET binding_version=2 WHERE season_id=?",f.sid);}).resume(command)).rejects.toThrow();
    expect(ctx.storage.sql.exec<{status:string}>("SELECT status FROM annual_archive_plans").one().status).toBe("CAPTURED");
    ctx.storage.sql.exec("UPDATE seasons SET binding_version=1 WHERE season_id=?",f.sid);
    ctx.storage.sql.exec(`INSERT INTO sync_bindings(season_id,binding_version,form_id,runtime_spreadsheet_id,response_sheet_id,response_sheet_name,
      field_mapping_json,schema_fingerprint,created_at,updated_at) VALUES (?,2,'local_form','local_runtime','local_response','Responses','{}','local_schema',?,?)`,f.sid,f.at,f.at);
    await expect(new C2ArchiveStorage(ctx.storage,context).resume(command)).rejects.toThrow();
  });
});
it("checks fresh server identity getter across SHA await without treating schema_version as writer authority",async()=>{
  const f=await setup("epoch_drift");await inSql(f,async ctx=>{
    const command=storageCommand(f),initial=storageContext(f);let current=initial;
    await new C2ArchiveStorage(ctx.storage,()=>current).capture(command);
    class ChangingAuthority extends C2ArchiveStorage {
      private changed=false;
      protected override async digest(text:string){if(!this.changed){this.changed=true;current={...initial,writer_epoch:initial.writer_epoch+1};}return sha256Base64Url(text);}
    }
    await expect(new ChangingAuthority(ctx.storage,()=>current).resume(command)).rejects.toThrow();
    expect(ctx.storage.sql.exec<{status:string}>("SELECT status FROM annual_archive_plans").one().status).toBe("CAPTURED");
    current=initial;expect((await new C2ArchiveStorage(ctx.storage,()=>current).resume(command)).state).toBe("LOCAL_DIGEST_READY");
    await expect(new C2ArchiveStorage(ctx.storage,{...initial,backend_generation:"replacement_generation"}).resume(command)).rejects.toThrow();
  });
});
it("upgrades nonempty v14 and all 47 protected tables with pending/SENT/FAILED/lane metadata unchanged, atomically",async()=>{
  const f=await setup("schema_upgrade");
  await inSql(f,async ctx=>{
    const sql=ctx.storage.sql;
    sql.exec(`INSERT INTO sync_bindings(season_id,binding_version,form_id,runtime_spreadsheet_id,response_sheet_id,response_sheet_name,
      field_mapping_json,schema_fingerprint,created_at,updated_at) VALUES (?,1,'migration_form','migration_runtime','migration_response','Responses','{}','migration_schema',?,?)`,f.sid,f.at,f.at);
    const request=sql.exec<{request_key:string}>("SELECT request_key FROM system_requests ORDER BY rowid LIMIT 1").one().request_key;
    const payload=archiveCanonical({action:"cancelSignup",entity:{season_id:f.sid,practice_id:f.pid,snapshot_schema:2,practice_version:1,signup_version:1,signup_rows:[]}});
    for(const [index,status] of ["PREPARED","SENT","FAILED"].entries()){
      const outbox="annual_old_outbox_"+index,batch="annual_old_batch_"+index;
      sql.exec("INSERT INTO sync_outbox(outbox_id,request_key,topic,payload_json,status,due_at_ms,created_at) VALUES (?,?,'SIGNUP_CHANGED',?,'PENDING',0,?)",outbox,request,payload,f.at);
      indexExportEvent(sql,outbox);
      sql.exec(`INSERT INTO sync_batches(batch_id,season_id,binding_version,writer_epoch,direction,status,payload_digest,first_outbox_id,last_outbox_id,created_at,updated_at)
        VALUES (?,?,1,?,'CLOUDFLARE_TO_GOOGLE',?,'old_batch_digest',?,?,?,?)`,batch,f.sid,f.identity.writer_epoch,status,outbox,outbox,f.at,f.at);
    }
    sql.exec(`INSERT INTO sync_export_event_blocks(season_id,binding_version,outbox_id,practice_id,payload_anchor,payload_digest,error_code,
      failure_count,next_attempt_at_ms,action_required,blocked_scope,blocked_entity_id,created_at,updated_at)
      VALUES (?,1,'annual_old_outbox_0',?,?,'old_anchor_digest','SYNC_REFERENCE_NEEDS_REVIEW',1,0,1,'PRACTICE',?,?,?)`,f.sid,f.pid,payload,f.pid,f.at,f.at);
    sql.exec(`INSERT INTO sync_export_request_selections(request_key,season_id,binding_version,outbox_id,event_anchor,event_digest,request_digest,created_at)
      VALUES ('old_selection_request',?,1,'annual_old_outbox_0',?,'event_digest','request_digest',?)`,f.sid,payload,f.at);
    sql.exec("INSERT INTO sync_export_poll_plans(request_key,request_digest,plan_json,plan_digest,created_at) VALUES ('old_poll','old_request_digest','[]','old_plan_digest',?)",f.at);
    const backup=await new C1HistoryService(ctx,f.testEnv).handle("/internal/c1/create-backup-snapshot",{request_id:"migration_table_list_001",session_token:f.token}) as any;
    const oldTables=backup.result.manifest.tables.map((row:any)=>row.name).filter((name:string)=>!name.startsWith("annual_archive_")) as string[];
    expect(oldTables).toHaveLength(47);
    sql.exec("DROP TABLE annual_archive_requests; DROP TABLE annual_archive_chunks; DROP TABLE annual_archive_plans;");
    sql.exec("UPDATE app_meta SET value='14' WHERE key='schema_version'");
    const original=Object.fromEntries(oldTables.map(table=>[table,sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray()]));
    const faulty=watched(ctx.storage,query=>{if(query.includes("CREATE TABLE IF NOT EXISTS annual_archive_plans"))throw Error("Migration post-DDL fault");});
    expect(()=>applySchema(faulty.wrapped as DurableObjectStorage)).toThrow("Migration post-DDL fault");
    expect(sql.exec<{value:string}>("SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe("14");
    expect(sql.exec<{n:number}>("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'annual_archive_%'").one().n).toBe(0);
    applySchema(ctx.storage);
    expect(APPLICATION_SCHEMA_VERSION).toBe(15);expect(counts(ctx)).toEqual([0,0,0]);
    for(const table of oldTables){
      const rows=sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray();
      if(table==="app_meta")expect(rows.map(row=>row.key==="schema_version"?{...row,value:"14"}:row)).toEqual(original[table]);
      else expect(rows,table).toEqual(original[table]);
    }
    expect(sql.exec<{value:string}>("SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe("15");
    sql.exec("UPDATE app_meta SET value='16' WHERE key='schema_version'");
    expect(()=>applySchema(ctx.storage)).toThrow("Unsupported");sql.exec("UPDATE app_meta SET value='15' WHERE key='schema_version'");
  });
});
it("protects both nonempty CAPTURED and READY plans/pins/chunks in 50-table backup with independent manifest recomputation",async()=>{
  const f=await setup("stored_backup");await inSql(f,async ctx=>{
    const context=storageContext(f),captured=await new C2ArchiveStorage(ctx.storage,context).capture(storageCommand(f));
    const practice=storageCommand(f,{request_id:"backup_practice_capture_001",kind:"PRACTICE",practice_id:f.pid});
    await new C2ArchiveStorage(ctx.storage,context).capture(practice);const ready=await new C2ArchiveStorage(ctx.storage,context).resume(practice);
    const expected=Object.fromEntries(["annual_archive_plans","annual_archive_chunks","annual_archive_requests"].map(table=>[table,ctx.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray()]));
    expect((expected.annual_archive_plans as any[]).map(row=>row.status)).toEqual(["CAPTURED","LOCAL_DIGEST_READY"]);
    const history=new C1HistoryService(ctx,f.testEnv);
    const created=await history.handle("/internal/c1/create-backup-snapshot",{request_id:"annual_backup_snapshot_001",session_token:f.token}) as any;
    const manifest=created.result.manifest;expect(manifest.schema_version).toBe(15);expect(manifest.tables).toHaveLength(50);
    const descriptors=[];
    for(const entry of manifest.tables){
      const rows:any[]=[];
      for(const chunk_index of entry.chunk_indices){
        const response=await history.handle("/internal/c1/get-backup-chunk",{request_id:"annual_backup_chunk_"+chunk_index,session_token:f.token,snapshot_id:created.result.snapshot_id,chunk_index}) as any;
        const chunk=response.chunk,digest="sha256_v1:"+await sha256Base64Url(canonicalJson(chunk.payload));expect(digest).toBe(chunk.payload_digest);
        descriptors.push({chunk_index:chunk.chunk_index,table_name:chunk.table_name,row_offset:chunk.row_offset,row_count:chunk.row_count,payload_digest:digest});rows.push(...chunk.payload.rows);
      }
      if(entry.name.startsWith("annual_archive_")){expect(rows.length).toBeGreaterThan(0);expect(rows).toEqual(expected[entry.name]);}
    }
    expect(descriptors).toEqual(manifest.chunks);
    const {content_digest,...core}=manifest;expect("sha256_v1:"+await sha256Base64Url(canonicalJson(core))).toBe(content_digest);
    expect(await history.handle("/internal/c1/verify-backup-snapshot",{request_id:"annual_backup_verify_001",session_token:f.token,snapshot_id:created.result.snapshot_id,content_digest})).toMatchObject({verified:true});
    expect(await new C2ArchiveStorage(ctx.storage,context).capture(storageCommand(f))).toEqual(captured);
    expect(await new C2ArchiveStorage(ctx.storage,context).resume(practice)).toEqual(ready);
  });
});
});
