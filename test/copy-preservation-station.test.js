import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import {canonicalEncode} from '../src/factory/fact-fabric.js';
import {readBoundInputs} from '../src/contract-assertion-station.js';
import {copyPreservationApplies,captureCopyInterfaceDocuments,copyFixtureBaselineCalls,runCopyPreservationStation,copyPreservationDecision} from '../src/copy-preservation-station.js';
import {lintGrammar} from '../src/grammar-lint.js';

const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const digest=x=>'sha256:'+sha(canonicalEncode(x));
const TASK='The JavaScript module api.mjs exports copy(input). Return a deep copy of any JSON object, preserving nested containers and independent of subsequent caller input mutations.';
const REQUIREMENT='Return a deep copy of any JSON object, preserving nested containers and independent of subsequent caller input mutations.';
const SPEC={module:'api.mjs',calls:[{export:'copy',args:[{$input:true}]}],observePath:[]};
const review={requirement:REQUIREMENT,reason:'The entire arbitrary JSON input is copied and detached by the explicit public promise.',valid:true};

function fixture(t){
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'copy-station-unit-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  const text='export function copy(input){ /* PRIVATE_SOURCE_MARKER */ return structuredClone(input); }\n';
  fs.writeFileSync(path.join(workspace,'api.mjs'),text);
  return {workspace,sources:[{path:'api.mjs',text,sha256:sha(text)}]};
}
function modelFor(options={}){
  const calls=[];
  return {calls,async complete(prompt,settings){
    calls.push({prompt,settings});assert.doesNotMatch(prompt,/PRIVATE_SOURCE_MARKER/);
    assert.equal(lintGrammar(settings.grammar).ok,true);
    if(settings.recordLabel==='copy-preservation-fixture')return {content:JSON.stringify(SPEC),tokens:20,...options.proposal};
    return {content:JSON.stringify(review),tokens:20,...options.review};
  }};
}
function runnerFor(inputs,{code=0,stderr=''}={}){
  let calls=0;
  const runExperiment=async(_workspace,action)=>{
    calls++;
    const sourceDigest=digest(inputs),experimentId='probe:station-unit';
    return {probeEvidence:{schema:'bantam.probe-receipt.v1',experimentId,specDigest:digest(action),
      sourceDigest,sourceAfterDigest:sourceDigest,sourceAfterError:null,question:action.question,inputs,
      stages:['setup','witness','check'].map(stage=>({stage,experimentId,sourceDigest,command:action[stage],commandDigest:digest(action[stage]),
        executed:true,code:stage==='check'?code:0,signal:null,timedOut:false,aborted:false,bufferExceeded:false,error:null,
        stdout:'measured source-bound result',stderr:stage==='check'?stderr:'',stdoutDigest:digest('measured source-bound result'),stderrDigest:digest(stage==='check'?stderr:'')}))}};
  };
  return {runExperiment,count:()=>calls};
}

test('routing requires affirmative explicit deep copying in a JavaScript contract',()=>{
  assert.equal(copyPreservationApplies(TASK),true);
  assert.equal(copyPreservationApplies('In api.mjs preserve deep item copying.'),true);
  for(const task of ['Keep api.mjs updates immutable.','Do not deep copy in api.mjs.','No deep cloning is needed for api.mjs.','Return a deep copy in api.py.'])
    assert.equal(copyPreservationApplies(task),false,task);
});

test('fixture admission sees literal baseline fields instead of an imagined complete record',()=>{
  const spec={module:'api.mjs',calls:[{export:'empty',args:[]},{export:'put',args:[{$result:0},{key:'k',metadata:{$input:true}}]}],observePath:['value','metadata']};
  assert.deepEqual(copyFixtureBaselineCalls(spec),[{export:'empty',args:[]},{export:'put',args:[{$result:0},{key:'k',metadata:{value:'baseline'}}]}]);
  assert.deepEqual(spec.calls[1].args[1].metadata,{$input:true},'presentation does not mutate fixture');
});

test('interface capture uses only explicit confined original test paths with bounded complete bytes',()=>{
  const reads=[];
  const docs=captureCopyInterfaceDocuments('Run node ./test/public.test.mjs. Other examples: `other.spec.js`.',p=>{reads.push(p);return 'original '+p;});
  assert.deepEqual(reads,['test/public.test.mjs','other.spec.js']);
  assert.ok(docs.every(d=>d.truncated===false));
  assert.deepEqual(captureCopyInterfaceDocuments('Run ../secret.test.js.',()=>{throw Error('must not escape');}),[]);
  assert.equal(captureCopyInterfaceDocuments('Run huge.test.js.',()=> 'x'.repeat(12001))[0].truncated,true);
});

test('fixture review is source-blind and passes only with real bound per-obligation receipts',async t=>{
  const f=fixture(t),model=modelFor(),runner=runnerFor(readBoundInputs(f.workspace,f.sources)),cache=new Map();
  const args={...f,task:TASK,documents:[],generation:1,model,proposalCache:cache,runExperiment:runner.runExperiment};
  const receipt=await runCopyPreservationStation(args);
  assert.equal(receipt.status,'passed',JSON.stringify(receipt));assert.equal(receipt.candidateVerified,false);
  assert.equal(copyPreservationDecision(TASK,receipt,1),null);assert.ok(copyPreservationDecision(TASK,receipt,2));
  assert.equal(model.calls.length,2);assert.equal(runner.count(),2);
  assert.match(model.calls[1].prompt,/closed input schema/);
  assert.ok(model.calls[0].prompt.includes(TASK));
  await runCopyPreservationStation({...args,generation:2});
  assert.equal(model.calls.length,2,'same public fixture can be reused');assert.equal(runner.count(),4,'execution cannot be reused');
  await runCopyPreservationStation({...args,generation:3,documents:[{path:'SPEC.md',text:'Additional original interface context.'}]});
  assert.equal(model.calls.length,4,'changed contract documents require new fixture admission');
  for(const mutate of [r=>r.generation++,r=>r.spec.calls[0].export='other',r=>r.fixtureReview.raw=JSON.stringify({...review,requirement:'made up'}),
    r=>r.documentsSha256='bad',r=>r.inputs[0].sha256='bad',r=>r.obligations[0].probeEvidence.stages[2].timedOut=true,
    r=>r.obligations=r.obligations.map(row=>({id:row.id,status:'passed'}))]){
    const invalid=structuredClone(receipt);mutate(invalid);assert.ok(copyPreservationDecision(TASK,invalid,1));
  }
});

test('a measured failure stays blocking and cannot be replaced by a passing summary',async t=>{
  const f=fixture(t),runner=runnerFor(readBoundInputs(f.workspace,f.sources),{code:1}),model=modelFor();
  const receipt=await runCopyPreservationStation({...f,task:TASK,generation:1,model,runExperiment:runner.runExperiment});
  assert.equal(receipt.status,'failed');assert.equal(receipt.advisoryFallback,undefined);
  assert.equal(model.calls.length,2,'a measured failure must not reroll the fixture');
  assert.equal(receipt.fixtureAttempts.length,1);
  assert.ok(copyPreservationDecision(TASK,receipt,1));
  const fake=structuredClone(receipt);fake.status='passed';fake.obligations.forEach(row=>row.status='passed');
  assert.ok(copyPreservationDecision(TASK,fake,1));
  fake.status='unverified';fake.obligations.forEach(row=>row.status='unverified');
  fake.advisoryFallback={kind:'ordinary-verification',executionEvidence:false};
  assert.ok(copyPreservationDecision(TASK,fake,1),'summary edits cannot hide a bound measured failure behind fallback');
});

test('initial positive-control rejection retries fixture once and preserves both executions',async t=>{
  const f=fixture(t),inputs=readBoundInputs(f.workspace,f.sources),model=modelFor(),cache=new Map();
  const diagnostic={status:'unavailable',cases:0,calls:1,phase:'positive-control',message:'baseline differs',expected:{value:'baseline'},actual:{transformed:true}};
  const bad=runnerFor(inputs,{code:125,stderr:'UNAVAILABLE: '+JSON.stringify(diagnostic)+'; child incomplete or fixture unverified; '}),good=runnerFor(inputs);
  let executions=0;
  const receipt=await runCopyPreservationStation({...f,task:TASK,generation:1,model,proposalCache:cache,
    runExperiment:(...args)=>(++executions<=2?bad:good).runExperiment(...args)});
  assert.equal(receipt.status,'passed');assert.equal(model.calls.length,4);assert.equal(executions,4);
  assert.match(model.calls[2].prompt,/NOT a candidate defect/);assert.match(model.calls[2].prompt,/transformed/);
  assert.equal(receipt.fixtureAttempts.length,2);assert.equal(receipt.fixtureAttempts[0].status,'unverified');
  assert.ok(receipt.fixtureAttempts[0].obligations.every(r=>r.probeEvidence.stages[2].code===125));
  assert.equal(cache.size,1);assert.equal(copyPreservationDecision(TASK,receipt,1),null);
});

test('baseline retry is bounded, never cached, and does not reroll infrastructure or later-case unavailability',async t=>{
  const f=fixture(t),inputs=readBoundInputs(f.workspace,f.sources);
  for(const [phase,cases,expectedCalls] of [['positive-control',0,4],['infrastructure',0,2],['precondition',5,2]]){
    const diagnostic={status:'unavailable',cases,calls:cases+1,phase,message:'unavailable'};
    const runner=runnerFor(inputs,{code:125,stderr:'UNAVAILABLE: '+JSON.stringify(diagnostic)+'; child incomplete or fixture unverified; '}),model=modelFor(),cache=new Map();
    const receipt=await runCopyPreservationStation({...f,task:TASK,generation:1,model,proposalCache:cache,runExperiment:runner.runExperiment});
    assert.equal(receipt.status,'unverified');assert.equal(model.calls.length,expectedCalls);assert.equal(cache.size,0);
    assert.equal(receipt.advisoryFallback.executionEvidence,false);
  }
});

test('unbound or blocked baseline text cannot trigger an execution-driven fixture retry',async t=>{
  const f=fixture(t),inputs=readBoundInputs(f.workspace,f.sources);
  const diagnostic={status:'unavailable',cases:0,calls:1,phase:'positive-control',message:'unavailable'};
  for(const corrupt of [r=>r.probeEvidence.sourceAfterDigest='wrong',r=>r.blocked=true,r=>r.interrupted=true]){
    const runner=runnerFor(inputs,{code:125,stderr:'UNAVAILABLE: '+JSON.stringify(diagnostic)+'; child incomplete or fixture unverified; '}),model=modelFor();
    const receipt=await runCopyPreservationStation({...f,task:TASK,generation:1,model,runExperiment:async(...args)=>{const result=await runner.runExperiment(...args);corrupt(result);return result;}});
    assert.equal(receipt.status,'unverified');assert.equal(model.calls.length,2);assert.equal(receipt.fixtureAttempts.length,1);
  }
});

for(const bad of [{truncated:true},{stoppedLimit:true},{tokens:-1},{tokens:'20'},{tokens:1600}])
test('incomplete proposal grants no fixture authority '+JSON.stringify(bad),async t=>{
  const f=fixture(t),model=modelFor({proposal:bad});let executions=0;
  const receipt=await runCopyPreservationStation({...f,task:TASK,generation:1,model,runExperiment:async()=>{executions++;}});
  assert.equal(receipt.status,'unverified');assert.equal(executions,0);assert.equal(model.calls.length,2);
  assert.equal(receipt.advisoryFallback.executionEvidence,false,'unsupported adapter is not a new product requirement');
});

for(const bad of [{truncated:true},{tokens:1100},{content:JSON.stringify({...review,valid:false})},{content:JSON.stringify({...review,requirement:'Invented contract'})}])
test('unadmitted review cannot execute or gain pass '+JSON.stringify(bad).slice(0,70),async t=>{
  const f=fixture(t),model=modelFor({review:bad});let executions=0;
  const receipt=await runCopyPreservationStation({...f,task:TASK,generation:1,model,runExperiment:async()=>{executions++;}});
  assert.equal(receipt.status,'unverified');assert.equal(executions,0);assert.equal(receipt.spec,undefined);
  assert.equal(copyPreservationDecision(TASK,receipt,1),null,'ordinary verification remains available without copy pass credit');
});

test('measured mismatch survives a large fixture and malformed receipts remain pending',async t=>{
  const f=fixture(t),runner=runnerFor(readBoundInputs(f.workspace,f.sources),{code:1});
  const receipt=await runCopyPreservationStation({...f,task:TASK,generation:1,model:modelFor(),runExperiment:runner.runExperiment});
  receipt.spec.calls[0].args.push('oversized-fixture '.repeat(400));
  receipt.obligations[0].probeEvidence.stages[2].stdout='MEASURED_ARRAY_BECAME_OBJECT';
  const decision=copyPreservationDecision(TASK,receipt,1);
  assert.ok(decision.text.length<=2400);assert.match(decision.text,/MEASURED_ARRAY_BECAME_OBJECT/);
  receipt.obligations={};assert.ok(copyPreservationDecision(TASK,receipt,1));
});

test('caller cancellation never becomes an admitted fixture or fallback receipt',async t=>{
  const f=fixture(t),controller=new AbortController();
  await assert.rejects(runCopyPreservationStation({...f,task:TASK,generation:1,signal:controller.signal,model:{async complete(){
    controller.abort(Error('operator stopped'));return {content:JSON.stringify(SPEC),tokens:1};
  }}}),/operator stopped/);
});
