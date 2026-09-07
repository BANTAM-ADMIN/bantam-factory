// One public CLI/API coherence case; no model-computed oracle.
import crypto from 'node:crypto';
import path from 'node:path';
import {ASSERTION_SPEC_SCHEMA,ASSERTION_SPEC_GRAMMAR} from './contract-assertion-spec.js';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const relative=v=>typeof v==='string'&&v.length>0&&v.length<=240&&!/[\\:\x00-\x1f\x7f]/.test(v)
  &&!path.posix.isAbsolute(v)&&path.posix.normalize(v)===v&&v!=='.'&&!v.startsWith('../');
const identifier=v=>typeof v==='string'&&/^[A-Za-z_$][A-Za-z0-9_$]{0,119}$/.test(v);
const sourceSet=values=>new Set((Array.isArray(values)?values:[]).map(v=>typeof v==='string'?v:v?.path??v?.p));
function names(text){const values=text.split(',').map(v=>v.trim());return values.length>=1&&values.length<=8&&values.every(identifier)&&new Set(values).size===values.length?values:null;}

// No inference from candidate code. Only simple public synchronous signatures
// whose named parameters exactly map to the documented JSON object fields.
export function deriveCliContract(task,{sourcePaths=null}={}){
  if(typeof task!=='string'||!task.trim()||Buffer.byteLength(task)>12000)return null;
  const entries=[...task.matchAll(/\bCLI:[ \t]*`node[ \t]+([^`\s]+)[ \t]+([A-Z][A-Z0-9_]*)`/g)];
  if(entries.length!==1)return null;
  const entry=entries[0],module=entry[1];
  if(!relative(module)||! /\.[cm]?js$/.test(module)||(sourcePaths!==null&&!sourceSet(sourcePaths).has(module)))return null;
  const end=task.indexOf('\n\n',entry.index),paragraph=task.slice(entry.index,end<0?task.length:end);
  if(paragraph.length>3000)return null;
  const normalized=paragraph.replace(/\s+/g,' ');
  const fieldsMatch=/\bUTF-8 JSON file contains\s+`\{([^{}]+)\}`/.exec(normalized);
  const fields=fieldsMatch&&names(fieldsMatch[1]);
  if(!fields||! /\bSuccess prints (?:exactly )?one (?:result )?JSON (?:plus|followed by) newline, exits 0 and has no stderr\./.test(normalized))return null;
  const declarations=[...task.matchAll(/\b(?:Export|Add) synchronous\s+`([A-Za-z_$][A-Za-z0-9_$]{0,119})\(([^()`]{1,1000})\)`/g)]
    .map(match=>({match,args:names(match[2])})).filter(({args})=>args&&args.length===fields.length&&args.every(arg=>fields.includes(arg)));
  if(declarations.length!==1)return null;
  const declaration=declarations[0],api={export:declaration.match[1],arguments:declaration.args};
  let arity=null;
  if(/\bExactly one argument is required\./.test(normalized)){
    const invalid=/\bInvalid arguments, [^.]{1,400}? exit ([1-9][0-9]{0,2}), with nonempty stderr and no stdout\./.exec(normalized);
    if(!invalid||Number(invalid[1])>255)return null;
    arity={arguments:1,exitCode:Number(invalid[1]),stdout:'empty',stderr:'nonempty'};
  }
  return {schema:'bantam.cli-contract.v2',taskSha256:sha(task),module,inputKind:'json-file',api,
    success:{exitCode:0,stdout:'single-json-newline',stderr:'empty'},arity,evidence:[paragraph,declaration.match[0]]};
}

function validContract(contract){
  if(!exact(contract,['schema','taskSha256','module','inputKind','api','success','arity','evidence'])
    ||contract.schema!=='bantam.cli-contract.v2'||!/^[a-f0-9]{64}$/.test(contract.taskSha256??'')
    ||!relative(contract.module)||! /\.[cm]?js$/.test(contract.module)||contract.inputKind!=='json-file'
    ||!exact(contract.api,['export','arguments'])||!identifier(contract.api.export)
    ||!Array.isArray(contract.api.arguments)||!names(contract.api.arguments.join(','))
    ||!contract.api.arguments.every(identifier)
    ||!exact(contract.success,['exitCode','stdout','stderr'])||contract.success.exitCode!==0
    ||contract.success.stdout!=='single-json-newline'||contract.success.stderr!=='empty'
    ||!Array.isArray(contract.evidence)||contract.evidence.length!==2||contract.evidence.some(v=>typeof v!=='string'||v.length>3000))return false;
  return contract.arity===null||(exact(contract.arity,['arguments','exitCode','stdout','stderr'])
    &&contract.arity.arguments===1&&Number.isInteger(contract.arity.exitCode)&&contract.arity.exitCode>=1&&contract.arity.exitCode<=255
    &&contract.arity.stdout==='empty'&&contract.arity.stderr==='nonempty');
}

export const CLI_ASSERTION_SPEC_SCHEMA={type:'object',additionalProperties:false,required:['module','input'],
  properties:{module:{type:'string',minLength:1,maxLength:240},input:{$ref:'#/$defs/value'}},$defs:ASSERTION_SPEC_SCHEMA.$defs};
export const CLI_ASSERTION_SPEC_GRAMMAR=String.raw`root ::= ws "{" ws "\"module\"" ws ":" ws string ws "," ws "\"input\"" ws ":" ws value ws "}" ws
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
    if(!exact(spec,['module','input'])||spec.module!==contract.module||!sourceSet(sourcePaths).has(spec.module)
      ||!object(spec.input)||!contract.api.arguments.every(name=>Object.hasOwn(spec.input,name))
      ||!jsonData(spec.input)||Buffer.byteLength(JSON.stringify(spec.input))>8192)return null;
    return spec;
  }catch{return null;}
}

const quote=text=>`'${text.replace(/'/g,`'"'"'`)}'`;
const node=code=>`node --input-type=module -e ${quote(code)}`;

// Child FD3 is the only API-return channel; candidate stdout is not authority.
// This mirrors the established API assertion child, without importing a model
// oracle or claiming to prove candidate semantics or hostile-code isolation.
const API_CHILD=String.raw`
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const emit=fs.writeSync.bind(fs),stringify=JSON.stringify.bind(JSON);
const {spec,contract,subject}=JSON.parse(process.env.BANTAM_CLI_REFERENCE);
const diagnostic=error=>({name:String(error?.name??'Error').slice(0,80),message:String(error?.message??error).slice(0,500),stack:String(error?.stack??'').slice(0,1000)});
const packet=(kind,value=null,error=null)=>emit(3,stringify({schema:'bantam.cli-api-reference.v1',module:spec.module,export:contract.api.export,kind,value,diagnostic:error===null?null:diagnostic(error)})+'\n');
function jsonOnly(value,depth=0,seen=new Set()){
 if(depth>16)return false;
 if(value===null||typeof value==='string'||typeof value==='boolean')return true;
 if(typeof value==='number')return Number.isFinite(value)&&!Object.is(value,-0);
 if(!value||typeof value!=='object'||seen.has(value))return false;
 if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)return false;
 seen.add(value);const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).some(k=>typeof k==='symbol'))return false;
 for(const [key,d]of Object.entries(descriptors)){
  if(Array.isArray(value)&&key==='length')continue;
  if(!d.enumerable||!Object.hasOwn(d,'value')||!jsonOnly(d.value,depth+1,seen))return false;
 }
 if(Array.isArray(value)&&(Object.keys(value).length!==value.length||Object.keys(value).some((key,i)=>key!==String(i))))return false;
 seen.delete(value);return true;
}
try{
 const module=await import(pathToFileURL(path.join(subject,spec.module)).href),fn=module[contract.api.export];
 if(typeof fn!=='function')throw Error('public API export is not callable');
 const args=contract.api.arguments.map(key=>spec.input[key]);
 let value;try{value=fn(...args);}catch(error){packet('threw',null,error);process.exit(0);}
 if(!jsonOnly(value))packet('unsupported',null,Error('synchronous public API returned a non-JSON value'));else packet('returned',value);
}catch(error){packet('infrastructure',null,error);}
`;

export function buildCliAssertionProbe(spec,{contract,inputs=[],question='Does the declared CLI preserve the measured public API result and explicit process rules for this input?'}={}){
  const normalized=inputs.map(input=>({p:typeof input==='string'?input:input?.p??input?.path}));
  if(normalized.length>16||normalized.some(i=>!relative(i.p))||new Set(normalized.map(i=>i.p)).size!==normalized.length
    ||typeof question!=='string'||!question.trim()||question.length>2000||!jsonData(spec?.input)
    ||!parseCliAssertionSpec(JSON.stringify(spec),{contract,sourcePaths:normalized}))throw Error('invalid CLI coherence spec or input binding');
  const data=Buffer.from(JSON.stringify({spec,contract})).toString('base64');
  const head=`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const {spec,contract}=JSON.parse(Buffer.from('${data}','base64').toString());
const root=path.join(process.cwd(),'case'),fixture=path.join(root,'input.json'),subject=path.join(process.cwd(),'subject'),module=path.join(subject,spec.module);
const LF=String.fromCharCode(10);
`;
  const setup=node(head+`fs.mkdirSync(root,{mode:0o755});fs.writeFileSync(fixture,JSON.stringify(spec.input)+LF,{flag:'wx',mode:0o644});console.log('CLI fixture created');`);
  const witness=node(head+`const f=fs.lstatSync(fixture),m=fs.lstatSync(module);assert.ok(f.isFile()&&!f.isSymbolicLink());assert.ok(m.isFile()&&!m.isSymbolicLink());assert.equal(fs.readFileSync(fixture,'utf8'),JSON.stringify(spec.input)+LF);console.log(JSON.stringify({schema:'bantam.cli-assertion-witness.v1',fixture:true,entrypoint:true}));`);
  const check=node(head+`import {spawnSync} from 'node:child_process';import crypto from 'node:crypto';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const options={cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe'],timeout:2000,killSignal:'SIGKILL',maxBuffer:16384};
const measure=result=>{const m={status:Number.isInteger(result.status)?result.status:null,signal:result.signal??null,error:result.error?String(result.error.code??result.error.message):null};
 for(const [name,b]of [['stdout',result.stdout??Buffer.alloc(0)],['stderr',result.stderr??Buffer.alloc(0)]])Object.assign(m,{[name+'Bytes']:b.length,[name+'Sha256']:sha(b),[name+'Base64']:b.toString('base64')});return m;};
const api=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(API_CHILD)}],{...options,env:{...options.env,BANTAM_CLI_REFERENCE:JSON.stringify({spec,contract,subject})},stdio:['ignore','pipe','pipe','pipe']});
const outcomeBytes=api.output?.[3]??Buffer.alloc(0),reference={...measure(api),outcomeBytes:outcomeBytes.length,outcomeSha256:sha(outcomeBytes),outcomeBase64:outcomeBytes.toString('base64'),result:'unavailable'};
let outcome;
try{
 assert.equal(api.error,undefined);assert.equal(api.signal,null);assert.equal(api.status,0);assert.ok(outcomeBytes.length<=16384);
 assert.equal(api.stdout.length,0,'API reference wrote stdout');assert.equal(api.stderr.length,0,'API reference wrote stderr');
 outcome=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(outcomeBytes));
 assert.deepStrictEqual(Object.keys(outcome).sort(),['diagnostic','export','kind','module','schema','value']);
 assert.equal(outcome.schema,'bantam.cli-api-reference.v1');assert.equal(outcome.module,spec.module);assert.equal(outcome.export,contract.api.export);
 assert.equal(outcome.kind,'returned','API reference '+String(outcome.kind)+': '+String(outcome.diagnostic?.message??'no supported JSON return')+' '+String(outcome.diagnostic?.stack??'').slice(0,180));assert.equal(outcome.diagnostic,null);
 reference.result='returned';
}catch(error){reference.reason=String(error.message).slice(0,500);}
const outcomes=[];
if(reference.result==='returned'){
 const cases=[{name:'valid-input',args:[fixture]},...(contract.arity?[{name:'missing-argument',args:[]},{name:'extra-argument',args:[fixture,fixture]}]:[])];
 for(const item of cases){
  const result=spawnSync(process.execPath,[module,...item.args],options),measured={case:item.name,...measure(result)};
  if(result.error||result.signal||!Number.isInteger(result.status)){outcomes.push({...measured,result:'unavailable'});continue;}
  try{
   if(item.name==='valid-input'){
    assert.equal(result.status,contract.success.exitCode);assert.equal(result.stderr.length,0);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result.stdout);
    assert.ok(text.endsWith(LF),'stdout must end in a newline');assert.deepStrictEqual(JSON.parse(text.slice(0,-1)),outcome.value);
   }else{assert.equal(result.status,contract.arity.exitCode);assert.equal(result.stdout.length,0);assert.ok(result.stderr.length>0,'stderr must be nonempty');}
   outcomes.push({...measured,result:'passed'});
  }catch(error){outcomes.push({...measured,result:'failed',reason:String(error.message).slice(0,500)});}
 }
}
const status=reference.result!=='returned'||outcomes.some(x=>x.result==='unavailable')?'unavailable':outcomes.some(x=>x.result==='failed')?'failed':'complete';
console.log(JSON.stringify({schema:'bantam.cli-assertion-check.v2',status,reference,cases:outcomes}));process.exitCode=status==='unavailable'?125:status==='failed'?1:0;
`);
  for(const c of [setup,witness,check])if(c.length>24000)throw Error('CLI coherence assertion exceeds existing probe command limit');
  return {a:'probe',question,inputs:normalized,setup,witness,check};
}
