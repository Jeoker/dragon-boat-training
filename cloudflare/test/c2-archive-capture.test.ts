import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import worker from "../src/index";
import {TeamState} from "../src/team-state";
import {C1HistoryService} from "../src/c1-history-service";
import {C1Service} from "../src/c1-service";
import {C1SignupService} from "../src/c1-signup-service";
import {C1SeatingService} from "../src/c1-seating-service";
import {legacyCredentialDigest} from "../src/crypto";
import {previewArchiveCapture} from "../src/c2-archive-capture";
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
function observe(storage:DurableObjectStorage){let materialized=0;const sql=new Proxy(storage.sql,{get(target,key){if(key==="exec")return(query:string,...args:SqlStorageValue[])=>{
    if(query.includes("/* archive materialize"))materialized++;return target.exec(query,...args);};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
  return {wrapped:{sql,transactionSync:<T>(fn:()=>T)=>storage.transactionSync(fn)},count:()=>materialized};}
async function addAudit(ctx:DurableObjectState,f:Awaited<ReturnType<typeof setup>>,request:string,action:string,details:Record<string,unknown>){
  const core=new C1Service(ctx,f.testEnv),identity=await core.createRequestIdentity(f.coach,action,request,details);
  ctx.storage.transactionSync(()=>core.recordRequest(identity,f.coach,action,request,{fixture:true},details,new Date().toISOString()));
}
async function localClock<T>(at:string,fn:()=>Promise<T>):Promise<T>{
  const OriginalDate=Date,millis=OriginalDate.parse(at);
  globalThis.Date=class extends OriginalDate {constructor(value?:string|number){super(value===undefined?millis:value);}static now(){return millis;}} as DateConstructor;
  try{return await fn();}finally{globalThis.Date=OriginalDate;}
}
describe("annual capture delivery1 real SQLite read-only adapter",()=>{
  it("adapts actual C1 initial versions with explicit virtual metadata and consumes the real frozen history",async()=>{
    const f=await setup("initial");await inSql(f,ctx=>{
      const before=ctx.storage.sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM audit_events").one().count;
      const result=previewArchiveCapture(ctx.storage,f.command,f.identity);
      expect(result.input.seating_states[0].updated_by).toBe("IMPLICIT_INITIAL_STATE");
      expect(result.proof.implicit_states).toEqual([{practice_id:f.pid,provenance:"IMPLICIT_INITIAL_STATE",source_table:"practices",source_created_at:f.at,
        seat_state_present:false,seat_plan_version:0,published_revision:0,child_count:0}]);
      expect(result.input.frozen_practices[0].final_status).toBe("UNPUBLISHED");expect(result.plan.state).toBe("LOCAL_PLAN_ONLY");
      expect(result.proof.source_counts.signup_states).toBe(1);expect(result.proof.source_counts.seating_states).toBe(1);
      expect(result.proof.actual_input_bytes).toBeLessThanOrEqual(result.proof.input_upper_bytes);
      expect(ctx.storage.sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM audit_events").one().count).toBe(before);
    });
  });
  it("adapts actual C1 formal revision, full empty SQL slots and immutable frozen names",async()=>{
    const f=await setup("formal",true);await inSql(f,ctx=>{
      ctx.storage.sql.exec("UPDATE members SET source_display_name='Later name' WHERE season_id=?",f.sid);
      const result=previewArchiveCapture(ctx.storage,f.command,f.identity);
      expect(result.proof.implicit_states).toEqual([]);expect(result.input.draft_seats[1].member_id).toBe("");
      expect(result.input.revisions[0].names[0].display_name).toBe("原始冻结姓名😀");
      expect(result.input.frozen_practices[0].snapshot.seat_plan.seats[0].display_name).toBe("原始冻结姓名😀");
    });
  });
  it("does not read big payloads when count or conservative UTF8 proof exceeds its budget",async()=>{
    for(const mode of ["count","bytes"]){const f=await setup(`budget_${mode}`);await inSql(f,ctx=>{
      if(mode==="bytes")ctx.storage.sql.exec("UPDATE members SET source_display_name=? WHERE season_id=?","😀\"\\\n".repeat(60000),f.sid);
      else ctx.storage.sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001)
        INSERT INTO members SELECT season_id,'member_budget_'||x,'source_budget_'||x,source_display_name,display_name_override,status,
        default_preference,member_version,created_at,updated_at FROM members,n WHERE member_id=?`,f.mid);
      const spy=observe(ctx.storage);expect(()=>previewArchiveCapture(spy.wrapped,f.command,f.identity)).toThrow();expect(spy.count()).toBe(0);
    });}
  });
  it("dirty initial child or missing version is refused before payload materialization",async()=>{
    for(const mode of ["dirty","missing"]){const f=await setup(`state_${mode}`);await inSql(f,ctx=>{
      if(mode==="dirty")ctx.storage.sql.exec("INSERT INTO seat_plan_draft_seats VALUES (?,?, 'LEFT',1,NULL,1,?,?)",f.sid,f.pid,f.coach,f.at);
      else ctx.storage.sql.exec("DELETE FROM practice_versions WHERE season_id=?",f.sid);
      const spy=observe(ctx.storage);expect(()=>previewArchiveCapture(spy.wrapped,f.command,f.identity)).toThrow();expect(spy.count()).toBe(0);
    });}
  });
  it("whole-season children without a training cannot be silently classified as cancelled exclusions",async()=>{
    const f=await setup("orphan_child");await inSql(f,ctx=>ctx.storage.transactionSync(()=>{
      ctx.storage.sql.exec("PRAGMA defer_foreign_keys=ON");
      ctx.storage.sql.exec("INSERT INTO practice_versions(season_id,practice_id) VALUES (?,?)",f.sid,"practice_missing_parent");
      const spy=observe(ctx.storage);expect(()=>previewArchiveCapture(spy.wrapped,f.command,f.identity)).toThrow();expect(spy.count()).toBe(0);
      ctx.storage.sql.exec("DELETE FROM practice_versions WHERE practice_id='practice_missing_parent'");
    }));
  });
  it("malformed audit, unknown action, ownership mismatch or missing practice ownership cannot be hidden",async()=>{
    for(const mode of ["json","unknown","season","practice"]){const f=await setup(`audit_${mode}`);await inSql(f,ctx=>{
      const event=ctx.storage.sql.exec<{event_id:string}>("SELECT event_id FROM audit_events WHERE action='freezePracticeHistory'").one().event_id;
      if(mode==="json")ctx.storage.sql.exec("UPDATE audit_events SET details_json='{' WHERE event_id=?",event);
      if(mode==="unknown")ctx.storage.sql.exec("UPDATE audit_events SET action='unknownBusiness' WHERE event_id=?",event);
      if(mode==="season")ctx.storage.sql.exec("UPDATE audit_events SET season_id=NULL WHERE event_id=?",event);
      if(mode==="practice")ctx.storage.sql.exec("UPDATE audit_events SET details_json=? WHERE event_id=?",JSON.stringify({season_id:f.sid,final_status:"UNPUBLISHED"}),event);
      const spy=observe(ctx.storage);expect(()=>previewArchiveCapture(spy.wrapped,f.command,f.identity)).toThrow();expect(spy.count()).toBe(0);
    });}
  });
  it("loads every applicable audit beyond ordinary management page limits without exporting operational records",async()=>{
    const f=await setup("audit_pages");await inSql(f,async ctx=>{
      for(let index=0;index<105;index++)await addAudit(ctx,f,`archive_audit_${index}`,"updateMember",{season_id:f.sid,member_id:f.mid,member_version:1});
      const result=previewArchiveCapture(ctx.storage,f.command,f.identity);
      expect(result.input.audits.filter(row=>row.action==="updateMember")).toHaveLength(105);
      expect(result.proof.excluded_operational_audits).toBeGreaterThan(0);expect(result.plan.canonical_text).not.toContain("code_digest");
      expect(result.input.audits.every(row=>!["coachLogin","importCoreSnapshot"].includes(row.action))).toBe(true);
    });
  });
  it("missing frozen history, not-due server time and corrupt snapshot fail without modifying SQL",async()=>{
    for(const mode of ["missing","due","json"]){const f=await setup(`frozen_${mode}`);await inSql(f,ctx=>{
      if(mode==="missing")ctx.storage.sql.exec("DELETE FROM practice_history WHERE season_id=?",f.sid);
      if(mode==="json")ctx.storage.sql.exec("UPDATE practice_history SET snapshot_json='{' WHERE season_id=?",f.sid);
      const before=ctx.storage.sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM audit_events").one().count;
      expect(()=>previewArchiveCapture(ctx.storage,f.command,f.identity,()=>mode==="due"?Date.parse(f.at):Date.now())).toThrow();
      expect(ctx.storage.sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM audit_events").one().count).toBe(before);
    });}
  });
  it("separate previews capture later private values and make no promise of durable original-request replay",async()=>{
    const f=await setup("preview_only");await inSql(f,ctx=>{
      const first=previewArchiveCapture(ctx.storage,f.command,f.identity);
      ctx.storage.sql.exec("UPDATE members SET display_name_override='变更😀' WHERE season_id=?",f.sid);
      const second=previewArchiveCapture(ctx.storage,f.command,f.identity);
      expect(first.plan.canonical_text).not.toBe(second.plan.canonical_text);
      expect(archiveCanonical(first.input)).not.toBe(archiveCanonical(second.input));
      expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'annual_archive_%'").toArray()).toEqual([]);
    });
  });
  it("captures native C1 signup/cancel audit seating, final corrections and subsequent history notes at one local time",async()=>{
    const f=await setup("native_events",false,false);await inSql(f,async ctx=>{
      const signup=new C1SignupService(ctx,f.testEnv),seating=new C1SeatingService(ctx,f.testEnv),history=new C1HistoryService(ctx,f.testEnv);
      const scope={session_token:f.token,season_id:f.sid,practice_id:f.pid,member_id:f.mid,practice_version:1};
      await localClock("2020-09-17T18:00:00.000Z",async()=>{
        await signup.handle("/internal/c1/signup-by-coach",{...scope,request_id:"native_signup_001",signup_version:0,preference:"LEFT"});
        await seating.handle("/internal/c1/save-seat-plan-draft",{...scope,request_id:"native_initial_draft",signup_version:1,seat_plan_version:0,change_kind:"EDIT",
          coach_member_id:"",steerer_member_id:"",seats:[{side:"LEFT",row_number:1,member_id:f.mid},{side:"RIGHT",row_number:1,member_id:""}]});
        await seating.handle("/internal/c1/publish-seat-plan",{...scope,request_id:"native_publish_001",signup_version:1,seat_plan_version:1,published_revision:0,acknowledge_preference_mismatch:false});
        await signup.handle("/internal/c1/cancel-signup-by-coach",{...scope,request_id:"native_cancel_001",signup_version:1});
      });
      await localClock("2020-09-18T01:00:00.000Z",async()=>{
        await seating.handle("/internal/c1/save-seat-plan-draft",{...scope,request_id:"native_draft_001",signup_version:2,seat_plan_version:2,published_revision:2,change_kind:"EDIT",
          coach_member_id:"",steerer_member_id:"",seats:[{side:"LEFT",row_number:1,member_id:f.mid},{side:"RIGHT",row_number:1,member_id:""}]});
        await seating.handle("/internal/c1/publish-seat-plan",{...scope,request_id:"native_publish_002",signup_version:2,seat_plan_version:3,published_revision:2,acknowledge_preference_mismatch:false});
      });
      await localClock("2020-09-22T00:00:00.000Z",async()=>{
        const payload={season_id:f.sid,practice_id:f.pid,backend_generation:f.testEnv.BACKEND_GENERATION,writer_epoch:Number(f.testEnv.WRITER_EPOCH)};
        for(const type of ["FREEZE_PRACTICE_HISTORY","COMPLETE_SEASON","ARCHIVE_SEASON_HISTORY"])await history.processScheduledJob(type,payload);
      });
      await localClock("2020-09-23T00:00:00.000Z",()=>history.handle("/internal/c1/append-history-correction",{
        ...scope,request_id:"native_note_001",history_version:1,note:"冻结后只追加说明"}));
      const result=previewArchiveCapture(ctx.storage,f.command,f.identity,()=>Date.parse("2020-09-24T00:00:00.000Z"));
      expect(result.input.signups[0].status).toBe("CANCELLED");expect(result.input.frozen_practices[0].frozen_revision).toBe(3);
      expect(result.input.corrections[0].note).toBe("冻结后只追加说明");
      const audit=result.input.audits.find(row=>row.action==="cancelSignupByCoach")!;
      expect(audit.details.seating).not.toBeNull();expect(result.proof.actual_input_bytes).toBeLessThanOrEqual(result.proof.input_upper_bytes);
      expect(result.input.revisions).toHaveLength(3);expect(result.proof.implicit_states).toEqual([]);
    });
  });
  it("practice scope excludes another published future graph and whole season excludes cancelled training with proof counts",async()=>{
    const f=await setup("scope");await inSql(f,async ctx=>{
      ctx.storage.sql.exec(`INSERT INTO practices SELECT season_id,'practice_capture_cancelled',week_id,NULL,NULL,start_at,end_at,timezone,location,address,map_url,
        left_capacity,right_capacity,signup_cutoff_at,practice_version,?, ?,schedule_published_at,schedule_published_by,created_at,updated_at FROM practices WHERE practice_id=?`,f.at,f.coach,f.pid);
      await addAudit(ctx,f,"cancelled_capture_audit","freezePracticeHistory",{season_id:f.sid,practice_id:"practice_capture_cancelled",final_status:"UNPUBLISHED"});
      const season=previewArchiveCapture(ctx.storage,f.command,f.identity);
      expect(season.input.practices).toHaveLength(1);expect(season.proof.excluded_cancelled_practices).toBe(1);expect(season.proof.excluded_cancelled_audits).toBe(1);
      expect(season.plan.canonical_text).not.toContain("practice_capture_cancelled");
      ctx.storage.sql.exec(`INSERT INTO practices SELECT season_id,'practice_capture_future',week_id,NULL,NULL,'2020-09-20T20:00:00.000Z','2020-09-20T22:00:00.000Z',timezone,location,address,map_url,
        left_capacity,right_capacity,'2020-09-20T18:00:00.000Z',practice_version,NULL,NULL,schedule_published_at,schedule_published_by,created_at,updated_at FROM practices WHERE practice_id=?`,f.pid);
      const practice=previewArchiveCapture(ctx.storage,{...f.command,kind:"PRACTICE",practice_id:f.pid},f.identity);
      expect(practice.input.practices).toHaveLength(1);expect(practice.input.audits.every(row=>row.details.practice_id===f.pid)).toBe(true);
      expect(()=>previewArchiveCapture(ctx.storage,f.command,f.identity)).toThrow();
    });
  });
});
