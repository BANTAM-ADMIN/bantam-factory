// Narrow public-contract adapter for synchronous byte-stream factory APIs.
// A recognized public protocol has a mechanical fixture adapter; other explicit
// cases use reviewed model-designed data. No benchmark names or grader inputs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {CHATML_TEMPLATE} from './profiles.js';
import {canonicalEncode} from './factory/fact-fabric.js';
import {readBoundInputs, validateAssertionProbeReceipt} from './contract-assertion-station.js';
import {runProbe} from './probe.js';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const digest = x => `sha256:${sha(canonicalEncode(x))}`;
const keys = ['module','export','validText','expectedJson','terminalSuffix'];
export const STREAM_SPEC_SCHEMA = {type:'object',additionalProperties:false,required:keys,
  properties:Object.fromEntries(keys.map(k=>[k,{type:'string',minLength:1,maxLength:k==='expectedJson'?1000:256}]))};
export const STREAM_SPEC_GRAMMAR = String.raw`
root ::= "{" ws "\"module\"" ws ":" ws str ws "," ws "\"export\"" ws ":" ws str ws "," ws "\"validText\"" ws ":" ws str ws "," ws "\"expectedJson\"" ws ":" ws str ws "," ws "\"terminalSuffix\"" ws ":" ws str ws "}" ws
str ::= "\"" ch{1,1000} "\""
ch ::= [^"\\\x00-\x1f\x7f] | "\\" (["\\/bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
ws ::= [ \t\r\n]*
`;
export function streamObligations(task) {
  if(typeof task!=='string'||task.length>12000
    ||! /push\(chunk:\s*Uint8Array\)/.test(task)||! /finish\(\)\s*->\s*\[\]/.test(task)
    ||! /strict UTF-8/.test(task)||! /rejected push\/finish poisons/.test(task)) return [];
  return ['chunk-partitions','strict-utf8','terminal-state','rejection-state',
    ...(/chunks:\[BASE64_STRING/.test(task)&&/canonical standard padded base64/.test(task)?['canonical-cli']:[])];
}
export function parseStreamSpec(raw,sources) {
  try {
    if(typeof raw!=='string'||raw.length>5000)return null;
    const s=JSON.parse(raw);
    const normalized=raw.replace(/"(?:\\.|[^"\\])*"|\s+/g,t=>t.startsWith('"')?JSON.stringify(JSON.parse(t)):'');
    if(normalized!==JSON.stringify(s)||Object.keys(s).join(',')!==keys.join(',')
      ||keys.some(k=>typeof s[k]!=='string'||!s[k].length||s[k].length>(k==='expectedJson'?1000:256))
      ||!sources.some(x=>x.path===s.module)||!/^\w[\w./-]*\.[cm]?js$/.test(s.module)
      ||s.module.split('/').includes('..')||! /^[A-Za-z_$][\w$]*$/.test(s.export)
      ||Buffer.byteLength(s.validText)>256||! /[^\x00-\x7f]/.test(s.validText)
      ||!s.validText.endsWith('\n')||!s.terminalSuffix.endsWith('\n'))return null;
    const expected=JSON.parse(s.expectedJson);
    if(!Array.isArray(expected)||expected.length<1||expected.length>8
      ||expected.some(x=>!x||Object.keys(x).sort().join(',')!=='data,event'||typeof x.data!=='string'||typeof x.event!=='string'))return null;
    return s;
  }catch{return null;}
}

export function streamFixtureIssue(spec,task){
  const marker=task.match(/exactly\s+`([^`\r\n]+)`[\s\S]{0,100}?stream terminated/i)?.[1];
  if(marker&&!spec.validText.includes(marker))return 'The proposed complete stream omits the public contract termination marker '+JSON.stringify(marker)+'.';
  return null;
}

// Deliberately narrow adapter, selected by explicit public protocol clauses.
// This constructs a fixture, NOT an implementation of the requested decoder.
// Neither source contents nor benchmark/grader identity supplies an oracle.
export function deriveLineStreamFixture(task,sources){
  if(typeof task!=='string'||!streamObligations(task).length)return null;
  const clauses=[/Lines end at LF or CRLF/i,/Join data-field values with exactly one LF between them/i,
    /`message` if none was\s+supplied/i,/Otherwise split at the first `:`/i,
    /Remove at most one leading ASCII space/i,/After that marker, only blank lines are allowed/i,
    /line beginning with `:` is a comment/i];
  if(!clauses.every(re=>re.test(task)))return null;
  const marker=task.match(/joined data value of a dispatched frame is exactly\s+`([^`\r\n]{1,80})`,\s*mark\s+the stream terminated and emit no frame for it/i)?.[1];
  const exported=task.match(/Export\s+`([A-Za-z_$][\w$]*)\(\)`/)?.[1];
  const named=sources.filter(s=>typeof s.path==='string'&&task.includes('`'+s.path+'`')&&/\.[cm]?js$/.test(s.path));
  if(!marker||!exported||named.length!==1)return null;
  const data=marker==='jig-é😀'?'jig-é😀!':'jig-é😀';
  const spec={module:named[0].path,export:exported,validText:`data: ${data}\r\n\r\ndata: ${marker}\n\n`,
    expectedJson:JSON.stringify([{event:'message',data}]),terminalSuffix:': jig\n'};
  if(!parseStreamSpec(JSON.stringify(spec),sources))return null;
  const framingClauses=[/Other CR characters remain data/i,/Strip\s+the one CR immediately preceding LF/i,
    /A blank line dispatches the current frame only if it has at least one data\s+field/i,
    /`push` returns only frames completed during that call/i];
  const lineFraming=framingClauses.every(re=>re.test(task))?{marker,clauses:framingClauses.map(re=>task.match(re)[0])}:null;
  return {spec,authority:'public-line-stream-adapter-v1',taskSha256:sha(task),lineFraming,
    clauses:[...clauses.map(re=>task.match(re)[0]),task.match(/joined data value of a dispatched frame is exactly\s+`([^`\r\n]{1,80})`,\s*mark\s+the stream terminated and emit no frame for it/i)[0]]};
}
const REVIEW_SCHEMA={type:'object',additionalProperties:false,required:['valid','reason'],properties:{valid:{type:'boolean'},reason:{type:'string',maxLength:500}}};
const REVIEW_GRAMMAR=String.raw`root ::= "{" ws "\"valid\"" ws ":" ws ("true" | "false") ws "," ws "\"reason\"" ws ":" ws str ws "}" ws
str ::= "\"" ch{0,500} "\""
ch ::= [^"\\\x00-\x1f\x7f] | "\\" (["\\/bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
ws ::= [ \t\r\n]*`;

// Fixed jig runs in a separate child inside the existing offline probe sandbox.
// The parent requires fd3 completion, so candidate process.exit(0) is not PASS.
const CHILD = String.raw`
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const write=fs.writeSync.bind(fs),stringify=JSON.stringify.bind(JSON);
const {spec:s,obligation:id,bom,lineFraming}=JSON.parse(process.env.BANTAM_STREAM_CASE);
let calls=0,traceDropped=0,phase='infrastructure',caseContext='module import',cli=null;
// Diagnostic pipe saturation is not a failure of the candidate protocol.
// Keep the fd3 completion receipt mandatory; only best-effort markers may drop.
const mark=x=>{try{write(2,x+'\n');}catch(e){if(e.code!=='EAGAIN')throw e;traceDropped++;}};
try{
 const m=await import(pathToFileURL(path.join(process.cwd(),'subject',s.module)));
 if(typeof m[s.export]!=='function')throw Error('export is not callable');
 phase='checking';
 const make=()=>{const d=m[s.export]();assert.equal(typeof d?.push,'function');assert.equal(typeof d?.finish,'function');return d;};
 const bytes=Buffer.from(s.validText),expected=JSON.parse(s.expectedJson);
 const push=(d,b)=>{mark('before push '+calls+++' prefix='+Buffer.from(b instanceof Uint8Array?b:[]).subarray(0,12).toString('hex'));const x=d.push(b);mark('after push');return x;};
 const finish=d=>{mark('before finish');const x=d.finish();mark('after finish');return x;};
 const decode=(chunks,label='whole valid fixture')=>{caseContext=label+'; chunksHex='+JSON.stringify(chunks.map(b=>Buffer.from(b).toString('hex')));const d=make(),out=[];for(const b of chunks)out.push(...push(d,b));assert.deepEqual(finish(d),[]);assert.deepEqual(out,expected);};
 phase='positive-control';decode([bytes]);phase='checking'; // Do not attribute a bad positive fixture to five separate obligations.
 if(id==='chunk-partitions'){
  if(lineFraming){
   const terminal='data: '+lineFraming.marker+'\n\n';
   const check=(label,chunks,outputs)=>{const d=make();for(let i=0;i<chunks.length;i++){
    caseContext=label+'; push index='+i+'; chunks='+stringify(chunks)+'; expected per-push='+stringify(outputs);
    assert.deepEqual(push(d,Buffer.from(chunks[i])),outputs[i]);
   }assert.deepEqual(finish(d),[]);};
   const frame=data=>[{event:'message',data}];
   check('embedded CR is data',['data: jig-é\rinside\n\n'+terminal],[frame('jig-é\rinside')]);
   check('split CRLF between data fields',['data: jig-é\r','\ndata: second\r','\n','\r','\n',terminal],
    [[],[],[],[],frame('jig-é\nsecond'),[]]);
   check('embedded CR at chunk edge',['data: jig-é\r','inside\n','\n',terminal],
    [[],[],frame('jig-é\rinside'),[]]);
  }
  for(const b of [bytes,...(bom?[Buffer.concat([Buffer.from([239,187,191]),bytes])]:[])]){
   const prefix=b===bytes?'without BOM':'with leading BOM';
   for(let i=0;i<=b.length;i++)decode([b.subarray(0,i),b.subarray(i)],prefix+'; two-part split='+i+'/'+b.length);
   decode([...b].map(x=>Uint8Array.of(x)),prefix+'; one-byte chunks');
  }
 }else if(id==='strict-utf8'){
  caseContext='fresh decoder; push invalid UTF-8 byte ff must throw';
  assert.throws(()=>push(make(),Uint8Array.of(255)),Error);
  caseContext='valid terminated stream followed by incomplete UTF-8 c3; final flush must throw';
  const d=make();push(d,bytes);push(d,Uint8Array.of(195));assert.throws(()=>finish(d),Error);
 }else if(id==='terminal-state'){
  caseContext='valid terminated stream followed by forbidden line '+stringify(s.terminalSuffix);
  const d=make();push(d,bytes);assert.throws(()=>push(d,Buffer.from(s.terminalSuffix)),Error);
  caseContext='successful finish followed by empty push and repeated finish must reject';
  const e=make();push(e,bytes);finish(e);assert.throws(()=>push(e,new Uint8Array()),Error);assert.throws(()=>finish(e),Error);
 }else if(id==='rejection-state'){
  for(const [name,trigger] of [['wrong-type push',d=>push(d,'invalid type')],['premature finish',d=>finish(d)],['invalid UTF-8 push',d=>push(d,Uint8Array.of(255))]]){
   caseContext=name+' must reject, then poison valid push and finish on SAME instance';
   const d=make();assert.throws(()=>trigger(d),Error);assert.throws(()=>push(d,bytes),Error);assert.throws(()=>finish(d),Error);decode([bytes]);
  }
 }else if(id==='canonical-cli'){
  const file=path.join(process.cwd(),'case.json'),entry=path.join(process.cwd(),'subject',s.module);
  const run=(chunks,label,expectedResult)=>{caseContext=label;const input={chunks:[...chunks]};fs.writeFileSync(file,stringify(input));const r=spawnSync(process.execPath,[entry,file],{encoding:'utf8',timeout:1500,maxBuffer:16384});
   const bounded=x=>({text:String(x??'').slice(0,400),truncated:String(x??'').length>400});
   cli={command:['node',s.module,'case.json'],input,expected:expectedResult,actual:{status:r.status,signal:r.signal,error:r.error?String(r.error.message).slice(0,200):null,stdout:bounded(r.stdout),stderr:bounded(r.stderr)}};return r;};
  const chunks=[bytes.subarray(0,1).toString('base64'),bytes.subarray(1).toString('base64')];
  let r=run(chunks,'CLI canonical valid input',{status:0,stdout:stringify({frames:expected})+'\n',stderr:''});assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0);assert.equal(r.stderr,'');assert.equal(r.stdout,stringify({frames:expected})+'\n');
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  chunks[0]=chunks[0][0]+alphabet[alphabet.indexOf(chunks[0][1])+1]+'=='; // Nonzero pad bits; same decoded byte.
  r=run(chunks,'CLI noncanonical pad bits',{status:2,stdout:'',stderr:'nonempty'});assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.ok(r.stderr.length>0);
 }else throw Error('unknown obligation');
 write(3,stringify({status:'passed',calls,traceDropped})+'\n');
}catch(e){write(3,stringify({status:phase==='checking'?'failed':'unavailable',caseContext:caseContext.slice(0,900),...(cli?{cli}:{}),message:String(e?.message??e).slice(0,1000),calls,traceDropped})+'\n');}
`;
const quote=s=>`'${s.replace(/'/g,`'"'"'`)}'`;
export function buildStreamProbe(spec,obligation,inputs,{bom=false,lineFraming=null}={}) {
  if(!parseStreamSpec(JSON.stringify(spec),inputs.map(x=>({path:x.p})))
    ||!['chunk-partitions','strict-utf8','terminal-state','rejection-state','canonical-cli'].includes(obligation))throw Error('invalid stream probe');
  if(lineFraming&&(!/^[^\r\n]{1,80}$/.test(lineFraming.marker)||typeof lineFraming.marker!=='string'))throw Error('invalid framing marker');
  const payload=Buffer.from(JSON.stringify({spec,obligation,bom,lineFraming})).toString('base64');
  const code=`import {spawnSync} from 'node:child_process';
const r=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(CHILD)}],{env:{...process.env,BANTAM_STREAM_CASE:Buffer.from('${payload}','base64').toString()},timeout:4000,maxBuffer:262144,stdio:['ignore','pipe','pipe','pipe']});
let x;try{x=JSON.parse(r.output[3]?.toString()??'');}catch{}
if(r.error||r.signal||r.status!==0||!x||!['passed','failed'].includes(x.status)||!Number.isSafeInteger(x.calls)){console.error('UNAVAILABLE: '+JSON.stringify(x??null)+'; child incomplete or positive fixture/implementation disagreement; last call markers: '+r.stderr?.toString().slice(-500));process.exit(125);}
console.log(JSON.stringify(x));if(x.status!=='passed'){console.error(r.stderr?.toString().slice(-800));process.exit(1);}`;
  return {a:'probe',question:`Does the declared public stream fixture satisfy ${obligation}?`,inputs:inputs.map(({p})=>({p})),
    setup:"node -e 'process.exit(0)'",witness:"node -e 'process.exit(0)'",check:`node --input-type=module -e ${quote(code)}`};
}

export async function runStreamObligationStation({workspace,model,task,sources,generation,signal,dockerImage,processRunner,
  proposalCache=new Map(),runExperiment=runProbe}) {
  const obligations=streamObligations(task),receipt={schema:'bantam.stream-obligations.v1',generation,taskSha256:sha(task),
    status:'unverified',sources:sources.map(({path,sha256})=>({path,sha256})),obligations:obligations.map(id=>({id,status:'unverified'})),
    authority:'model-designed-fixture-controller-executed',candidateVerified:false};
  try{
    if(!obligations.length)throw Error('unsupported contract');
    const inputs=readBoundInputs(fs.realpathSync(workspace),sources);receipt.inputs=inputs;receipt.inputDigest=digest(inputs);
    const derived=deriveLineStreamFixture(task,sources);
    const key=sha(task+JSON.stringify(sources.map(s=>s.path)));const cached=proposalCache.get(key);
    let spec=derived?.spec??(cached?.review?.valid===true?cached.spec:null);
    if(derived){receipt.authority=derived.authority;receipt.fixtureDerivation=derived;
      receipt.fixtureReview={valid:true,authority:derived.authority,reason:'Mechanically constructed from matched public clauses; no model-designed protocol fixture.'};}
    else if(spec)receipt.fixtureReview=cached.review;
    if(!spec){
      const template=model.template??CHATML_TEMPLATE;
      const scrub=s=>String(s).replace(template.control??CHATML_TEMPLATE.control,t=>t.replace(/[<|>/]/g,''));
      const prompt=template.open('system')+'Design fixture DATA for a byte-stream verification jig. No tools or code. Derive expected output ONLY from the public contract, never candidate implementation. Return the constrained JSON object.'+template.close
        +template.open('user')+'Return module,export,validText,expectedJson,terminalSuffix in that order. Choose the actual exported decoder factory and source module from the public task and supplied path list. validText is a SHORT complete valid protocol stream including required termination, with at least one multibyte data character and CRLF. expectedJson is a JSON array of the exact expected {event,data} frames, excluding termination. terminalSuffix is a short nonblank line explicitly forbidden after termination. No BOM in validText; the jig separately prepends one when allowed. Keep the fixture under 256 UTF-8 bytes. The fixed jig varies byte partitions and exercises strict UTF-8, termination, rejection poisoning and canonical CLI encoding.\nPUBLIC TASK:\n'+scrub(task)+'\nSOURCE PATHS:\n'+scrub(JSON.stringify(sources.map(s=>s.path)))+template.close+template.open(template.assistantRole??'assistant');
      receipt.promptSha256=sha(prompt);
      receipt.proposals=[];let issue='';
      for(let attempt=0;attempt<2;attempt++){
        const proposedPrompt=issue?prompt.replace('\nPUBLIC TASK:\n','\nPrevious fixture rejected before execution: '+scrub(issue)+' Return a corrected complete JSON fixture.\nPUBLIC TASK:\n'):prompt;
        const output=await model.complete(proposedPrompt,{grammar:STREAM_SPEC_GRAMMAR,jsonSchema:STREAM_SPEC_SCHEMA,nPredict:1200,temperature:0,retries:0,
          signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),recordLabel:'stream-obligation-fixture'});
        receipt.tokens=(receipt.tokens??0)+(output.tokens??0);receipt.rawProposal=output.content;
        spec=output.stoppedLimit?null:parseStreamSpec(output.content,sources);
        issue=spec?streamFixtureIssue(spec,task):'Invalid bounded fixture: include complete newline-terminated validText and terminalSuffix.';
        const proposal={promptSha256:sha(proposedPrompt),raw:output.content,issue};receipt.proposals.push(proposal);
        if(issue)continue;
        const reviewPrompt=template.open('system')+'Independently review fixture DATA against a public contract. No candidate implementation is supplied. Return only {"valid":BOOLEAN,"reason":STRING}. Do not infer validity from the proposer.'+template.close
          +template.open('user')+'Trace the literal stream and verify required termination, exact expected frames, multibyte data and a COMPLETE line forbidden after termination. Check expectedJson character-for-character against the public rules. Reject incomplete fixtures or incorrect expected values.\nPUBLIC TASK:\n'+scrub(task)+'\nPROPOSED FIXTURE:\n'+scrub(JSON.stringify(spec))+template.close+template.open(template.assistantRole??'assistant');
        const reviewed=await model.complete(reviewPrompt,{grammar:REVIEW_GRAMMAR,jsonSchema:REVIEW_SCHEMA,nPredict:700,temperature:0,retries:0,
          signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),recordLabel:'stream-obligation-fixture-review'});
        receipt.tokens+=(reviewed.tokens??0);let review;try{review=JSON.parse(reviewed.content);}catch{}
        proposal.review={promptSha256:sha(reviewPrompt),raw:reviewed.content};
        if(reviewed.stoppedLimit||!review||Object.keys(review).sort().join(',')!=='reason,valid'||typeof review.valid!=='boolean'||typeof review.reason!=='string'||review.reason.length>500){issue='Fixture review unavailable';continue;}
        receipt.fixtureReview={...review,promptSha256:sha(reviewPrompt)};
        if(!review.valid){issue=review.reason;continue;}
        issue='';proposalCache.set(key,{spec,review:receipt.fixtureReview});break;
      }
      if(issue||!spec||receipt.fixtureReview?.valid!==true)throw Error('Fixture not admitted: '+issue);
    }
    receipt.spec=spec;receipt.specSha256=digest(spec);
    for(const row of receipt.obligations){
      signal?.throwIfAborted();
      if(digest(readBoundInputs(fs.realpathSync(workspace),sources))!==receipt.inputDigest)throw Error('source changed');
      const action=buildStreamProbe(spec,row.id,inputs,{bom:/leading UTF-8 BOM is ignored/.test(task),lineFraming:derived?.lineFraming});
      const result=await runExperiment(workspace,action,{signal,dockerImage,processRunner,timeoutMs:10000});
      row.probeEvidence=result?.probeEvidence;
      const projection=validateAssertionProbeReceipt(row.probeEvidence,{action,inputs});
      row.status=projection?.status==='assertion_passed'?'passed':projection?.status==='assertion_failed'?'failed':'unverified';
      row.probeSpecDigest=digest(action);
    }
    if(digest(readBoundInputs(fs.realpathSync(workspace),sources))!==receipt.inputDigest)throw Error('source changed');
    receipt.sourceUnchanged=true;
    receipt.status=receipt.obligations.every(x=>x.status==='passed')?'passed':'unverified';
  }catch(e){if(signal?.aborted)throw e;receipt.reason=String(e?.message??e).slice(0,300);}
  return receipt;
}
export function streamObligationDecision(task,receipt,generation){
  const ids=streamObligations(task);if(!ids.length)return null;
  const current=receipt?.schema==='bantam.stream-obligations.v1'&&receipt.generation===generation&&receipt.taskSha256===sha(task);
  const valid = (()=>{try{return current && receipt.sourceUnchanged && receipt.fixtureReview?.valid===true && Array.isArray(receipt.inputs) && receipt.spec
    && (receipt.authority!=='public-line-stream-adapter-v1'
      || (JSON.stringify(deriveLineStreamFixture(task,receipt.inputs.map(x=>({path:x.p}))))===JSON.stringify(receipt.fixtureDerivation)
        && JSON.stringify(receipt.spec)===JSON.stringify(receipt.fixtureDerivation.spec)))
    && receipt.inputDigest===digest(receipt.inputs) && receipt.specSha256===digest(receipt.spec)
    && parseStreamSpec(JSON.stringify(receipt.spec),receipt.inputs.map(x=>({path:x.p})))
    && receipt.obligations?.length===ids.length && ids.every((id,i)=>{
      const row=receipt.obligations[i];if(row?.id!==id)return false;
      const action=buildStreamProbe(receipt.spec,id,receipt.inputs,{bom:/leading UTF-8 BOM is ignored/.test(task),
        lineFraming:deriveLineStreamFixture(task,receipt.inputs.map(x=>({path:x.p})))?.lineFraming});
      return row.probeSpecDigest===digest(action)
        && validateAssertionProbeReceipt(row.probeEvidence,{action,inputs:receipt.inputs})?.status==='assertion_passed';
    });}catch{return false;}})();
  if(valid)return null;
  const rows=ids.map(id=>`${id}: ${current?receipt.obligations?.find(x=>x.id===id)?.status??'unverified':'unverified (no current receipt)'}`);
  const failures=current?(receipt.obligations??[]).filter(x=>x.status!=='passed').sort((a,b)=>(b.id==='canonical-cli')-(a.id==='canonical-cli')).map(x=>{
    const s=x.probeEvidence?.stages?.find(s=>s.stage==='check');return `${x.id}: ${(s?.stdout||s?.stderr||'execution unavailable').slice(0,x.id==='canonical-cli'?2400:700)}`;
  }).join('\n').slice(0,3200):'';
  const header='CONTRACT AUDIT PHASE: stream obligations remain; CLI/project green cannot discharge different API obligations.\n'+rows.join('\n');
  const footer='\nReproduce the reported case against the PUBLIC contract, repair demonstrated defects, then run the configured verifier. CLI command runs from the source root with the reported JSON saved as case.json. Fixture expectations do not prove the whole contract.';
  const fixture=current&&receipt.spec?'\nDeclared fixture: '+JSON.stringify(receipt.spec).slice(0,650):'';
  const issue=current&&receipt.reason?'\nStation issue: '+receipt.reason:'';
  const budget=2400-header.length-footer.length-1;
  const evidence=failures+issue;
  const body=evidence.length>budget?evidence.slice(0,budget-28)+'\n[more in raw probe receipt]':evidence;
  return {schema:1,phase:'focused',generation,text:header+'\n'+body+(body.length+fixture.length<=budget?fixture:'')+footer};
}
