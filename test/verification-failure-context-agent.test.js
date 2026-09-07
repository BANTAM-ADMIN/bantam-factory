import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runAgent,formatWorkingNoteReanchor} from '../src/agent.js';
import {collectObjectConstructionFacts,formatObjectConstructionFacts} from '../src/object-construction-facts.js';

const MARKER='[verification workflow: current decision]';
const FALSE_NOTE='HYPOTHESIS_SENTINEL: s.frame = frameFor(s), so frameFor must have returned undefined. Inspect the private helper export again.';
const BAD="function frameFor(s) { return s.text.toUpperCase(); }\n"
  +"export function packItems(items) {\n  return items.map(s => ({\n    frame: frameFor(s),\n    bytes: Buffer.byteLength(s.frame, 'utf8'),\n  }));\n}\n";
const GOOD=BAD.replace("Buffer.byteLength(s.frame, 'utf8')","Buffer.byteLength(frameFor(s), 'utf8')");
const latestWorkflow=prompt=>prompt.slice(prompt.lastIndexOf(MARKER));

test('current typed failure suppresses a newer freeform checkpoint, not its raw journal',()=>{
  const state={workingNote:{turn:18,text:FALSE_NOTE},lastEdit:{turn:6,target:'src/items.js'},
    editsSinceWorkingNote:0,lastVerdict:{turn:17,result:'fail'}};
  const original=JSON.stringify(state);
  assert.match(formatWorkingNoteReanchor(state,{recoveryEvidence:{turn:17,status:'fail'}}),/HYPOTHESIS_SENTINEL/);
  assert.equal(formatWorkingNoteReanchor(state,{suppressDuringCurrentFailure:true,recoveryEvidence:{turn:17,status:'fail'}}),'');
  assert.equal(JSON.stringify(state),original);
});

for(const workspacePrefix of [false,true])test(`actual ${workspacePrefix?'exact-workspace cd':'direct'} extension keeps current red and complete source facts through log/read turns, then retires on real configured PASS`,async t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-configured-failure-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.mkdirSync(path.join(workspace,'src'));fs.mkdirSync(path.join(workspace,'test'));
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test test/public.test.js'}}));
  fs.writeFileSync(path.join(workspace,'src/items.js'),'// Implement the public transformation here.\n');
  fs.writeFileSync(path.join(workspace,'test/public.test.js'),"import test from 'node:test'; import assert from 'node:assert/strict'; import {packItems} from '../src/items.js'; test('actual public operand',()=>assert.deepEqual(packItems([{text:'ok'}]),[{frame:'OK',bytes:2}]));\n");
  const configuredShell=workspacePrefix?`cd ${workspace} && npm test 2>&1\n`:'npm test';
  const actions=[
    {a:'write_file',p:'src/items.js',content:BAD},
    {a:'shell',c:configuredShell},
    {a:'read_file',p:'src/items.js',start:2,limit:6},
    {a:'shell',c:'node --check src/items.js'},
    {a:'read_file',p:'src/items.js',start:3,limit:5},
    {a:'write_file',p:'src/items.js',content:GOOD},
    {a:'shell',c:configuredShell},
    {a:'read_file',p:'src/items.js',start:1,limit:8},
    {a:'done',summary:'Implemented and verified the public transformation.'},
  ];
  let cursor=0;
  const thoughtPrompts=[],actionPrompts=[];
  const model={assistantPrefill:'<|im_start|>assistant\n<think>\n</think>\n\n',
    thinkMarkers:{open:'<think>\n',close:'</think>'},stop:[],actTemperature:null,
    async complete(prompt){
      if(prompt.endsWith('<think>\n')){
        thoughtPrompts.push(prompt);
        return {content:cursor===2?FALSE_NOTE:'Use current source and execution evidence.',tokens:1,stoppedEos:true};
      }
      actionPrompts.push(prompt);assert.ok(cursor<actions.length,'scripted model is bounded; no live model calls');
      return {content:JSON.stringify(actions[cursor++]),tokens:1,stoppedEos:true};
    }};
  const live=process.env.BANTAM_LIVE_SANDBOX_TEST==='1';
  const result=await runAgent({workspace,model,
    task:'Implement src/items.js packItems(items). For each input object with text, return a new object with uppercase frame and its UTF-8 bytes. Do not mutate inputs. Run npm test.',
    maxTurns:actions.length,maxInvalidPerTurn:0,terminalClosureTurns:0,
    promptTrajectory:'extension',extensionBareHistory:true,thinkMode:'always',useGrammar:true,
    interactive:false,grounding:false,shellSandbox:live?'docker':'host',verificationScript:'npm test',
    verificationWorkspaceReadOnly:live,completionAudit:false,stateAudit:'off',contractStateAudit:'off',
    contractAssertionStation:'off',diagnoseStuckTests:false,testFocus:false,regressionGuard:false,
    progressAwareness:false,preGate:false,autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
  });
  assert.equal(cursor,actions.length);assert.equal(result.turns[1].verificationEvidence.status,'fail');
  assert.equal(result.turns[1].verificationEvidence.configuredCommand,workspacePrefix?null:'npm test',
    'actual recorder binds the direct command, but leaves the merged workspace-prefixed alias null');
  assert.equal(result.turns[3].verificationEvidence.status,'pass','unrelated syntax command really ran green');
  assert.equal(result.turns[6].verificationEvidence.status,'pass',result.turns.slice(5,7).map(t=>t.observation).join('\n'));
  assert.equal(result.reachedDone,true,result.turns.at(-1)?.observation);
  assert.equal(result.turns[2].reasoning,FALSE_NOTE,'raw reasoning remains available for audit');
  const sourceReceipt=collectObjectConstructionFacts({source:BAD,path:'src/items.js'});
  const fact=formatObjectConstructionFacts(sourceReceipt);
  for(const i of [2,3,4,5]){
    const current=latestWorkflow(thoughtPrompts[i]);
    assert.match(current,/^\[verification workflow: current decision\]\nEXECUTION FAILURE:/);
    assert.ok(current.includes(JSON.stringify(configuredShell.replace(/[\x00-\x1f\x7f]/g,' '))),
      'the exact actual command remains visible, including its recognized workspace prefix');
    assert.ok(current.includes(fact),'entire source distinction and caveat must survive delivery');
    assert.doesNotMatch(current,/HYPOTHESIS_SENTINEL|\[working-checkpoint/);
    assert.equal(result.turns[i-1].verificationWorkflow.phase,'failure');
    assert.equal(result.turns[i-1].verificationWorkflow.sourceFacts[0].sourceSha256,
      crypto.createHash('sha256').update(BAD).digest('hex'));
  }
  for(let i=1;i<thoughtPrompts.length;i++){
    const prior=thoughtPrompts[i-1].slice(0,thoughtPrompts[i-1].lastIndexOf('<|im_start|>assistant'));
    assert.ok(thoughtPrompts[i].startsWith(prior),`decision ${i} keeps the exact cacheable prefix; only the thinking tail is volatile`);
  }
  for(const i of [7,8]){
    assert.equal(result.turns[i-1].verificationWorkflow,undefined,'no current failure slot remains after actual configured PASS');
    const appended=thoughtPrompts[i].slice(thoughtPrompts[i-1].lastIndexOf('<|im_start|>assistant'));
    assert.doesNotMatch(appended,/EXECUTION FAILURE:|Current source fact:/);
  }
  assert.ok(thoughtPrompts[7].includes('EXECUTION FAILURE:'),'old failure remains historical immutable evidence');
  assert.equal(fs.readFileSync(path.join(workspace,'src/items.js'),'utf8'),GOOD);
});
