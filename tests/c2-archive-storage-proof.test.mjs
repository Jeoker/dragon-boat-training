import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import ts from "typescript";

const modules=new Map();
function moduleUrl(url){if(modules.has(url.href))return modules.get(url.href);
  let code=ts.transpileModule(readFileSync(url,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  code=code.replace(/(from\s+["'])(\.[^"']+)(["'])/gu,(_,start,path,end)=>start+moduleUrl(new URL(path.endsWith(".ts")?path:`${path}.ts`,url))+end);
  const result=`data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${url.href}`).toString("base64")}`;modules.set(url.href,result);return result;}
const {proveStoredArchiveBudget}=await import(moduleUrl(new URL("../cloudflare/src/c2-archive-storage.ts",import.meta.url)));
test("saved snapshot proof budgets duplicate texts, all chunks and the current pin before loading persisted payload",()=>{
  const valid={plans:1,plan_bytes:8_008_192,pin_bytes:8192,chunks:5000,payload_bytes:2_000_000,chunk_bytes:3_280_000};
  assert.doesNotThrow(()=>proveStoredArchiveBudget(valid));
  for(const [key,value] of Object.entries({plans:0,plan_bytes:8_008_193,pin_bytes:8193,chunks:5001,payload_bytes:2_000_001,chunk_bytes:3_280_001}))
    assert.throws(()=>proveStoredArchiveBudget({...valid,[key]:value}));
  assert.throws(()=>proveStoredArchiveBudget({...valid,chunks:0}));
});
test("corrupt aggregate numbers cannot bypass saved replay limits",()=>{
  const valid={plans:1,plan_bytes:1,pin_bytes:1,chunks:1,payload_bytes:1,chunk_bytes:1};
  for(const key of Object.keys(valid))for(const value of [-1,NaN,Infinity,0.1,Number.MAX_SAFE_INTEGER+1,"1",null])
    assert.throws(()=>proveStoredArchiveBudget({...valid,[key]:value}));
});
