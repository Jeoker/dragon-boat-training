import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Load the real TypeScript modules without emitting files or touching Worker/runtime configuration.
const modules = new Map();
function moduleUrl(url) {
  const key = url.href; if (modules.has(key)) return modules.get(key);
  let source = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  // Expose existing private pure helpers in this test-only module; repository source stays unchanged.
  if(url.pathname.endsWith("/c1-seating-service.ts"))source+="\nexport { seatingExportSnapshot as auditSnapshotOracle };";
  if(url.pathname.endsWith("/c1-schedule-service.ts"))source+="\nexport { practiceProjection as auditPracticeOracle };";
  source = source.replace(/(from\s+["'])(\.[^"']+)(["'])/gu, (_, before, path, after) =>
    before + moduleUrl(new URL(path.endsWith(".ts") ? path : `${path}.ts`, url)) + after);
  const result = `data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=${url.href}`).toString("base64")}`;
  modules.set(key,result); return result;
}
const contract = await import(moduleUrl(new URL("../shared/c2-archive-contract.ts",import.meta.url)));
const { ContractValidationError } = await import(moduleUrl(new URL("../shared/c1-contract.ts",import.meta.url)));
const { createArchivePlan } = await import(moduleUrl(new URL("../shared/c2-archive-projection.ts",import.meta.url)));
const { C1HistoryService } = await import(moduleUrl(new URL("../cloudflare/src/c1-history-service.ts",import.meta.url)));
const { auditSnapshotOracle, C1SeatingService, seatingMode } = await import(moduleUrl(new URL("../cloudflare/src/c1-seating-service.ts",import.meta.url)));
const { auditPracticeOracle } = await import(moduleUrl(new URL("../cloudflare/src/c1-schedule-service.ts",import.meta.url)));
const clone = value => structuredClone(value);
const before = "2025-12-01T12:00:00.000Z", start = "2026-01-01T01:00:00.000Z", end = "2026-01-01T02:00:00.000Z";
const published = "2026-01-01T03:00:00.000Z", frozen = "2026-01-02T02:00:00.000Z", captured = "2026-01-03T12:00:00.000Z";
const sid="season_archive_01", pid="practice_archive_01", memberId="member_archive_01";
function fixture() {
  const practice = { season_id:sid,practice_id:pid,week_id:"week_archive_01",template_id:null,generation_key:null,
    start_at:start,end_at:end,timezone:"UTC",location:"River",address:"Boat launch",map_url:"",left_capacity:2,right_capacity:2,
    signup_cutoff_at:start,practice_version:1,cancelled_at:null,cancelled_by:null,schedule_published_at:before,
    schedule_published_by:"coach_archive_01",created_at:before,updated_at:before };
  const revision={season_id:sid,practice_id:pid,revision_number:1,revision_id:"revision_archive_01",source:"COACH_PUBLISH",
    seat_plan_version:1,coach_member_id:"",steerer_member_id:"",seats:[{side:"LEFT",row_number:1,member_id:memberId}],
    names:[{member_id:memberId,display_name:"冻结姓名 😀"}],published_by:"coach_archive_01",published_at:published,request_id:"publish_archive_01"};
  const snapshot={practice:{practice_id:pid,start_at:start,end_at:end,timezone:"UTC",location:"River",address:"Boat launch",map_url:""},
    final_status:"FROZEN",seat_plan:{status:"FROZEN",published_revision:1,published_at:published,source:"COACH_PUBLISH",
      coach:null,steerer:null,seats:[{side:"LEFT",row_number:1,display_name:"冻结姓名 😀"}]}};
  return { format:contract.ARCHIVE_FORMAT,request_id:"annual_request_01",snapshot_id:"annual_snapshot_01",kind:"PRACTICE",practice_id:pid,
    team_id:"team_archive_01",backend_generation:"cf_archive_local",writer_epoch:0,binding_version:1,
    season_timezone:"America/New_York",captured_at:captured,cutoff_at:frozen,
    season:{season_id:sid,name:"跨年季",start_date:"2025-12-01",end_date:"2026-01-02",timezone:"America/New_York",
      season_ends_at:"2026-01-03T05:00:00.000Z",status:"OPEN",binding_version:1,season_version:1,roster_version:1,
      created_by:"coach_archive_01",created_at:before,updated_at:before},
    members:[{season_id:sid,member_id:memberId,source_key:"form_response_original",source_display_name:"当前姓名",
      display_name_override:"",status:"ACTIVE",default_preference:"LEFT",member_version:1,created_at:before,updated_at:before}],
    templates:[],weeks:[{season_id:sid,week_id:"week_archive_01",week_start_date:"2025-12-29",scheduled_open_at:null,status:"OPENED",
      week_version:1,confirmed_version:1,confirmed_by:"coach_archive_01",confirmed_at:before,published_at:before,created_at:before,updated_at:before}],
    practices:[practice],signup_states:[{season_id:sid,practice_id:pid,signup_version:1,signup_sequence:1}],
    signups:[{season_id:sid,practice_id:pid,member_id:memberId,preference:"LEFT",status:"CANCELLED",queue_at:before,
      queue_sequence:1,updated_at:before,last_request_id:"cancel_signup_001"}],
    seating_states:[{season_id:sid,practice_id:pid,seat_plan_version:1,published_revision:1,coach_member_id:"",steerer_member_id:"",
      updated_by:"coach_archive_01",updated_at:published}],draft_seats:[{season_id:sid,practice_id:pid,seat_plan_version:1,side:"LEFT",row_number:1,member_id:memberId},
      ...["RIGHT:1","LEFT:2","RIGHT:2"].map(key=>{const [side,row]=key.split(":");return {season_id:sid,practice_id:pid,seat_plan_version:1,side,row_number:Number(row),member_id:""};})],
    revisions:[revision],frozen_practices:[{season_id:sid,practice_id:pid,history_version:1,final_status:"FROZEN",frozen_revision:1,frozen_at:frozen,snapshot}],
    audits:[{season_id:sid,event_id:"event_cancel_signup_01",request_key:"request_original",actor_scope:"C1:MEMBER",action:"cancelSignup",created_at:before,
      details:{season_id:sid,practice_id:pid,member_id:memberId,status:"CANCELLED",promoted_member_ids:[],seating:null}}],corrections:[] };
}
function records(plan) { return plan.chunks.flatMap(chunk=>JSON.parse(chunk.payload_text).records); }
function rejected(mutate) { const input=fixture();mutate(input);assert.throws(()=>createArchivePlan(input)); }

// Independent pre-change canonical recipe for ordinary JSON; no new serializer
// or builder is used to calculate these expected bytes.
function ordinaryCanonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(ordinaryCanonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${ordinaryCanonical(value[key])}`).join(",")}}`;
}

test("archive meters a fixed descriptor copy without invoking getters or hidden toJSON",()=>{
  const input=fixture(), original=createArchivePlan(input).canonical_text;
  assert.equal(createArchivePlan(Object.assign(Object.create(null),input)).canonical_text,original);
  input.private_extension={fraction:1.5};assert.equal(createArchivePlan(input).canonical_text,original);
  let calls=0;
  const accessor=fixture();Object.defineProperty(accessor,"request_id",{enumerable:true,get(){calls++;throw new Error("PRIVATE_TEST_BODY");}});
  assert.throws(()=>createArchivePlan(accessor),error=>error.message==="Archive input is incomplete or inconsistent."&&error.field==="json_descriptor");
  assert.equal(calls,0);
  const hidden=fixture();hidden.ignored="x".repeat(contract.ARCHIVE_LIMITS.input_bytes+1);
  hidden.toJSON=()=>{calls++;return {};};assert.throws(()=>createArchivePlan(hidden));assert.equal(calls,0);
  delete hidden.toJSON;assert.throws(()=>createArchivePlan(hidden),error=>error.field==="input_bytes");
});

test("public archive canonical rejects sparse, extended, accessor, cyclic and overdeep objects",()=>{
  const sparse=[,1],extended=[1];extended.private_extension=1;
  const cyclic={};cyclic.self=cyclic;
  let deep=null;for(let index=0;index<contract.ARCHIVE_LIMITS.depth+2;index++)deep={value:deep};
  let calls=0;const accessor={};Object.defineProperty(accessor,"value",{enumerable:true,get(){calls++;return 1;}});
  const nonenumerable={};Object.defineProperty(nonenumerable,"value",{value:1});
  const symbol={};symbol[Symbol("private")]=1;
  for(const value of [sparse,extended,cyclic,deep,accessor,nonenumerable,symbol,{toJSON(){calls++;return 1;}}])
    assert.throws(()=>contract.archiveCanonical(value),error=>error.message==="Archive input is incomplete or inconsistent.");
  assert.equal(calls,0);
  const huge=new Array(contract.ARCHIVE_LIMITS.input_bytes+1);assert.throws(()=>createArchivePlan(huge),error=>error.field==="input_bytes");
});

test("archive reflection failures redact even forged contract errors and thrown hostile proxies",()=>{
  const thrownProxy=new Proxy({},{getPrototypeOf(){throw new Error("PRIVATE_SECONDARY_BODY");}});
  for(const thrown of [new Error("PRIVATE_TEST_BODY"),new ContractValidationError("PRIVATE_TEST_BODY","PRIVATE_FIELD"),thrownProxy]) {
    for(const trap of ["getPrototypeOf","ownKeys","getOwnPropertyDescriptor"]) {
      const value=new Proxy(fixture(),{[trap](){throw thrown;}});
      for(const operation of [()=>contract.archiveCanonical(value),()=>createArchivePlan(value)])
        assert.throws(operation,error=>error.message==="Archive input is incomplete or inconsistent."&&error.field==="json");
    }
  }
});

test("ordinary canonical bytes and complete escaped SQL-row comparisons remain compatible",()=>{
  const input=fixture(),plan=createArchivePlan(input);
  assert.equal(contract.archiveCanonical(input),ordinaryCanonical(input));
  assert.equal(contract.archiveCanonical(JSON.parse(plan.canonical_text)),plan.canonical_text);
  for(const chunk of plan.chunks)assert.equal(ordinaryCanonical(JSON.parse(chunk.payload_text)),chunk.payload_text);
  const text=ordinaryCanonical({text:"\u0000\\\"".repeat(190000)});
  assert.ok(contract.utf8Bytes(text)<contract.ARCHIVE_LIMITS.total_bytes);
  const row={canonical_plan_text:text,metadata_text:text,capture_proof_text:text,manifest_text:text};
  const expected=ordinaryCanonical(row);assert.ok(contract.utf8Bytes(expected)>contract.ARCHIVE_LIMITS.total_bytes);
  assert.equal(contract.archiveCanonical(row),expected);
});

test("practice plan derives local calendar year and never claims private Google or source verification",()=>{
  const plan=createArchivePlan(fixture());assert.equal(plan.archive_year,2025);assert.equal(plan.state,"LOCAL_PLAN_ONLY");
  assert.equal(plan.source_status,"SOURCE_NOT_YET_VERIFIED");assert.equal(JSON.parse(plan.metadata_text).season_timezone,"America/New_York");
  const input=fixture();input.archive_year=2040;assert.equal(createArchivePlan(input).archive_year,2025);
  assert.equal(records(plan).find(row=>row.type==="practice").value.timezone,"UTC");
});
test("matches the actual C1 frozen projection while preserving complete private identity and cancelled signup audit",()=>{
  const input=fixture(),rev=input.revisions[0];
  const sql={exec(query){const rows=query.includes("seat_plan_revision_names")?rev.names:query.includes("seat_plan_revision_seats")?rev.seats:[rev];return {toArray:()=>clone(rows)};}};
  const history=Object.create(C1HistoryService.prototype);history.ctx={storage:{sql}};
  const actual=history.buildFrozenSnapshot({...input.practices[0],published_revision:1});
  assert.deepEqual(actual,input.frozen_practices[0].snapshot);
  const rows=records(createArchivePlan(input));assert.equal(rows.find(row=>row.type==="signup").value.status,"CANCELLED");
  assert.equal(rows.find(row=>row.type==="audit").value.action,"cancelSignup");
  assert.equal(rows.find(row=>row.type==="revision").value.names[0].display_name,"冻结姓名 😀");
  input.members[0].source_display_name="后来改名";const changed=records(createArchivePlan(input));
  assert.deepEqual(changed.find(row=>row.type==="frozen_practice").value.snapshot,actual);
});
test("whole season derives its end-date year, excludes cancelled practice data, and retains private unpublished drafts",()=>{
  const input=fixture();input.kind="SEASON";input.practice_id=null;input.season.status="COMPLETED";input.cutoff_at=captured;
  const cancelled=clone(input.practices[0]);cancelled.practice_id="practice_cancelled_01";cancelled.cancelled_at=before;cancelled.cancelled_by="coach_archive_01";
  const draft=clone(input.practices[0]);draft.practice_id="practice_unpublished_01";draft.schedule_published_at=null;draft.schedule_published_by=null;
  input.practices.push(cancelled,draft);
  for(const practice of [cancelled,draft]) {input.signup_states.push({...input.signup_states[0],practice_id:practice.practice_id});input.seating_states.push({...input.seating_states[0],practice_id:practice.practice_id,published_revision:0,seat_plan_version:0});}
  const projection=auditPracticeOracle(cancelled);
  input.audits.push({...input.audits[0],event_id:"event_cancel_practice_01",action:"cancelPractice",details:{season_id:sid,practice_id:cancelled.practice_id,
    week_id:cancelled.week_id,before:projection,after:projection,signup_version:1}});
  const plan=createArchivePlan(input),rows=records(plan);assert.equal(plan.archive_year,2026);
  assert.ok(!plan.canonical_text.includes(cancelled.practice_id));assert.ok(plan.canonical_text.includes(draft.practice_id));
  assert.equal(rows.filter(row=>row.type==="frozen_practice").length,1);
});
test("unpublished final result must match real C1 shape and never copies a draft into formal history",()=>{
  const input=fixture();input.revisions=[];input.seating_states[0].published_revision=0;
  input.frozen_practices[0].frozen_revision=0;input.frozen_practices[0].final_status="UNPUBLISHED";
  const state=input.frozen_practices[0].snapshot;state.final_status="UNPUBLISHED";state.seat_plan={status:"UNPUBLISHED",published_revision:0,published_at:"",source:"",coach:null,steerer:null,seats:[]};
  const plan=createArchivePlan(input);assert.equal(records(plan).find(row=>row.type==="frozen_practice").value.snapshot.seat_plan.seats.length,0);
  assert.equal(records(plan).filter(row=>row.type==="draft_seat").length,4);
});
test("fixed deadline and explicit private input are required; no missing state, source array, or revision is guessed",()=>{
  rejected(input=>input.cutoff_at="2026-01-02T01:59:59.999Z");rejected(input=>input.captured_at=before);
  rejected(input=>delete input.signups);rejected(input=>input.signup_states=[]);rejected(input=>input.revisions=[]);
  rejected(input=>input.frozen_practices=[]);rejected(input=>input.revisions[0].published_at=frozen);
  rejected(input=>{input.kind="SEASON";input.practice_id=null;});
});
test("duplicate keys, absent references, role overlaps, seating capacity and cross-season inputs stop",()=>{
  rejected(input=>input.members.push(clone(input.members[0])));rejected(input=>input.signups.push(clone(input.signups[0])));
  rejected(input=>input.members=[]);rejected(input=>input.weeks=[]);rejected(input=>input.practices[0].template_id="template_missing_01");
  rejected(input=>input.revisions[0].names=[]);rejected(input=>input.revisions[0].seats[0].row_number=3);
  rejected(input=>input.revisions[0].coach_member_id=memberId);rejected(input=>input.signups[0].season_id="season_different_01");
  rejected(input=>input.frozen_practices[0].snapshot.seat_plan.seats[0].display_name="当前姓名");
});
test("explicit business whitelist drops credential extensions and rejects unsupported audit details",()=>{
  const input=fixture();input.coach_code="private_sentinel";input.season.code_digest="private_sentinel";
  input.members[0].session_token="private_sentinel";input.revisions[0].secret="private_sentinel";
  assert.ok(!createArchivePlan(input).canonical_text.includes("private_sentinel"));
  rejected(input=>input.audits[0].details.session_token="private_sentinel");
});
test("array and object ordering preserve exact canonical text and UTF8 chunks",()=>{
  const input=fixture();for(let index=2;index<=110;index++)input.members.push({...input.members[0],member_id:`member_archive_${String(index).padStart(3,"0")}`});
  const plan=createArchivePlan(input),other=clone(input);for(const value of Object.values(other))if(Array.isArray(value))value.reverse();
  other.season=Object.fromEntries(Object.entries(other.season).reverse());assert.equal(createArchivePlan(other).canonical_text,plan.canonical_text);
  assert.ok(plan.chunks.length>1);let offset=0;for(const [index,chunk]of plan.chunks.entries()){assert.equal(chunk.chunk_index,index);assert.equal(chunk.row_offset,offset);offset+=chunk.row_count;
    assert.equal(chunk.utf8_bytes,Buffer.byteLength(chunk.payload_text,"utf8"));assert.ok(chunk.utf8_bytes<=contract.ARCHIVE_LIMITS.chunk_bytes);}
  assert.equal(offset,plan.record_count);
});
test("Unicode budgets reject lone surrogates and oversized input instead of constructing partial plans",()=>{
  assert.equal(contract.utf8Bytes("😀中"),7);assert.throws(()=>contract.archiveCanonical("\uD800"));
  rejected(input=>input.members[0].source_display_name="\uDC00");
  rejected(input=>input.ignored="中".repeat(700000));
  const input=fixture();for(let index=0;index<100;index++)input.audits.push({...input.audits[0],event_id:`event_large_${String(index).padStart(3,"0")}`,
    details:{season_id:sid,practice_id:pid,note:"中".repeat(1000),promoted_member_ids:Array(100).fill("中".repeat(1000))}});
  assert.throws(()=>createArchivePlan(input));
});
test("single practice can freeze while another published practice is still in its future window",()=>{
  const input=fixture(),other=clone(input.practices[0]);other.practice_id="practice_future_01";other.start_at="2026-02-01T01:00:00.000Z";other.end_at="2026-02-01T02:00:00.000Z";
  input.season.end_date="2026-02-02";input.season.season_ends_at="2026-02-03T05:00:00.000Z";
  input.practices.push(other);input.signup_states.push({...input.signup_states[0],practice_id:other.practice_id});
  input.seating_states.push({...input.seating_states[0],practice_id:other.practice_id,published_revision:0,seat_plan_version:0});
  assert.ok(!createArchivePlan(input).canonical_text.includes(other.practice_id));
});
test("capture timestamps and correction history are complete immutable inputs",()=>{
  rejected(input=>input.members[0].updated_at="2026-02-01T00:00:00.000Z");
  rejected(input=>input.frozen_practices[0].history_version=2);
  const input=fixture();input.frozen_practices[0].history_version=2;
  input.corrections=[{season_id:sid,practice_id:pid,correction_id:"correction_archive_01",history_version:2,
    note:"补充说明",created_by:"coach_archive_01",created_at:"2026-01-03T06:00:00.000Z"}];
  assert.equal(records(createArchivePlan(input)).find(row=>row.type==="correction").value.note,"补充说明");
  input.corrections[0].created_at=before;assert.throws(()=>createArchivePlan(input));
});
test("DST calendar routing follows explicit season timezone, and unsupported or mismatched zones stop",()=>{
  const input=fixture();input.practices[0].start_at="2026-03-08T06:30:00.000Z";input.practices[0].end_at="2026-03-08T07:30:00.000Z";
  input.practices[0].signup_cutoff_at=input.practices[0].start_at;input.season.end_date="2026-03-10";input.season.season_ends_at="2026-03-11T04:00:00.000Z";
  input.cutoff_at="2026-03-09T07:30:00.000Z";input.captured_at="2026-03-09T12:00:00.000Z";
  input.frozen_practices[0].frozen_at=input.cutoff_at;input.frozen_practices[0].snapshot.practice.start_at=input.practices[0].start_at;
  input.frozen_practices[0].snapshot.practice.end_at=input.practices[0].end_at;
  assert.equal(createArchivePlan(input).archive_year,2026);
  rejected(input=>input.season_timezone="Mars/Local");rejected(input=>input.season_timezone="UTC");
});
test("a record larger than a UTF8 chunk fails the whole plan",()=>{
  const input=fixture(),rev=input.revisions[0];input.practices[0].left_capacity=50;input.practices[0].right_capacity=50;
  input.members=[];rev.names=[];rev.seats=[];input.draft_seats=[];
  for(let index=0;index<100;index++){const id=`member_${String(index).padStart(3,"0")}_${"x".repeat(117)}`;
    input.members.push({...fixture().members[0],member_id:id});rev.names.push({member_id:id,display_name:"中".repeat(120)});
    const seat={side:index<50?"LEFT":"RIGHT",row_number:index%50+1,member_id:id};rev.seats.push(seat);input.draft_seats.push({...seat,season_id:sid,practice_id:pid,seat_plan_version:1});}
  input.signups[0].member_id=input.members[0].member_id;input.audits=[];
  input.frozen_practices[0].snapshot.seat_plan.seats=rev.seats.map(seat=>({side:seat.side,row_number:seat.row_number,display_name:"中".repeat(120)}));
  assert.throws(()=>createArchivePlan(input),error=>error.field==="record_bytes");
  assert.equal(createArchivePlan(fixture()).state,"LOCAL_PLAN_ONLY");
});
test("more than 5000 records reject the whole plan",()=>{
  const large=fixture();for(let index=0;index<5000;index++)large.members.push({...large.members[0],member_id:`member_large_${String(index).padStart(5,"0")}`});
  assert.throws(()=>createArchivePlan(large),error=>error.field==="records");
});
test("real C1 permits the same member as Coach and Steerer, while either role intersecting a seat remains invalid",()=>{
  const input=fixture(),roleId="member_dual_role_01",rev=input.revisions[0];
  input.members.push({...input.members[0],member_id:roleId});
  rev.coach_member_id=roleId;rev.steerer_member_id=roleId;rev.names.push({member_id:roleId,display_name:"双角色冻结姓名"});
  input.seating_states[0].coach_member_id=roleId;input.seating_states[0].steerer_member_id=roleId;
  const sql={exec(query){return {toArray:()=>clone(query.includes("seat_plan_revision_names")?rev.names:query.includes("seat_plan_revision_seats")?rev.seats:[rev])};}};
  const history=Object.create(C1HistoryService.prototype);history.ctx={storage:{sql}};
  input.frozen_practices[0].snapshot=history.buildFrozenSnapshot({...input.practices[0],published_revision:1});
  const plan=createArchivePlan(input),actual=records(plan).find(row=>row.type==="frozen_practice").value.snapshot;
  assert.deepEqual(actual.seat_plan.coach,{display_name:"双角色冻结姓名"});assert.deepEqual(actual.seat_plan.steerer,actual.seat_plan.coach);
  const bad=clone(input);bad.revisions[0].coach_member_id=memberId;assert.throws(()=>createArchivePlan(bad),error=>error.field==="role_overlap");
  bad.revisions[0].coach_member_id=roleId;bad.revisions[0].steerer_member_id=memberId;assert.throws(()=>createArchivePlan(bad),error=>error.field==="role_overlap");
});
test("actual C1 seating and schedule audit projections pass finite nested whitelists; credentials in any nested object stop",()=>{
  const input=fixture(),rev=input.revisions[0],state=input.seating_states[0];
  input.practices[0].map_url=`https://example.com/${"a".repeat(1500)}`;
  input.frozen_practices[0].snapshot.practice.map_url=input.practices[0].map_url;
  const sql={exec(query){const rows=query.includes("FROM practice_versions")?[{...state,state_updated_at:state.updated_at}]:
    query.includes("seat_plan_revision_names")?rev.names:query.includes("seat_plan_revision_seats")?rev.seats:
    query.includes("seat_plan_draft_seats")?input.draft_seats:[rev];return {toArray:()=>clone(rows)};}};
  const snapshot=auditSnapshotOracle(sql,input.practices[0],true,true);
  input.audits[0].created_at=published;input.audits[0].details.seating={seat_plan_version:1,published_revision:1,draft_changed:true,published_changed:true,snapshot};
  const before=auditPracticeOracle(input.practices[0]),after={...before,location:"New river"};
  input.audits.push({...input.audits[0],event_id:"event_schedule_change_01",action:"updatePractice",details:{season_id:sid,practice_id:pid,
    week_id:input.practices[0].week_id,before,after,signup_version:1}});
  const parsed=records(createArchivePlan(input));assert.deepEqual(parsed.find(row=>row.type==="audit"&&row.key===input.audits[0].event_id).value.details.seating.snapshot,snapshot);
  const shuffled=clone(input);shuffled.audits[0].details.seating.snapshot.draft_seats.reverse();
  assert.equal(createArchivePlan(shuffled).canonical_text,createArchivePlan(input).canonical_text);
  assert.equal(parsed.find(row=>row.key==="event_schedule_change_01").value.details.after.location,"New river");
  for(const change of [value=>value.audits[0].details.seating.snapshot.state.session_token="secret",
    value=>value.audits[0].details.seating.snapshot.revision.names[0].code_digest="secret",
    value=>value.audits[1].details.before.raw_backup="secret",
    value=>value.audits[0].details.seating.snapshot.state.season_id="season_other_01",
    value=>value.audits[0].details.seating.snapshot.state.updated_at="2026-02-01T00:00:00.000Z",
    value=>value.audits[0].details.seating.snapshot.revision.practice_id="practice_other_01",
    value=>delete value.audits[0].details.seating.snapshot.state.coach_member_id,
    value=>delete value.audits[0].details.seating.snapshot.revision.steerer_member_id,
    value=>value.audits[0].details.seating.snapshot.draft_seats.pop(),
    value=>value.audits[0].details.seating.snapshot.draft_seats[0].row_number=999,
    value=>value.audits[1].details.before.practice_id="practice_other_01"]){const bad=clone(input);change(bad);assert.throws(()=>createArchivePlan(bad));}
  assert.equal(parsed.find(row=>row.key==="event_schedule_change_01").value.details.before.map_url.length,1520);
});
test("action-specific business audit keys support actual week and Form shapes without permitting nested payloads or foreign action keys",()=>{
  const input=fixture(),add=(action,details)=>input.audits.push({...input.audits[0],event_id:`event_${action}`,action,details:{season_id:sid,...details}});
  add("prepareTrainingWeek",{week_id:input.weeks[0].week_id,created:true});
  add("confirmTrainingWeek",{week_id:input.weeks[0].week_id,open_at:before});
  add("pullFormResponses",{counts:{created:1,updated:0,reviewed:0,unchanged:0},has_more:false});
  add("resolveFormSource",{member_id:memberId,stable_source_id:"stable_source_01"});
  input.kind="SEASON";input.practice_id=null;input.cutoff_at=captured;input.season.status="COMPLETED";
  assert.equal(records(createArchivePlan(input)).filter(row=>row.type==="audit").length,5);
  const repeated=clone(input);repeated.audits[1].details.created=false;assert.equal(records(createArchivePlan(repeated)).find(row=>row.key==="event_prepareTrainingWeek").value.details.created,false);
  for(const mutate of [value=>value.audits[1].details.seating=null,value=>value.audits[3].details.counts.secret="secret",
    value=>value.audits[2].details.open_at={session_token:"secret"},value=>delete value.audits[1].details.created,
    value=>value.audits[1].details.created=-1,value=>value.audits[1].details.created=1,value=>value.audits[1].details.created="yes",
    value=>value.audits[3].details.has_more="false",value=>value.audits[0].details.status="INVALID"]){
    const bad=clone(input);mutate(bad);assert.throws(()=>createArchivePlan(bad));}
  const bad=clone(input);bad.audits.push({...bad.audits[0],event_id:"event_publish_wrong",action:"publishSeatPlan",
    details:{season_id:sid,practice_id:pid,published_revision:"wrong",seat_plan_version:1,preference_mismatches:[]}});
  assert.throws(()=>createArchivePlan(bad));
});
test("real C1 graph invariants require every draft slot, bounded revision versions, ordered unique signup sequence, and true season end",()=>{
  rejected(input=>input.draft_seats.pop());rejected(input=>input.draft_seats=[]);
  rejected(input=>delete input.draft_seats[0].member_id);rejected(input=>delete input.revisions[0].seats[0].member_id);
  rejected(input=>delete input.seating_states[0].coach_member_id);rejected(input=>delete input.revisions[0].steerer_member_id);
  rejected(input=>input.seating_states[0].coach_member_id=null);rejected(input=>input.draft_seats[0].member_id=null);
  rejected(input=>input.revisions[0].seat_plan_version=2);
  rejected(input=>{input.members.push({...input.members[0],member_id:"member_other_signup"});input.signups.push({...input.signups[0],member_id:"member_other_signup"});});
  rejected(input=>input.signups[0].updated_at="2025-11-01T12:00:00.000Z");
  rejected(input=>{input.kind="SEASON";input.practice_id=null;input.season.status="COMPLETED";input.cutoff_at=frozen;input.season.season_ends_at=before;});
});
test("confirmed signup side and total capacities are checked without re-running historical waitlist eligibility",()=>{
  const input=fixture();input.members[0].status="INACTIVE";input.signups[0].status="WAITLISTED";input.audits[0].details.status="WAITLISTED";
  assert.equal(records(createArchivePlan(input)).find(row=>row.type==="signup").value.status,"WAITLISTED");
  for(const preference of ["LEFT","RIGHT","AMBIENT"]){const bad=fixture(),count=preference==="AMBIENT"?5:3;bad.signups=[];
    for(let index=0;index<count;index++){const id=`member_capacity_${index}`;bad.members.push({...bad.members[0],member_id:id});
      bad.signups.push({...fixture().signups[0],member_id:id,preference,status:"CONFIRMED",queue_sequence:index+1});}
    bad.signup_states[0].signup_sequence=count;assert.throws(()=>createArchivePlan(bad),error=>error.field==="signup_capacity");}
  const active=fixture();active.signups[0].status="CONFIRMED";active.audits[0].details.status="CONFIRMED";
  assert.equal(records(createArchivePlan(active)).find(row=>row.type==="audit").value.details.status,"CONFIRMED");
});
test("actual C1 final correction permits cancelled signup attendance while upcoming publishing requires confirmed signups",()=>{
  const input=fixture(),practice=input.practices[0],rev=input.revisions[0];
  const seating=Object.create(C1SeatingService.prototype);
  seating.ctx={storage:{sql:{exec(query){return {toArray:()=>clone(query.includes("FROM members")?input.members:
    query.includes("status='CONFIRMED'")?[]:input.signups)};}}}};
  const snapshot={coach_member_id:rev.coach_member_id,steerer_member_id:rev.steerer_member_id,seats:rev.seats};
  assert.equal(seatingMode(practice,Date.parse(published)),"FINAL_CORRECTION");
  assert.deepEqual(seating.validateSnapshot(practice,snapshot,"FINAL_CORRECTION",true),[]);
  assert.throws(()=>seating.validateSnapshot(practice,snapshot,"UPCOMING",true),error=>error.code==="SEAT_MEMBER_NOT_CONFIRMED");
  assert.equal(records(createArchivePlan(input)).find(row=>row.type==="revision").value.seats[0].member_id,memberId);
});
