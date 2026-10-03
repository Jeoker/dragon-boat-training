import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, archiveAssert, archiveCanonical, parseArchiveInput, utf8Bytes } from "../../shared/c2-archive-contract";
import { createArchivePlan } from "../../shared/c2-archive-projection";
import { enumeration, identifier, integer, object, requestId, string, type Input } from "../../shared/c1-contract";

// Delivery 1: read-only, test-callable adapter. No routing, schema, jobs, persistence or Google.
export const ARCHIVE_BUSINESS_ACTIONS = ["createSeason","updateMember","updateScheduleTemplates","prepareTrainingWeek",
  "confirmTrainingWeek","publishTrainingWeek","createPractice","publishAdditionalPractice","updatePractice","cancelPractice",
  "signup","signupByCoach","updateSignup","updateSignupByCoach","cancelSignup","cancelSignupByCoach","saveSeatPlanDraft",
  "publishSeatPlan","freezePracticeHistory","completeSeason","archiveSeasonHistory","appendHistoryCorrection",
  "resolveFormSource","pullFormResponses"] as const;
export const ARCHIVE_OPERATIONAL_ACTIONS = ["coachLogin","coachLogout","importCoreSnapshot","importScheduleSnapshot",
  "importSignupSnapshot","importSeatingSnapshot","importHistorySnapshot","createBackupSnapshot","importSyncFoundation",
  "exportNextMember","exportNextSchedule","exportNextAssociated","pollDueExports","setExportPause","retryExport"] as const;
const quoted = (values:readonly string[]) => values.map(value=>`'${value}'`).join(",");
interface Spec { name:string; query:string; logical:boolean; }
export interface ArchiveCaptureProof {
  format:"annual-capture-proof-v1"; captured_at:string; logical_rows:number; projected_sql_bytes:number;
  input_upper_bytes:number; actual_input_bytes:number; source_counts:Record<string,number>;
  excluded_cancelled_practices:number; excluded_operational_audits:number;
  excluded_cancelled_audits:number;
  implicit_states:Array<{practice_id:string;provenance:"IMPLICIT_INITIAL_STATE";source_table:"practices";
    source_created_at:string;seat_state_present:false;seat_plan_version:0;published_revision:0;child_count:0}>;
}
export function proveArchiveBudget(logical:number,bytes:number,nestedRows:number,metadata:unknown):number {
  archiveAssert([logical,bytes,nestedRows].every(value=>Number.isSafeInteger(value)&&value>=0),"capture_resource");
  const upper=6*bytes+utf8Bytes(archiveCanonical(metadata))+4096+2*(logical+nestedRows);
  archiveAssert(Number.isSafeInteger(upper)&&logical<=ARCHIVE_LIMITS.records&&upper<=ARCHIVE_LIMITS.input_bytes,"capture_resource");return upper;
}
function jsonRow(fields:string[],alias="r",expressions:Record<string,string>={}):string {
  return `json_object(${fields.flatMap(field=>[`'${field}'`,expressions[field]??`${alias}.${field}`]).join(",")})`;
}
function aggregate(sql:SqlStorage,query:string,args:SqlStorageValue[]) {
  const row=sql.exec<{count:number;bytes:number}>(`SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(row_json AS BLOB))),0) AS bytes FROM (${query})`,...args).one();
  archiveAssert(Number.isSafeInteger(row.count)&&row.count>=0&&Number.isSafeInteger(row.bytes)&&row.bytes>=0,"capture_resource");return row;
}
function assertZero(sql:SqlStorage,query:string,args:SqlStorageValue[],field:string) {
  archiveAssert(sql.exec<{count:number}>(`SELECT COUNT(*) AS count FROM (${query})`,...args).one().count===0,field);
}
function specs(selected:string):Spec[] {
  const base=(name:string,table:string,fields:string[],where="r.season_id=?1",expressions:Record<string,string>={}):Spec=>
    ({name,logical:true,query:`SELECT ${jsonRow(fields,"r",expressions)} AS row_json FROM ${table} r WHERE ${where} AND ?3 IN ('PRACTICE','SEASON') AND (?2 IS NULL OR ?2 IS NOT NULL)`});
  const scoped=`r.season_id=?1 AND r.practice_id IN (${selected})`;
  return [
    base("season","seasons",["season_id","name","start_date","end_date","timezone","season_ends_at","status","binding_version","season_version","roster_version","created_by","created_at","updated_at"]),
    base("members","members",["season_id","member_id","source_key","source_display_name","display_name_override","status","default_preference","member_version","created_at","updated_at"]),
    base("templates","schedule_templates",["season_id","template_id","day_of_week","start_time","end_time","timezone","location","address","map_url","active","template_version","created_at","updated_at"]),
    base("weeks","training_weeks",["season_id","week_id","week_start_date","scheduled_open_at","status","week_version","confirmed_version","confirmed_by","confirmed_at","published_at","created_at","updated_at"]),
    base("practices","practices",["season_id","practice_id","week_id","template_id","generation_key","start_at","end_at","timezone","location","address","map_url","left_capacity","right_capacity","signup_cutoff_at","practice_version","cancelled_at","cancelled_by","schedule_published_at","schedule_published_by","created_at","updated_at"],scoped),
    base("signup_states","practice_versions",["season_id","practice_id","signup_version","signup_sequence"],scoped),
    base("signups","signups",["season_id","practice_id","member_id","preference","status","queue_at","queue_sequence","updated_at","last_request_id"],scoped),
    {name:"seating_states",logical:true,query:`SELECT ${jsonRow(["season_id","practice_id","seat_plan_version","published_revision","coach_member_id","steerer_member_id","updated_by","updated_at","implicit_state"],"r",{
      coach_member_id:"COALESCE(s.coach_member_id,'')",steerer_member_id:"COALESCE(s.steerer_member_id,'')",
      updated_by:"CASE WHEN s.practice_id IS NULL THEN 'IMPLICIT_INITIAL_STATE' ELSE s.updated_by END",
      updated_at:"CASE WHEN s.practice_id IS NULL THEN p.created_at ELSE s.updated_at END",implicit_state:"CASE WHEN s.practice_id IS NULL THEN 1 ELSE 0 END"})} AS row_json
      FROM practice_versions r JOIN practices p ON p.season_id=r.season_id AND p.practice_id=r.practice_id
      LEFT JOIN seat_plan_states s ON s.season_id=r.season_id AND s.practice_id=r.practice_id WHERE ${scoped}`},
    base("draft_seats","seat_plan_draft_seats",["season_id","practice_id","seat_plan_version","side","row_number","member_id"],scoped,{member_id:"COALESCE(r.member_id,'')"}),
    base("revisions","seat_plan_revisions",["season_id","practice_id","revision_number","revision_id","source","seat_plan_version","coach_member_id","steerer_member_id","published_by","published_at","request_id"],scoped,{coach_member_id:"COALESCE(r.coach_member_id,'')",steerer_member_id:"COALESCE(r.steerer_member_id,'')"}),
    {...base("revision_seats","seat_plan_revision_seats",["season_id","practice_id","revision_number","side","row_number","member_id"],scoped),logical:false},
    {...base("revision_names","seat_plan_revision_names",["season_id","practice_id","revision_number","member_id","display_name"],scoped),logical:false},
    base("frozen_practices","practice_history",["season_id","practice_id","history_version","final_status","frozen_revision","frozen_at","snapshot_json"],scoped),
    base("corrections","history_corrections",["season_id","practice_id","correction_id","history_version","note","created_by","created_at"],scoped),
    base("audits","audit_events",["season_id","event_id","request_key","actor_scope","action","created_at","details_json"],
      `r.season_id=?1 AND r.action IN (${quoted(ARCHIVE_BUSINESS_ACTIONS)}) AND CASE WHEN json_valid(r.details_json) THEN
        CASE WHEN json_type(r.details_json,'$.practice_id') IS NULL THEN ?3='SEASON'
        ELSE json_extract(r.details_json,'$.practice_id') IN (${selected}) END ELSE 0 END`)
  ];
}

/** Caller supplies server identity; clock injection is for local tests. Always reads one synchronous transaction. */
export function previewArchiveCapture(storage:Pick<DurableObjectStorage,"sql"|"transactionSync">,value:unknown,
  identity:{team_id:string;backend_generation:string;writer_epoch:number},clock:()=>number=Date.now) {
  const command=object(value),kind=enumeration(command,"kind",["PRACTICE","SEASON"] as const),sid=identifier(command,"season_id");
  const pid=kind==="PRACTICE"?identifier(command,"practice_id"):null;
  archiveAssert(kind!=="SEASON" || command.practice_id===null,"practice_id");
  const request_id=requestId(command),snapshot_id=identifier(command,"snapshot_id"),binding_version=integer(command,"binding_version",1);
  const team_id=identifier(object(identity),"team_id"),backend_generation=string(object(identity),"backend_generation",1,128),writer_epoch=integer(object(identity),"writer_epoch");
  return storage.transactionSync(()=>{
    const sql=storage.sql,now=clock();archiveAssert(Number.isSafeInteger(now),"capture_clock");const captured_at=new Date(now).toISOString();
    const selected="SELECT practice_id FROM practices WHERE season_id=?1 AND cancelled_at IS NULL AND (?3='SEASON' OR practice_id=?2)";
    const args:SqlStorageValue[]=[sid,pid,kind];
    // SQL proof returns only counts, never audit/history payloads. CASE avoids malformed JSON exceptions.
    const practiceActions=ARCHIVE_BUSINESS_ACTIONS.filter(action=>["createPractice","publishAdditionalPractice","updatePractice","cancelPractice","signup","signupByCoach",
      "updateSignup","updateSignupByCoach","cancelSignup","cancelSignupByCoach","saveSeatPlanDraft","publishSeatPlan","freezePracticeHistory","appendHistoryCorrection"].includes(action));
    assertZero(sql,`SELECT 1 FROM audit_events a WHERE CASE
      WHEN NOT json_valid(a.details_json) THEN 1
      WHEN json_type(a.details_json) IS NOT 'object' THEN 1
      WHEN a.action IN (${quoted(ARCHIVE_OPERATIONAL_ACTIONS)}) THEN 0
      WHEN a.action NOT IN (${quoted(ARCHIVE_BUSINESS_ACTIONS)}) THEN 1
      ELSE CASE WHEN json_type(a.details_json,'$.season_id') IS NOT 'text' OR
        length(json_extract(a.details_json,'$.season_id')) NOT BETWEEN 8 AND 128 OR
        json_extract(a.details_json,'$.season_id') GLOB '*[^A-Za-z0-9_-]*' OR
        json_extract(a.details_json,'$.season_id') IS NOT a.season_id OR NOT EXISTS
        (SELECT 1 FROM seasons s WHERE s.season_id=a.season_id) OR
        (a.action IN (${quoted(practiceActions)}) AND json_type(a.details_json,'$.practice_id') IS NOT 'text') OR
        (json_type(a.details_json,'$.practice_id') IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM practices p WHERE p.season_id=a.season_id AND p.practice_id=json_extract(a.details_json,'$.practice_id'))) OR
        (json_type(a.details_json,'$.week_id') IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM training_weeks w WHERE w.season_id=a.season_id AND w.week_id=json_extract(a.details_json,'$.week_id'))) OR
        (json_type(a.details_json,'$.member_id') IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM members m WHERE m.season_id=a.season_id AND m.member_id=json_extract(a.details_json,'$.member_id')))
        THEN 1 ELSE 0 END END`,[],"audit_ownership");
    assertZero(sql,`SELECT 1 FROM practices p LEFT JOIN practice_versions v ON v.season_id=p.season_id AND v.practice_id=p.practice_id
      WHERE p.season_id=?1 AND p.practice_id IN (${selected}) AND v.practice_id IS NULL`,args,"capture_state_missing");
    const children=["seat_plan_draft_seats","seat_plan_revisions","seat_plan_revision_seats","seat_plan_revision_names"];
    for(const table of ["practice_versions","signups","seat_plan_states",...children,"practice_history","history_corrections"])
      assertZero(sql,`SELECT 1 FROM ${table} c WHERE c.season_id=?1 AND (?3='SEASON' OR c.practice_id=?2) AND NOT EXISTS
        (SELECT 1 FROM practices p WHERE p.season_id=c.season_id AND p.practice_id=c.practice_id)`,args,"practice_child_orphan");
    assertZero(sql,`SELECT 1 FROM practice_versions v LEFT JOIN seat_plan_states s ON s.season_id=v.season_id AND s.practice_id=v.practice_id
      WHERE v.season_id=?1 AND v.practice_id IN (${selected}) AND s.practice_id IS NULL AND
      (v.seat_plan_version<>0 OR v.published_revision<>0 OR ${children.map(table=>`EXISTS(SELECT 1 FROM ${table} c WHERE c.season_id=v.season_id AND c.practice_id=v.practice_id)`).join(" OR ")})`,args,"implicit_state_dirty");
    for(const table of ["seat_plan_revision_seats","seat_plan_revision_names"]){
      assertZero(sql,`SELECT 1 FROM ${table} c WHERE c.season_id=?1 AND c.practice_id IN (${selected}) AND NOT EXISTS
        (SELECT 1 FROM seat_plan_revisions r WHERE r.season_id=c.season_id AND r.practice_id=c.practice_id AND r.revision_number=c.revision_number)`,args,"revision_child_orphan");
      assertZero(sql,`SELECT practice_id,revision_number FROM ${table} WHERE season_id=?1 AND practice_id IN (${selected})
        GROUP BY practice_id,revision_number HAVING COUNT(*)>${table.endsWith("names")?102:100}`,args,"revision_child_limit");
    }
    assertZero(sql,`SELECT 1 FROM practice_history r WHERE r.season_id=?1 AND r.practice_id IN (${selected}) AND NOT json_valid(r.snapshot_json)`,args,"history_json");
    const sources=specs(selected),counts:Record<string,number>={};let logical=0,bytes=0;
    for(const spec of sources){const result=aggregate(sql,spec.query,args);counts[spec.name]=result.count;bytes+=result.bytes;if(spec.logical)logical+=result.count;}
    archiveAssert(counts.season===1 && (kind==="SEASON" || counts.practices===1),"capture_scope_missing");
    // Counts include two DTO states per practice_versions row; children are bounded above before this aggregation.
    const metadata={format:ARCHIVE_FORMAT,request_id,snapshot_id,kind,practice_id:pid,team_id,backend_generation,writer_epoch,binding_version,captured_at,
      cutoff_at:captured_at,season_timezone:"x".repeat(100)};
    // Each original byte is charged six times, including nested/raw JSON and punctuation; row wrappers are projected too.
    const upper=proveArchiveBudget(logical,bytes,counts.revision_seats+counts.revision_names,metadata);
    const rows:Record<string,Input[]>={};
    for(const spec of sources){rows[spec.name]=[];for(const row of sql.exec<{row_json:string}>(`/* archive materialize ${spec.name} */ ${spec.query}`,...args))
      rows[spec.name].push(object(JSON.parse(row.row_json)));archiveAssert(rows[spec.name].length===counts[spec.name],"capture_count_changed");}
    for(const row of rows.templates){archiveAssert(row.active===0||row.active===1,"template_boolean");row.active=row.active===1;}
    const implicit:ArchiveCaptureProof["implicit_states"]=[];
    for(const state of rows.seating_states){if(state.implicit_state===1)implicit.push({practice_id:String(state.practice_id),provenance:"IMPLICIT_INITIAL_STATE",source_table:"practices",source_created_at:String(state.updated_at),
        seat_state_present:false,seat_plan_version:0,published_revision:0,child_count:0});delete state.implicit_state;}
    for(const revision of rows.revisions){const matches=(row:Input)=>row.practice_id===revision.practice_id&&row.revision_number===revision.revision_number;
      revision.seats=rows.revision_seats.filter(matches).map(({side,row_number,member_id})=>({side,row_number,member_id}));
      revision.names=rows.revision_names.filter(matches).map(({member_id,display_name})=>({member_id,display_name}));}
    for(const history of rows.frozen_practices){history.snapshot=JSON.parse(String(history.snapshot_json));delete history.snapshot_json;}
    for(const audit of rows.audits){audit.details=JSON.parse(String(audit.details_json));delete audit.details_json;}
    const season=rows.season[0],practiceDue=rows.practices.filter(row=>row.schedule_published_at!==null).map(row=>Date.parse(String(row.end_at))+86_400_000);
    const cutoff=kind==="PRACTICE"?Date.parse(String(rows.practices[0].end_at))+86_400_000:Math.max(Date.parse(String(season.season_ends_at)),...practiceDue);
    archiveAssert(Number.isFinite(cutoff)&&now>=cutoff,"capture_not_due");
    const raw={...metadata,cutoff_at:new Date(cutoff).toISOString(),season_timezone:season.timezone,season,
      ...Object.fromEntries(Object.entries(rows).filter(([key])=>!["season","revision_seats","revision_names"].includes(key)))};
    const input=parseArchiveInput(raw),actual=utf8Bytes(JSON.stringify(raw));archiveAssert(actual<=upper,"capture_budget_proof");
    const plan=createArchivePlan(input);
    const proof:ArchiveCaptureProof={format:"annual-capture-proof-v1",captured_at,logical_rows:logical,projected_sql_bytes:bytes,input_upper_bytes:upper,
      actual_input_bytes:actual,source_counts:counts,implicit_states:implicit,
      excluded_cancelled_practices:sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM practices WHERE season_id=? AND cancelled_at IS NOT NULL",sid).one().count,
      excluded_cancelled_audits:sql.exec<{count:number}>(`SELECT COUNT(*) AS count FROM audit_events a WHERE a.season_id=? AND a.action IN (${quoted(ARCHIVE_BUSINESS_ACTIONS)})
        AND json_extract(a.details_json,'$.practice_id') IN (SELECT practice_id FROM practices WHERE season_id=? AND cancelled_at IS NOT NULL)`,sid,sid).one().count,
      excluded_operational_audits:sql.exec<{count:number}>(`SELECT COUNT(*) AS count FROM audit_events WHERE action IN (${quoted(ARCHIVE_OPERATIONAL_ACTIONS)})`).one().count};
    archiveAssert(utf8Bytes(archiveCanonical(proof))<=ARCHIVE_LIMITS.input_bytes,"capture_proof_bytes");
    return {input,plan,proof};
  });
}
