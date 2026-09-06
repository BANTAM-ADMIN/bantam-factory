// One declarative API case. Model-owned data/expectation, controller-owned code.
// This is a scoped experiment, not a correctness oracle or hostile-code boundary.
const MAX_BYTES = 12000;
const FIXTURE_KEYS = ["kind", "path", "text", "mode", "target"];
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const relative = value => typeof value === "string" && value.length > 0 && value.length <= 240
  && !/[\\:\x00]/.test(value) && !value.startsWith("/")
  && value.split("/").every(part => part && part !== "." && part !== "..");
const allowedPaths = sources => new Set((Array.isArray(sources) ? sources : []).map(s => typeof s === "string" ? s : s?.path ?? s?.p));

const jsonValue = { anyOf: [
  { type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string", maxLength: 8192 },
  { type: "array", maxItems: 64, items: { $ref: "#/$defs/value" } },
  { type: "object", maxProperties: 64, additionalProperties: { $ref: "#/$defs/value" } },
] };
export const ASSERTION_SPEC_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["module", "export", "fixtures", "args", "expect"],
  properties: {
    module: { type: "string", minLength: 1, maxLength: 240 },
    export: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$", maxLength: 120 },
    fixtures: { type: "array", maxItems: 8, items: {
      type: "object", additionalProperties: false, required: FIXTURE_KEYS,
      properties: { kind: { enum: ["directory", "file", "symlink"] }, path: { type: "string", minLength: 1, maxLength: 240 },
        text: { type: "string", maxLength: 8192 }, mode: { type: "integer", minimum: 0, maximum: 511 },
        target: { type: "string", maxLength: 240 } },
    } },
    args: { type: "array", maxItems: 64, items: { $ref: "#/$defs/value" } },
    expect: { type: "object", additionalProperties: false, required: ["kind", "value"],
      properties: { kind: { enum: ["equals", "throws"] }, value: { $ref: "#/$defs/value" } } },
  },
  $defs: { value: jsonValue },
};

export const ASSERTION_SPEC_GRAMMAR = String.raw`
root ::= ws "{" ws "\"module\"" ws ":" ws string ws "," ws "\"export\"" ws ":" ws string ws "," ws "\"fixtures\"" ws ":" ws "[" ws (fixture (ws "," ws fixture){0,7})? ws "]" ws "," ws "\"args\"" ws ":" ws array ws "," ws "\"expect\"" ws ":" ws expectation ws "}" ws
fixture ::= "{" ws "\"kind\"" ws ":" ws ("\"directory\"" | "\"file\"" | "\"symlink\"") ws "," ws "\"path\"" ws ":" ws string ws "," ws "\"text\"" ws ":" ws string ws "," ws "\"mode\"" ws ":" ws integer ws "," ws "\"target\"" ws ":" ws string ws "}"
expectation ::= "{" ws "\"kind\"" ws ":" ws ("\"equals\"" | "\"throws\"") ws "," ws "\"value\"" ws ":" ws value ws "}"
value ::= string | number | object | array | "true" | "false" | "null"
object ::= "{" ws (string ws ":" ws value (ws "," ws string ws ":" ws value){0,63})? ws "}"
array ::= "[" ws (value (ws "," ws value){0,63})? ws "]"
string ::= "\"" schar{0,8192} "\""
schar ::= [^"\\\x7F\x00-\x1F] | "\\" escape
escape ::= ["\\/bfnrt] | "u" hex hex hex hex
hex ::= [0-9a-fA-F]
integer ::= "0" | [1-9] [0-9]{0,15}
number ::= "-"? integer ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
ws ::= [ \t\n\r]*
`;

function duplicateKeys(raw) {
  const stack = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]/g)) {
    const token = match[0], top = stack.at(-1);
    if (token === "{") stack.push({ object: true, key: true, seen: new Set() });
    else if (token === "[") stack.push({ object: false });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && top?.object) top.key = true;
    else if (token === ":" && top?.object) top.key = false;
    else if (token.startsWith('"') && top?.object && top.key) {
      const key = JSON.parse(token);
      if (top.seen.has(key)) return true;
      top.seen.add(key);
    }
  }
  return false;
}

function jsonData(value, { refs = false } = {}, depth = 0, count = { n: 0 }) {
  if (++count.n > 512 || depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 8192;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (!value || typeof value !== "object") return false;
  if (refs && Object.hasOwn(value, "$fixture")) return exactKeys(value, ["$fixture"]) && relative(value.$fixture);
  const entries = Array.isArray(value) ? value : Object.values(value);
  return entries.length <= 64 && entries.every(v => jsonData(v, { refs }, depth + 1, count));
}

export function parseAssertionSpec(text, { sourcePaths = [] } = {}) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) return null;
    const spec = JSON.parse(text);
    if (duplicateKeys(text) || !exactKeys(spec, ["module", "export", "fixtures", "args", "expect"])
        || !relative(spec.module) || !/\.(?:js|mjs|cjs)$/.test(spec.module) || !allowedPaths(sourcePaths).has(spec.module)
        || typeof spec.export !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,119}$/.test(spec.export)
        || !Array.isArray(spec.fixtures) || spec.fixtures.length > 8
        || !Array.isArray(spec.args) || !jsonData(spec.args, { refs: true })
        || !exactKeys(spec.expect, ["kind", "value"]) || !["equals", "throws"].includes(spec.expect.kind)
        || !jsonData(spec.expect.value) || (spec.expect.kind === "throws" && spec.expect.value !== null)) return null;
    const fixtures = new Map(); let textBytes = 0;
    for (const item of spec.fixtures) {
      if (!exactKeys(item, FIXTURE_KEYS) || !["directory", "file", "symlink"].includes(item.kind)
          || !relative(item.path) || fixtures.has(item.path) || typeof item.text !== "string"
          || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 511 || typeof item.target !== "string") return null;
      if (item.kind === "file" ? item.target !== "" : item.text !== "" || item.mode !== 420) return null;
      if (item.kind === "symlink" ? !relative(item.target) : item.target !== "") return null;
      textBytes += Buffer.byteLength(item.text);
      if (textBytes > 8192) return null;
      fixtures.set(item.path, item);
    }
    for (const name of fixtures.keys()) {
      const parts = name.split("/"); parts.pop();
      while (parts.length) {
        const parent = fixtures.get(parts.join("/"));
        if (parent && parent.kind !== "directory") return null;
        parts.pop();
      }
    }
    return spec;
  } catch { return null; }
}

const quote = text => `'${text.replace(/'/g, `'"'"'`)}'`;
const nodeCommand = code => `node --input-type=module -e ${quote(code)}`;

// Fixed child: candidate stdout is not the receipt channel. Import and argument
// construction occur outside the API-call catch, so they cannot satisfy throws.
const CHILD = String.raw`
import fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
const emit=fs.writeSync.bind(fs), stringify=JSON.stringify.bind(JSON), ErrorConstructor=Error;
const spec=JSON.parse(process.env.BANTAM_ASSERTION_SPEC), phase=process.env.BANTAM_ASSERTION_PHASE;
const packet=(kind,value=null)=>emit(3,stringify({schema:'bantam.assertion-outcome.v1',kind,value})+'\n');
function resolve(value){
 if(value&&typeof value==='object'){
  if(!Array.isArray(value)&&Object.keys(value).length===1&&Object.hasOwn(value,'$fixture')) return path.join(process.cwd(),'case',value.$fixture);
  if(Array.isArray(value))return value.map(resolve);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)]));
 }
 return value;
}
function jsonOnly(value,depth=0,seen=new Set()){
 if(depth>16)return false;
 if(value===null||typeof value==='string'||typeof value==='boolean')return true;
 if(typeof value==='number')return Number.isFinite(value)&&!Object.is(value,-0);
 if(!value||typeof value!=='object'||seen.has(value))return false;
 if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)return false;
 seen.add(value);
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).some(k=>typeof k==='symbol'))return false;
 for(const [key,d]of Object.entries(descriptors)){
  if(Array.isArray(value)&&key==='length')continue;
  if(!d.enumerable||!Object.hasOwn(d,'value')||!jsonOnly(d.value,depth+1,seen))return false;
 }
 if(Array.isArray(value)&&(Object.keys(value).length!==value.length||Object.keys(value).some((key,i)=>key!==String(i))))return false;
 seen.delete(value);return true;
}
try{
 const module=await import(pathToFileURL(path.join(process.cwd(),'subject',spec.module)).href);
 const fn=module[spec.export];if(typeof fn!=='function')throw Error('selected export is not callable');
 const args=resolve(spec.args);
 if(phase==='witness')packet('callable');
 else{
  let result,thrownKind=null;
  try{result=fn(...args);}catch(error){thrownKind=error instanceof ErrorConstructor?'threw':'threw-non-error';}
  if(thrownKind)packet(thrownKind);
  else if(!jsonOnly(result))packet('unsupported');
  else packet('returned',result);
 }
}catch(error){packet('infrastructure');}
`;

// This parent never imports candidate code. A clean child exit plus exactly one
// closed fd3 outcome is mandatory; process.exit(0), logging, and import failures
// are not successful assertions. Timeout/oversized/non-JSON replies are unknown.
function comparisonCode(spec, phase, before = "") {
  return `import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
const spec=JSON.parse(Buffer.from('${Buffer.from(JSON.stringify(spec)).toString("base64")}','base64').toString());
${before}
const result=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(CHILD)}],{
 cwd:process.cwd(),env:{...process.env,BANTAM_ASSERTION_SPEC:JSON.stringify(spec),BANTAM_ASSERTION_PHASE:${JSON.stringify(phase)}},
 timeout:5000,maxBuffer:65536,stdio:['ignore','pipe','pipe','pipe']});
let outcome;try{outcome=JSON.parse(result.output[3]?.toString()??'');}catch{}
if(result.error||result.signal||result.status!==0||!outcome||Object.keys(outcome).join(',')!=='schema,kind,value'
 ||outcome.schema!=='bantam.assertion-outcome.v1'||['infrastructure','unsupported'].includes(outcome.kind)){
 console.error('ASSERTION_UNAVAILABLE: missing, unsupported, or incomplete API outcome');process.exit(125);
}
try{
 ${phase === "witness" ? "assert.equal(outcome.kind,'callable');assert.equal(outcome.value,null);" : `if(spec.expect.kind==='throws'){assert.equal(outcome.kind,'threw');assert.equal(outcome.value,null);}
 else{assert.equal(outcome.kind,'returned');assert.deepStrictEqual(outcome.value,spec.expect.value);}`}
 console.log(JSON.stringify({schema:'bantam.contract-assertion.v1',phase:${JSON.stringify(phase)},pass:true,apiOutcome:outcome.kind}));
}catch(error){console.error('ASSERTION_FAILED: '+error.message);process.exit(1);}`;
}

export function buildAssertionProbe(spec, { inputs = [], question = "Does this public API satisfy this one declared assertion?" } = {}) {
  const normalized = inputs.map(input => ({ p: typeof input === "string" ? input : input?.p ?? input?.path }));
  if (normalized.length > 16 || normalized.some(input => !relative(input.p))
      || new Set(normalized.map(input => input.p)).size !== normalized.length
      || typeof question !== "string" || !question.trim() || question.length > 2000
      || !parseAssertionSpec(JSON.stringify(spec), { sourcePaths: normalized })) throw Error("invalid assertion spec or copied inputs");
  const serialized = `Buffer.from('${Buffer.from(JSON.stringify(spec)).toString("base64")}','base64').toString()`;
  const setup = nodeCommand(`import fs from 'node:fs'; import path from 'node:path';
const spec=JSON.parse(${serialized}),root=path.join(process.cwd(),'case');
fs.mkdirSync(root,{mode:0o755});
for(const f of spec.fixtures.filter(f=>f.kind==='directory').sort((a,b)=>a.path.length-b.path.length))fs.mkdirSync(path.join(root,f.path),{recursive:true,mode:0o755});
for(const f of spec.fixtures.filter(f=>f.kind!=='directory')){
 const name=path.join(root,f.path);fs.mkdirSync(path.dirname(name),{recursive:true,mode:0o755});
 if(f.kind==='file'){fs.writeFileSync(name,f.text,{flag:'wx',mode:f.mode});fs.chmodSync(name,f.mode);}
}
for(const f of spec.fixtures.filter(f=>f.kind==='symlink'))fs.symlinkSync(path.relative(path.dirname(path.join(root,f.path)),path.join(root,f.target)),path.join(root,f.path));
console.log('fixture created');`);
  const fixtureWitness = `const root=path.join(process.cwd(),'case');
assert.ok(fs.lstatSync(root).isDirectory());
for(const f of spec.fixtures){const name=path.join(root,f.path),s=fs.lstatSync(name);
 if(f.kind==='directory')assert.ok(s.isDirectory()&&!s.isSymbolicLink());
 else if(f.kind==='symlink'){assert.ok(s.isSymbolicLink());assert.equal(fs.readlinkSync(name),path.relative(path.dirname(name),path.join(root,f.target)));}
 else{assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(fs.readFileSync(name,'utf8'),f.text);assert.equal(s.mode&0o777,f.mode);}}
`;
  // Separate fixed Node programs avoid any candidate-controlled shell syntax.
  const witness = nodeCommand(comparisonCode(spec, "witness", fixtureWitness));
  const check = nodeCommand(comparisonCode(spec, "check"));
  for (const command of [setup, witness, check]) if (command.length > 24000) throw Error("assertion command exceeds existing probe limit");
  return { a: "probe", question, inputs: normalized, setup, witness, check };
}
