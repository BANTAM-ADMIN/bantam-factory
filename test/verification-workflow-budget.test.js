import assert from 'node:assert/strict';
import test from 'node:test';
import {budgetTurns} from '../src/history-budget.js';
import {buildPrompt} from '../src/prompt.js';
import {verificationWorkflowPromptText} from '../src/contract-audit-phase.js';

const PREFIX='CONTRACT AUDIT PHASE:';
const state={schema:1,phase:'focused',generation:2,text:PREFIX+'x'.repeat(2400-PREFIX.length)};
const rows=()=>Array.from({length:4},(_,i)=>({i,observation:`observation ${i}`,verificationWorkflow:structuredClone(state)}));

test('history charges the complete validated workflow and its separate chat wrapper',()=>{
  const turns=rows(),before=JSON.stringify(turns),formatted=verificationWorkflowPromptText(state);
  assert.ok(formatted.length>2400,'renderer wrapper is charged as well as bounded text');
  const perTurn=turns[0].observation.length+96+formatted.length+96;
  assert.deepEqual(budgetTurns(turns,{charBudget:perTurn*2}).map(t=>t.i),[2,3]);
  assert.deepEqual(budgetTurns(turns,{charBudget:perTurn*2-1}).map(t=>t.i),[3]);
  assert.equal(JSON.stringify(turns),before,'budgeting cannot rewrite the evidence store');
});

test('unrendered malformed or oversized workflow cannot charge unchecked metadata',()=>{
  const variants=[null,{...state,schema:2},{...state,phase:'unknown'},{...state,generation:-1},
    {...state,generation:1.5},{...state,text:'not a workflow'},
    {...state,text:state.text+'x'},{...state,text:PREFIX+'x'.repeat(1000000)}];
  const base=rows().map(({verificationWorkflow,...turn})=>turn);
  const limit=base.reduce((n,t)=>n+t.observation.length+96,0);
  for(const invalid of variants){
    assert.equal(verificationWorkflowPromptText(invalid),'');
    assert.equal(budgetTurns(base.map(t=>({...t,verificationWorkflow:invalid})),{charBudget:limit}).length,4);
  }
  const validWithPrivateMetadata={...state,rawEvidence:'x'.repeat(1000000)};
  assert.equal(verificationWorkflowPromptText(validWithPrivateMetadata),verificationWorkflowPromptText(state));
  const withMetadata=base.map(t=>({...t,verificationWorkflow:validWithPrivateMetadata}));
  assert.deepEqual(budgetTurns(withMetadata,{charBudget:6000}).map(t=>t.i),[2,3]);
});

test('budgeted extension retains each surviving workflow, evicts old blocks and preserves frozen valid bytes',()=>{
  const turns=rows().map(t=>({...t,action:{a:'read_file',p:'src/file.js',start:t.i+1,limit:1}}));
  const cache=new Map(),render=items=>buildPrompt({task:'Implement the public API.',env:'src/',turns:items,
    extensionTrajectory:true,immutableHistory:true,renderCache:cache});
  const first=render(turns.slice(0,2)),appended=render(turns.slice(0,3));
  assert.ok(appended.startsWith(first),'normal append keeps the exact cache prefix');
  const window=budgetTurns(turns,{charBudget:6000}),prompt=render(window);
  assert.deepEqual(window.map(t=>t.i),[2,3]);
  assert.equal((prompt.match(/\[verification workflow: current decision\]/g)||[]).length,2);
  assert.ok(prompt.includes(verificationWorkflowPromptText(state)));
  assert.doesNotMatch(prompt,/observation 0|observation 1/);
  assert.equal(budgetTurns(turns,{charBudget:0}).at(-1).i,3,'newest causal turn stays available even below its size');
});
