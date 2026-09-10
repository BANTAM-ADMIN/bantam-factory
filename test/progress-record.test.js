import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {progressRecordFeedback} from '../src/progress-record.js';
import {runAgent} from '../src/agent.js';
import {shouldThink} from '../src/thinking.js';

test('checked file feedback excludes plans, examples, traversal and unknown filesystem status', () => {
  const checked=[];
  const text=['- [ ] src/future.js','- [x] src/present.js — implemented',
    '- [x] ../private.js','- [x] /tmp/outside.js','- [x] https://example.org/a.js',
    '```md','- [x] src/example.js','```','    - [x] src/indented-example.js',
    '- [x] src/unreadable.js','- [x] `src/absent.js` — done','- [X] src/absent.js — duplicate'].join('\n');
  const result=progressRecordFeedback('PROGRESS.md',text,p=>{checked.push(p);return p==='src/absent.js'?false:p==='src/unreadable.js'?undefined:true;});
  assert.deepEqual(checked,['src/present.js','src/unreadable.js','src/absent.js']);
  assert.deepEqual(result.missing,['src/absent.js']);
  assert.ok(result.text.length<700, 'whole feedback fits the protected annotation head');
  assert.match(result.text,/no verification credit/);
  for(const record of ['README.md','docs/PROGRESS.md','DESIGN.md'])assert.equal(progressRecordFeedback(record,text,()=>{throw Error('must not probe');}),null);
  assert.equal(progressRecordFeedback('TODO.md','x'.repeat(65537),()=>{throw Error('oversized');}),null);
});

test('real progress edits flag missing files in the next prompt; verification still comes from execution', async t => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-progress-record-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));fs.mkdirSync(path.join(workspace,'src'));
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test check.test.js'}}));
  fs.writeFileSync(path.join(workspace,'check.test.js'),"import test from 'node:test'; import assert from 'node:assert/strict'; test('actual sum module',async()=>{const {sum}=await import('./src/sum.js'); assert.equal(sum([2,5]),7); assert.equal(sum([]),0);});\n");
  const bad='- [x] src/sum.js — implemented\n';
  const actions=[{a:'write_file',p:'PROGRESS.md',content:bad},{a:'shell',c:'npm test'},
    {a:'write_file',p:'src/sum.js',content:'export const sum = xs => xs.reduce((a,b)=>a+b,0);\n'},
    {a:'write_file',p:'PROGRESS.md',content:bad+'\nImplementation present; verification pending.\n'},
    {a:'shell',c:'npm test'},{a:'done',summary:'Implemented sum and verified the module.'}];
  const prompts=[],events=[];
  const result=await runAgent({task:'Implement src/sum.js sum(xs), returning the numeric sum (zero for an empty array). Maintain PROGRESS.md and run npm test.',workspace,
    maxTurns:actions.length,maxInvalidPerTurn:0,model:{assistantPrefill:'',actTemperature:null,async complete(prompt){prompts.push(prompt);assert.ok(actions.length);return{content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true};}},
    promptTrajectory:'extension',useGrammar:true,interactive:false,grounding:false,shellSandbox:'host',verificationScript:'npm test',
    completionAudit:false,stateAudit:'off',contractStateAudit:'off',diagnoseStuckTests:false,testFocus:false,regressionGuard:false,
    autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,onEvent:e=>events.push(e)});
  assert.match(result.turns[0].observation,/\[progress-record\].*"src\/sum.js"/);
  assert.ok(prompts[1].includes(result.turns[0].observation.match(/\[progress-record\][^\n]*/)[0]));
  assert.equal(shouldThink('auto',{turnIndex:1,lastObservation:result.turns[0].observation,lean:true}),true);
  assert.equal(result.turns[0].verificationEvidence??null,null);
  assert.equal(result.turns[1].verificationEvidence.status,'fail','checkbox did not create the missing implementation');
  assert.doesNotMatch(result.turns[3].observation,/\[progress-record\]/,'current source now exists');
  // The existing landing verifier may run after the source repair. Its real
  // receipt, rather than the checkbox, supplies the subsequent passing proof.
  if (result.turns[3].verificationEvidence) {
    const proof=result.turns[3].verificationEvidence;
    assert.equal(proof.source,'landing');
    assert.equal(proof.executedCommand,'npm test');
    assert.equal(proof.counts.passed,1);
    assert.match(proof.outputSha256,/^[a-f0-9]{64}$/);
  }
  assert.equal(result.turns[4].verificationEvidence.status,'pass');
  assert.equal(events.filter(e=>e.type==='progress_record_warning').length,1);
  assert.equal(result.reachedDone,true,result.turns.at(-1).observation);
});
