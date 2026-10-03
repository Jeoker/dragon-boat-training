import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, archiveAssert, archiveCanonical, utf8Bytes } from "../../shared/c2-archive-contract";
import type { ArchivePlan } from "../../shared/c2-archive-projection";
import { enumeration, identifier, integer, object, requestId, string } from "../../shared/c1-contract";
import { sha256Base64Url } from "./crypto";
import { previewArchiveCapture, type ArchiveCaptureProof } from "./c2-archive-capture";

// Internal only. The caller must supply authenticated, server-owned context. No Worker dispatch/import.
export interface ArchiveStorageContext { team_id:string; actor_scope:string; backend_generation:string; writer_epoch:number; }
type Row = Record<string,SqlStorageValue>;
interface Identity { request_key:string; request_id:string; snapshot_id:string; command_text:string; command_digest:string;
  logical_scope:string; kind:"PRACTICE"|"SEASON"; season_id:string; practice_id:string|null; binding_version:number; }
interface Saved { row:Row; pin:Row; chunks:Row[]; plan:ArchivePlan; proof:ArchiveCaptureProof; }
export interface StoredArchiveArtifact { request_id:string; state:"CAPTURED"|"LOCAL_DIGEST_READY"; plan:ArchivePlan;
  proof:ArchiveCaptureProof; manifest:Record<string,unknown>|null; content_digest:string|null; }
const MAX_SMALL_TEXT=8192;
const PLAN_TEXTS=["snapshot_id","logical_scope","first_request_key","first_request_id","actor_scope","command_text","command_digest",
  "team_id","season_id","practice_id","kind","format","backend_generation","captured_at","cutoff_at","status",
  "metadata_text","canonical_plan_text","capture_proof_text","manifest_text","content_digest","completed_at"];
const PIN_TEXTS=["request_key","actor_scope","request_id","command_text","command_digest","snapshot_id","saved_result_text","created_at"];
const PLAN_NUMBERS=["binding_version","writer_epoch","archive_year","record_count","chunk_count","input_bytes"];
const CHUNK_NUMBERS=["chunk_index","row_offset","row_count","utf8_bytes"];
const badNumbers=(columns:string[])=>columns.map(column=>`typeof(${column})<>'integer' OR ${column}<0 OR ${column}>9007199254740991`).join(" OR ");
const sizes=(columns:string[])=>columns.map(column=>`COALESCE(LENGTH(CAST(${column} AS BLOB)),0)`).join("+");
const safe=(value:unknown,max:number)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&value<=max;
const json=(text:SqlStorageValue)=>object(JSON.parse(String(text)));
const equal=(left:unknown,right:unknown)=>archiveCanonical(left)===archiveCanonical(right);

/** Each replay budgets only its own pin, never the growing set of scope aliases. */
export function proveStoredArchiveBudget(value:{plans:number;plan_bytes:number;pin_bytes:number;chunks:number;payload_bytes:number;chunk_bytes:number}):void {
  archiveAssert(value.plans===1&&safe(value.plan_bytes,4*ARCHIVE_LIMITS.total_bytes+MAX_SMALL_TEXT)&&safe(value.pin_bytes,MAX_SMALL_TEXT)&&
    safe(value.chunks,ARCHIVE_LIMITS.records)&&value.chunks>0&&safe(value.payload_bytes,ARCHIVE_LIMITS.total_bytes)&&
    safe(value.chunk_bytes,ARCHIVE_LIMITS.total_bytes+ARCHIVE_LIMITS.records*256),"saved_resource");
}

export class C2ArchiveStorage {
  constructor(private readonly storage:Pick<DurableObjectStorage,"sql"|"transactionSync">,private readonly sourceContext:ArchiveStorageContext|(()=>ArchiveStorageContext),
    private readonly clock:()=>number=Date.now) {
    this.context;
  }
  private get context():ArchiveStorageContext {
    const input=object(typeof this.sourceContext==="function"?this.sourceContext():this.sourceContext);
    return {team_id:identifier(input,"team_id"),actor_scope:identifier(input,"actor_scope"),
      backend_generation:string(input,"backend_generation",1,128),writer_epoch:integer(input,"writer_epoch")};
  }
  protected async digest(text:string):Promise<string> { return sha256Base64Url(text); }
  private async identity(raw:unknown):Promise<Identity> {
    const row=object(raw);archiveAssert(Object.keys(row).every(key=>["request_id","kind","season_id","practice_id","binding_version"].includes(key)),"command_keys");
    const kind=enumeration(row,"kind",["PRACTICE","SEASON"] as const),season_id=identifier(row,"season_id"),request_id=requestId(row);
    const practice_id=kind==="PRACTICE"?identifier(row,"practice_id"):null;
    archiveAssert(kind!=="SEASON"||row.practice_id===null,"practice_id");const binding_version=integer(row,"binding_version",1);
    const context=this.context,command_text=archiveCanonical({...context,format:ARCHIVE_FORMAT,kind,season_id,practice_id,binding_version});
    const request_key=`annual_request_${await sha256Base64Url(archiveCanonical([context.team_id,context.actor_scope,request_id]))}`;
    return {request_key,request_id,snapshot_id:`annual_${request_key.slice(-43)}`,command_text,
      command_digest:`sha256_v1:${await sha256Base64Url(command_text)}`,logical_scope:archiveCanonical([context.team_id,kind,season_id,practice_id]),
      kind,season_id,practice_id,binding_version};
  }
  private ownership(identity:Identity):void {
    const command=json(identity.command_text),context=this.context;
    archiveAssert(command.team_id===context.team_id&&command.actor_scope===context.actor_scope&&command.backend_generation===context.backend_generation&&
      command.writer_epoch===context.writer_epoch,"OWNERSHIP_CHANGED");
    // Current scalar ownership is the only live lookup on replay; no business snapshot is recaptured.
    const current=this.storage.sql.exec<{binding_version:number;sync_binding:number|null}>(`/* annual ownership */
      SELECT CASE WHEN typeof(s.binding_version)='integer' THEN s.binding_version ELSE NULL END binding_version,
        (SELECT CASE WHEN typeof(b.binding_version)='integer' THEN b.binding_version ELSE -1 END FROM sync_bindings b WHERE b.season_id=s.season_id) sync_binding
      FROM seasons s WHERE s.season_id=?`,identity.season_id).toArray()[0];
    archiveAssert(current&&safe(current.binding_version,Number.MAX_SAFE_INTEGER)&&current.binding_version===identity.binding_version&&
      (current.sync_binding===null||current.sync_binding===identity.binding_version),"OWNERSHIP_CHANGED");
  }
  private pin(identity:Identity):Row|undefined {
    const sql=this.storage.sql;
    const size=sql.exec<{bytes:number}>(`SELECT ${sizes(PIN_TEXTS)} AS bytes FROM annual_archive_requests WHERE actor_scope=? AND request_id=?`,
      this.context.actor_scope,identity.request_id).toArray()[0];
    if(!size)return;archiveAssert(safe(size.bytes,MAX_SMALL_TEXT),"saved_resource");
    const pin=sql.exec<Row>("/* annual materialize pin */ SELECT * FROM annual_archive_requests WHERE actor_scope=? AND request_id=?",
      this.context.actor_scope,identity.request_id).one();
    const prior=json(pin.command_text);
    archiveAssert(prior.team_id===this.context.team_id&&prior.backend_generation===this.context.backend_generation&&prior.writer_epoch===this.context.writer_epoch&&
      prior.binding_version===identity.binding_version,"OWNERSHIP_CHANGED");
    archiveAssert(pin.request_key===identity.request_key&&pin.command_text===identity.command_text&&pin.command_digest===identity.command_digest,"IDEMPOTENCY_CONFLICT");
    archiveAssert(typeof pin.snapshot_id==="string"&&pin.snapshot_id.length<=128,"saved_identity");return pin;
  }
  private load(identity:Identity,pin:Row):Saved {
    this.ownership(identity);
    const sql=this.storage.sql,snapshot=String(pin.snapshot_id);
    const size=sql.exec<{plans:number;plan_bytes:number;invalid:number}>(`SELECT COUNT(*) plans, COALESCE(SUM(${sizes(PLAN_TEXTS)}),0) plan_bytes,
      COALESCE(SUM(CASE WHEN ${badNumbers(PLAN_NUMBERS)} OR LENGTH(CAST(metadata_text AS BLOB))>? OR LENGTH(CAST(canonical_plan_text AS BLOB))>? OR
        LENGTH(CAST(capture_proof_text AS BLOB))>? OR COALESCE(LENGTH(CAST(manifest_text AS BLOB)),0)>? OR
        (${sizes(PLAN_TEXTS.filter(column=>!["metadata_text","canonical_plan_text","capture_proof_text","manifest_text"].includes(column)))})>${MAX_SMALL_TEXT}
        THEN 1 ELSE 0 END),0) invalid FROM annual_archive_plans WHERE snapshot_id=?`,
      ARCHIVE_LIMITS.total_bytes,ARCHIVE_LIMITS.total_bytes,ARCHIVE_LIMITS.total_bytes,ARCHIVE_LIMITS.total_bytes,snapshot).one();
    const blocks=sql.exec<{chunks:number;payload_bytes:number;chunk_bytes:number;invalid:number}>(`SELECT COUNT(*) chunks,
      COALESCE(SUM(LENGTH(CAST(payload_text AS BLOB))),0) payload_bytes,
      COALESCE(SUM(LENGTH(CAST(payload_text AS BLOB))+COALESCE(LENGTH(CAST(payload_digest AS BLOB)),0)+LENGTH(CAST(snapshot_id AS BLOB))),0) chunk_bytes,
      COALESCE(SUM(CASE WHEN ${badNumbers(CHUNK_NUMBERS)} OR LENGTH(CAST(payload_text AS BLOB))>? OR COALESCE(LENGTH(payload_digest),0)>64 THEN 1 ELSE 0 END),0) invalid
      FROM annual_archive_chunks WHERE snapshot_id=?`,ARCHIVE_LIMITS.chunk_bytes,snapshot).one();
    proveStoredArchiveBudget({...size,...blocks,pin_bytes:utf8Bytes(archiveCanonical(pin))});
    archiveAssert(size.invalid===0&&blocks.invalid===0,"saved_resource");
    const row=sql.exec<Row>("/* annual materialize plan */ SELECT * FROM annual_archive_plans WHERE snapshot_id=?",snapshot).one();
    const chunks=sql.exec<Row>("/* annual materialize chunks */ SELECT * FROM annual_archive_chunks WHERE snapshot_id=? ORDER BY chunk_index",snapshot).toArray();
    archiveAssert(row.logical_scope===identity.logical_scope&&row.team_id===this.context.team_id&&row.kind===identity.kind&&row.season_id===identity.season_id&&
      row.practice_id===identity.practice_id&&row.binding_version===identity.binding_version&&row.backend_generation===this.context.backend_generation&&
      row.writer_epoch===this.context.writer_epoch&&row.format===ARCHIVE_FORMAT,"OWNERSHIP_CHANGED");
    archiveAssert(row.status==="CAPTURED"||row.status==="LOCAL_DIGEST_READY","saved_state");
    const base=json(row.canonical_plan_text),metadata=json(row.metadata_text),proof=json(row.capture_proof_text);
    archiveAssert(archiveCanonical(base)===row.canonical_plan_text&&archiveCanonical(metadata)===row.metadata_text&&archiveCanonical(proof)===row.capture_proof_text,"saved_canonical");
    archiveAssert(base.format===ARCHIVE_FORMAT&&base.snapshot_id===snapshot&&base.request_id===row.first_request_id&&base.kind===row.kind&&base.archive_year===row.archive_year&&
      base.state==="LOCAL_PLAN_ONLY"&&base.source_status==="SOURCE_NOT_YET_VERIFIED"&&base.metadata_text===row.metadata_text&&base.record_count===row.record_count&&
      metadata.snapshot_id===snapshot&&metadata.team_id===row.team_id&&metadata.season_id===row.season_id&&metadata.practice_id===row.practice_id&&metadata.kind===row.kind&&
      metadata.binding_version===row.binding_version&&metadata.backend_generation===row.backend_generation&&metadata.writer_epoch===row.writer_epoch&&
      metadata.captured_at===row.captured_at&&metadata.cutoff_at===row.cutoff_at&&metadata.archive_year===row.archive_year&&metadata.source_status==="SOURCE_NOT_YET_VERIFIED"&&
      proof.format==="annual-capture-proof-v1"&&proof.captured_at===row.captured_at&&proof.actual_input_bytes===row.input_bytes,"saved_identity");
    archiveAssert(safe(row.record_count,ARCHIVE_LIMITS.records)&&safe(row.chunk_count,ARCHIVE_LIMITS.records)&&row.chunk_count===chunks.length&&
      safe(row.input_bytes,ARCHIVE_LIMITS.input_bytes)&&Array.isArray(base.chunks)&&base.chunks.length===chunks.length,"saved_counts");
    let offset=0;
    for(const [index,chunk] of chunks.entries()){
      archiveAssert(chunk.chunk_index===index&&chunk.row_offset===offset&&safe(chunk.row_count,ARCHIVE_LIMITS.chunk_records)&&Number(chunk.row_count)>0&&
        chunk.utf8_bytes===utf8Bytes(String(chunk.payload_text)),"saved_chunks");
      const payload=json(chunk.payload_text);
      archiveAssert(archiveCanonical(payload)===chunk.payload_text&&payload.format===ARCHIVE_FORMAT&&payload.snapshot_id===snapshot&&payload.chunk_index===index&&
        payload.row_offset===offset&&Array.isArray(payload.records)&&payload.records.length===chunk.row_count,"saved_chunks");
      archiveAssert(equal(base.chunks[index],{chunk_index:index,row_offset:offset,row_count:chunk.row_count,payload_text:chunk.payload_text,utf8_bytes:chunk.utf8_bytes}),"saved_chunks");
      archiveAssert(row.status==="CAPTURED"?chunk.payload_digest===null:typeof chunk.payload_digest==="string","saved_digest_state");offset+=Number(chunk.row_count);
    }
    archiveAssert(offset===row.record_count,"saved_counts");
    const original=json(row.command_text);
    archiveAssert(original.actor_scope===row.actor_scope&&original.team_id===row.team_id&&original.format===row.format&&original.kind===row.kind&&
      original.season_id===row.season_id&&original.practice_id===row.practice_id&&original.binding_version===row.binding_version&&
      original.backend_generation===row.backend_generation&&original.writer_epoch===row.writer_epoch,"saved_identity");
    archiveAssert(sql.exec<{count:number}>(`SELECT COUNT(*) count FROM annual_archive_requests WHERE request_key=? AND actor_scope=? AND request_id=?
      AND snapshot_id=? AND command_text=? AND command_digest=?`,row.first_request_key,row.actor_scope,row.first_request_id,row.snapshot_id,
      row.command_text,row.command_digest).one().count===1,"saved_original_pin");
    archiveAssert(row.status==="CAPTURED"?(row.manifest_text===null&&row.content_digest===null&&row.completed_at===null&&pin.saved_result_text===null):
      typeof row.manifest_text==="string"&&typeof row.content_digest==="string"&&typeof row.completed_at==="string","saved_digest_state");
    if(pin.saved_result_text!==null)archiveAssert(pin.saved_result_text===this.resultText(identity,row),"saved_result");
    return {row,pin,chunks,plan:{...base,canonical_text:String(row.canonical_plan_text)} as unknown as ArchivePlan,proof:proof as unknown as ArchiveCaptureProof};
  }
  private resultText(identity:Identity,row:Row):string {
    return archiveCanonical({request_id:identity.request_id,snapshot_id:row.snapshot_id,state:"LOCAL_DIGEST_READY",source_status:"SOURCE_NOT_YET_VERIFIED",
      content_digest:row.content_digest,completed_at:row.completed_at});
  }
  private artifact(saved:Saved):StoredArchiveArtifact {
    return {request_id:String(saved.pin.request_id),state:saved.row.status as StoredArchiveArtifact["state"],plan:saved.plan,proof:saved.proof,
      manifest:saved.row.manifest_text===null?null:json(saved.row.manifest_text),content_digest:saved.row.content_digest===null?null:String(saved.row.content_digest)};
  }
  async capture(raw:unknown):Promise<StoredArchiveArtifact> {
    const identity=await this.identity(raw);
    const saved=this.storage.transactionSync(()=>{
      this.ownership(identity);
      const original=this.pin(identity);if(original)return this.load(identity,original);
      const sql=this.storage.sql;
      const scope=sql.exec<{snapshot_id:string|null;bytes:number}>(`SELECT CASE WHEN length(snapshot_id)<=128 THEN snapshot_id ELSE NULL END snapshot_id,
        LENGTH(CAST(snapshot_id AS BLOB)) bytes FROM annual_archive_plans WHERE logical_scope=?`,identity.logical_scope).toArray()[0];
      if(scope){archiveAssert(typeof scope.snapshot_id==="string"&&safe(scope.bytes,128),"saved_identity");
        // Alias identity is verified against saved artifact before adding its pin, never against mutable business data.
        const pin:Row={request_key:identity.request_key,actor_scope:this.context.actor_scope,request_id:identity.request_id,command_text:identity.command_text,
          command_digest:identity.command_digest,snapshot_id:scope.snapshot_id,saved_result_text:null,created_at:new Date(this.clock()).toISOString()};
        const artifact=this.load(identity,pin);
        sql.exec("INSERT INTO annual_archive_requests(request_key,actor_scope,request_id,command_text,command_digest,snapshot_id,created_at) VALUES (?,?,?,?,?,?,?)",
          pin.request_key,pin.actor_scope,pin.request_id,pin.command_text,pin.command_digest,pin.snapshot_id,pin.created_at).toArray();return artifact;
      }
      const captured=previewArchiveCapture(this.storage,{request_id:identity.request_id,snapshot_id:identity.snapshot_id,kind:identity.kind,
        season_id:identity.season_id,practice_id:identity.practice_id,binding_version:identity.binding_version},this.context,this.clock);
      const {plan,proof}=captured,metadata=json(plan.metadata_text);
      sql.exec(`INSERT INTO annual_archive_plans(snapshot_id,logical_scope,first_request_key,first_request_id,actor_scope,command_text,command_digest,
        team_id,season_id,practice_id,kind,format,binding_version,backend_generation,writer_epoch,captured_at,cutoff_at,archive_year,status,
        metadata_text,canonical_plan_text,capture_proof_text,record_count,chunk_count,input_bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CAPTURED',?,?,?,?,?,?)`,identity.snapshot_id,identity.logical_scope,identity.request_key,identity.request_id,
        this.context.actor_scope,identity.command_text,identity.command_digest,this.context.team_id,identity.season_id,identity.practice_id,identity.kind,ARCHIVE_FORMAT,
        identity.binding_version,this.context.backend_generation,this.context.writer_epoch,captured.input.captured_at,captured.input.cutoff_at,plan.archive_year,
        plan.metadata_text,plan.canonical_text,archiveCanonical(proof),plan.record_count,plan.chunks.length,proof.actual_input_bytes).toArray();
      for(const chunk of plan.chunks)sql.exec(`INSERT INTO annual_archive_chunks(snapshot_id,chunk_index,row_offset,row_count,payload_text,utf8_bytes)
        VALUES (?,?,?,?,?,?)`,identity.snapshot_id,chunk.chunk_index,chunk.row_offset,chunk.row_count,chunk.payload_text,chunk.utf8_bytes).toArray();
      sql.exec("INSERT INTO annual_archive_requests(request_key,actor_scope,request_id,command_text,command_digest,snapshot_id,created_at) VALUES (?,?,?,?,?,?,?)",
        identity.request_key,this.context.actor_scope,identity.request_id,identity.command_text,identity.command_digest,identity.snapshot_id,String(metadata.captured_at)).toArray();
      return this.load(identity,this.pin(identity)!);
    });
    return saved.row.status==="LOCAL_DIGEST_READY"?this.finalize(raw):this.artifact(saved);
  }
  async resume(raw:unknown):Promise<StoredArchiveArtifact> { return this.finalize(raw); }
  async finalize(raw:unknown):Promise<StoredArchiveArtifact> {
    const identity=await this.identity(raw),saved=this.storage.transactionSync(()=>{
      const pin=this.pin(identity);archiveAssert(pin,"ARCHIVE_NOT_CAPTURED");return this.load(identity,pin);
    });
    const hash=async(text:string)=>`sha256_v1:${await this.digest(text)}`;
    archiveAssert(await hash(String(saved.row.command_text))===saved.row.command_digest,"saved_command_digest");
    const descriptors:Array<{chunk_index:SqlStorageValue;row_offset:SqlStorageValue;row_count:SqlStorageValue;utf8_bytes:SqlStorageValue;payload_digest:string}>=[];
    for(const chunk of saved.chunks)descriptors.push({chunk_index:chunk.chunk_index,row_offset:chunk.row_offset,row_count:chunk.row_count,
      utf8_bytes:chunk.utf8_bytes,payload_digest:await hash(String(chunk.payload_text))});
    const core={format:"annual-local-manifest-v1",snapshot_id:saved.row.snapshot_id,plan_format:ARCHIVE_FORMAT,
      metadata_digest:await hash(String(saved.row.metadata_text)),canonical_plan_digest:await hash(String(saved.row.canonical_plan_text)),
      capture_proof_digest:await hash(String(saved.row.capture_proof_text)),captured_at:saved.row.captured_at,cutoff_at:saved.row.cutoff_at,
      record_count:saved.row.record_count,chunk_count:saved.row.chunk_count,input_bytes:saved.row.input_bytes,
      source_status:"SOURCE_NOT_YET_VERIFIED",chunks:descriptors};
    const content_digest=await hash(archiveCanonical(core)),manifest_text=archiveCanonical({...core,content_digest});
    archiveAssert(utf8Bytes(manifest_text)<=ARCHIVE_LIMITS.total_bytes,"saved_resource");
    return this.storage.transactionSync(()=>{
      const pin=this.pin(identity);archiveAssert(pin,"ARCHIVE_NOT_CAPTURED");const current=this.load(identity,pin);
      const stable=(row:Row)=>Object.fromEntries(Object.entries(row).filter(([key])=>!["status","manifest_text","content_digest","completed_at"].includes(key)));
      const stableChunks=(chunks:Row[])=>chunks.map(({payload_digest,...row})=>row);
      archiveAssert(equal(stable(current.row),stable(saved.row))&&equal(stableChunks(current.chunks),stableChunks(saved.chunks)),"ARCHIVE_CONTENT_CHANGED");
      archiveAssert(current.pin.command_text===saved.pin.command_text&&current.pin.command_digest===saved.pin.command_digest&&
        current.pin.snapshot_id===saved.pin.snapshot_id&&current.pin.created_at===saved.pin.created_at,"ARCHIVE_CONTENT_CHANGED");
      const stablePin=({saved_result_text,...row}:Row)=>row;
      archiveAssert(equal(stablePin(current.pin),stablePin(saved.pin)),"ARCHIVE_CONTENT_CHANGED");
      if(saved.row.status==="LOCAL_DIGEST_READY")archiveAssert(equal(current.row,saved.row)&&equal(current.chunks,saved.chunks)&&
        equal(current.pin,saved.pin),"ARCHIVE_CONTENT_CHANGED");
      const sql=this.storage.sql;
      if(current.row.status==="LOCAL_DIGEST_READY"){
        archiveAssert(current.row.manifest_text===manifest_text&&current.row.content_digest===content_digest&&
          current.chunks.every((chunk,index)=>chunk.payload_digest===descriptors[index].payload_digest),"ARCHIVE_CONTENT_CHANGED");
      }else{
        archiveAssert(current.pin.saved_result_text===null,"ARCHIVE_CONTENT_CHANGED");
        for(const descriptor of descriptors)sql.exec("UPDATE annual_archive_chunks SET payload_digest=? WHERE snapshot_id=? AND chunk_index=?",
          descriptor.payload_digest,current.row.snapshot_id,descriptor.chunk_index).toArray();
        const completed_at=new Date(this.clock()).toISOString();
        sql.exec("UPDATE annual_archive_plans SET status='LOCAL_DIGEST_READY',manifest_text=?,content_digest=?,completed_at=? WHERE snapshot_id=?",
          manifest_text,content_digest,completed_at,current.row.snapshot_id).toArray();
        current.row={...current.row,status:"LOCAL_DIGEST_READY",manifest_text,content_digest,completed_at};
      }
      const result=this.resultText(identity,current.row);
      archiveAssert(current.pin.saved_result_text===null||current.pin.saved_result_text===result,"ARCHIVE_CONTENT_CHANGED");
      if(current.pin.saved_result_text===null)sql.exec("UPDATE annual_archive_requests SET saved_result_text=? WHERE request_key=?",result,identity.request_key).toArray();
      return this.artifact(this.load(identity,this.pin(identity)!));
    });
  }
}
