import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {introducedDuplicateDefinition, duplicateDefinitionNote} from '../src/source-validation.js';
import {Executor} from '../src/executor.js';
import {runAgent} from '../src/agent.js';
import {shouldThink} from '../src/thinking.js';

const original = "export class Weapons {\n  fire() { return 'firing'; }\n  fire() { return 'firing'; }\n}\n";
const edited = original.replace("return 'firing'", "return 'pumping'");
const fixed = "export class Weapons { fire() { return 'pumping'; } }\n";
const finding = (before, after) => introducedDuplicateDefinition({path:'weapons.mjs',before,after});
function workspace(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-method-shadow-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}

test('class feedback distinguishes shadowed edits from active edits and legitimate separate members', () => {
  const result=finding(original, edited);
  assert.equal(result.name, 'Weapons.fire');
  assert.deepEqual(result.lines,[2,3]);
  assert.equal(result.shadowedEdit,true);
  assert.equal(finding(original,original),null);
  assert.equal(finding(original,original.replace("  fire() { return 'firing'; }\n}","  fire() { return 'pumping'; }\n}")),null);
  assert.equal(finding(original,fixed),null);
  assert.ok(finding(fixed,original),'introducing the duplicate is also visible');
  for(const source of [
    'class A {fire(){}} class B {fire(){}}',
    'class A {fire(){} static fire(){}}',
    'class A {get fire(){return 1} set fire(x){}}',
    'class A {[one](){} [two](){}}',
    'class A {fire = 1; fire(){}}',
    'const text = "class A {fire(){} fire(){}}";',
    'class Broken {',
  ]) assert.equal(finding('',source),null,source);
  const staticDup=finding('', 'class A {static fire(){} static fire(){}}');
  assert.equal(staticDup.name,'A.static fire');
  assert.equal(finding('', ' '.repeat(250001)+original),null,'advisory parsing stays bounded');
  const note=duplicateDefinitionNote(result,'weapons.mjs');
  assert.match(note,/LAST definition.*line 3/);
  assert.match(note,/cannot change the method called at runtime/);
  assert.ok(note.length<700);
  assert.equal(shouldThink('auto',{turnIndex:3,lastObservation:note,lean:true}),true);
});

test('all direct edit routes return the same shadowing evidence after successful writes', async t => {
  for(const a of ['replace','edit_lines','patch','write_file','write_batch']) {
    const dir=workspace(t);fs.writeFileSync(path.join(dir,'weapons.mjs'),original);
    const action=a==='replace'?{a,p:'weapons.mjs',old:"return 'firing'",new:"return 'pumping'",line:2}
      :a==='edit_lines'?{a,p:'weapons.mjs',start:2,end:2,new:"  fire() { return 'pumping'; }"}
      :a==='patch'?{a,edits:[{p:'weapons.mjs',old:"  fire() { return 'firing'; }",new:"  fire() { return 'pumping'; }",line:2}]}
      :a==='write_file'?{a,p:'weapons.mjs',content:edited}
      :{a,files:[{p:'weapons.mjs',content:edited}]};
    const executor=new Executor(dir,{shellSandbox:'host'});
    const result=await executor.execute(action);
    assert.match(result.observation,/\[dup-def\].*Weapons.fire/,a);
    assert.equal(fs.readFileSync(path.join(dir,'weapons.mjs'),'utf8'),edited,a);
    assert.equal(result.editOutcome.applied,true,a);
  }
});

test('real agent sees the shadowed-method notice and still needs actual passing execution',async t=>{
  const dir=workspace(t);fs.writeFileSync(path.join(dir,'weapons.mjs'),original);
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test check.test.js'}}));
  fs.writeFileSync(path.join(dir,'check.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {Weapons} from './weapons.mjs';test('immediate pump state',()=>assert.equal(new Weapons().fire(),'pumping'));\n");
  const actions=[{a:'replace',p:'weapons.mjs',old:"return 'firing'",new:"return 'pumping'",line:2},
    {a:'shell',c:'npm test'},{a:'write_file',p:'weapons.mjs',content:fixed},{a:'shell',c:'npm test'},
    {a:'done',summary:'The actual method returns the requested state and the test passes.'}];
  const prompts=[];
  const result=await runAgent({task:'Fix Weapons.fire() to immediately return pumping. Preserve the existing check and run npm test.',workspace:dir,
    maxTurns:actions.length,maxInvalidPerTurn:0,model:{assistantPrefill:'',actTemperature:null,async complete(prompt){prompts.push(prompt);assert.ok(actions.length);return{content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true};}},
    promptTrajectory:'extension',useGrammar:true,interactive:false,grounding:false,shellSandbox:'host',verificationScript:'npm test',
    completionAudit:false,stateAudit:'off',contractStateAudit:'off',diagnoseStuckTests:false,testFocus:false,regressionGuard:false,
    autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0});
  assert.match(prompts[1],/\[dup-def\].*Weapons.fire/);
  assert.equal(result.turns[0].verificationEvidence??null,null);
  assert.equal(result.turns[1].verificationEvidence.status,'fail','editing dead code did not repair the actual behavior');
  assert.doesNotMatch(result.turns[2].observation,/\[dup-def\]/);
  assert.equal(result.turns[3].verificationEvidence.status,'pass');
  assert.equal(result.reachedDone,true);
});
