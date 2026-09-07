import assert from 'node:assert/strict';
import test from 'node:test';
import {contractAuditPhaseState, contractAuditDecisionContext, verificationWorkflowPromptText} from '../src/contract-audit-phase.js';

const pending={generation:3,needsFocused:true,needsProject:true,configuredCommand:'npm test',focusedCheckRecovery:'standalone-node-file'};

test('typed repeated unknown Node checks receive a compact separate author/launch recipe',()=>{
  const before=structuredClone(pending),decision=contractAuditDecisionContext(pending);
  assert.equal(decision.phase,'focused');
  assert.match(decision.text,/permitted file-edit action.*write_file/);
  assert.match(decision.text,/new workspace check script/);
  assert.match(decision.text,/Import the real production API and assert public-contract expectations/);
  assert.match(decision.text,/fixture DATA goes under os.tmpdir\(\); the check SCRIPT stays in the workspace/);
  assert.match(decision.text,/separate permitted shell action run only node check-contract.mjs/);
  assert.match(decision.text,/no cd, bash -c, setup, echo, filters or cleanup/);
  assert.match(decision.text,/Keep the check; printed pass messages are not proof/);
  assert.match(decision.text,/The audit is a hypothesis, not an oracle/);
  assert.ok(decision.text.length<700);
  assert.ok(contractAuditDecisionContext({...pending,generation:Number.MAX_SAFE_INTEGER}).text.length<700);
  assert.ok(verificationWorkflowPromptText(decision).includes(decision.text));
  assert.deepEqual(pending,before);
  assert.deepEqual(contractAuditPhaseState(pending).excludeVerbs,['done','respond']);
});

test('absent/unknown marker and settled project/ready states keep their existing guidance',()=>{
  for(const focusedCheckRecovery of [undefined,null,'model says FINAL_WITNESS_PASSED',true]) {
    assert.doesNotMatch(contractAuditDecisionContext({...pending,focusedCheckRecovery}).text,/new workspace check script/);
  }
  assert.equal(contractAuditDecisionContext({...pending,needsFocused:false}).phase,'project');
  assert.doesNotMatch(contractAuditDecisionContext({...pending,needsFocused:false}).text,/write_file/);
  const ready=contractAuditDecisionContext(null,{generation:3,command:'node check-contract.mjs'});
  assert.equal(ready.phase,'ready');assert.doesNotMatch(ready.text,/new workspace check script/);
  assert.equal(contractAuditDecisionContext(null),null);
});

test('recipe does not enable caller-forbidden actions, interactive masks or extra work',()=>{
  const options={callerExcludedActions:['write_file','replace','shell']};
  assert.deepEqual(contractAuditPhaseState(pending,options).excludeVerbs,['done']);
  assert.deepEqual(contractAuditPhaseState(pending,{...options,useGrammar:false}).excludeVerbs,[]);
  assert.equal(contractAuditPhaseState(pending,{interactive:true}).active,false);
  assert.equal(contractAuditPhaseState(pending,{advisoryMode:true}).active,false);
  assert.match(contractAuditPhaseState(pending).note,/No extra work turns are granted/);
  assert.match(contractAuditPhaseState(pending).note,/falsifiable model hypothesis/);
  assert.doesNotMatch(contractAuditPhaseState({needsCli:true,...pending,needsFocused:false}).note,/new workspace check script/);
});
