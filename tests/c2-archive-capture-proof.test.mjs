import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";

const modules=new Map();
function moduleUrl(url){if(modules.has(url.href))return modules.get(url.href);
  let code=ts.transpileModule(readFileSync(url,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  code=code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu,(_,start,path,end)=>start+moduleUrl(new URL(path.endsWith(".ts")?path:`${path}.ts`,url))+end);
  const result=`data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${url.href}`).toString("base64")}`;modules.set(url.href,result);return result;}
const {proveArchiveBudget,ARCHIVE_BUSINESS_ACTIONS,ARCHIVE_OPERATIONAL_ACTIONS}=await import(moduleUrl(new URL("../cloudflare/src/c2-archive-capture.ts",import.meta.url)));
test("pure budget proof charges worst UTF8 escaping, logical rows and nested wrappers before allocation",()=>{
  const metadata={format:"example",captured_at:"2026-09-30T12:00:00.000Z"};
  const bytes=Buffer.byteLength(JSON.stringify({name:"😀中\"\\\n"}),"utf8"),proof=proveArchiveBudget(3,bytes,2,metadata);
  assert.equal(proof,6*bytes+Buffer.byteLength(JSON.stringify(metadata))+4096+10);
  assert.throws(()=>proveArchiveBudget(5001,0,0,metadata));assert.throws(()=>proveArchiveBudget(1,334000,0,metadata));
  assert.throws(()=>proveArchiveBudget(1,1,Number.MAX_SAFE_INTEGER,metadata));
});
test("invalid numeric proof inputs cannot turn a resource overflow into a success",()=>{
  for(const value of [-1,NaN,Infinity,1.1,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>proveArchiveBudget(value,1,1,{}));assert.throws(()=>proveArchiveBudget(1,value,1,{}));assert.throws(()=>proveArchiveBudget(1,1,value,{}));}
});
test("business and operational audit classification is explicit, disjoint and private operations stay excluded",()=>{
  assert.equal(new Set(ARCHIVE_BUSINESS_ACTIONS).size,ARCHIVE_BUSINESS_ACTIONS.length);
  assert.equal(new Set(ARCHIVE_OPERATIONAL_ACTIONS).size,ARCHIVE_OPERATIONAL_ACTIONS.length);
  assert.ok(ARCHIVE_BUSINESS_ACTIONS.every(value=>!ARCHIVE_OPERATIONAL_ACTIONS.includes(value)));
  assert.ok(ARCHIVE_BUSINESS_ACTIONS.includes("cancelSignup"));assert.ok(ARCHIVE_BUSINESS_ACTIONS.includes("pullFormResponses"));
  assert.ok(ARCHIVE_OPERATIONAL_ACTIONS.includes("coachLogin"));assert.ok(ARCHIVE_OPERATIONAL_ACTIONS.includes("createBackupSnapshot"));
});
