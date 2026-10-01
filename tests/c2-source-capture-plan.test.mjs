import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";

const modules=new Map();
function moduleUrl(url){if(modules.has(url.href))return modules.get(url.href);
  let code=ts.transpileModule(readFileSync(url,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  code=code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu,(_,start,path,end)=>start+moduleUrl(new URL(path.endsWith(".ts")?path:`${path}.ts`,url))+end);
  const result=`data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${url.href}`).toString("base64")}`;modules.set(url.href,result);return result;
}
const {parseSourceJson,sourceCanonical,sourceInstant,SourceModelError,SOURCE_LIMITS}=await import(moduleUrl(new URL("../shared/c2-source-capture-contract.ts",import.meta.url)));
const {buildLocalSourcePlan,SOURCE_NAMESPACES}=await import(moduleUrl(new URL("../shared/c2-source-capture-projection.ts",import.meta.url)));
const clone=value=>structuredClone(value);
const pinned={source_operation_id:"local_source_operation",team_id:"local_team",season_id:"local_season",binding_version:1,backend_generation:"local_generation",writer_epoch:0,
  form_id:"local_form",spreadsheet_id:"local_spreadsheet",sheet_id:7,season_ends_at:"2026-10-01T04:00:00Z"};
const text=value=>({userEnteredValue:{stringValue:value},effectiveValue:{stringValue:value},formattedValue:value});
const response=(id,at,value="Current 😀 answer")=>({responseId:id,createTime:at,lastSubmittedTime:"2026-10-01T04:01:00Z",respondentEmail:"fictional@example.invalid",
  answers:{q_name:{questionId:"q_name",textAnswers:{answers:[{value}]}}}});
function fixture(){return {format:"c2-source-input-v1",observed_start_at:"2026-10-01T04:01:00Z",observed_end_at:"2026-10-01T04:02:00Z",
  form_schema:{formId:pinned.form_id,linkedSheetId:pinned.spreadsheet_id,revisionId:"local_revision",info:{title:"完整源 😀",description:"Private only"},
    settings:{emailCollectionType:"DO_NOT_COLLECT",quizSettings:{isQuiz:false}},items:[{itemId:"item_1",title:"Name",questionItem:{question:{questionId:"q_name",required:true,textQuestion:{paragraph:false}}}}]},
  form_responses:[response("response_early","2026-09-30T12:00:00Z")],
  sheet_schema:{spreadsheetId:pinned.spreadsheet_id,sheetId:pinned.sheet_id,title:"Responses",locale:"en_US",timeZone:"America/New_York",rowCount:3,columnCount:3,headerRowIndex:0,
    headers:[text("Timestamp"),text("Name"),text("Value")]},
  sheet_rows:[{row_index:1,cells:[{userEnteredValue:{numberValue:46296.541666666664},effectiveValue:{numberValue:46296.541666666664},formattedValue:"9/30/2026 13:00:00",
    userEnteredFormat:{numberFormat:{type:"DATE_TIME",pattern:"m/d/yyyy hh:mm:ss"}}},text("Sheet edited name"),{}]},
    {row_index:2,cells:[{},text("Unmapped row"),{userEnteredValue:{formulaValue:'=HYPERLINK("https://example.invalid","literal")'},effectiveValue:{errorValue:{type:"REF",message:"local error"}},formattedValue:"#REF!"}]}],
  known_sources:[{kind:"FORM_RESPONSE",form_id:pinned.form_id,response_id:"response_early",status:"IMPORTED"},
    {kind:"FORM_RESPONSE",form_id:pinned.form_id,response_id:"known_missing",status:"REVIEW_REQUIRED"}],
  declared_mappings:[{state:"DECLARED_ONLY",row_index:1,response_id:"response_early",evidence_id:"unproved_local_declaration"}]};}
const plan=(value=fixture(),context=pinned)=>buildLocalSourcePlan(JSON.stringify(value),context);
function rows(artifact,namespace){return artifact.chunks.filter(chunk=>chunk.namespace===namespace).flatMap(chunk=>JSON.parse(chunk.payload_text).records);}
const codes=artifact=>rows(artifact,"GAP_LEDGER").map(row=>row.code);
function rejects(fn,code){assert.throws(fn,error=>error instanceof SourceModelError&&error.code===code&&error.message==="Source input is unsupported or inconsistent.");}

test("complete current Form records and declared Sheet rows stay in separate namespaces; no pure source verification",()=>{
  const source=fixture(),artifact=plan(source);
  assert.equal(artifact.state,"LOCAL_SOURCE_PLAN_ONLY");assert.equal(artifact.source_status,"SOURCE_NOT_VERIFIED");
  assert.deepEqual(rows(artifact,"FORM_CURRENT").map(row=>row.raw),[source.form_schema,source.form_responses[0]]);
  assert.equal(artifact.namespace_counts.SHEET_CURRENT,0);assert.equal(rows(artifact,"SHEET_CURRENT").length,0);
  const pending=rows(artifact,"PRIVATE_PENDING");assert.deepEqual(pending.filter(row=>row.record_type==="SHEET_ROW").map(row=>row.raw),source.sheet_rows);
  assert.deepEqual(pending.find(row=>row.record_type==="SHEET_SCHEMA").raw,source.sheet_schema);
  assert.equal(pending[1].candidate_submission_scope,"BEFORE_CUTOFF");assert.equal(pending[1].mapping_status,"DECLARED_EXTERNAL_EVIDENCE_REQUIRED");
  assert.ok(codes(artifact).includes("KNOWN_RESPONSE_NOT_OBSERVED"));assert.ok(codes(artifact).includes("READ_COMPLETENESS_AND_OBSERVATION_UNPROVEN"));
  const conditions=rows(artifact,"GAP_LEDGER");assert.equal(conditions.find(row=>row.code==="HISTORIC_UNOBSERVED_RESPONSES_NOT_RECOVERABLE").classification,"COVERAGE_LIMIT");
  assert.equal(conditions.find(row=>row.code==="READ_COMPLETENESS_AND_OBSERVATION_UNPROVEN").classification,"PROOF_REQUIRED");
  assert.equal(conditions.find(row=>row.code==="KNOWN_RESPONSE_NOT_OBSERVED").classification,"SOURCE_GAP");
  assert.equal(JSON.parse(artifact.metadata_text).submission_cutoff_at,pinned.season_ends_at);
  assert.ok(!artifact.canonical_text.includes('"verified":true'));assert.ok(!Object.hasOwn(artifact,"receipt"));
});
test("cutoff minus one nanosecond qualifies, equality and plus one do not; latest edit may be after cutoff",()=>{
  const source=fixture();source.form_responses=[response("minus","2026-10-01T03:59:59.999999999Z","Latest after cutoff"),
    response("equal","2026-10-01T04:00:00.000000000Z","Late sentinel equal"),response("plus","2026-10-01T04:00:00.000000001Z","Late sentinel plus")];
  const artifact=plan(source);assert.deepEqual(rows(artifact,"FORM_CURRENT").filter(row=>row.record_type==="FORM_RESPONSE").map(row=>row.raw.responseId),["minus"]);
  assert.deepEqual(rows(artifact,"EXCLUDED_IDENTITIES").map(row=>row.identity.response_id),["equal","plus"]);
  assert.ok(!artifact.canonical_text.includes("Late sentinel"));assert.equal(rows(artifact,"FORM_CURRENT")[1].raw.lastSubmittedTime,"2026-10-01T04:01:00Z");
});
test("RFC3339 offsets compare exact instants and preserve original text; invalid civil dates/leaps/unknown offsets reject",()=>{
  assert.equal(sourceInstant("2026-10-01T00:00:00.123456789-04:00"),sourceInstant("2026-10-01T04:00:00.123456789Z"));
  assert.equal(sourceInstant("2026-10-01T09:30:00.123456789+05:30"),sourceInstant("2026-10-01T04:00:00.123456789Z"));
  assert.equal(sourceInstant("2024-02-29T00:00:00Z")+1n,sourceInstant("2024-02-29T00:00:00.000000001Z"));
  for(const value of ["2026-02-29T00:00:00Z","2026-10-01T24:00:00Z","2026-10-01T03:59:60Z","2026-10-01T04:00:00-00:00","2026-10-01T04:00:00.1234567891Z","2026-10-01T04:00:00+24:00"])
    rejects(()=>sourceInstant(value),"INVALID_TIMESTAMP");
  const source=fixture();source.form_responses[0].createTime="2026-09-30T23:59:59.999999999-04:00";
  assert.equal(rows(plan(source),"FORM_CURRENT")[1].raw.createTime,source.form_responses[0].createTime);
});
test("raw object duplicate decoded keys fail before last-value-wins JSON parsing at any level",()=>{
  for(const value of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"outer":{"\\uD83D\\uDE00":1,"😀":2}}','[{"a":null,"a":false}]'])
    rejects(()=>parseSourceJson(value),"DUPLICATE_JSON_KEY");
  assert.deepEqual(parseSourceJson('{"a":1,"nested":{"a":2},"text":"\\\"a\\\":1"}'),{a:1,nested:{a:2},text:'"a":1'});
});
test("raw UTF8 and recursion budgets precede parse; malformed JSON never produces an artifact",()=>{
  rejects(()=>parseSourceJson('"'+"😀".repeat(500_001)+'"'),"INPUT_BYTES_EXCEEDED");
  assert.doesNotThrow(()=>parseSourceJson('['.repeat(32)+'0'+']'.repeat(32)));
  rejects(()=>parseSourceJson('['.repeat(33)+'0'+']'.repeat(33)),"DEPTH_EXCEEDED");
  for(const text of ['{"a":1,}','[1,,2]','{"a":01}','{"a":"\\q"}','{} trailing','NaN',''])rejects(()=>parseSourceJson(text),"INVALID_JSON");
});
test("finite decimal/large IEEE754 values survive; negative zero is explicitly normalized and non-JSON arrays reject",()=>{
  const source=fixture();source.form_responses[0].totalScore=1.25;source.form_responses[0].answers.q_name.grade={score:0.125,correct:false};
  source.sheet_rows[0].cells[2]={userEnteredValue:{numberValue:1e100},effectiveValue:{numberValue:-0},formattedValue:"custom"};
  const artifact=plan(source);assert.equal(rows(artifact,"FORM_CURRENT")[1].raw.answers.q_name.grade.score,0.125);
  assert.equal(rows(artifact,"PRIVATE_PENDING")[1].raw.cells[2].userEnteredValue.numberValue,1e100);
  assert.equal(sourceCanonical(-0),"0");assert.ok(JSON.parse(artifact.metadata_text).numeric_model.includes("MINUS_ZERO_CANONICAL_ZERO"));
  const minusZero=JSON.stringify(source).replace('"effectiveValue":{"numberValue":0}', '"effectiveValue":{"numberValue":-0}');
  assert.ok(minusZero.includes('"numberValue":-0'));assert.equal(rows(buildLocalSourcePlan(minusZero,pinned),"PRIVATE_PENDING")[1].raw.cells[2].effectiveValue.numberValue,0);
  for(const raw of ['1e999','-1e999'])rejects(()=>parseSourceJson(raw),"NONFINITE_NUMBER");
  rejects(()=>sourceCanonical([,1]),"SPARSE_OR_EXTENDED_ARRAY");const disguised=[];disguised.length=1;disguised.extra=1;
  rejects(()=>sourceCanonical(disguised),"SPARSE_OR_EXTENDED_ARRAY");
  for(const value of [NaN,Infinity,-Infinity])rejects(()=>sourceCanonical(value),"NONFINITE_NUMBER");
});
test("emoji is preserved; lone Unicode surrogates and non-JSON values cannot silently turn into replacement characters",()=>{
  assert.equal(parseSourceJson('"\\uD83D\\uDE00"'),"😀");assert.equal(sourceCanonical("😀"),'"😀"');
  for(const value of ['"\\ud800"','"\\udc00"','{"\\ud800":1}'])rejects(()=>parseSourceJson(value),"INVALID_UNICODE");
  rejects(()=>sourceCanonical(undefined),"INVALID_JSON_VALUE");rejects(()=>sourceCanonical(1n),"INVALID_JSON_VALUE");
  const circle={};circle.self=circle;rejects(()=>sourceCanonical(circle),"INVALID_JSON_VALUE");
});
test("unknown response fields and answer constructs retain the entire raw early record in pending",()=>{
  const source=fixture();source.form_responses[0].futureField={complete:["future",1.25,null]};source.form_responses[0].answers.q_name.futureAnswer={secretValue:"must remain"};
  const artifact=plan(source);assert.equal(rows(artifact,"FORM_CURRENT").filter(row=>row.record_type==="FORM_RESPONSE").length,0);
  assert.deepEqual(rows(artifact,"PRIVATE_PENDING").find(row=>row.record_type==="FORM_RESPONSE").raw,source.form_responses[0]);
  assert.ok(codes(artifact).includes("FORM_RESPONSE_UNSUPPORTED"));
  source.form_responses[0].createTime=pinned.season_ends_at;rejects(()=>plan(source),"UNSUPPORTED_LATE_RESPONSE");
  const unknownUnion=fixture();unknownUnion.form_responses[0].answers.q_name={questionId:"q_name",futureAnswers:{complete:["raw"]}};
  rejects(()=>plan(unknownUnion),"ANSWER_UNION_INVALID");
});
test("unknown schema and enums preserve the whole schema plus early responses; no false supported schema",()=>{
  for(const mutate of [source=>source.form_schema.futureSchema={raw:"unknown"},source=>source.form_schema.settings.emailCollectionType="FUTURE_EMAIL",
    source=>source.form_schema.items[0].questionItem.question={questionId:"q_name",choiceQuestion:{type:"FUTURE_CHOICE",options:[{value:"A"}]}},
    source=>source.form_schema.items[0].questionItem.question={questionId:"q_name",choiceQuestion:{type:"RADIO",options:[{value:"A",goToAction:"FUTURE_ACTION"}]}}]){
    const source=fixture();mutate(source);const artifact=plan(source);
    assert.deepEqual(rows(artifact,"PRIVATE_PENDING").find(row=>row.record_type==="FORM_SCHEMA").raw,source.form_schema);
    assert.deepEqual(rows(artifact,"PRIVATE_PENDING").find(row=>row.record_type==="FORM_RESPONSE").raw,source.form_responses[0]);assert.ok(codes(artifact).includes("FORM_SCHEMA_UNSUPPORTED"));
  }
  const unknownQuestion=fixture();unknownQuestion.form_schema.items[0].questionItem.question={questionId:"q_name",futureQuestion:{complete:"raw"}};
  rejects(()=>plan(unknownQuestion),"QUESTION_UNION_INVALID");
  const unknownItem=fixture();unknownItem.form_schema.items[0]={itemId:"item_1",futureItem:{complete:"raw"}};rejects(()=>plan(unknownItem),"ITEM_UNION_INVALID");
});
test("omitted REST defaults/empty maps remain absent; multi-valued answer order and identical titles are preserved",()=>{
  const source=fixture();source.form_schema.items[0].questionItem.question={questionId:"q_name",scaleQuestion:{high:5}};delete source.form_responses[0].answers;
  const artifact=plan(source);assert.ok(!Object.hasOwn(rows(artifact,"FORM_CURRENT")[1].raw,"answers"));
  assert.ok(!Object.hasOwn(rows(artifact,"FORM_CURRENT")[0].raw.items[0].questionItem.question.scaleQuestion,"low"));
  const empty=fixture();empty.form_responses[0].answers.q_name.textAnswers.answers=[{}];assert.deepEqual(rows(plan(empty),"FORM_CURRENT")[1].raw.answers.q_name.textAnswers.answers,[{}]);
  const repeated=fixture();repeated.form_responses[0].answers.q_name.textAnswers={};assert.deepEqual(rows(plan(repeated),"FORM_CURRENT")[1].raw.answers.q_name.textAnswers,{});
  const multi=fixture();multi.form_schema.items[0].questionItem.question={questionId:"q_name",choiceQuestion:{type:"CHECKBOX",options:[{value:"A"},{value:"B"}]}};
  multi.form_responses[0].answers.q_name.textAnswers.answers=[{value:"B"},{value:"A"},{value:"A"}];
  assert.deepEqual(rows(plan(multi),"FORM_CURRENT")[1].raw.answers.q_name.textAnswers.answers,[{value:"B"},{value:"A"},{value:"A"}]);
});
test("unknown/deleted question IDs and file references stay unverified with complete raw records",()=>{
  const unknown=fixture();unknown.form_responses[0].answers={deleted:{questionId:"deleted",textAnswers:{answers:[{value:"Deleted question value"}]}}};
  assert.ok(codes(plan(unknown)).includes("ANSWER_SCHEMA_UNMATCHABLE"));assert.deepEqual(rows(plan(unknown),"PRIVATE_PENDING").find(row=>row.record_type==="FORM_RESPONSE").raw,unknown.form_responses[0]);
  const files=fixture();files.form_responses[0].answers.q_name={questionId:"q_name",fileUploadAnswers:{answers:[{fileId:"local_file",fileName:"evidence.txt",mimeType:"text/plain"}]}};
  const artifact=plan(files);assert.ok(codes(artifact).includes("ATTACHMENT_CONTENT_NOT_CAPTURED"));
  assert.deepEqual(rows(artifact,"PRIVATE_PENDING").find(row=>row.record_type==="FORM_RESPONSE").raw,files.form_responses[0]);
});
test("known missing/legacy/unmapped sources retain honest census gaps, including review-required IDs",()=>{
  const source=fixture();source.known_sources.push({kind:"LEGACY_ROW",source_key:"tab:22",status:"IMPORTED"},{kind:"UNMAPPED_MEMBER",member_id:"local_unmapped"});
  const artifact=plan(source);for(const code of ["KNOWN_RESPONSE_NOT_OBSERVED","LEGACY_ROW_RESPONSE_UNMATCHABLE","MEMBER_RESPONSE_UNMATCHABLE"])assert.ok(codes(artifact).includes(code));
  assert.equal(rows(artifact,"GAP_LEDGER").find(row=>row.code==="KNOWN_RESPONSE_NOT_OBSERVED").identity.status,"REVIEW_REQUIRED");
  assert.deepEqual(JSON.parse(artifact.metadata_text).known_sources,source.known_sources);
});
test("declared mappings never qualify Sheet rows, even candidate-late rows; forged verified flags and duplicates reject",()=>{
  const source=fixture();source.form_responses.push(response("late",pinned.season_ends_at,"late raw"));source.declared_mappings.push({state:"DECLARED_ONLY",row_index:2,response_id:"late",evidence_id:"declaration2"});
  const artifact=plan(source);assert.equal(artifact.namespace_counts.SHEET_CURRENT,0);assert.equal(rows(artifact,"PRIVATE_PENDING").find(row=>row.record_type==="SHEET_ROW"&&row.raw.row_index===2).candidate_submission_scope,"AT_OR_AFTER_CUTOFF");
  const forged=clone(source);forged.declared_mappings[0].verified=true;rejects(()=>plan(forged),"UNEXPECTED_INPUT_FIELD");
  const duplicate=clone(source);duplicate.declared_mappings[1].response_id="response_early";rejects(()=>plan(duplicate),"DUPLICATE_DECLARED_MAPPING");
  source.declared_mappings[0].response_id="missing_declared";assert.ok(codes(plan(source)).includes("DECLARED_MAPPING_RESPONSE_NOT_OBSERVED"));
});
test("Sheet raw schema/style/chips/unknown row fields remain complete pending; formula and serial types are not executed/converted",()=>{
  const source=fixture();source.sheet_schema.futureStyle={x:1.5};source.sheet_rows[0].futureRowField=["retain"];source.sheet_rows[0].cells[1].chipRuns=[{startIndex:0,chip:{personProperties:{email:"fictional@example.invalid"}}}];
  const artifact=plan(source),pending=rows(artifact,"PRIVATE_PENDING");assert.deepEqual(pending.find(row=>row.record_type==="SHEET_SCHEMA").raw,source.sheet_schema);
  assert.deepEqual(pending.filter(row=>row.record_type==="SHEET_ROW").map(row=>row.raw),source.sheet_rows);assert.ok(codes(artifact).includes("SHEET_ROW_UNSUPPORTED"));
  assert.equal(pending[1].raw.cells[0].userEnteredValue.numberValue,46296.541666666664);
  assert.equal(pending[2].raw.cells[2].userEnteredValue.formulaValue,source.sheet_rows[1].cells[2].userEnteredValue.formulaValue);
});
test("missing/reordered/duplicate grid rows and cells reject instead of manufacturing blank cells",()=>{
  for(const mutate of [source=>source.sheet_rows.pop(),source=>source.sheet_rows.reverse(),source=>source.sheet_rows[1].row_index=1,
    source=>source.sheet_rows[0].cells.pop(),source=>source.sheet_schema.headers.pop()]){const source=fixture();mutate(source);rejects(()=>plan(source),"SHEET_COVERAGE_INCOMPLETE");}
  const invalid=fixture();invalid.sheet_rows[0].cells[0].userEnteredValue={numberValue:1,stringValue:"1"};rejects(()=>plan(invalid),"CELL_VALUE_UNION_INVALID");
});
test("official empty ExtendedValue stays exactly empty, while future union/error fields remain complete unsupported pending",()=>{
  const source=fixture();source.sheet_rows[0].cells[2]={userEnteredValue:{},effectiveValue:{}};
  const artifact=plan(source),empty=rows(artifact,"PRIVATE_PENDING").find(row=>row.record_type==="SHEET_ROW"&&row.raw.row_index===1);
  assert.deepEqual(empty.raw.cells[2],{userEnteredValue:{},effectiveValue:{}});assert.deepEqual(empty.reasons,["SHEET_SCOPE_UNPROVEN"]);
  for(const value of [{effectiveValue:{futureValue:"keep full"}},{effectiveValue:{errorValue:{type:"FUTURE_ERROR",message:"original error"}}},{effectiveValue:{errorValue:{message:"missing type"}}}]){
    const future=fixture();future.sheet_rows[0].cells[2]=value;const result=plan(future);
    assert.deepEqual(rows(result,"PRIVATE_PENDING").find(row=>row.record_type==="SHEET_ROW"&&row.raw.row_index===1).raw.cells[2],value);
    assert.ok(codes(result).includes("SHEET_ROW_UNSUPPORTED"));
  }
});
test("fixed caller identity, duplicate question/response/census IDs and interval cannot be bypassed by raw cutoff",()=>{
  const raw=fixture();raw.submission_cutoff_at="2099-01-01T00:00:00Z";rejects(()=>plan(raw),"UNEXPECTED_INPUT_FIELD");
  const wrong=fixture();wrong.form_schema.formId="other_form";rejects(()=>plan(wrong),"SOURCE_IDENTITY_MISMATCH");
  const duplicate=fixture();duplicate.form_schema.items.push({...clone(duplicate.form_schema.items[0]),itemId:"item_2"});rejects(()=>plan(duplicate),"DUPLICATE_QUESTION_ID");
  const responses=fixture();responses.form_responses.push(clone(responses.form_responses[0]));rejects(()=>plan(responses),"DUPLICATE_RESPONSE_ID");
  const census=fixture();census.known_sources.push(clone(census.known_sources[0]));rejects(()=>plan(census),"DUPLICATE_CENSUS_ID");
  const interval=fixture();interval.observed_end_at="2026-09-30T12:00:00Z";rejects(()=>plan(interval),"OBSERVED_INTERVAL_INVALID");
});
test("resource counts reject before whole per-record/cell work; large record/chunk wrapping cannot be truncated",()=>{
  const many=fixture();many.form_responses=Array.from({length:5000},(_,i)=>({responseId:`count_${i}`}));rejects(()=>plan(many),"RECORD_COUNT_EXCEEDED");
  const cells=fixture();cells.sheet_schema.columnCount=25_001;rejects(()=>plan(cells),"CELL_COUNT_EXCEEDED");
  const large=fixture();large.form_responses[0].answers.q_name.textAnswers.answers[0].value="x".repeat(64_000);rejects(()=>plan(large),"RECORD_BYTES_EXCEEDED");
  // Find a boundary source record which fits 64KB but cannot fit its fixed chunk envelope; do not invent a smaller output.
  const wrap=fixture();wrap.form_responses[0].answers.q_name.textAnswers.answers[0].value="x".repeat(63_650);rejects(()=>plan(wrap),"CHUNK_BYTES_EXCEEDED");
});
test("all namespace chunks independently reconstruct exact records, offsets and byte counts without source storage or replay claims",()=>{
  const source=fixture();for(let i=0;i<205;i++)source.form_responses.push(response(`bulk_${i}`,"2026-09-30T12:00:00Z",`Value ${i}`));
  const artifact=plan(source);let total=0;
  for(const namespace of SOURCE_NAMESPACES){let index=0,offset=0;for(const chunk of artifact.chunks.filter(row=>row.namespace===namespace)){
    const payload=JSON.parse(chunk.payload_text);assert.equal(chunk.chunk_index,index++);assert.equal(chunk.row_offset,offset);
    assert.equal(payload.namespace,namespace);assert.equal(payload.chunk_index,chunk.chunk_index);assert.equal(payload.row_offset,offset);
    assert.equal(payload.source_operation_id,pinned.source_operation_id);assert.equal(payload.records.length,chunk.row_count);
    assert.equal(Buffer.byteLength(chunk.payload_text,"utf8"),chunk.utf8_bytes);assert.ok(chunk.utf8_bytes<=64_000&&chunk.row_count<=100);offset+=chunk.row_count;
  }assert.equal(offset,artifact.namespace_counts[namespace]);total+=offset;}
  assert.equal(total,artifact.record_count);assert.ok(Buffer.byteLength(artifact.canonical_text,"utf8")<=SOURCE_LIMITS.total_bytes);
  assert.equal(rows(artifact,"FORM_CURRENT").filter(row=>row.record_type==="FORM_RESPONSE").length,206);
  assert.deepEqual(rows(artifact,"FORM_CURRENT").slice(1).map(row=>row.raw),source.form_responses);
  const changed=clone(source);changed.form_responses[0].answers.q_name.textAnswers.answers[0].value="Later source value";
  assert.notEqual(plan(changed).canonical_text,artifact.canonical_text); // This is not a durable request/replay implementation.
});
