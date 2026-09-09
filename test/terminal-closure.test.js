import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runAgent} from '../src/agent.js';
import {buildArtifact} from '../src/artifact.js';
import {terminalClosureAllowance,terminalClosureEligible} from '../src/terminal-closure.js';

const TASK='Implement src/value.js exporting function value() that returns 7. Run npm test.';
const GOOD='export function value() { return 7; }\n';
const WRITE={a:'write_file',p:'src/value.js',content:GOOD};
const VERIFY={a:'shell',c:'npm test'};
const DONE={a:'done',summary:'Implemented value() and verified npm test.'};
function fixture(t){
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-terminal-closure-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.mkdirSync(path.join(workspace,'src'));fs.mkdirSync(path.join(workspace,'test'));
  fs.writeFileSync(path.join(workspace,'src/value.js'),'export function value() { return 0; }\n');
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test'}}));
  fs.writeFileSync(path.join(workspace,'test/value.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.js';test('value',()=>assert.equal(value(),7));\n");
  return workspace;
}
async function run(workspace,actions,options={}){
  const prompts=[],requests=[],events=[];
  const result=await runAgent({task:TASK,workspace,maxTurns:2,maxInvalidPerTurn:3,terminalClosureTurns:0,
    model:{assistantPrefill:'',actTemperature:null,async complete(prompt,request){
      prompts.push(prompt);requests.push(request);assert.ok(actions.length,'no extra unbounded model calls');
      const action=actions.shift();return {content:typeof action==='string'?action:JSON.stringify(action),tokens:1,stoppedEos:true};
    }},useGrammar:true,interactive:false,grounding:false,shellSandbox:'host',verificationScript:'npm test',
    completionAudit:false,stateAudit:'off',contractStateAudit:'off',diagnoseStuckTests:false,testFocus:false,
    regressionGuard:false,autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
    onEvent:e=>events.push(e),...options});
  return {result,prompts,requests,events};
}

test('closure permission requires a fresh generation-bound passing execution, not green prose',()=>{
  const evidence={schema:1,generation:4,configuredCommand:'npm test',cwd:'/ws',status:'pass',exitCode:0,
    timedOut:false,interrupted:false,workspaceReadOnly:true,counts:{total:1,passed:1,failed:0}};
  const base={allowance:1,used:false,turnsUsed:60,workTurnLimit:60,action:VERIFY,
    proof:{generation:4,command:'npm test',verification:{status:'pass'},evidence},generation:4,
    configuredCommand:'npm test',workspace:'/ws',verificationWorkspaceReadOnly:true,pendingAudit:null,
    interrupted:false,controllerStopped:false,resultDone:false,callerExcludedActions:[],freshEvidence:true};
  assert.equal(terminalClosureEligible(base),true);
  for(const change of [{allowance:0},{used:true},{turnsUsed:59},{turnsUsed:61},{action:DONE},
    {freshEvidence:false},{pendingAudit:{}},{interrupted:true},{controllerStopped:{}},{resultDone:true},
    {callerExcludedActions:['done']},{generation:5},{workspace:'/other'},{configuredCommand:'node --test'},{proof:null}])
    assert.equal(terminalClosureEligible({...base,...change}),false,JSON.stringify(change));
  for(const change of [{status:'unverified'},{status:'fail'},{exitCode:1},{timedOut:true},{interrupted:true},
    {bufferExceeded:true},{blocked:true},{error:'runner error'},{invalidated:true},{counts:{total:0}},
    {counts:{total:2,passed:1,failed:1}},{workspaceReadOnly:false},{schema:2},{generation:3}])
    assert.equal(terminalClosureEligible({...base,proof:{...base.proof,evidence:{...evidence,...change}}}),false,JSON.stringify(change));
  for(const value of [null,true,2,-1,1.5,'1'])assert.throws(()=>terminalClosureAllowance(value),/0 or 1/);
});

test('default work-turn cap stays hard even when the last verification passes',async t=>{
  const {result,prompts}=await run(fixture(t),[WRITE,VERIFY]);
  assert.equal(result.turns.length,2);assert.equal(prompts.length,2);assert.equal(result.reachedDone,false);
  assert.equal(result.verification.status,'pass');assert.equal(result.metrics.terminalClosure.granted,false);
});

test('unlimited work still finishes through the real configured verifier and accepted DONE',async t=>{
  const {result,prompts}=await run(fixture(t),[WRITE,VERIFY,DONE],{maxTurns:Infinity});
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);
  assert.equal(result.verification.status,'pass');
  assert.equal(result.turns.at(-1).doneAccepted,true);
  assert.equal(prompts.length,3);
  assert.equal(result.metrics.landingVerifies,0);
  assert.equal(result.metrics.terminalClosure.granted,false);
});

test('explicit closing allowance delivers one DONE-only opportunity and still records actual accepted DONE',async t=>{
  const {result,prompts,requests,events}=await run(fixture(t),[WRITE,VERIFY,DONE],{terminalClosureTurns:1});
  assert.equal(result.turns.length,3);assert.equal(prompts.length,3);
  assert.match(prompts[2],/\[terminal-closure\].*ONE additional DONE-only action/s);
  assert.ok(requests[2].grammar.includes('done'));
  assert.ok(!requests[2].grammar.includes('write_file'));assert.ok(!requests[2].grammar.includes('shell'));
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);assert.equal(result.turns.at(-1).doneAccepted,true);
  assert.equal(result.metrics.terminalClosure.grantedTurn,1);assert.equal(result.metrics.terminalClosure.usedTurn,2);
  assert.equal(result.metrics.terminalClosure.allowance,1);assert.equal(result.metrics.terminalClosure.workTurnLimit,2);
  assert.ok(events.some(e=>e.type==='terminal_closure'&&e.phase==='used'));
  const film=buildArtifact({runId:'terminal-closure',stamp:'test',result});
  assert.deepEqual(film.metrics.terminalClosure,result.metrics.terminalClosure);
  assert.equal(film.turns.at(-1).doneAccepted,true);
});

test('non-DONE output cannot execute a tool in the closing allowance, including grammar-free callers',async t=>{
  for(const useGrammar of [true,false]){
    const workspace=fixture(t),forbidden={a:'shell',c:'touch forbidden.txt'};
    const {result,prompts}=await run(workspace,[WRITE,VERIFY,forbidden],{terminalClosureTurns:1,useGrammar});
    assert.equal(prompts.length,3);assert.equal(result.reachedDone,false);assert.equal(fs.existsSync(path.join(workspace,'forbidden.txt')),false);
    assert.match(result.turns.at(-1).observation,/only done was permitted/);assert.equal(result.turns.at(-1).shellExecution,null);
  }
});

test('closing allowance skips only its own reasoning rail, leaving ordinary reasoning enabled',async t=>{
  const actions=[WRITE,VERIFY,DONE],phases=[];
  const {result}=await run(fixture(t),[],{terminalClosureTurns:1,thinkMode:'always',
    model:{assistantPrefill:'<|im_start|>assistant\n<think>\n</think>\n\n',actTemperature:null,stop:[],
      async complete(prompt,request){
        if(!request.grammar){phases.push('reason');return {content:'Use the prescribed action.',tokens:1,stoppedEos:true};}
        phases.push('act');assert.ok(actions.length);return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true};
      }}});
  assert.deepEqual(phases,['reason','act','reason','act','act']);
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);
  assert.equal(result.turns.at(-1).doneAccepted,true);
});

test('closing allowance never retries malformed JSON or bypasses remaining output gates',async t=>{
  const malformed=await run(fixture(t),[WRITE,VERIFY,'{'],{terminalClosureTurns:1});
  assert.equal(malformed.prompts.length,3);assert.equal(malformed.result.reachedDone,false);
  const gated=await run(fixture(t),[WRITE,VERIFY,DONE],{terminalClosureTurns:1,
    task:TASK+' Also create nonempty report.txt as a required deliverable.'});
  assert.equal(gated.prompts.length,3);assert.equal(gated.result.reachedDone,false);
  assert.equal(gated.result.turns.at(-1).doneAccepted,false);assert.match(gated.result.turns.at(-1).observation,/report\.txt/);
});

test('last-work-turn focused assertion plus actual controller project check can close a collection audit',async t=>{
  const workspace=fixture(t),actions=[{...WRITE,content:"export function value(items = []) { if (!Array.isArray(items)) throw Error('items'); return 7; }\n"},VERIFY,
    {a:'shell',c:`node --input-type=module -e "import assert from 'node:assert/strict';import {value} from './src/value.js';assert.equal(value([]),7);assert.throws(()=>value(null));"`},DONE];
  let audits=0,workerCalls=0;
  const {result}=await run(workspace,[],{terminalClosureTurns:1,maxTurns:3,contractStateAudit:'auto',
    task:'Implement and export synchronous value(items = []) in src/value.js. items must be an array, reject nonarrays. Return 7 including for an empty array. Run npm test.',
    model:{assistantPrefill:'',actTemperature:null,async complete(prompt){
      if(String(prompt).includes('You are a source-code state-machine auditor.')){
        audits++;return {content:JSON.stringify({findings:[],note:'Execute one public-API assertion.'}),tokens:1};
      }
      workerCalls++;assert.ok(actions.length);return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true};
    }},
    shellSandbox:process.env.BANTAM_LIVE_SANDBOX_TEST==='1'?'docker':'host',
    verificationWorkspaceReadOnly:process.env.BANTAM_LIVE_SANDBOX_TEST==='1'});
  assert.equal(audits,1);assert.equal(workerCalls,4);assert.equal(result.turns.length,4);
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);
  const proofTurn=result.turns[2];
  assert.equal(proofTurn.verificationReceipts.entries.length,2,'actual focused execution and following automatic project execution retained');
  assert.equal(proofTurn.verificationReceipts.entries[0].shellExecution.exitCode,0);
  assert.match(proofTurn.verificationReceipts.entries[0].shellExecution.executedCommand,/assert\.equal\(value\(\[\]\),7\)/);
  assert.equal(proofTurn.verificationReceipts.entries[1].verificationEvidence.status,'pass');
  assert.equal(proofTurn.verificationReceipts.entries[1].verificationEvidence.configuredCommand,'npm test');
  assert.equal(result.metrics.terminalClosure.grantedTurn,2);assert.equal(result.turns[3].doneAccepted,true);
});


test('wall reserve grants the real agent a closing action while ordinary turns remain', async t => {
  const realNow = Date.now.bind(Date); let offset = 0, calls = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const actions = [WRITE, VERIFY, DONE];
  const {result, events} = await run(fixture(t), [], {maxTurns:60, wallDeadlineMs:600000, terminalClosureTurns:1,
    model:{assistantPrefill:'', actTemperature:null, async complete(){
      calls++; assert.ok(actions.length, 'no unbounded closure calls');
      const action = actions.shift(); if (calls === 2) offset = 560000;
      return {content:JSON.stringify(action),tokens:1,stoppedEos:true};
    }}});
  assert.equal(calls,3);
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);
  assert.equal(result.turns.at(-1).doneAccepted,true);
  assert.ok(events.some(e => e.type === 'terminal_closure' && e.phase === 'used'));
});
