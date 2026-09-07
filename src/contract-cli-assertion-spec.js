// Narrow public JSON-file CLI contract. No arbitrary command/argument programs,
// private graders, source-derived oracle, or candidate repair instructions.
import crypto from 'node:crypto';
import path from 'node:path';
import {ASSERTION_SPEC_SCHEMA,ASSERTION_SPEC_GRAMMAR} from './contract-assertion-spec.js';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const relative=v=>typeof v==='string'&&v.length>0&&v.length<=240&&!/[\\:\x00-\x1f\x7f]/.test(v)
  &&!path.posix.isAbsolute(v)&&path.posix.normalize(v)===v&&v!=='.'&&!v.startsWith('../');
const sourceSet=values=>new Set((Array.isArray(values)?values:[]).map(v=>typeof v==='string'?v:v?.path??v?.p));

// Deliberately incomplete recognizer: unfamiliar wording, multiple CLI entries,
// subcommands, stdin programs, and ambiguous contracts remain unavailable.
export function deriveCliContract(task,{sourcePaths=null}={}){
  if(typeof task!=='string'||!task.trim()||Buffer.byteLength(task)>12000)return null;
  const entries=[...task.matchAll(/\bCLI:[ \t]*`node[ \t]+([^`\s]+)[ \t]+([A-Z][A-Z0-9_]*)`/g)];
  if(entries.length!==1)return null;
  const entry=entries[0],module=entry[1];
  if(!relative(module)||! /\.[cm]?js$/.test(module)||(sourcePaths!==null&&!sourceSet(sourcePaths).has(module)))return null;
  const end=task.indexOf('\n\n',entry.index),paragraph=task.slice(entry.index,end<0?task.length:end);
  if(paragraph.length>3000)return null;
  const normalized=paragraph.replace(/\s+/g,' ');
  if(!/\bUTF-8 JSON file contains\b/.test(normalized)
    ||! /\bSuccess prints (?:exactly )?one (?:result )?JSON (?:plus|followed by) newline, exits 0 and has no stderr\./.test(normalized))return null;
  let arity=null;
  if(/\bExactly one argument is required\./.test(normalized)){
    const invalid=/\bInvalid arguments, [^.]{1,400}? exit ([1-9][0-9]{0,2}), with nonempty stderr and no stdout\./.exec(normalized);
    if(!invalid||Number(invalid[1])>255)return null;
    arity={arguments:1,exitCode:Number(invalid[1]),stdout:'empty',stderr:'nonempty'};
  }
  return {schema:'bantam.cli-contract.v1',taskSha256:sha(task),module,inputKind:'json-file',
    success:{exitCode:0,stdout:'single-json-newline',stderr:'empty'},arity,evidence:[paragraph]};
}

function validContract(contract){
  if(!exact(contract,['schema','taskSha256','module','inputKind','success','arity','evidence'])
    ||contract.schema!=='bantam.cli-contract.v1'||!/^[a-f0-9]{64}$/.test(contract.taskSha256??'')
    ||!relative(contract.module)||! /\.[cm]?js$/.test(contract.module)||contract.inputKind!=='json-file'
    ||!exact(contract.success,['exitCode','stdout','stderr'])||contract.success.exitCode!==0
    ||contract.success.stdout!=='single-json-newline'||contract.success.stderr!=='empty'
    ||!Array.isArray(contract.evidence)||contract.evidence.length!==1||typeof contract.evidence[0]!=='string'
    ||contract.evidence[0].length>3000)return false;
  return contract.arity===null||(exact(contract.arity,['arguments','exitCode','stdout','stderr'])
    &&contract.arity.arguments===1&&Number.isInteger(contract.arity.exitCode)&&contract.arity.exitCode>=1&&contract.arity.exitCode<=255
    &&contract.arity.stdout==='empty'&&contract.arity.stderr==='nonempty');
}

export const CLI_ASSERTION_SPEC_SCHEMA={type:'object',additionalProperties:false,required:['module','input','expected'],
  properties:{module:{type:'string',minLength:1,maxLength:240},input:{$ref:'#/$defs/value'},expected:{$ref:'#/$defs/value'}},
  $defs:ASSERTION_SPEC_SCHEMA.$defs};
export const CLI_ASSERTION_SPEC_GRAMMAR=String.raw`root ::= ws "{" ws "\"module\"" ws ":" ws string ws "," ws "\"input\"" ws ":" ws value ws "," ws "\"expected\"" ws ":" ws value ws "}" ws
`+ASSERTION_SPEC_GRAMMAR.slice(ASSERTION_SPEC_GRAMMAR.indexOf('value ::='));

function jsonData(value,depth=0,state={count:0}){
  if(++state.count>512||depth>8)return false;
  if(value===null||typeof value==='boolean')return true;
  if(typeof value==='string')return value.length<=8192;
  if(typeof value==='number')return Number.isFinite(value)&&!Object.is(value,-0);
  if(!Array.isArray(value)&&!object(value))return false;
  const keys=Object.keys(value);if(keys.length>64||(Array.isArray(value)&&keys.length!==value.length))return false;
  return keys.every((key,i)=>(!Array.isArray(value)||key===String(i))&&jsonData(value[key],depth+1,state));
}
function duplicateKeys(raw){
  const stack=[];
  for(const m of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]/g)){
    const token=m[0],top=stack.at(-1);
    if(token==='{')stack.push({object:true,key:true,seen:new Set()});
    else if(token==='[')stack.push({object:false});
    else if(token==='}'||token===']')stack.pop();
    else if(token===','&&top?.object)top.key=true;
    else if(token===':'&&top?.object)top.key=false;
    else if(token.startsWith('"')&&top?.object&&top.key){const key=JSON.parse(token);if(top.seen.has(key))return true;top.seen.add(key);}
  }
  return false;
}
export function parseCliAssertionSpec(text,{contract,sourcePaths=[]}={}){
  try{
    if(!validContract(contract)||typeof text!=='string'||Buffer.byteLength(text)>12000||duplicateKeys(text))return null;
    const spec=JSON.parse(text);
    if(!exact(spec,['module','input','expected'])||spec.module!==contract.module||!sourceSet(sourcePaths).has(spec.module)
      ||!jsonData(spec.input)||!jsonData(spec.expected)||Buffer.byteLength(JSON.stringify(spec.input))>8192
      ||Buffer.byteLength(JSON.stringify(spec.expected))>8192)return null;
    return spec;
  }catch{return null;}
}

const quote=text=>`'${text.replace(/'/g,`'"'"'`)}'`;
const node=code=>`node --input-type=module -e ${quote(code)}`;

export function buildCliAssertionProbe(spec,{contract,inputs=[],question='Does this declared public JSON-file CLI case satisfy its documented process and output contract?'}={}){
  const normalized=inputs.map(input=>({p:typeof input==='string'?input:input?.p??input?.path}));
  if(normalized.length>16||normalized.some(i=>!relative(i.p))||new Set(normalized.map(i=>i.p)).size!==normalized.length
    ||typeof question!=='string'||!question.trim()||question.length>2000||!jsonData(spec?.input)||!jsonData(spec?.expected)
    ||!parseCliAssertionSpec(JSON.stringify(spec),{contract,sourcePaths:normalized}))throw Error('invalid CLI assertion spec or input binding');
  const data=Buffer.from(JSON.stringify({spec,contract})).toString('base64');
  const head=`import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const {spec,contract}=JSON.parse(Buffer.from('${data}','base64').toString());
const root=path.join(process.cwd(),'case'),fixture=path.join(root,'input.json'),module=path.join(process.cwd(),'subject',spec.module);
const LF=String.fromCharCode(10);
`;
  const setup=node(head+`fs.mkdirSync(root,{mode:0o755});fs.writeFileSync(fixture,JSON.stringify(spec.input)+LF,{flag:'wx',mode:0o644});console.log('CLI fixture created');`);
  const witness=node(head+`const f=fs.lstatSync(fixture),m=fs.lstatSync(module);assert.ok(f.isFile()&&!f.isSymbolicLink());assert.ok(m.isFile()&&!m.isSymbolicLink());assert.equal(fs.readFileSync(fixture,'utf8'),JSON.stringify(spec.input)+LF);console.log(JSON.stringify({schema:'bantam.cli-assertion-witness.v1',fixture:true,entrypoint:true}));`);
  const check=node(head+`import {spawnSync} from 'node:child_process'; import crypto from 'node:crypto';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const cases=[{name:'valid-input',args:[fixture]},...(contract.arity?[{name:'missing-argument',args:[]},{name:'extra-argument',args:[fixture,fixture]}]:[])];
const outcomes=[];
for(const item of cases){
 const result=spawnSync(process.execPath,[module,...item.args],{cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe'],timeout:2000,killSignal:'SIGKILL',maxBuffer:16384});
 const stdout=result.stdout??Buffer.alloc(0),stderr=result.stderr??Buffer.alloc(0);
 const measured={case:item.name,status:Number.isInteger(result.status)?result.status:null,signal:result.signal??null,error:result.error?String(result.error.code??result.error.message):null,stdoutBytes:stdout.length,stderrBytes:stderr.length,stdoutSha256:sha(stdout),stderrSha256:sha(stderr),stdoutBase64:stdout.toString('base64'),stderrBase64:stderr.toString('base64')};
 if(result.error||result.signal||!Number.isInteger(result.status)){outcomes.push({...measured,result:'unavailable'});continue;}
 try{
  if(item.name==='valid-input'){
   assert.equal(result.status,contract.success.exitCode);assert.equal(stderr.length,0);
   const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(stdout);
   assert.ok(text.endsWith(LF),'stdout must end in a newline');
   const body=text.slice(0,-1);
   assert.deepStrictEqual(JSON.parse(body),spec.expected);
  }else{assert.equal(result.status,contract.arity.exitCode);assert.equal(stdout.length,0);assert.ok(stderr.length>0,'stderr must be nonempty');}
  outcomes.push({...measured,result:'passed'});
 }catch(error){outcomes.push({...measured,result:'failed',reason:String(error.message).slice(0,500)});}
}
const status=outcomes.some(x=>x.result==='unavailable')?'unavailable':outcomes.some(x=>x.result==='failed')?'failed':'complete';
console.log(JSON.stringify({schema:'bantam.cli-assertion-check.v1',status,cases:outcomes}));
process.exitCode=status==='unavailable'?125:status==='failed'?1:0;
`);
  for(const c of [setup,witness,check])if(c.length>24000)throw Error('CLI assertion exceeds existing probe command limit');
  return {a:'probe',question,inputs:normalized,setup,witness,check};
}
