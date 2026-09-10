import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runAgent} from '../src/agent.js';
import {QWEN_ASSISTANT_PREFILL} from '../src/profiles.js';

test('an actual non-TAP project pass reaches reasoning before the next milestone action', async t => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-verification-think-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({type:'module',scripts:{test:'node verify.mjs'}}));
  fs.writeFileSync(path.join(workspace,'value.js'),'export const value = 4;\n');
  fs.writeFileSync(path.join(workspace,'verify.mjs'),"import assert from 'node:assert/strict'; import {value} from './value.js'; assert.equal(value,4); console.log('1 passed, 0 failed');\n");
  const calls=[],actions=[{a:'shell',c:'npm test'},
    {a:'write_file',p:'PROGRESS.md',content:'Value check passed. Next milestone: implement the missing interface. The application remains unfinished.\n'}];
  const thought='The existing value check passed. The interface is still absent. Record that next milestone before implementing it.';
  const result=await runAgent({workspace,task:'Run npm test, then record the next missing interface milestone in PROGRESS.md. Do not claim that the application is finished.',
    maxTurns:2,thinkMode:'auto',useGrammar:true,shellSandbox:'host',grounding:false,preGate:false,
    preEditSynthesis:false,progressAwareness:false,completionAudit:false,stateAudit:'off',contractStateAudit:'off',
    regressionGuard:false,testFocus:false,verificationScript:'npm test',
    autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
    model:{assistantPrefill:QWEN_ASSISTANT_PREFILL,stop:['<|im_end|>'],async complete(prompt,options){
      const thinking=String(prompt).endsWith('<think>\n');calls.push({prompt:String(prompt),thinking});
      if(!thinking)assert.ok(actions.length,'no unplanned model repair calls');
      return {content:thinking?thought:JSON.stringify(actions.shift()),tokens:20,stoppedEos:true,timings:{}};
    }},
  });
  assert.equal(result.turns[0].verificationEvidence.status,'pass');
  assert.deepEqual(result.turns[0].verificationEvidence.counts,{passed:1,failed:0,total:1});
  const boundary=calls.findIndex(c=>c.thinking&&c.prompt.includes('1 passed, 0 failed'));
  assert.ok(boundary>=0,'the actual custom-format green is present in a reasoning request');
  assert.ok(calls[boundary+1].prompt.includes(thought),'the action receives the post-verification decision');
  assert.equal(result.metrics.verificationBoundaryThinks,1);
  assert.equal(result.turns[1].editApplied,true);
  assert.match(fs.readFileSync(path.join(workspace,'PROGRESS.md'),'utf8'),/application remains unfinished/);
  assert.equal(result.reachedDone,false,'reasoning does not grant task completion');
});
