// Executable, bounded JSON preservation laws. Public-contract admission belongs
// to the station; neither an API name nor a candidate implementation is an oracle.
import path from 'node:path';

const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected) => record(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const safeModule = value => typeof value === 'string' && value.length <= 256
  && /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.[cm]?js$/.test(value)
  && path.posix.normalize(value) === value && !value.split('/').some(part => part === '..' || unsafe.has(part));
const COPY_CORPUS = ['baseline', null, 0, false, '', 'probe-é', {}, [], [null], [0], [[]], [[0]],
  { leaf: 0 }, { items: [{ leaf: 'a' }] }, [[{ leaf: 'a' }]], { rows: [[{ leaf: 0 }]] },
  [{ rows: [[null, { leaf: [true, false] }]] }]];
export const COPY_PROBE_CASE_COUNT = COPY_CORPUS.length;

// Shared by the controller's literal fixture review and the executable child.
// A template preserves known-valid required fields; only an unused metadata field
// receives the controller's varied value. No template key supplies an oracle.
function copyInputRecord(spec, value, clone, owns) {
  if (!owns(spec, 'inputTemplate')) return { value: clone(value) };
  const input = clone(spec.inputTemplate);
  let key = 'copyProbeValue', suffix = 1;
  while (owns(input, key)) key = 'copyProbeValue' + suffix++;
  input[key] = clone(value);
  return input;
}

export function copyProbeInput(spec, value) {
  return copyInputRecord(spec, value, input => JSON.parse(JSON.stringify(input)),
    (input, key) => Object.prototype.hasOwnProperty.call(input, key));
}

export const COPY_SPEC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['module', 'inputTemplate', 'calls', 'observePath'],
  properties: {
    module: { type: 'string', minLength: 0, maxLength: 256 },
    inputTemplate: { type: 'object', maxProperties: 64, additionalProperties: { $ref: '#/$defs/json' } },
    calls: { type: 'array', minItems: 0, maxItems: 4, items: {
      type: 'object', additionalProperties: false, required: ['export', 'args'], properties: {
        export: { type: 'string', minLength: 1, maxLength: 128 },
        args: { type: 'array', maxItems: 8, items: { $ref: '#/$defs/json' } },
      },
    } },
    observePath: { type: 'array', maxItems: 8, items: { anyOf: [
      { type: 'string', maxLength: 128 }, { type: 'integer', minimum: 0, maximum: 1000000 },
    ] } },
  },
  $defs: { json: { anyOf: [
    { type: 'null' }, { type: 'boolean' }, { type: 'number' }, { type: 'string', maxLength: 8192 },
    { type: 'array', maxItems: 64, items: { $ref: '#/$defs/json' } },
    { type: 'object', maxProperties: 64, additionalProperties: { $ref: '#/$defs/json' } },
  ] } },
};
export const COPY_SPEC_GRAMMAR = String.raw`
root ::= "{" ws "\"module\"" ws ":" ws str ws "," ws "\"inputTemplate\"" ws ":" ws object ws "," ws "\"calls\"" ws ":" ws "[" ws (call (ws "," ws call){0,3})? ws "]" ws "," ws "\"observePath\"" ws ":" ws "[" ws (part (ws "," ws part){0,7})? ws "]" ws "}" ws
call ::= "{" ws "\"export\"" ws ":" ws str ws "," ws "\"args\"" ws ":" ws "[" ws (value (ws "," ws value){0,7})? ws "]" ws "}"
part ::= str | ("0" | [1-9] [0-9]{0,6})
value ::= str | number | "true" | "false" | "null" | "[" ws (value (ws "," ws value){0,63})? ws "]" | object
object ::= "{" ws (pair (ws "," ws pair){0,63})? ws "}"
pair ::= str ws ":" ws value
number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
str ::= "\"" ch{0,8192} "\""
ch ::= [^"\\\x00-\x1f\x7f] | "\\" (["\\/bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
ws ::= [ \t\r\n]{0,8}
`;

export function parseCopySpec(text, sourcePaths) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 8192 || !Array.isArray(sourcePaths)) return null;
    const spec = JSON.parse(text);
    // Duplicate JSON keys must not silently replace fixture data or capabilities.
    const normalized = text.replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? JSON.stringify(JSON.parse(token)) : '');
    if (normalized !== JSON.stringify(spec)
      || !(exactKeys(spec, ['module', 'calls', 'observePath']) || exactKeys(spec, ['module', 'inputTemplate', 'calls', 'observePath']))
      || !safeModule(spec.module) || !sourcePaths.some(source => (typeof source === 'string' ? source : source?.path) === spec.module)
      || !Array.isArray(spec.calls) || spec.calls.length < 1 || spec.calls.length > 4
      || !Array.isArray(spec.observePath) || spec.observePath.length > 8
      || spec.observePath.some(key => !(typeof key === 'string' && key.length <= 128 && !unsafe.has(key))
        && !(Number.isSafeInteger(key) && key >= 0 && key <= 1000000))) return null;
    let inputs = 0, nodes = 0;
    const validArg = (value, callIndex, depth = 0, allowReferences = true) => {
      if (++nodes > 1024 || depth > 12) return false;
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
      if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
      if (Array.isArray(value)) return value.length <= 64 && value.every(child => validArg(child, callIndex, depth + 1, allowReferences));
      if (!record(value)) return false;
      const keys = Object.keys(value);
      if (keys.some(key => unsafe.has(key)) || keys.length > 64) return false;
      if (keys.includes('$input')) {
        if (!allowReferences || !exactKeys(value, ['$input']) || value.$input !== true) return false;
        inputs++; return inputs === 1;
      }
      if (keys.includes('$result')) return allowReferences && exactKeys(value, ['$result'])
        && Number.isSafeInteger(value.$result) && value.$result >= 0 && value.$result < callIndex;
      return keys.every(key => !key.startsWith('$') && validArg(value[key], callIndex, depth + 1, allowReferences));
    };
    if (Object.prototype.hasOwnProperty.call(spec, 'inputTemplate')
      && (!record(spec.inputTemplate) || !validArg(spec.inputTemplate, -1, 0, false))) return null;
    if (spec.calls.some((call, index) => !exactKeys(call, ['export', 'args'])
      || typeof call.export !== 'string' || call.export.length > 128
      || !/^[A-Za-z_$][\w$]*$/.test(call.export) || unsafe.has(call.export) || call.export === 'default'
      || !Array.isArray(call.args) || call.args.length > 8
      || !call.args.every(arg => validArg(arg, index)))) return null;
    return inputs === 1 ? spec : null;
  } catch { return null; }
}

// A fresh child receives only fixed jig code and admitted fixture DATA. Capture
// observation primitives before importing the subject, and never run model code.
// The runProbe sandbox owns host isolation; this child owns completion accounting.
const CHILD = String.raw`
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const write=fs.writeSync.bind(fs),stringify=JSON.stringify.bind(JSON),parse=JSON.parse.bind(JSON);
const keys=Object.keys.bind(Object),desc=Object.getOwnPropertyDescriptor.bind(Object),proto=Object.getPrototypeOf.bind(Object);
const define=Object.defineProperty.bind(Object),array=Array.isArray.bind(Array),finite=Number.isFinite.bind(Number);
const plain=Object.prototype,arrayProto=Array.prototype,is=Object.is.bind(Object),sort=Function.call.bind(Array.prototype.sort);
const {spec:s,obligation:id,corpus}=parse(process.env.BANTAM_COPY_CASE);
const makeInput=${copyInputRecord.toString()};
let calls=0,cases=0,phase='infrastructure',caseContext='module import',input,expected,actual;
const snapshot=value=>{
 let count=0;const seen=new Set();
 const visit=(v,depth)=>{
  if(++count>4096||depth>32)throw Error('observation exceeds bounded JSON limits');
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'&&finite(v)&&!is(v,-0))return v;
  if(!v||typeof v!=='object'||seen.has(v))throw Error('observation is not acyclic JSON data');
  const a=array(v),p=proto(v);if(a?p!==arrayProto:p!==plain&&p!==null)throw Error('observation is not plain JSON data');
  seen.add(v);const out=a?[]:{},names=keys(v);sort(names);
  if(a&&(names.length!==v.length||names.some(k=>!/^\d+$/.test(k)||Number(k)>=v.length)))throw Error('observation array is sparse or has non-JSON properties');
  for(const key of names){const d=desc(v,key);if(!d||!('value'in d))throw Error('observation has accessor properties');
   define(out,key,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});}
  seen.delete(v);return out;
 };return visit(value,0);
};
const equal=(a,b)=>stringify(a)===stringify(b);
const observe=result=>{let v=result;for(const key of s.observePath){if(v===null||typeof v!=='object')throw Error('observation path crosses a non-object');
 const d=desc(v,key);if(!d||!('value'in d))throw Error('observation path is missing or is an accessor');v=d.value;}
 if(v===undefined)throw Error('observation is undefined');return v;};
const resolve=(value,results)=>{
 if(value===null||typeof value!=='object')return value;
 if(array(value))return value.map(child=>resolve(child,results));
 if(keys(value).length===1&&value.$input===true)return input;
 if(keys(value).length===1&&Number.isSafeInteger(value.$result))return results[value.$result];
 const out={};for(const key of keys(value))define(out,key,{value:resolve(value[key],results),enumerable:true,writable:true,configurable:true});return out;
};
const mutate=value=>{
 for(const key of keys(value)){const d=desc(value,key);if(!d||!('value'in d))throw Error('input mutation requires ordinary data');
  const child=d.value;if(child!==null&&typeof child==='object')mutate(child);
  else define(value,key,{value:typeof child==='number'?child+1:typeof child==='boolean'?!child:'copy-probe-mutated',enumerable:true,writable:true,configurable:true});}
 define(value,array(value)?String(value.length):'copyProbeMutation',{value:true,enumerable:true,writable:true,configurable:true});
};
const difference=(a,b,p=[])=>{
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||array(a)!==array(b))return equal(a,b)?null:p;
 const ak=keys(a),bk=keys(b);sort(ak);sort(bk);if(!equal(ak,bk))return p;
 for(const key of ak){const found=difference(a[key],b[key],[...p,array(a)?Number(key):key]);if(found)return found;}return null;
};
try{
 const module=await import(pathToFileURL(path.join(process.cwd(),'subject',s.module)));
 for(const call of s.calls)if(typeof module[call.export]!=='function')throw Error('declared named export is not callable: '+call.export);
 for(let index=0;index<corpus.length;index++){
  phase=index===0?'fixture':'checking';caseContext='corpus case '+index;input=makeInput(s,corpus[index],value=>parse(stringify(value)),(value,key)=>desc(value,key)!==undefined);expected=snapshot(input);actual=undefined;
  const results=[];let callIndex=0;for(const call of s.calls){caseContext='corpus case '+index+'; call '+callIndex+++' export '+call.export;
   calls++;const value=module[call.export](...call.args.map(arg=>resolve(arg,results)));
   const callPhase=phase;phase='unsupported';if(value&&typeof value.then==='function')throw Error('only synchronous public APIs are supported');phase=callPhase;results.push(value);}
  // Establish the identity observation before attributing any metamorphic
  // difference to implementation behavior. A legitimate transforming API can
  // disagree with a proposed adapter despite that adapter passing review.
  phase=index===0?'positive-control':'checking';caseContext='corpus case '+index+'; observing final result';
  const finalResult=results[results.length-1];actual=snapshot(observe(finalResult));
  if(index===0&&!equal(expected,actual))throw Error('baseline positive control does not preserve the declared input observation; fixture unverified');
  if(id==='shape-preservation'){phase='checking';if(!equal(expected,actual))throw Error('observed JSON structure differs from the supplied input');}
  else if(id==='input-detachment'){
   phase='precondition';
   if(!equal(expected,actual))throw Error('detachment fixture must preserve the initial JSON shape before aliasing can be tested');
   phase='mutation';mutate(input);if(equal(snapshot(input),expected))throw Error('input mutation did not change the fixture');
   phase='checking';actual=undefined;actual=snapshot(observe(finalResult));if(!equal(expected,actual))throw Error('mutating the original input changed the observed copied value');
  }else throw Error('unknown copying obligation');
  cases++;
 }
 write(3,stringify({status:'passed',calls,cases})+'\n');
}catch(e){
 const result={status:phase==='checking'?'failed':'unavailable',calls,cases,phase,caseContext,message:String(e?.message??e).slice(0,700)};
 if(expected!==undefined){result.input=expected;result.expected=expected;}
 if(actual!==undefined){result.actual=actual;result.differencePath=difference(expected,actual);}
 write(3,stringify(result)+'\n');
}
`;

const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
export function buildCopyProbe(spec, obligation, inputs) {
  const admitted = Array.isArray(inputs) ? parseCopySpec(JSON.stringify(spec), inputs.map(input => ({ path: input?.p }))) : null;
  if (!admitted
    || !['shape-preservation', 'input-detachment'].includes(obligation)) throw Error('invalid copy-preservation probe');
  spec = admitted;
  const payload = Buffer.from(JSON.stringify({ spec, obligation, corpus: COPY_CORPUS })).toString('base64');
  const code = `import {spawnSync} from 'node:child_process';
const r=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(CHILD)}],{env:{...process.env,BANTAM_COPY_CASE:Buffer.from('${payload}','base64').toString()},timeout:4000,maxBuffer:262144,stdio:['ignore','pipe','pipe','pipe']});
let x;try{x=JSON.parse(r.output[3]?.toString()??'');}catch{}
const complete=x&&Number.isSafeInteger(x.calls)&&Number.isSafeInteger(x.cases)&&(x.status==='passed'?x.cases===${COPY_PROBE_CASE_COUNT}&&x.calls===${COPY_PROBE_CASE_COUNT * spec.calls.length}:x.status==='failed'&&x.cases>=0&&x.cases<${COPY_PROBE_CASE_COUNT}&&(x.cases===0?x.calls===${spec.calls.length}:x.calls>x.cases*${spec.calls.length}&&x.calls<=(x.cases+1)*${spec.calls.length}));
if(r.error||r.signal||r.status!==0||!complete){console.error('UNAVAILABLE: '+JSON.stringify(x??null)+'; child incomplete or fixture unverified; '+r.stderr?.toString().slice(-500));process.exit(125);}
console.log(JSON.stringify(x));if(x.status!=='passed')process.exit(1);`;
  const action = { a: 'probe', question: `Does the admitted public copying fixture satisfy ${obligation} for bounded recursive JSON values?`,
    inputs: inputs.map(({ p }) => ({ p })), setup: "node -e 'process.exit(0)'", witness: "node -e 'process.exit(0)'",
    check: `node --input-type=module -e ${quote(code)}` };
  if (action.check.length > 24000) throw Error('copy-preservation probe exceeds executable command limit');
  return action;
}
