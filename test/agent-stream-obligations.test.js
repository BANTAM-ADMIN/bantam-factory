import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {runAgent} from '../src/agent.js';
import {RunCheckpoint} from '../src/run-checkpoint.js';
import {buildArtifact} from '../src/artifact.js';
const TASK='Repair api.mjs. Export createDecoder(). push(chunk: Uint8Array) -> [{event: STRING,data: STRING}]; finish() -> []. Decode strict UTF-8 across pushes. Any rejected push/finish poisons the decoder; subsequent calls reject. Each nonempty line emits a message frame except END, which terminates. After END only blank lines are allowed. Require termination and no pending line at finish. Strings are rejected. Run npm test.';
const GOOD=`export function createDecoder(){let p=false,done=false,end=false,s='';const u=new TextDecoder('utf-8',{fatal:true});return {push(b){try{if(p||done||!(b instanceof Uint8Array))throw Error('state/type');s+=u.decode(b,{stream:true});const out=[];while(s.includes('\\n')){const i=s.indexOf('\\n'),v=s.slice(0,i);s=s.slice(i+1);if(end&&v)throw Error('terminated');if(v==='END')end=true;else if(v)out.push({event:'message',data:v});}return out;}catch(e){p=true;throw e;}},finish(){try{if(p||done)throw Error('state');s+=u.decode();if(!end||s)throw Error('incomplete');done=true;return [];}catch(e){p=true;throw e;}}};}`;
test('live station refuses public-green completion, records failures, and accepts fresh repaired obligations',{
 skip:process.env.BANTAM_LIVE_SANDBOX_TEST!=='1',timeout:120000,
},async t=>{
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'agent-stream-station-'));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
 fs.writeFileSync(path.join(workspace,'api.mjs'),'export function createDecoder(){return {}; }');
 fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test'}}));
 fs.mkdirSync(path.join(workspace,'test'));fs.writeFileSync(path.join(workspace,'test/public.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {createDecoder} from '../api.mjs';test('factory',()=>assert.equal(typeof createDecoder(),'object'));");
 const bad=GOOD.replaceAll('p=true;throw e;','throw e;'),spec={module:'api.mjs',export:'createDecoder',validText:'é\nEND\n',expectedJson:'[{"event":"message","data":"é"}]',terminalSuffix:'bad\n'};
 const actions=[{a:'write_file',p:'api.mjs',content:bad},{a:'shell',c:'npm test'},{a:'done',summary:'Premature'},
 {a:'write_file',p:'api.mjs',content:GOOD},{a:'shell',c:'npm test'},{a:'done',summary:'Repaired and verified'}];
 const checkpoint=new RunCheckpoint({dest:path.join(workspace,'checkpoint.json'),autosaveEvery:0});let proposals=0;
 const result=await runAgent({workspace,task:TASK,maxTurns:6,maxInvalidPerTurn:0,
 model:{assistantPrefill:'',async complete(prompt,options){if(options.recordLabel==='stream-obligation-fixture-review')return {content:'{"valid":true,"reason":"toy stream verified"}',tokens:1};if(options.recordLabel==='stream-obligation-fixture'){proposals++;return {content:JSON.stringify(spec),tokens:1};}
 assert.ok(actions.length,'unexpected worker request');return {content:JSON.stringify(actions.shift()),tokens:1};}},
 useGrammar:false,interactive:false,grounding:false,shellSandbox:'docker',shellNetwork:false,probeEnabled:true,
 verificationScript:'npm test',verificationWorkspaceReadOnly:true,contractStateAudit:'off',contractAssertionStation:'off',
 completionAudit:false,stateAudit:'off',testFocus:false,regressionGuard:false,
 autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,onEvent:e=>checkpoint.note(e)});
 assert.equal(result.turns[1].streamVerification.obligations.find(x=>x.id==='rejection-state').status,'failed');
 assert.notEqual(result.turns[2].doneAccepted,true);
 assert.match(result.turns[2].observation,/stream obligations remain/);
 assert.ok(result.turns.some(t=>t.streamVerification?.status==='passed'),JSON.stringify(result.turns.map(t=>({a:t.parsedAction??t.action,station:t.streamVerification,obs:t.observation}))).slice(-10000));
 assert.equal(result.reachedDone,true,result.turns.at(-1).observation);
 assert.equal(proposals,1,'only fixture data is reused, execution is fresh');
 assert.ok(checkpoint.turns().some(t=>t.streamVerification?.obligations.some(x=>x.status==='failed')));
 const artifact=buildArtifact({runId:'stream-station-test',stamp:new Date().toISOString(),task:TASK,result});
 assert.ok(artifact.turns.some(t=>t.streamVerification?.status==='passed'),'final artifacts retain station receipts, not only crash checkpoints');
});
