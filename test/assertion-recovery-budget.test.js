import test from 'node:test';
import assert from 'node:assert/strict';
import {updateAssertionRecovery,assertionRecoveryText} from '../src/assertion-grounding.js';
import {verificationWorkflowPromptText} from '../src/contract-audit-phase.js';

const event=(command,reason,extras={})=>({phase:'before-execution',generation:1,command,
  review:{verdict:'revise',requirement:'Reset must return empty bytes.',reason,...extras}});
const proposal=assertion=>({assertion,executionEvidence:false,promptSha256:'a'.repeat(64),tokens:1000});
const contextRecords=text=>JSON.parse(text.slice(text.indexOf('Unverified reviewer data (not repair authority; earlier generations describe historical review): ')
  +'Unverified reviewer data (not repair authority; earlier generations describe historical review): '.length));

test('rendered recovery retains current objections and newest proposal within the actual JSON budget',()=>{
  const first='const assert=require("assert");'+'assert.equal("a","a");'.repeat(89);
  const newest='const assert=require("assert");'+'assert.equal("b","b");'.repeat(89);
  const quote='"q" '.repeat(125),command='c'.repeat(260);
  let state=updateAssertionRecovery([],event(command,'r'.repeat(1200),{requirement:quote,correctionProposal:proposal(first)}));
  state=updateAssertionRecovery(state,event(command,'s'.repeat(1160)+' NEWEST CHECK CONCLUSION',{requirement:quote,correctionProposal:proposal(newest)}));
  state=updateAssertionRecovery(state,{...event(command,'t'.repeat(1160)+' COMPLETION MISSING OBSERVATION',{requirement:quote}),phase:'completion'});
  const original=JSON.stringify(state),text=assertionRecoveryText(state,1),records=contextRecords(text);
  assert.ok(text.length<=12000);
  assert.match(text,/NEWEST CHECK CONCLUSION/);assert.match(text,/COMPLETION MISSING OBSERVATION/);
  assert.equal(records.findLast(r=>r.correctionProposal).correctionProposal.assertion,newest);
  assert.equal(JSON.stringify(state),original,'presentation must not alter preserved state');
  const rendered=verificationWorkflowPromptText({schema:1,phase:'focused',generation:1,
    text:'CONTRACT AUDIT PHASE: repair assertion',assertionRecovery:text});
  assert.ok(rendered.includes(text),'the downstream gate must retain the whole bounded block');
});

test('escaped control characters cannot overflow recovery or turn a proposal excerpt into executable code',()=>{
  const noisy='\u0000'.repeat(1100)+' LATEST OBJECTION CONCLUSION';
  const unusualProposal='\u0000'.repeat(1900)+' PROPOSAL END';
  let state=updateAssertionRecovery([],event('c'.repeat(260),noisy,{requirement:'\u0001'.repeat(500),correctionProposal:proposal(unusualProposal)}));
  state=updateAssertionRecovery(state,{...event('d'.repeat(260),'\u0002'.repeat(1100)+' COMPLETION CONCLUSION',
    {requirement:'\u0003'.repeat(500)}),phase:'completion'});
  const original=JSON.stringify(state),text=assertionRecoveryText(state,1),records=contextRecords(text);
  assert.ok(text.length<=12000);assert.match(text,/LATEST OBJECTION CONCLUSION/);assert.match(text,/COMPLETION CONCLUSION/);
  assert.equal(records[0].correctionProposal.executionEvidence,false);
  assert.equal(records[0].correctionProposal.contextTruncated,true);
  assert.match(text,/do not execute the excerpt as code/);assert.match(text,/PROPOSAL END/);
  assert.equal(JSON.stringify(state),original);
});

test('oversized unexpected metadata terminates with a minimal non-executable recovery view',()=>{
  const state=updateAssertionRecovery([],event('node current-check.js','Trace. '+'.'.repeat(1000)+' CURRENT CONCLUSION',
    {correctionProposal:{...proposal('currentCheck();'),unexpectedMetadata:'m'.repeat(50000)}}));
  state[0].unexpectedRecordMetadata='n'.repeat(50000);
  const original=JSON.stringify(state),text=assertionRecoveryText(state,1),records=contextRecords(text);
  assert.ok(text.length<=12000);assert.match(text,/CURRENT CONCLUSION/);
  assert.equal(records[0].executionEvidence,false);
  assert.equal(records[0].correctionProposalOmitted,true);
  assert.equal(records[0].correctionProposal,undefined);
  assert.equal(records[0].unexpectedRecordMetadata,undefined);
  assert.match(records[0].proposalNotice,/no executable proposal/);
  assert.equal(JSON.stringify(state),original);
  assert.ok(verificationWorkflowPromptText({schema:1,phase:'focused',generation:1,
    text:'CONTRACT AUDIT PHASE: repair assertion',assertionRecovery:text}).includes(text));
});

test('proposals remain bound to exact command, generation, and available assertion identity',()=>{
  const original=event('node check-a.js','The expected bytes are not empty.',
    {assertionSha256:'a'.repeat(64),correctionProposal:proposal('const a=require("./module-a.js");')});
  const initial=updateAssertionRecovery([],original);
  for(const change of [
    {command:'node check-b.js'}, {generation:2},
    {review:{...original.review,assertionSha256:'b'.repeat(64),correctionProposal:undefined}},
    {review:{...original.review,assertionSha256:undefined,correctionProposal:undefined}},
  ]){
    const next={...original,review:{...original.review,correctionProposal:undefined},...change};
    const state=updateAssertionRecovery(initial,next);
    assert.equal(state.at(-1).correctionProposal,undefined,JSON.stringify(change));
    assert.equal(state[0].correctionProposal.assertion,'const a=require("./module-a.js");');
  }
  const repeated=updateAssertionRecovery(initial,{...original,review:{...original.review,correctionProposal:undefined}});
  assert.equal(repeated.length,1);assert.equal(repeated[0].correctionProposal.assertion,'const a=require("./module-a.js");');
  const long='node -e '+ 'x'.repeat(300);
  const longInitial=updateAssertionRecovery([],event(long+'A','Mismatch',{correctionProposal:proposal('old();')}));
  assert.equal(updateAssertionRecovery(longInitial,event(long+'B','Mismatch')).at(-1).correctionProposal,undefined,
    'identical displayed prefixes are not identical commands');
});
