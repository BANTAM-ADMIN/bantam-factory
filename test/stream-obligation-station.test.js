import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {streamObligations,parseStreamSpec,buildStreamProbe,runStreamObligationStation,streamObligationDecision,streamFixtureIssue,deriveLineStreamFixture} from '../src/stream-obligation-station.js';
import {canonicalEncode} from '../src/factory/fact-fabric.js';
import {lexicalContractAuditMessage} from '../src/completion-audit.js';
import {verificationWorkflowPromptText} from '../src/contract-audit-phase.js';
const task='Export createDecoder(). push(chunk: Uint8Array) -> frames; finish() -> []. Decode strict UTF-8. Any rejected push/finish poisons the instance. One optional leading UTF-8 BOM is ignored. CLI receives chunks:[BASE64_STRING,...] in JSON with canonical standard padded base64.';
const spec={module:'api.mjs',export:'createDecoder',validText:'é\nEND\n',expectedJson:'[{"event":"message","data":"é"}]',terminalSuffix:'bad\n'};
const source=`import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export function createDecoder(){let text='',ended=false,finished=false,poisoned=false;const utf=new TextDecoder('utf-8',{fatal:true});return {
push(chunk){try{if(poisoned||finished)throw Error('closed');if(!(chunk instanceof Uint8Array))throw Error('type');text+=utf.decode(chunk,{stream:true});const out=[];while(text.includes('\\n')){const i=text.indexOf('\\n'),line=text.slice(0,i);text=text.slice(i+1);if(ended&&line)throw Error('after end');if(line==='END')ended=true;else if(line)out.push({event:'message',data:line});}return out;}catch(e){poisoned=true;throw e;}},
finish(){try{if(poisoned||finished)throw Error('closed');text+=utf.decode();if(!ended||text)throw Error('incomplete');finished=true;return [];}catch(e){poisoned=true;throw e;}}
};}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),d=createDecoder(),frames=[];for(const s of input.chunks){const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)throw Error('canonical');frames.push(...d.push(b));}frames.push(...d.finish());console.log(JSON.stringify({frames}));}catch(e){console.error(e.message);process.exitCode=2;}}`;
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const digest=x=>`sha256:${sha(canonicalEncode(x))}`;
const LINE_TASK=task+' Repair `api.mjs`. Export `createDecoder()`. Lines end at LF or CRLF. Join data-field values with exactly one LF between them. Default is `message` if none was supplied. Otherwise split at the first `:`. Remove at most one leading ASCII space. After that marker, only blank lines are allowed. A line beginning with `:` is a comment. When the joined data value of a dispatched frame is exactly `[STOP]`, mark the stream terminated and emit no frame for it.';
function fixture(t,code=source){const root=fs.mkdtempSync(path.join(os.tmpdir(),'stream-jig-'));fs.mkdirSync(path.join(root,'subject'));fs.writeFileSync(path.join(root,'subject/api.mjs'),code);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function execute(root,id){const action=buildStreamProbe(spec,id,[{p:'api.mjs'}],{bom:true});return spawnSync('/bin/sh',['-c',action.check],{cwd:root,encoding:'utf8',timeout:7000});}
test('five actual jigs accept a correct independent toy protocol',t=>{const root=fixture(t);for(const id of streamObligations(task)){const r=execute(root,id);assert.equal(r.status,0,`${id}: ${r.stdout} ${r.stderr}`);}});
test('diagnostic EAGAIN cannot turn a correct protocol into a failure or hide a real failure',t=>{
 const replacement='((fd,...args)=>{if(fd===2){const e=Error();e.code=String.fromCharCode(69,65,71,65,73,78);throw e;}return fs.writeSync(fd,...args);})';
 for(const [code,expected]of [[source,0],[source.replace('{fatal:true}','{fatal:false}'),1]]){
  const root=fixture(t,code),action=buildStreamProbe(spec,'strict-utf8',[{p:'api.mjs'}],{bom:true});
  const check=action.check.replace('fs.writeSync.bind(fs)',replacement);
  assert.notEqual(check,action.check);
  const r=spawnSync('/bin/sh',['-c',check],{cwd:root,encoding:'utf8',timeout:7000});
  assert.equal(r.status,expected,r.stdout+r.stderr);
  assert.ok(JSON.parse(r.stdout).traceDropped>0);
 }
});
test('mutation checks discriminate strict decoding, termination, poison, BOM, and canonical bits',t=>{
 const variants=[['strict-utf8',source.replace('{fatal:true}','{fatal:false}')],
 ['terminal-state',source.replace("if(ended&&line)throw Error('after end');",'')],
 ['rejection-state',source.replaceAll('poisoned=true;throw e;','throw e;')],
 ['chunk-partitions',source.replace("{fatal:true}",'{fatal:true,ignoreBOM:true}')],
 ['canonical-cli',source.replace("if(b.toString('base64')!==s)throw Error('canonical');",'')]];
 for(const [id,code]of variants){const r=execute(fixture(t,code),id);assert.equal(r.status,1,`${id}: ${r.stdout} ${r.stderr}`);
 if(id==='chunk-partitions'){const outcome=JSON.parse(r.stdout);assert.match(outcome.caseContext,/with leading BOM; two-part split=0/);assert.match(outcome.caseContext,/efbbbf/);}}
});
test('missing fd3 completion and synchronous hangs are unavailable, not passes',t=>{
 for(const code of ['process.exit(0);', 'export function createDecoder(){while(true){}}']){
  const r=execute(fixture(t,code),'chunk-partitions');assert.equal(r.status,125);assert.match(r.stderr,/UNAVAILABLE/);
 }
});
test('CLI failures deliver reproducible input and actual process evidence into repair context',t=>{
 const variants=[
  [source.replace("if(b.toString('base64')!==s)throw Error('canonical');","throw Error('valid input rejected');"),'CLI canonical valid input',2,'valid input rejected\n',0],
  [source.replace("if(b.toString('base64')!==s)throw Error('canonical');",''),'CLI noncanonical pad bits',0,'',2],
 ];
 for(const [code,label,status,stderr,expectedStatus] of variants){
  const r=execute(fixture(t,code),'canonical-cli');assert.equal(r.status,1);
  const outcome=JSON.parse(r.stdout);assert.equal(outcome.caseContext,label);
  assert.equal(outcome.cli.actual.status,status);assert.equal(outcome.cli.actual.stderr.text,stderr);
  assert.equal(outcome.cli.actual.signal,null);assert.equal(outcome.cli.actual.error,null);
  assert.equal(outcome.cli.expected.status,expectedStatus);
  assert.deepEqual(outcome.cli.command,['node','api.mjs','case.json']);
  assert.equal(Buffer.concat(outcome.cli.input.chunks.map(s=>Buffer.from(s,'base64'))).toString(),spec.validText);
  const receipt={schema:'bantam.stream-obligations.v1',generation:1,taskSha256:sha(task),spec,
   obligations:streamObligations(task).map(id=>({id,status:id==='canonical-cli'?'failed':'passed',
    probeEvidence:{stages:[{stage:'check',stdout:id==='canonical-cli'?r.stdout:'',stderr:''}]}}))};
  const decision=streamObligationDecision(task,receipt,1);
  assert.ok(decision.text.includes(JSON.stringify(outcome.cli)),'complete CLI evidence must survive context rendering');
  assert.ok(verificationWorkflowPromptText(decision).includes(JSON.stringify(outcome.cli)),'real prompt validator must retain CLI evidence');
  receipt.obligations.forEach(row=>{row.status='failed';row.probeEvidence.stages[0].stdout=row.id==='canonical-cli'?r.stdout:'x'.repeat(2000);});
  const crowded=streamObligationDecision(task,receipt,1);
  assert.ok(crowded.text.length<=2400);assert.ok(verificationWorkflowPromptText(crowded).includes(JSON.stringify(outcome.cli)));
 }
});
test('bounded declarative schema rejects unsafe paths, extra keys, duplicate keys and bad expectations',()=>{
 assert.ok(parseStreamSpec(JSON.stringify(spec),[{path:'api.mjs'}]));
 for(const s of [{...spec,module:'../api.mjs'},{...spec,expectedJson:'null'},{...spec,extra:1},{...spec,validText:'a'.repeat(257)}])assert.equal(parseStreamSpec(JSON.stringify(s),[{path:s.module}]),null);
 assert.equal(parseStreamSpec(JSON.stringify(spec).replace('"export":','"module":"evil","export":'),[{path:'api.mjs'}]),null);
 assert.deepEqual(streamObligations('Build a stream player'),[]);
});
test('negative trimming language cannot override canonical input',()=>{
 assert.equal(lexicalContractAuditMessage('Values are not parsed as JSON or trimmed. Require canonical standard padded base64.'),'');
 assert.match(lexicalContractAuditMessage('Names are trimmed; payload uses canonical base64.'),/Preserve explicit canonical-encoding requirements/);
});
test('station reuses fixture data but reexecutes and verifies bound receipts; stale or tampered evidence cannot clear obligations',async t=>{
 const root=fixture(t);fs.copyFileSync(path.join(root,'subject/api.mjs'),path.join(root,'api.mjs'));
 const sources=[{path:'api.mjs',text:source,sha256:sha(source)}],cache=new Map();let proposals=0,executions=0;
 const model={async complete(prompt,options){assert.doesNotMatch(prompt,/const utf=|worker history/);if(options.recordLabel==='stream-obligation-fixture-review')return {content:JSON.stringify({valid:true,reason:'toy protocol fixture checked'}),tokens:10};proposals++;return {content:JSON.stringify(spec),tokens:100};}};
 const runExperiment=async(workspace,action)=>{executions++;const inputs=[{p:'api.mjs',size:Buffer.byteLength(source),sha256:sha(source),mode:fs.statSync(path.join(root,'api.mjs')).mode&511}];const sourceDigest=digest(inputs),experimentId='probe:test';
 return {probeEvidence:{schema:'bantam.probe-receipt.v1',experimentId,specDigest:digest(action),sourceDigest,sourceAfterDigest:sourceDigest,sourceAfterError:null,question:action.question,inputs,
 stages:['setup','witness','check'].map(stage=>({stage,experimentId,sourceDigest,command:action[stage],commandDigest:digest(action[stage]),executed:true,code:0,signal:null,timedOut:false,aborted:false,bufferExceeded:false,error:null,stdout:'measured',stderr:'',stdoutDigest:digest('measured'),stderrDigest:digest('')}))}};};
 const args={workspace:root,model,task,sources,generation:1,proposalCache:cache,runExperiment};
 const receipt=await runStreamObligationStation(args);
 assert.equal(receipt.status,'passed',JSON.stringify(receipt));assert.equal(streamObligationDecision(task,receipt,1),null);
 assert.ok(streamObligationDecision(task,receipt,2));
 const broken=structuredClone(receipt);broken.obligations[0].probeEvidence.stages[2].timedOut=true;assert.ok(streamObligationDecision(task,broken,1));
 await runStreamObligationStation({...args,generation:2});assert.equal(proposals,1);assert.equal(executions,10);
 const noEvidence={...receipt,obligations:receipt.obligations.map(x=>({id:x.id,status:'passed'}))};assert.ok(streamObligationDecision(task,noEvidence,1));
});
test('fixture admission rejects missing termination and incomplete suffix before executing any candidate',async t=>{
 assert.match(streamFixtureIssue({...spec,validText:'é\n'},'When exactly `[DONE]`, mark the stream terminated.'),/omits/);
 assert.equal(parseStreamSpec(JSON.stringify({...spec,terminalSuffix:'bad'}),[{path:'api.mjs'}]),null);
 const root=fixture(t);fs.copyFileSync(path.join(root,'subject/api.mjs'),path.join(root,'api.mjs'));
 let runs=0,reviews=0;
 const r=await runStreamObligationStation({workspace:root,task,sources:[{path:'api.mjs',text:source,sha256:sha(source)}],generation:0,
 model:{async complete(prompt,options){if(options.recordLabel==='stream-obligation-fixture-review'){reviews++;return {content:'{"valid":false,"reason":"wrong expected frames"}',tokens:10};}return {content:JSON.stringify(spec),tokens:10};}},
 runExperiment:async()=>{runs++;throw Error('must not execute');}});
 assert.equal(r.status,'unverified');assert.equal(runs,0);assert.equal(reviews,2);assert.match(r.reason,/Fixture not admitted/);
 assert.ok(r.obligations.every(x=>x.status==='unverified'));
});
test('public-clause adapter constructs termination and expectations without a model or benchmark identity',async t=>{
 const derived=deriveLineStreamFixture(LINE_TASK,[{path:'api.mjs'}]);assert.ok(derived);
 assert.equal(derived.spec.validText,'data: jig-é😀\r\n\r\ndata: [STOP]\n\n');
 assert.deepEqual(JSON.parse(derived.spec.expectedJson),[{event:'message',data:'jig-é😀'}]);
 assert.equal(derived.spec.terminalSuffix,': jig\n');
 assert.equal(deriveLineStreamFixture(LINE_TASK.replace('Lines end at LF or CRLF','Lines end at semicolons'),[{path:'api.mjs'}]),null);
 assert.equal(deriveLineStreamFixture(LINE_TASK,[{path:'unrelated.mjs'}]),null);
 assert.ok(deriveLineStreamFixture(LINE_TASK.replaceAll('[STOP]','FINISHED'),[{path:'api.mjs'}]).spec.validText.endsWith('data: FINISHED\n\n'));
 const root=fixture(t);fs.copyFileSync(path.join(root,'subject/api.mjs'),path.join(root,'api.mjs'));let calls=0;
 const r=await runStreamObligationStation({workspace:root,task:LINE_TASK,sources:[{path:'api.mjs',text:source,sha256:sha(source)}],generation:0,
 model:{async complete(){throw Error('fixture construction must not invoke the model');}},runExperiment:async()=>{calls++;return {};}});
 assert.equal(calls,5);assert.equal(r.authority,'public-line-stream-adapter-v1');assert.deepEqual(r.spec,derived.spec);
 assert.ok(r.obligations.every(x=>x.status==='unverified'),'derived fixture alone supplies no execution proof');
});
test('line framing witnesses distinguish embedded CR, split CRLF and per-push dispatch',t=>{
 const publicTask=LINE_TASK+' Other CR characters remain data. Strip the one CR immediately preceding LF. A blank line dispatches the current frame only if it has at least one data field. `push` returns only frames completed during that call.';
 const derived=deriveLineStreamFixture(publicTask,[{path:'api.mjs'}]);assert.ok(derived.lineFraming);
 assert.equal(deriveLineStreamFixture(LINE_TASK,[{path:'api.mjs'}]).lineFraming,null,'do not infer missing protocol rules');
 const correct=String.raw`export function createDecoder(){let text='',data=[],ended=false;const u=new TextDecoder('utf-8',{fatal:true});return {
 push(b){text+=u.decode(b,{stream:true});const out=[];while(text.includes('\n')){const at=text.indexOf('\n');let line=text.slice(0,at);text=text.slice(at+1);if(line.endsWith('\r'))line=line.slice(0,-1);
 if(!line){if(data.length){const value=data.join('\n');data=[];if(value==='[STOP]')ended=true;else out.push({event:'message',data:value});}}else if(line.startsWith('data: '))data.push(line.slice(6));}return out;},
 finish(){u.decode();if(!ended||text||data.length)throw Error('unfinished');return [];}};}`;
 const mutants=[
  correct.replace("if(line.endsWith('\\r'))line=line.slice(0,-1);","line=line.replace(/\\r.*/, '');"),
  correct.replace("text+=u.decode(b,{stream:true});","text+=u.decode(b,{stream:true}).replace(/\\r(?!\\n)/g,'\\n');"),
  correct.replace("text+=u.decode(b,{stream:true});","text+=u.decode(b,{stream:true});if(text.endsWith('\\r'))text+='\\n';"),
 ];
 for(const [index,code]of [correct,...mutants].entries()){
  const root=fixture(t,code),action=buildStreamProbe(derived.spec,'chunk-partitions',[{p:'api.mjs'}],{bom:true,lineFraming:derived.lineFraming});
  const r=spawnSync('/bin/sh',['-c',action.check],{cwd:root,encoding:'utf8',timeout:7000});
  assert.equal(r.status,index===0?0:1,r.stdout+r.stderr);
  if(index){const outcome=JSON.parse(r.stdout);assert.match(outcome.caseContext,/embedded CR|split CRLF/);assert.match(outcome.caseContext,/push index=|chunks=/);}
 }
});
