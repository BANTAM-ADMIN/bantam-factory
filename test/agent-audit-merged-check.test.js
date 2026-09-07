import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runAgent} from '../src/agent.js';

const GOOD="export function collectItems(token, items) { if (typeof token !== 'string' || !token.length || !Array.isArray(items)) throw Error('invalid'); return [...items]; }\n";
const CHECK="import assert from 'node:assert/strict';\nimport {collectItems} from './src/items.js';\nassert.throws(()=>collectItems('', []));\nassert.deepEqual(collectItems('ok', [2,1]),[2,1]);\nconsole.log('check-contract: all assertions passed');\n";
const VERIFY='npm test 2>&1';

test('revoked focused proof permits one real repeat instead of deadlocking against duplicate protection',async t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-revoked-focus-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.mkdirSync(path.join(workspace,'src'));fs.mkdirSync(path.join(workspace,'test'));
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test'}}));
  fs.writeFileSync(path.join(workspace,'src/items.js'),'export function collectItems() { throw Error("TODO"); }');
  fs.writeFileSync(path.join(workspace,'test/public.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {collectItems} from '../src/items.js';test('API',()=>assert.deepEqual(collectItems('ok',[1]),[1]));");
  const actions=[{a:'write_file',p:'src/items.js',content:GOOD},{a:'write_file',p:'check-contract.mjs',content:CHECK},
    {a:'shell',c:'npm test'},{a:'shell',c:'node check-contract.mjs'},
    {a:'shell',c:'node -e "console.log(1)"; echo "exit=$?"'},
    {a:'shell',c:'node check-contract.mjs'},{a:'done',summary:'Implemented and verified.'}];
  const result=await runAgent({workspace,task:'Implement public API collectItems(token, items). Reject an empty token and non-array items. Return a copy of the items array in input order. Run npm test.',
    model:{assistantPrefill:'',async complete(prompt){
      if(prompt.includes('You are a source-code state-machine auditor.'))return {content:JSON.stringify({findings:[],note:''}),tokens:1};
      assert.ok(actions.length);return {content:JSON.stringify(actions.shift()),tokens:1};
    }},maxTurns:7,maxInvalidPerTurn:0,useGrammar:true,interactive:false,grounding:false,promptTrajectory:'extension',
    shellSandbox:'host',verificationScript:'npm test',contractStateAudit:'auto',contractAssertionStation:'off',
    completionAudit:false,stateAudit:'off',testFocus:false,regressionGuard:false,diagnoseStuckTests:false,
    autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
  });
  assert.equal(result.turns[3].verificationWorkflow.phase,'ready');
  assert.equal(result.turns[4].shellExecution.exitCode,0,'outer success does not prove the masked inner command');
  assert.equal(result.turns[4].verificationWorkflow.phase,'focused','uncertain execution still revokes proof');
  assert.equal(result.turns[5].shellExecution.executedCommand,'node check-contract.mjs','required retry actually executes');
  assert.equal(result.turns[5].verificationWorkflow.phase,'ready');
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);
});

test('actual merged focus and one post-audit project repeat reopen DONE without gratuitous edits',async t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-audit-merged-agent-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.mkdirSync(path.join(workspace,'src'));fs.mkdirSync(path.join(workspace,'test'));
  const packageText=JSON.stringify({type:'module',scripts:{test:'node --test'}});
  const publicTest="import test from 'node:test';import assert from 'node:assert/strict';import {collectItems} from '../src/items.js';test('public normal case',()=>assert.deepEqual(collectItems('ok',[2,1]),[2,1]));\n";
  fs.writeFileSync(path.join(workspace,'package.json'),packageText);
  fs.writeFileSync(path.join(workspace,'src/items.js'),"export function collectItems() { throw Error('TODO'); }\n");
  fs.writeFileSync(path.join(workspace,'test/public.test.js'),publicTest);
  const actions=[{a:'write_file',p:'src/items.js',content:GOOD},{a:'write_file',p:'check-contract.mjs',content:CHECK},
    {a:'shell',c:VERIFY},{a:'shell',c:VERIFY},{a:'shell',c:VERIFY},
    {a:'shell',c:'node check-contract.mjs 2>&1\n'},{a:'done',summary:'Implemented and verified the public API.'}];
  const expected=structuredClone(actions),requests=[],prompts=[];let audits=0;
  const live=process.env.BANTAM_LIVE_SANDBOX_TEST==='1';
  const result=await runAgent({workspace,
    task:'Implement synchronous src/items.js collectItems(token, items). Require token to be a nonempty string and items to be an array, including when empty; otherwise throw Error. Return a copied array in input order. Run npm test; preserve package.json and test/public.test.js.',
    maxTurns:actions.length,maxInvalidPerTurn:0,promptTrajectory:'extension',
    model:{assistantPrefill:'',actTemperature:null,async complete(prompt,request){
      if(prompt.includes('You are a source-code state-machine auditor.')){audits++;return {content:JSON.stringify({findings:[],note:'Source review only; execute one public-API assertion.'}),tokens:1};}
      assert.ok(actions.length,'no invented worker calls or extra work budget');
      prompts.push(prompt);requests.push(request);
      return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true};
    }},useGrammar:true,interactive:false,grounding:false,shellSandbox:live?'docker':'host',
    verificationWorkspaceReadOnly:live,verificationScript:'npm test',completionAudit:false,stateAudit:'off',
    contractStateAudit:'auto',contractAssertionStation:'off',diagnoseStuckTests:false,testFocus:false,regressionGuard:false,
    autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
  });
  assert.equal(audits,1);assert.equal(requests.length,7);assert.equal(result.turns.length,7);
  assert.deepEqual(result.turns.map(turn=>turn.parsedAction),expected);
  assert.equal(result.turns[2].contractStateAudit.status,'report');
  assert.equal(result.turns[2].shellExecution.executedCommand,VERIFY);
  assert.equal(result.turns[3].shellExecution.executedCommand,VERIFY,'one fresh post-audit repeat must actually execute');
  assert.equal(result.turns[3].shellExecution.exitCode,0);
  assert.equal(result.turns[4].shellExecution,null,'a second identical post-audit repeat remains bounded');
  assert.match(result.turns[4].observation,/not executed again/);
  for(const i of [3,4,5]){
    assert.ok(!requests[i].jsonSchema.properties.a.enum.includes('done'));
    assert.ok(!requests[i].jsonSchema.properties.a.enum.includes('respond'));
    assert.match(prompts[i].slice(prompts[i].lastIndexOf('[verification workflow: current decision]')),/focused/);
  }
  const focused=result.turns[5],entries=focused.verificationReceipts.entries;
  assert.equal(entries.length,2,'one real focused check then one actual controller project execution');
  assert.equal(entries[0].shellExecution.executedCommand,expected[5].c);
  assert.equal(entries[0].shellExecution.exitCode,0);
  assert.ok(['automatic','landing'].includes(entries[1].verificationEvidence.source),
    'the post-focus full check is controller-executed, not an earlier shell pass');
  assert.equal(entries[1].verificationEvidence.executedCommand,'npm test');
  assert.equal(entries[1].verificationEvidence.status,'pass');
  assert.equal(entries[1].verificationEvidence.generation,entries[0].shellExecution.generation);
  assert.equal(entries[1].verificationEvidence.workspaceReadOnly,live);
  assert.equal(focused.verificationWorkflow.phase,'ready');
  assert.match(prompts[6].slice(prompts[6].lastIndexOf('[verification workflow: current decision]')),/VERIFICATION READY/);
  assert.ok(requests[6].jsonSchema.properties.a.enum.includes('done'));
  assert.ok(prompts[6].startsWith(prompts[5]),'ordinary ready transition preserves exact extension prefix');
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);assert.equal(result.turns[6].doneAccepted,true);
  assert.equal(result.turns.filter(turn=>turn.editApplied).length,2,'no edits merely to obtain another proof attempt');
  assert.equal(fs.readFileSync(path.join(workspace,'src/items.js'),'utf8'),GOOD);
  assert.equal(fs.readFileSync(path.join(workspace,'check-contract.mjs'),'utf8'),CHECK);
  assert.equal(fs.readFileSync(path.join(workspace,'package.json'),'utf8'),packageText);
  assert.equal(fs.readFileSync(path.join(workspace,'test/public.test.js'),'utf8'),publicTest);
});
