import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runAgent} from '../src/agent.js';
import {parseTestFailures,testFailureDetail,formatFailingTestFocus} from '../src/logic/test-focus.js';

test('exception text reaches failure guidance instead of unknown expected/actual values', () => {
  const tap="not ok 1 - board initializes\n  ---\n  location: 'test/game.test.js:1:1'\n  error: 'window is not defined'\n  ...\n";
  assert.equal(testFailureDetail(parseTestFailures(tap)[0]),'window is not defined');
  assert.match(formatFailingTestFocus(tap,()=>''),/window is not defined/);
  assert.match(testFailureDetail({}),/No concrete failure detail/);
  assert.match(testFailureDetail({message:'invalid result',diff:['+ 1','- 2']}),/invalid result\n\+ 1  - 2/);
});

test('a shared fixture failure gets one diagnostic then a worker repair, not one model call per failed test', async t => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-diagnosis-cascade-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.mkdirSync(path.join(workspace,'src'));fs.mkdirSync(path.join(workspace,'test'));
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test'}}));
  fs.writeFileSync(path.join(workspace,'src/value.js'),'export function value(){return 0;}\n');
  fs.writeFileSync(path.join(workspace,'test/value.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.js';\n"+
    [1,2,3].map(i=>`test('caller ${i}',()=>assert.equal(value(),7));`).join('\n'));
  const actions=[{a:'write_file',p:'src/value.js',content:'export function value(){return window.answer;}\n'},{a:'shell',c:'npm test'},
    {a:'write_file',p:'src/value.js',content:'export function value(){return 7;}\n'},
    {a:'shell',c:'npm test'},{a:'done',summary:'Repaired value() and verified all three callers.'}];
  const diagnosticPrompts=[];
  const result=await runAgent({workspace,task:'Fix src/value.js so value() returns 7 in Node without browser globals. Preserve the supplied tests. Run npm test.',
    model:{assistantPrefill:'',actTemperature:null,async complete(prompt){
      if(prompt.includes('STRICT OUTPUT — exactly these THREE short lines')) {
        diagnosticPrompts.push(prompt);
        return {content:'FIX: src/value.js value(): return the literal 7.\nCAUSE: Node has no window global.\nTRACE: value() -> reads window -> ReferenceError',tokens:1,stoppedEos:true};
      }
      assert.ok(actions.length,'no extra worker calls');
      return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true};
    }},maxTurns:10,useGrammar:false,interactive:false,grounding:false,shellSandbox:'host',verificationScript:'npm test',
    completionAudit:false,stateAudit:'off',contractStateAudit:'off',diagnoseStuckTests:true,diagnoseAfter:1,testFocus:true,
    regressionGuard:false,autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0});
  assert.equal(diagnosticPrompts.length,1,JSON.stringify(result.turns.map(t=>({a:t.action,obs:t.observation?.slice(0,1600),receipt:t.verificationEvidence?.status}))));
  assert.match(diagnosticPrompts[0],/THE FAILURE: window is not defined/);
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);
  assert.equal(result.verification.status,'pass');
});
