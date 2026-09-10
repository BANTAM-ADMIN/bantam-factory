import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {missingSourceRead} from '../src/source-read-recovery.js';
import {runAgent} from '../src/agent.js';
function fixture(t){const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-source-recovery-'));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));fs.writeFileSync(path.join(workspace,'app.js'),'export const value = 1;\nexport const other = 2;\n');return workspace;}
const action={a:'read_file',p:'app.js',start:1,limit:2};
const view='app.js (3 lines, showing 1-2):\n1\texport const value = 1;\n2\texport const other = 2;\n';
test('recover missing current source, not merely an old header or historical delivery',t=>{
 const workspace=fixture(t),config={workspace,paths:new Set(['app.js']),prompt:'earlier searches only',maxLines:160,maxChars:4000};
 assert.equal(missingSourceRead(action,config),true);
 assert.equal(missingSourceRead(action,{...config,prompt:view}),false);
 assert.equal(missingSourceRead(action,{...config,prompt:view.replace('value = 1','value = 0')}),true);
 assert.equal(missingSourceRead(action,{...config,prompt:view.split('\n').slice(0,2).join('\n')+'\n'}),true);
 assert.equal(missingSourceRead(action,{...config,paths:new Set()}),false);
 for(const override of [{limit:1000},{start:0},{start:90},{start:undefined,limit:undefined},{a:'shell',c:'cat app.js'}])assert.equal(missingSourceRead({...action,...override},config),false);
 fs.symlinkSync('/etc/hosts',path.join(workspace,'outside'));
 assert.equal(missingSourceRead({...action,p:'outside'},{...config,paths:new Set(['outside'])}),false);
});
test('only the lines fitting the actual source budget need recovery',t=>{
 const workspace=fixture(t);fs.writeFileSync(path.join(workspace,'app.js'),Array.from({length:160},(_,i)=>`// ${i} ${'data '.repeat(30)}`).join('\n'));
 const config={workspace,paths:new Set(['app.js']),prompt:'',maxLines:160,maxChars:4000};
 const source=fs.readFileSync(path.join(workspace,'app.js'),'utf8').split('\n');
 const prompt='app.js (160 lines, showing 1-160):\n'+source.map((s,i)=>`${i+1}\t${s}`).join('\n')+'\n';
 assert.equal(missingSourceRead({...action,limit:160},{...config,prompt}),false);
 assert.equal(missingSourceRead({...action,limit:160},{...config,prompt:prompt.slice(0,100)}),true);
});
test('a stalled real agent can fetch absent authored bytes, while repeated visible reads stay gated',async t=>{
 const workspace=fixture(t),controller=new AbortController(),events=[],prompts=[];
 const source=fs.readFileSync(path.join(workspace,'app.js'),'utf8');
 const actions=[{a:'search',q:'missing-one',p:'app.js'},{a:'search',q:'missing-two',p:'app.js'},{a:'search',q:'missing-three',p:'app.js'},action,action,action,action,action,action];
 let count=0;
 await runAgent({workspace,task:'Complete the implementation.',maxTurns:100,interactive:false,grounding:false,openFilesView:false,
  useGrammar:false,shellSandbox:'host',progressNudgeAfter:3,progressGateAllowEvery:0,thinkMode:'never',promptTrajectory:'extension',signal:controller.signal,
  resumeTurns:[{action:{a:'write_file',p:'app.js',content:source},editApplied:true,observation:'wrote app.js'}],
  model:{assistantPrefill:'',async complete(prompt){prompts.push(prompt);return {content:JSON.stringify(actions[count++]??action),tokens:1,stoppedEos:true,timings:{}};}},
  onEvent:e=>{events.push(e);if(e.type==='progress_gate'&&e.action?.a==='read_file')controller.abort();}
 });
 assert.equal(events.filter(e=>e.type==='progress_source_recovery').length,1);
 assert.ok(prompts.some(p=>p.includes('1\texport const value = 1;')),'recovered bytes reach the actual next prompt');
 assert.ok(events.some(e=>e.type==='progress_gate'&&e.action?.a==='read_file'),'same visible reads cannot evade the stall guard');
});
