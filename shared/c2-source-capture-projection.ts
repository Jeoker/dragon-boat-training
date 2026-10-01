import { SOURCE_FORMAT,SOURCE_LIMITS,parseSourceCaptureInput,responseSupported,sourceAssert,sourceArray,sourceObject,
  sourceText,sourceInteger,sourceInstant,sourceCanonical,sourceBytes,type SourceJson,type SourceObject } from "./c2-source-capture-contract";

export const SOURCE_NAMESPACES=["FORM_CURRENT","SHEET_CURRENT","EXCLUDED_IDENTITIES","PRIVATE_PENDING","GAP_LEDGER"] as const;
export type SourceNamespace=typeof SOURCE_NAMESPACES[number];
export interface LocalSourceChunk { namespace:SourceNamespace;chunk_index:number;row_offset:number;row_count:number;payload_text:string;utf8_bytes:number; }
export interface LocalSourcePlan {
  format:typeof SOURCE_FORMAT;state:"LOCAL_SOURCE_PLAN_ONLY";source_status:"SOURCE_NOT_VERIFIED";
  metadata_text:string;namespace_counts:Record<SourceNamespace,number>;record_count:number;chunks:LocalSourceChunk[];canonical_text:string;
}
const has=(row:SourceObject,key:string)=>Object.hasOwn(row,key);
const known=(row:SourceObject,keys:string[])=>Object.keys(row).every(key=>keys.includes(key));
const unsafeCell=(cell:SourceJson):boolean=>{
  const row=sourceObject(cell);let unsupported=!known(row,["userEnteredValue","effectiveValue","formattedValue","userEnteredFormat","effectiveFormat","hyperlink","note"]);
  for(const key of ["formattedValue","hyperlink","note"])if(has(row,key))sourceText(row[key],0,SOURCE_LIMITS.record_bytes);
  for(const key of ["userEnteredValue","effectiveValue"]){if(!has(row,key))continue;const value=sourceObject(row[key]);
    const types=["numberValue","stringValue","boolValue","formulaValue","errorValue"],fields=types.filter(type=>has(value,type));
    unsupported=!known(value,types)||unsupported;sourceAssert(fields.length<=1,"CELL_VALUE_UNION_INVALID");
    // Official ExtendedValue allows no populated union field to denote no data. Keep the original {}.
    if(fields.length===0)continue;const type=fields[0];
    if(type==="numberValue")sourceAssert(typeof value[type]==="number"&&Number.isFinite(value[type]),"NONFINITE_NUMBER");
    else if(type==="boolValue")sourceAssert(typeof value[type]==="boolean","BOOLEAN_REQUIRED");
    else if(type==="errorValue"){const error=sourceObject(value[type]);unsupported=!known(error,["type","message"])||unsupported;
      if(has(error,"type")){const errorType=sourceText(error.type,1);unsupported=!["ERROR_TYPE_UNSPECIFIED","ERROR","NULL_VALUE","DIVIDE_BY_ZERO","VALUE","REF","NAME","NUM","N_A","LOADING"].includes(errorType)||unsupported;}
      else unsupported=true; // Do not invent the missing default enum value in the captured raw object.
      if(has(error,"message"))sourceText(error.message,0,SOURCE_LIMITS.record_bytes);}
    else sourceText(value[type],0,SOURCE_LIMITS.record_bytes);
    if(key==="effectiveValue"&&type==="formulaValue")unsupported=true;
  }
  for(const key of ["userEnteredFormat","effectiveFormat"]){if(!has(row,key))continue;const format=sourceObject(row[key]);unsupported=!known(format,["numberFormat"])||unsupported;
    if(has(format,"numberFormat")){const number=sourceObject(format.numberFormat);unsupported=!known(number,["type","pattern"])||unsupported;
      if(has(number,"type")){const type=sourceText(number.type,1);unsupported=!["TEXT","NUMBER","PERCENT","CURRENCY","DATE","TIME","DATE_TIME","SCIENTIFIC"].includes(type)||unsupported;}
      if(has(number,"pattern"))sourceText(number.pattern,0,SOURCE_LIMITS.record_bytes);}}
  return unsupported;
};

/** Pure declarations only. A well-shaped mapping can NEVER promote a Sheet row into annual scope. */
export function buildLocalSourcePlan(rawJsonText:unknown,pinnedContext:unknown):LocalSourcePlan {
  const input=parseSourceCaptureInput(rawJsonText,pinnedContext),cutoff=sourceInstant(input.pinned.season_ends_at);
  const records:Record<SourceNamespace,SourceObject[]>={FORM_CURRENT:[],SHEET_CURRENT:[],EXCLUDED_IDENTITIES:[],PRIVATE_PENDING:[],GAP_LEDGER:[]};
  const add=(namespace:SourceNamespace,record:SourceObject)=>{sourceAssert(sourceBytes(sourceCanonical(record))<=SOURCE_LIMITS.record_bytes,"RECORD_BYTES_EXCEEDED");records[namespace].push(record);};
  const gap=(code:string,identity:SourceObject={},classification="SOURCE_GAP")=>add("GAP_LEDGER",{record_type:"SOURCE_EVIDENCE_CONDITION",classification,code,identity});
  gap("READ_COMPLETENESS_AND_OBSERVATION_UNPROVEN",{},"PROOF_REQUIRED"); // No read/page/range/receipt evidence is manufactured by this pure input model.
  gap("HISTORIC_UNOBSERVED_RESPONSES_NOT_RECOVERABLE",{},"COVERAGE_LIMIT"); // Coverage limit, never a claim that an unknown deletion occurred.
  if(input.schema_supported)add("FORM_CURRENT",{record_type:"FORM_SCHEMA",raw:input.form_schema});
  else {add("PRIVATE_PENDING",{record_type:"FORM_SCHEMA",reasons:["FORM_SCHEMA_UNSUPPORTED"],raw:input.form_schema});gap("FORM_SCHEMA_UNSUPPORTED",{},"UNSUPPORTED");}
  let sheetUnsupported=!known(input.sheet_schema,["spreadsheetId","sheetId","title","locale","timeZone","rowCount","columnCount","headerRowIndex","headers"]);
  for(const cell of sourceArray(input.sheet_schema.headers))sheetUnsupported=unsafeCell(cell)||sheetUnsupported;
  add("PRIVATE_PENDING",{record_type:"SHEET_SCHEMA",reasons:["SHEET_SCOPE_UNPROVEN",...(sheetUnsupported?["SHEET_SCHEMA_UNSUPPORTED"]:[])],raw:input.sheet_schema});
  gap("SHEET_MAPPING_VERIFICATION_NOT_IMPLEMENTED",{},"PROOF_REQUIRED");if(sheetUnsupported)gap("SHEET_SCHEMA_UNSUPPORTED",{},"UNSUPPORTED");
  const responseById=new Map<string,SourceObject>();
  for(const response of input.form_responses){const id=sourceText(response.responseId,1,512),status=responseSupported(response,input.question_ids);
    responseById.set(id,response);
    if(sourceInstant(String(response.createTime))>=cutoff){
      // Unknown late fields cannot be discarded into an identity-only projection: reject the whole input instead.
      sourceAssert(status.supported,"UNSUPPORTED_LATE_RESPONSE");
      add("EXCLUDED_IDENTITIES",{record_type:"FORM_RESPONSE_EXCLUDED",reason:"FIRST_SUBMISSION_NOT_BEFORE_CUTOFF",
        identity:{form_id:input.pinned.form_id,response_id:id,createTime:response.createTime}});continue;
    }
    const reasons=[...(!input.schema_supported?["FORM_SCHEMA_UNSUPPORTED"]:[]),...(!status.supported?["FORM_RESPONSE_UNSUPPORTED"]:[]),
      ...(status.unknown_question?["ANSWER_SCHEMA_UNMATCHABLE"]:[]),...(status.attachment?["ATTACHMENT_CONTENT_NOT_CAPTURED"]:[])];
    if(reasons.length){add("PRIVATE_PENDING",{record_type:"FORM_RESPONSE",identity:{form_id:input.pinned.form_id,response_id:id},reasons,raw:response});
      for(const code of reasons)gap(code,{form_id:input.pinned.form_id,response_id:id},code==="ATTACHMENT_CONTENT_NOT_CAPTURED"?"PROOF_REQUIRED":code==="ANSWER_SCHEMA_UNMATCHABLE"?"SOURCE_GAP":"UNSUPPORTED");}
    else add("FORM_CURRENT",{record_type:"FORM_RESPONSE",raw:response});
  }
  const mappings=new Map(input.declared_mappings.map(row=>[sourceInteger(row.row_index,1),row]));
  for(const row of input.sheet_rows){const rowIndex=sourceInteger(row.row_index,1);let unsupported=!known(row,["row_index","cells"]);
    for(const cell of sourceArray(row.cells))unsupported=unsafeCell(cell)||unsupported;
    const mapping=mappings.get(rowIndex),response=mapping?responseById.get(String(mapping.response_id)):undefined;
    const candidate=response?(sourceInstant(String(response.createTime))<cutoff?"BEFORE_CUTOFF":"AT_OR_AFTER_CUTOFF"):"UNKNOWN";
    add("PRIVATE_PENDING",{record_type:"SHEET_ROW",identity:{spreadsheet_id:input.pinned.spreadsheet_id,sheet_id:input.pinned.sheet_id,row_index:rowIndex},
      reasons:["SHEET_SCOPE_UNPROVEN",...(unsupported?["SHEET_ROW_UNSUPPORTED"]:[])],candidate_submission_scope:candidate,
      mapping_status:"DECLARED_EXTERNAL_EVIDENCE_REQUIRED",declared_mapping:mapping??null,raw:row});
    if(unsupported)gap("SHEET_ROW_UNSUPPORTED",{row_index:rowIndex},"UNSUPPORTED");
    if(mapping&&!response)gap("DECLARED_MAPPING_RESPONSE_NOT_OBSERVED",{row_index:rowIndex,response_id:mapping.response_id});
  }
  for(const source of input.known_sources){
    if(source.kind==="FORM_RESPONSE"){if(!responseById.has(String(source.response_id)))gap("KNOWN_RESPONSE_NOT_OBSERVED",source);}
    else gap(source.kind==="LEGACY_ROW"?"LEGACY_ROW_RESPONSE_UNMATCHABLE":"MEMBER_RESPONSE_UNMATCHABLE",source);
  }
  const namespace_counts=Object.fromEntries(SOURCE_NAMESPACES.map(namespace=>[namespace,records[namespace].length])) as Record<SourceNamespace,number>;
  const record_count=Object.values(namespace_counts).reduce((sum,count)=>sum+count,0);sourceAssert(record_count<=SOURCE_LIMITS.records,"RECORD_COUNT_EXCEEDED");
  const chunks:LocalSourceChunk[]=[];
  for(const namespace of SOURCE_NAMESPACES){let offset=0;while(offset<records[namespace].length){const block:SourceObject[]=[],index=chunks.filter(chunk=>chunk.namespace===namespace).length;
    const payload=(rows:SourceObject[])=>({format:SOURCE_FORMAT,source_operation_id:input.pinned.source_operation_id,namespace,chunk_index:index,row_offset:offset,records:rows});
    while(offset+block.length<records[namespace].length&&block.length<SOURCE_LIMITS.chunk_records){
      const candidate=[...block,records[namespace][offset+block.length]],text=sourceCanonical(payload(candidate));
      if(sourceBytes(text)>SOURCE_LIMITS.chunk_bytes)break;block.push(candidate[candidate.length-1]);}
    sourceAssert(block.length>0,"CHUNK_BYTES_EXCEEDED");const payload_text=sourceCanonical(payload(block));
    chunks.push({namespace,chunk_index:index,row_offset:offset,row_count:block.length,payload_text,utf8_bytes:sourceBytes(payload_text)});offset+=block.length;
  }}
  const metadata_text=sourceCanonical({format:SOURCE_FORMAT,pinned_context:input.pinned as unknown as SourceJson,
    submission_cutoff_at:input.pinned.season_ends_at,observed_start_at:input.raw.observed_start_at,observed_end_at:input.raw.observed_end_at,
    observation_status:"INPUT_DECLARATIONS_ONLY",mapping_status:"DECLARED_EXTERNAL_EVIDENCE_REQUIRED",known_sources:input.known_sources,
    input_bytes:input.input_bytes,numeric_model:"FINITE_IEEE754_JSON_ALREADY_PARSED_MINUS_ZERO_CANONICAL_ZERO",
    historical_coverage:"CURRENT_ACCESSIBLE_DECLARED_INPUT_AND_KNOWN_CENSUS_ONLY",sheet_archive_eligible_rows:0,
    evidence_condition_counts:Object.fromEntries(["SOURCE_GAP","UNSUPPORTED","PROOF_REQUIRED","COVERAGE_LIMIT"].map(category=>
      [category,records.GAP_LEDGER.filter(row=>row.classification===category).length]))});
  const core={format:SOURCE_FORMAT as typeof SOURCE_FORMAT,state:"LOCAL_SOURCE_PLAN_ONLY" as const,source_status:"SOURCE_NOT_VERIFIED" as const,metadata_text,namespace_counts,record_count,chunks};
  const canonical_text=sourceCanonical(core as unknown as SourceJson);sourceAssert(sourceBytes(canonical_text)<=SOURCE_LIMITS.total_bytes,"TOTAL_BYTES_EXCEEDED");
  return {...core,canonical_text};
}
