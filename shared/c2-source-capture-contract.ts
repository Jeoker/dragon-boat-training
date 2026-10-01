// Private, pure source model. No runtime, Google, persistence, receipt or public DTO imports.
export const SOURCE_FORMAT = "c2-source-plan-v1";
export const SOURCE_LIMITS = Object.freeze({ input_bytes:2_000_000,total_bytes:2_000_000,records:5000,
  cells:50_000,depth:32,record_bytes:64_000,chunk_bytes:64_000,chunk_records:100 });
export type SourceJson = null|boolean|number|string|SourceJson[]|{[key:string]:SourceJson};
export type SourceObject = {[key:string]:SourceJson};
export class SourceModelError extends Error {
  constructor(readonly code:string){super("Source input is unsupported or inconsistent.");this.name="SourceModelError";}
}
export function sourceAssert(condition:unknown,code:string):asserts condition { if(!condition)throw new SourceModelError(code); }
export const sourceBytes=(text:string)=>new TextEncoder().encode(text).length;
function unicode(text:string){sourceAssert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text),"INVALID_UNICODE");}
export function sourceCanonical(value:SourceJson):string {
  const ancestors=new Set<object>();
  const write=(node:SourceJson,depth:number):string=>{
    // Raw depth is proven at 32 by the scanner; allow bounded generated control wrappers here.
    sourceAssert(depth<=SOURCE_LIMITS.depth+8,"DEPTH_EXCEEDED");
    if(node===null||typeof node==="boolean")return JSON.stringify(node);
    if(typeof node==="number"){sourceAssert(Number.isFinite(node),"NONFINITE_NUMBER");return JSON.stringify(node);}
    if(typeof node==="string"){unicode(node);return JSON.stringify(node);}
    sourceAssert(node&&typeof node==="object"&&(Array.isArray(node)||Object.getPrototypeOf(node)===Object.prototype),"INVALID_JSON_VALUE");
    sourceAssert(!ancestors.has(node)&&Object.getOwnPropertySymbols(node).length===0,"INVALID_JSON_VALUE");ancestors.add(node);
    const keys=Object.keys(node);sourceAssert(Object.getOwnPropertyNames(node).length===keys.length+(Array.isArray(node)?1:0),"INVALID_JSON_VALUE");
    for(const key of keys)sourceAssert(Object.hasOwn(Object.getOwnPropertyDescriptor(node,key)!,"value"),"INVALID_JSON_VALUE");
    let result:string;
    if(Array.isArray(node)){sourceAssert(keys.length===node.length&&keys.every((key,index)=>key===String(index)),"SPARSE_OR_EXTENDED_ARRAY");
      result=`[${node.map(entry=>write(entry,depth+1)).join(",")}]`;}
    else result=`{${keys.sort().map(key=>`${write(key,depth+1)}:${write(node[key],depth+1)}`).join(",")}}`;
    ancestors.delete(node);return result;
  };return write(value,0);
}

/** Check bytes/depth/decoded duplicate keys before JSON.parse can discard any field. */
export function parseSourceJson(text:unknown):SourceJson {
  return parseSourceJsonWithDepth(text, SOURCE_LIMITS.depth);
}

/** Generated wrappers have a separate fixed budget; the raw entry point remains depth 32. */
export function parseGeneratedSourceJson(text:unknown):SourceJson {
  return parseSourceJsonWithDepth(text, SOURCE_LIMITS.depth + 8);
}

function parseSourceJsonWithDepth(text:unknown,maxDepth:number):SourceJson {
  sourceAssert(typeof text==="string","RAW_JSON_REQUIRED");
  sourceAssert(text.length<=SOURCE_LIMITS.input_bytes&&sourceBytes(text)<=SOURCE_LIMITS.input_bytes,"INPUT_BYTES_EXCEEDED");
  let at=0;
  const whitespace=()=>{while(at<text.length&&/[\t\r\n ]/u.test(text[at]))at++;};
  const tokenString=():string=>{
    sourceAssert(text[at]==='"',"INVALID_JSON");const start=at++;
    while(at<text.length){const c=text[at++];if(c==='"'){
      let value:string;try{value=JSON.parse(text.slice(start,at));}catch{throw new SourceModelError("INVALID_JSON");}
      unicode(value);return value;
    }if(c==='\\'){sourceAssert(at<text.length,"INVALID_JSON");at++;}}
    throw new SourceModelError("INVALID_JSON");
  };
  const value=(depth:number):void=>{
    whitespace();sourceAssert(at<text.length,"INVALID_JSON");const c=text[at];
    if(c==="{"||c==="["){
      sourceAssert(depth<maxDepth,"DEPTH_EXCEEDED");at++;whitespace();const close=c==="{"?"}":"]";
      if(text[at]===close){at++;return;}const keys=new Set<string>();
      while(true){if(c==="{"){whitespace();const key=tokenString();sourceAssert(!keys.has(key),"DUPLICATE_JSON_KEY");keys.add(key);
        whitespace();sourceAssert(text[at++]===':',"INVALID_JSON");}
        value(depth+1);whitespace();if(text[at]===close){at++;return;}
        sourceAssert(text[at++]===',',"INVALID_JSON");
      }
    }
    if(c==='"'){tokenString();return;}
    const remaining=text.slice(at),literal=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(remaining);
    sourceAssert(literal,"INVALID_JSON");at+=literal[0].length;
  };
  value(0);whitespace();sourceAssert(at===text.length,"INVALID_JSON");
  let parsed:SourceJson;try{parsed=JSON.parse(text);}catch{throw new SourceModelError("INVALID_JSON");}
  // The lexical scan guarantees bounded nesting; this also rejects JSON numeric overflow.
  sourceCanonical(parsed);return parsed;
}
export function sourceObject(value:SourceJson):SourceObject {
  sourceAssert(value!==null&&!Array.isArray(value)&&typeof value==="object"&&Object.getPrototypeOf(value)===Object.prototype,"OBJECT_REQUIRED");
  const descriptors=Object.getOwnPropertyDescriptors(value);
  sourceAssert(Object.getOwnPropertySymbols(value).length===0&&Object.values(descriptors).every(entry=>entry.enumerable&&Object.hasOwn(entry,"value")),"INVALID_JSON_VALUE");return value;
}
export function sourceArray(value:SourceJson):SourceJson[] { sourceAssert(Array.isArray(value),"ARRAY_REQUIRED");return value; }
export function sourceText(value:SourceJson,min=0,max:number=SOURCE_LIMITS.record_bytes):string {
  sourceAssert(typeof value==="string","STRING_REQUIRED");
  // UTF8 bytes are never fewer than UTF16 code units. Reject clearly oversized
  // dependency strings before scanning Unicode or allocating an encoded copy.
  sourceAssert(value.length>=min&&value.length<=max,"STRING_BOUNDS");
  unicode(value);sourceAssert(sourceBytes(value)<=max,"STRING_BOUNDS");return value;
}
export function sourceInteger(value:SourceJson,min=0,max=Number.MAX_SAFE_INTEGER):number {
  sourceAssert(typeof value==="number"&&Number.isSafeInteger(value)&&value>=min&&value<=max,"INTEGER_BOUNDS");return value;
}
export function exactSourceKeys(row:SourceObject,keys:string[]){sourceAssert(Object.keys(row).every(key=>keys.includes(key)),"UNEXPECTED_INPUT_FIELD");}
const has=(row:SourceObject,key:string)=>Object.hasOwn(row,key);
const bool=(value:SourceJson)=>sourceAssert(typeof value==="boolean","BOOLEAN_REQUIRED");
const fieldsKnown=(row:SourceObject,keys:string[])=>Object.keys(row).every(key=>keys.includes(key));
const optionalText=(row:SourceObject,keys:string[])=>{for(const key of keys)if(has(row,key))sourceText(row[key]);};
const optionalBool=(row:SourceObject,keys:string[])=>{for(const key of keys)if(has(row,key))bool(row[key]);};

/** Exact nanoseconds from RFC3339; keep the original text separately. No Sheet serial conversion. */
export function sourceInstant(text:string):bigint {
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(text);
  sourceAssert(m,"INVALID_TIMESTAMP");const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
  const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  sourceAssert(year>=1&&month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<=23&&minute<=59&&second<=59,"INVALID_TIMESTAMP");
  if(m[8]!=="Z")sourceAssert(m[8]!=="-00:00"&&Number(m[8].slice(1,3))<=23&&Number(m[8].slice(4))<=59,"INVALID_TIMESTAMP");
  const milliseconds=Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[8]}`);
  sourceAssert(Number.isSafeInteger(milliseconds)&&milliseconds>=Date.parse("0001-01-01T00:00:00Z")&&milliseconds<=Date.parse("9999-12-31T23:59:59Z"),"INVALID_TIMESTAMP");
  return BigInt(milliseconds)*1_000_000n+BigInt((m[7]??"").padEnd(9,"0"));
}

export interface SourcePinnedContext {
  source_operation_id:string;team_id:string;season_id:string;binding_version:number;backend_generation:string;writer_epoch:number;
  form_id:string;spreadsheet_id:string;sheet_id:number;season_ends_at:string;
}
export interface ParsedSourceInput {
  pinned:SourcePinnedContext;raw:SourceObject;form_schema:SourceObject;form_responses:SourceObject[];
  sheet_schema:SourceObject;sheet_rows:SourceObject[];known_sources:SourceObject[];declared_mappings:SourceObject[];
  schema_supported:boolean;question_ids:Set<string>;input_bytes:number;
}

export function sourcePinnedContext(value: unknown): SourcePinnedContext {
  const fields = ["source_operation_id", "team_id", "season_id", "binding_version", "backend_generation",
    "writer_epoch", "form_id", "spreadsheet_id", "sheet_id", "season_ends_at"];
  sourceAssert(value !== null && typeof value === "object", "OBJECT_REQUIRED");
  let prototype: object | null, keys: PropertyKey[], array: boolean;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch { throw new SourceModelError("INVALID_JSON_VALUE"); }
  sourceAssert(!array && prototype === Object.prototype, "OBJECT_REQUIRED");
  sourceAssert(keys.length <= fields.length && keys.every(key => typeof key === "string" && fields.includes(key)),
    "UNEXPECTED_INPUT_FIELD");
  const row: SourceObject = {};
  for (const key of keys as string[]) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { throw new SourceModelError("INVALID_JSON_VALUE"); }
    sourceAssert(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value"), "INVALID_JSON_VALUE");
    const entry = descriptor.value;
    // A fixed primitive copy prevents getter/toJSON execution and a second read
    // of mutable caller properties. Bound strings before UTF8 allocation below.
    sourceAssert(typeof entry !== "string" || entry.length <= 512, "STRING_BOUNDS");
    row[key] = entry;
  }
  const pinned = {
    source_operation_id: sourceText(row.source_operation_id, 1, 512),
    team_id: sourceText(row.team_id, 1, 512),
    season_id: sourceText(row.season_id, 1, 512),
    binding_version: sourceInteger(row.binding_version, 1),
    backend_generation: sourceText(row.backend_generation, 1, 512),
    writer_epoch: sourceInteger(row.writer_epoch),
    form_id: sourceText(row.form_id, 1, 512),
    spreadsheet_id: sourceText(row.spreadsheet_id, 1, 512),
    sheet_id: sourceInteger(row.sheet_id),
    season_ends_at: sourceText(row.season_ends_at, 1),
  };
  sourceInstant(pinned.season_ends_at);
  return pinned;
}

export function sourceSheetCoverage(schema: SourceObject, rows: SourceObject[], pinned: SourcePinnedContext) {
  sourceAssert(schema.spreadsheetId === pinned.spreadsheet_id && schema.sheetId === pinned.sheet_id,
    "SOURCE_IDENTITY_MISMATCH");
  sourceText(schema.title);
  sourceText(schema.locale, 1);
  sourceText(schema.timeZone, 1);
  const rowCount = sourceInteger(schema.rowCount, 1, SOURCE_LIMITS.records);
  const columnCount = sourceInteger(schema.columnCount, 1, SOURCE_LIMITS.cells);
  sourceAssert(sourceInteger(schema.headerRowIndex) === 0, "HEADER_POSITION_UNSUPPORTED");
  sourceAssert(rowCount * columnCount <= SOURCE_LIMITS.cells, "CELL_COUNT_EXCEEDED");
  sourceAssert(sourceArray(schema.headers).length === columnCount && rows.length === rowCount - 1,
    "SHEET_COVERAGE_INCOMPLETE");
  for (const [index, row] of rows.entries()) {
    sourceAssert(sourceInteger(row.row_index, 1) === index + 1 && sourceArray(row.cells).length === columnCount,
      "SHEET_COVERAGE_INCOMPLETE");
  }
  return { rowCount, columnCount };
}

export function sourceResponseIdentity(row: SourceObject, pinned: SourcePinnedContext, observedEnd: bigint) {
  const id = sourceText(row.responseId, 1, 512);
  sourceAssert(!has(row, "formId") || row.formId === pinned.form_id, "SOURCE_IDENTITY_MISMATCH");
  sourceAssert(sourceInstant(sourceText(row.lastSubmittedTime, 1)) <= observedEnd, "RESPONSE_AFTER_OBSERVATION");
  return id;
}

export function sourceKnownSources(rows: SourceObject[], pinned: SourcePinnedContext): void {
  const known = new Set<string>();
  for (const row of rows) {
    const type = sourceText(row.kind, 1);
    const allowed = type === "FORM_RESPONSE" ? ["kind", "form_id", "response_id", "status"] :
      type === "LEGACY_ROW" ? ["kind", "source_key", "status"] :
        type === "UNMAPPED_MEMBER" ? ["kind", "member_id"] : [];
    sourceAssert(allowed.length > 0, "CENSUS_KIND_UNSUPPORTED");
    exactSourceKeys(row, allowed);
    if (type !== "UNMAPPED_MEMBER") {
      sourceAssert(row.status === "IMPORTED" || row.status === "REVIEW_REQUIRED", "CENSUS_STATUS_INVALID");
    }
    if (type === "FORM_RESPONSE") sourceAssert(row.form_id === pinned.form_id, "SOURCE_IDENTITY_MISMATCH");
    const keyField = type === "FORM_RESPONSE" ? "response_id" : type === "LEGACY_ROW" ? "source_key" : "member_id";
    const id = sourceText(row[keyField], 1, 512);
    const key = sourceCanonical([type, id]);
    sourceAssert(!known.has(key), "DUPLICATE_CENSUS_ID");
    known.add(key);
  }
}

export function sourceDeclaredMappings(mappings: SourceObject[], rowCount: number): void {
  const rows = new Set<number>();
  const ids = new Set<string>();
  for (const mapping of mappings) {
    exactSourceKeys(mapping, ["state", "row_index", "response_id", "evidence_id"]);
    sourceAssert(mapping.state === "DECLARED_ONLY", "MAPPING_STATE_INVALID");
    const row = sourceInteger(mapping.row_index, 1, rowCount - 1);
    const id = sourceText(mapping.response_id, 1, 512);
    sourceText(mapping.evidence_id, 1, 512);
    sourceAssert(!rows.has(row) && !ids.has(id), "DUPLICATE_DECLARED_MAPPING");
    rows.add(row);
    ids.add(id);
  }
}

// A deliberately explicit supported schema. Unhandled image/video/grading/format constructs stay complete in pending.
export function sourceFormSchema(schema:SourceObject):{supported:boolean;questions:Set<string>} {
  let supported=fieldsKnown(schema,["formId","info","settings","items","revisionId","responderUri","linkedSheetId","publishSettings"]);
  sourceText(schema.formId,1,512);optionalText(schema,["revisionId","responderUri","linkedSheetId"]);
  const info=sourceObject(schema.info);supported=fieldsKnown(info,["title","description","documentTitle"])&&supported;
  sourceText(info.title);optionalText(info,["description","documentTitle"]);
  if(has(schema,"settings")){const settings=sourceObject(schema.settings);supported=fieldsKnown(settings,["quizSettings","emailCollectionType"])&&supported;
    if(has(settings,"emailCollectionType"))supported=["EMAIL_COLLECTION_TYPE_UNSPECIFIED","DO_NOT_COLLECT","VERIFIED","RESPONDER_INPUT"].includes(sourceText(settings.emailCollectionType))&&supported;
    if(has(settings,"quizSettings")){const quiz=sourceObject(settings.quizSettings);supported=fieldsKnown(quiz,["isQuiz"])&&supported;optionalBool(quiz,["isQuiz"]);}}
  if(has(schema,"publishSettings")){const settings=sourceObject(schema.publishSettings);supported=fieldsKnown(settings,["publishState"])&&supported;
    const state=sourceObject(settings.publishState);supported=fieldsKnown(state,["isPublished","isAcceptingResponses"])&&supported;optionalBool(state,["isPublished","isAcceptingResponses"]);}
  const questions=new Set<string>(),items=new Set<string>();
  const question=(raw:SourceJson)=>{
    const q=sourceObject(raw),id=sourceText(q.questionId,1,512);sourceAssert(!questions.has(id),"DUPLICATE_QUESTION_ID");questions.add(id);optionalBool(q,["required"]);
    const types=["textQuestion","choiceQuestion","scaleQuestion","dateQuestion","timeQuestion","fileUploadQuestion","rowQuestion","ratingQuestion"];
    supported=fieldsKnown(q,["questionId","required","grading",...types])&&supported;
    const variants=types.filter(key=>has(q,key));sourceAssert(variants.length===1,"QUESTION_UNION_INVALID");const type=variants[0],detail=sourceObject(q[type]);
    if(has(q,"grading")){sourceObject(q.grading);supported=false;}
    if(type==="textQuestion"){supported=fieldsKnown(detail,["paragraph"])&&supported;optionalBool(detail,["paragraph"]);}
    else if(type==="dateQuestion"){supported=fieldsKnown(detail,["includeTime","includeYear"])&&supported;optionalBool(detail,["includeTime","includeYear"]);}
    else if(type==="timeQuestion"){supported=fieldsKnown(detail,["duration"])&&supported;optionalBool(detail,["duration"]);}
    else if(type==="rowQuestion"){supported=fieldsKnown(detail,["title"])&&supported;sourceText(detail.title);}
    else if(type==="scaleQuestion"){supported=fieldsKnown(detail,["low","high","lowLabel","highLabel"])&&supported;
      if(has(detail,"low"))sourceInteger(detail.low);sourceInteger(detail.high);optionalText(detail,["lowLabel","highLabel"]);}
    else if(type==="choiceQuestion"){
      supported=fieldsKnown(detail,["type","options","shuffle"])&&supported;
      supported=["CHOICE_TYPE_UNSPECIFIED","RADIO","CHECKBOX","DROP_DOWN"].includes(sourceText(detail.type))&&supported;optionalBool(detail,["shuffle"]);
      for(const rawOption of sourceArray(detail.options)){const option=sourceObject(rawOption);
        supported=fieldsKnown(option,["value","isOther","goToAction","goToSectionId"])&&supported;optionalText(option,["value","goToAction","goToSectionId"]);optionalBool(option,["isOther"]);
        if(has(option,"goToAction"))supported=["GO_TO_ACTION_UNSPECIFIED","NEXT_SECTION","RESTART_FORM","SUBMIT_FORM"].includes(String(option.goToAction))&&supported;}
    }else{supported=false;} // Complete file/rating records are retained; this slice makes no attachment/type-completeness claim.
  };
  for(const raw of has(schema,"items")?sourceArray(schema.items):[]){const item=sourceObject(raw),id=sourceText(item.itemId,1,512);
    sourceAssert(!items.has(id),"DUPLICATE_ITEM_ID");items.add(id);optionalText(item,["title","description"]);
    const types=["questionItem","questionGroupItem","pageBreakItem","textItem","imageItem","videoItem"];
    supported=fieldsKnown(item,["itemId","title","description",...types])&&supported;
    const variants=types.filter(key=>has(item,key));sourceAssert(variants.length===1,"ITEM_UNION_INVALID");const type=variants[0],detail=sourceObject(item[type]);
    if(type==="questionItem"){supported=fieldsKnown(detail,["question"])&&supported;question(detail.question);}
    else if(type==="questionGroupItem"){supported=fieldsKnown(detail,["questions","grid"])&&supported;
      for(const q of sourceArray(detail.questions))question(q);if(has(detail,"grid")){sourceObject(detail.grid);supported=false;}}
    else if(type==="pageBreakItem"||type==="textItem")supported=Object.keys(detail).length===0&&supported;
    else supported=false;
  }
  return {supported,questions};
}

export function responseSupported(row:SourceObject,questions:Set<string>):{supported:boolean;attachment:boolean;unknown_question:boolean} {
  let supported=fieldsKnown(row,["formId","responseId","createTime","lastSubmittedTime","respondentEmail","answers","totalScore"]),attachment=false,unknown_question=false;
  sourceText(row.responseId,1,512);sourceInstant(sourceText(row.createTime,1));sourceInstant(sourceText(row.lastSubmittedTime,1));
  sourceAssert(sourceInstant(String(row.createTime))<=sourceInstant(String(row.lastSubmittedTime)),"RESPONSE_TIME_ORDER");
  optionalText(row,["formId","respondentEmail"]);if(has(row,"totalScore"))sourceAssert(typeof row.totalScore==="number"&&Number.isFinite(row.totalScore),"NONFINITE_NUMBER");
  // REST may omit an empty answers map. Preserve absence; do not manufacture answers:{}.
  const answers=has(row,"answers")?sourceObject(row.answers):{};
  for(const [id,raw] of Object.entries(answers)){const answer=sourceObject(raw);sourceAssert(sourceText(answer.questionId,1,512)===id,"ANSWER_QUESTION_MISMATCH");
    unknown_question=!questions.has(id)||unknown_question;supported=fieldsKnown(answer,["questionId","grade","textAnswers","fileUploadAnswers"])&&supported;
    const variants=["textAnswers","fileUploadAnswers"].filter(key=>has(answer,key));sourceAssert(variants.length===1,"ANSWER_UNION_INVALID");
    const content=sourceObject(answer[variants[0]]);supported=fieldsKnown(content,["answers"])&&supported;
    for(const value of has(content,"answers")?sourceArray(content.answers):[]){const entry=sourceObject(value);
      if(variants[0]==="textAnswers"){supported=fieldsKnown(entry,["value"])&&supported;if(has(entry,"value"))sourceText(entry.value,0,SOURCE_LIMITS.record_bytes);}
      else {attachment=true;supported=fieldsKnown(entry,["fileId","fileName","mimeType"])&&supported;
        sourceText(entry.fileId,1,512);sourceText(entry.fileName);sourceText(entry.mimeType);}}
    if(has(answer,"grade")){const grade=sourceObject(answer.grade);supported=fieldsKnown(grade,["score","correct","feedback"])&&supported;
      if(has(grade,"score"))sourceAssert(typeof grade.score==="number"&&Number.isFinite(grade.score),"NONFINITE_NUMBER");optionalBool(grade,["correct"]);
      if(has(grade,"feedback")){sourceObject(grade.feedback);supported=false;}}
  }
  return {supported,attachment,unknown_question};
}

export function parseSourceCaptureInput(text:unknown,context:unknown):ParsedSourceInput {
  const raw=sourceObject(parseSourceJson(text)),pinned=sourcePinnedContext(context);
  const cutoff=sourceInstant(pinned.season_ends_at);
  exactSourceKeys(raw,["format","observed_start_at","observed_end_at","form_schema","form_responses","sheet_schema","sheet_rows","known_sources","declared_mappings"]);
  sourceAssert(raw.format==="c2-source-input-v1","INPUT_FORMAT");const start=sourceInstant(sourceText(raw.observed_start_at,1)),end=sourceInstant(sourceText(raw.observed_end_at,1));
  sourceAssert(start<=end&&end>=cutoff,"OBSERVED_INTERVAL_INVALID");
  const form_schema=sourceObject(raw.form_schema),sheet_schema=sourceObject(raw.sheet_schema);
  sourceAssert(form_schema.formId===pinned.form_id&&(!has(form_schema,"linkedSheetId")||form_schema.linkedSheetId===pinned.spreadsheet_id),"SOURCE_IDENTITY_MISMATCH");
  const arrays=[raw.form_responses,raw.sheet_rows,raw.known_sources,raw.declared_mappings].map(sourceArray);
  sourceAssert(arrays.reduce((total,rows)=>total+rows.length,2)<=SOURCE_LIMITS.records,"RECORD_COUNT_EXCEEDED");
  const [form_responses,sheet_rows,known_sources,declared_mappings]=arrays.map(rows=>rows.map(sourceObject));
  for(const row of [form_schema,sheet_schema,...form_responses,...sheet_rows,...known_sources,...declared_mappings])
    sourceAssert(sourceBytes(sourceCanonical(row))<=SOURCE_LIMITS.record_bytes,"RECORD_BYTES_EXCEEDED");
  const {rowCount}=sourceSheetCoverage(sheet_schema,sheet_rows,pinned);
  const seen=new Set<string>();for(const row of form_responses){const id=sourceText(row.responseId,1,512);sourceAssert(!seen.has(id),"DUPLICATE_RESPONSE_ID");seen.add(id);
    sourceResponseIdentity(row,pinned,end);}
  sourceKnownSources(known_sources,pinned);
  sourceDeclaredMappings(declared_mappings,rowCount);
  const schema=sourceFormSchema(form_schema);
  return {pinned,raw,form_schema,form_responses,sheet_schema,sheet_rows,known_sources,declared_mappings,
    schema_supported:schema.supported,question_ids:schema.questions,input_bytes:sourceBytes(text as string)};
}
