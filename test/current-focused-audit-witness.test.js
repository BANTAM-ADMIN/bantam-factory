import assert from 'node:assert/strict';
import test from 'node:test';
import {currentFocusedAuditWitness, pendingContractAudit, VERIFICATION_RECEIPTS_SCHEMA} from '../src/contract-audit-recovery.js';
import {verificationEvidence,verificationReceipt,shellExecutionReceipt} from '../src/verification-evidence.js';

const workspace='/tmp/bantam-witness-fixture';
const options={generation:4,workspace,configuredCommand:'npm test',verificationWorkspaceReadOnly:true};
const audit=()=>({contractStateAudit:{focus:'collection-preconditions',status:'report',promptSha256:'a'.repeat(64),report:'Unverified hypothesis',sources:[]}});
function execution(command='node check-api.mjs',source='shell',changes={}){
  const raw={command,executedCommand:command,cwd:workspace,sandbox:'docker:fixture',workspaceReadOnly:source!=='shell',
    exitCode:0,stdout:'# tests 2\n# pass 2\n# fail 0\n',stderr:'',...changes};
  return {verificationEvidence:verificationReceipt(verificationEvidence({execution:raw,generation:4,configuredCommand:'npm test',source})),
    shellExecution:source==='shell'?shellExecutionReceipt(raw,{generation:4}):null};
}
const project=()=>execution('npm test','landing');
function ordered(entries,turn=1){
  const rows=JSON.parse(JSON.stringify(entries.map((entry,sequence)=>({sequence,...entry}))));
  return {verificationReceipts:{schema:VERIFICATION_RECEIPTS_SCHEMA,authority:'controller-execution-order',turn,entries:rows},
    verificationEvidence:rows.findLast(r=>r.verificationEvidence)?.verificationEvidence??null,
    shellExecution:rows.find(r=>r.shellExecution)?.shellExecution??null};
}
const settled=()=>[audit(),ordered([execution(),project()])];
function witness(turns,settings=options){
  const before=JSON.stringify(turns),result=currentFocusedAuditWitness(turns,settings);
  assert.equal(JSON.stringify(turns),before,'read-only projection');
  if(result)assert.equal(pendingContractAudit(turns,settings),null,'witness never introduces acceptance authority');
  return result;
}

test('settled ordered focus returns only its exact execution command, index and current generation',()=>{
  assert.deepEqual(witness(settled()),{command:'node check-api.mjs',turn:1,generation:4});
  assert.deepEqual(witness([audit(),execution(),execution('npm test')]),{command:'node check-api.mjs',turn:1,generation:4},'valid legacy turn order remains supported');
  assert.deepEqual(witness([audit(),ordered([execution('node --test test/edge.test.js'),project()])]),
    {command:'node --test test/edge.test.js',turn:1,generation:4});
});

test('no audit, unqualified audit, same-turn proof or a new audit supplies no current witness',()=>{
  for(const turns of [[],[execution(),execution('npm test')],[{contractStateAudit:{focus:'collection-preconditions',status:'unavailable'}},ordered([execution(),project()])],
    [{contractStateAudit:{focus:'stateful',status:'report'}},ordered([execution(),project()])],
    [{...audit(),...ordered([execution(),project()],0)}],[...settled(),audit()]])assert.equal(witness(turns),null);
  assert.equal(witness(settled(),{...options,generation:5}),null);
  assert.equal(witness(settled(),{...options,generation:null}),null);
});

test('configured proof follows its focus; extra passing checks retain the completed pair until another pair replaces it',()=>{
  assert.equal(witness([audit(),ordered([execution()])]),null);
  assert.equal(witness([audit(),ordered([project(),execution()])]),null);
  assert.deepEqual(witness([audit(),ordered([project(),execution()]),ordered([project()],2)]),
    {command:'node check-api.mjs',turn:1,generation:4});
  assert.deepEqual(witness([...settled(),ordered([execution('node check-next.mjs')],2)]),
    {command:'node check-api.mjs',turn:1,generation:4});
  assert.deepEqual(witness([...settled(),ordered([execution('node check-next.mjs'),project()],2)]),
    {command:'node check-next.mjs',turn:2,generation:4});
  assert.deepEqual(witness([audit(),ordered([execution()])],{...options,configuredCommand:null}),
    {command:'node check-api.mjs',turn:1,generation:4});
});

test('failure, invalidation, stale generation and incomplete execution retire prior witness credit',()=>{
  for(const patch of [{status:'fail'},{generation:3},{invalidated:true},{exitCode:1},{blocked:true},{timedOut:true},
    {interrupted:true},{bufferExceeded:true},{outputSha256:'invalid'},{source:'model'},{counts:{total:0,passed:0,failed:0}}]){
    const bad=execution();bad.verificationEvidence={...bad.verificationEvidence,...patch};
    assert.equal(witness([audit(),ordered([bad,project()])]),null,JSON.stringify(patch));
    assert.equal(witness([...settled(),ordered([bad],2)]),null,JSON.stringify(patch));
  }
  for(const patch of [{controllerStop:{kind:'stopped'}},{shellScopeRollback:{violations:['protected']}}])
    assert.equal(witness([audit(),{...ordered([execution(),project()]),...patch}]),null);
});

test('forged envelopes and conflicting aliases cannot nominate a script',()=>{
  for(const mutate of [
    r=>{r.verificationReceipts.authority='model';},r=>{r.verificationReceipts.turn=0;},
    r=>{r.verificationReceipts.entries[1].sequence=0;},r=>{r.verificationReceipts.entries.reverse();},
    r=>{r.verificationReceipts=r.verificationReceipts.entries;},r=>{r.verificationReceipts=null;},
    r=>{r.shellExecution={...r.shellExecution,command:'node check-foreign.mjs'};},
    r=>{r.verificationEvidence={...r.verificationEvidence,invalidated:true};},
  ]){const row=ordered([execution(),project()]);mutate(row);assert.equal(witness([audit(),row]),null,mutate.toString());}
  const legacy=execution();legacy.shellExecution={...legacy.shellExecution,command:'node check-foreign.mjs'};
  assert.equal(witness([audit(),legacy,execution('npm test')]),null,'legacy mismatched aliases are not protected');
});

test('actual cwd and exact configured controller check remain bound',()=>{
  for(const patch of [{cwd:'/tmp/foreign'},{cwd:null},{workspaceReadOnly:false},{executedCommand:'npm run other'},
    {configuredCommand:'npm run other'},{statusCommand:'npm run other'}]){
    const broad=project();broad.verificationEvidence={...broad.verificationEvidence,...patch};
    assert.equal(witness([audit(),ordered([execution(),broad])]),null,JSON.stringify(patch));
  }
  assert.equal(witness(settled(),{...options,workspace:'/tmp/foreign'}),null);
  const command=`cd '${workspace}' && node check-api.mjs`;
  assert.deepEqual(witness([audit(),ordered([execution(command),project()])]),
    {command:'node check-api.mjs',turn:1,generation:4},'only existing bound cd normalization is applied');
});

test('inline witnesses are locators too; print-only and status-masked commands are not',()=>{
  const command=`node --input-type=module -e 'import assert from "node:assert/strict"; assert.equal(1,1)'`;
  assert.deepEqual(witness([audit(),ordered([execution(command),project()])]),{command,turn:1,generation:4});
  for(const c of ['node check-api.mjs; echo DONE','node check-api.mjs | tail','node check-api.mjs && npm test',
    `node -e 'console.log("assert.equal(1,1)")'`])assert.equal(witness([audit(),ordered([execution(c),project()])]),null,c);
});

test('a new station cannot borrow an ordinary workspace witness from earlier or parallel receipts',()=>{
  const station={contractAssertion:{status:'assertion_passed'}};
  assert.equal(witness([...settled(),station]),null);
  assert.equal(witness([audit(),{...ordered([execution(),project()]),...station}]),null);
});
