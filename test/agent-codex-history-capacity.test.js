import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runAgent} from '../src/agent.js';
import {ModelClient} from '../src/model.js';

test('the model client exposes only its selected native runtime capacity', () => {
  const model=new ModelClient({codex:true,model:'capacity-test'});
  model.modelName='capacity-test';
  model.codexRuntime={contextWindowFor:name=>name==='capacity-test'?258400:null};
  assert.equal(model.contextWindowTokens,258400);
  model.modelName='different-model';
  assert.equal(model.contextWindowTokens,null);
  model.codex=false;
  assert.equal(model.contextWindowTokens,null);
});

test('a large design read stays in the extension prompt after the first native capacity receipt', async t => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-codex-capacity-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  for(let i=0;i<6;i++)fs.writeFileSync(path.join(workspace,`design-${i}.md`),
    Array.from({length:180},(_,n)=>`Section ${i} line ${n}: `+String.fromCharCode(65+i).repeat(165)).join('\n')+`\nREQUIREMENT_${i}_END\n`);
  const prompts=[],events=[];
  const model={assistantPrefill:'',actTemperature:null,codexBacked:true,contextWindowTokens:null,
    requestCursor(){return prompts.length;},
    async complete(prompt){
      const index=prompts.length;prompts.push(String(prompt));this.contextWindowTokens=258400;
      return {content:JSON.stringify(index<6?{a:'read_file',p:`design-${index}.md`}:{a:'respond',text:'The specification has been read.'}),tokens:1,stoppedEos:true,stoppedLimit:false,timings:{}};
    }};
  const result=await runAgent({task:'Read all six design documents and explain them without editing.',workspace,model,maxTurns:8,
    interactive:true,useGrammar:false,grounding:false,shellSandbox:'host',promptTrajectory:'extension',verificationPolicy:'after_edit',onEvent:e=>events.push(e)});
  assert.equal(result.responded,true);
  assert.equal(prompts.length,7);
  assert.ok(events.some(e=>e.type==='history_budget_updated'&&e.contextTokens===258400&&e.source==='runtime'));
  assert.ok(!events.some(e=>e.type==='extension_history_rebase'&&e.overflow));
  assert.ok(prompts.at(-1).length>120000,'exercise the old premature rebase threshold');
  for(let i=0;i<6;i++)assert.ok(prompts.at(-1).includes(`REQUIREMENT_${i}_END`),`design ${i} retained`);
});
