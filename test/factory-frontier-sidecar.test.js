import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FRONTIER_MODELS,frontierPlan,frontierCommand,nativeModelIdentity,sidecarOutcome,
  gradeFrontier,frontierSourceSeal,runFrontierSidecar} from '../scripts/factory-frontier-sidecar.mjs';
import {freshCommand,FIGHT_CARDS} from '../scripts/factory-fights.mjs';
import {codexSessionUsage} from '../scripts/fight-usage.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const good={code:0,timedOut:false,aborted:false,bufferExceeded:false};
const grading={publicResult:good,hidden:good,record:{pass:true}};
const context=(model='gpt-5.6-sol',effort='medium')=>({type:'turn_context',payload:{model,effort,turn_id:'turn-1',
  collaboration_mode:{settings:{model,reasoning_effort:effort}}}});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'frontier-sidecar-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function session(dir,rows,name='native.jsonl'){fs.writeFileSync(path.join(dir,name),rows.map(r=>typeof r==='string'?r:JSON.stringify(r)).join('\n')+'\n');}

test('six independent native bouts cover each model/card once with alternating pair order',()=>{
  const plan=frontierPlan();assert.equal(plan.length,6);assert.equal(new Set(plan.map(r=>r.card+':'+r.model)).size,6);
  for(const card of FIGHT_CARDS)assert.deepEqual(new Set(plan.filter(r=>r.card===card).map(r=>r.model)),new Set(FRONTIER_MODELS));
  assert.deepEqual(plan.map(r=>r.arm),['codex-sol','codex-terra','codex-terra','codex-sol','codex-sol','codex-terra']);
  assert.ok(plan.every(r=>r.repeat===1));
});

test('command differs from frozen Astra command only at exact model value',()=>{
  const options={task:'Task with --model text, no rewriting',workspace:'/tmp/sidecar/ws',dir:'/tmp/sidecar',timeoutMs:600000};
  const baseline=freshCommand({...options,arm:'codex-astra'});
  for(const model of FRONTIER_MODELS){
    const actual=frontierCommand({...options,model}),expected=structuredClone(baseline);
    expected.args[expected.args.indexOf('--model')+1]=model;assert.deepEqual(actual,expected);
    assert.ok(actual.exe.endsWith('/scripts/astra-container-cli.mjs'));
    assert.ok(actual.args.includes('model_reasoning_effort="medium"'));
    assert.ok(actual.args.includes('--ignore-user-config'));assert.ok(actual.args.includes('--ignore-rules'));
    assert.ok(!actual.args.includes('--ephemeral'));assert.equal(actual.env.ASTRA_CONTAINER_SESSION_DIR,'/tmp/sidecar/native-sessions');
  }
  assert.throws(()=>frontierCommand({...options,model:'gpt-6-astra'}),/unsupported/);
});

test('model evidence requires actual matching turn contexts and medium effort across sessions',t=>{
  const dir=fixture(t);assert.equal(nativeModelIdentity(dir,'gpt-5.6-sol').status,'unknown');
  session(dir,[{type:'session_meta',payload:{model:'untrusted-metadata-only'}},context()]);
  let identity=nativeModelIdentity(dir,'gpt-5.6-sol');assert.equal(identity.status,'verified');assert.deepEqual(identity.observedModels,['gpt-5.6-sol']);
  session(dir,[context('gpt-5.6-terra')],'child.jsonl');assert.equal(nativeModelIdentity(dir,'gpt-5.6-sol').status,'mismatch');
  session(dir,[context('gpt-5.6-sol','high')],'child.jsonl');assert.equal(nativeModelIdentity(dir,'gpt-5.6-sol').status,'mismatch');
  const row=context();row.payload.collaboration_mode.settings.model='unexpected';session(dir,[row],'child.jsonl');
  assert.equal(nativeModelIdentity(dir,'gpt-5.6-sol').status,'mismatch');
});

test('malformed, missing, and symlink identity evidence never verifies by assumption',t=>{
  const dir=fixture(t);session(dir,[context(),'not-json']);assert.equal(nativeModelIdentity(dir,'gpt-5.6-sol').status,'unknown');
  session(dir,[context(),{type:'turn_context',payload:{model:'gpt-5.6-sol'}}]);assert.equal(nativeModelIdentity(dir,'gpt-5.6-sol').status,'unknown');
  session(dir,[context()]);fs.symlinkSync(path.join(dir,'native.jsonl'),path.join(dir,'linked.jsonl'));
  const identity=nativeModelIdentity(dir,'gpt-5.6-sol');assert.equal(identity.status,'unknown');assert.ok(identity.errors.some(e=>e.includes('symlink')));
  fs.symlinkSync(dir,path.join(dir,'linked-directory'));assert.equal(nativeModelIdentity(path.join(dir,'linked-directory'),'gpt-5.6-sol').status,'unknown');
});

test('all six rows retain failures, output-only, model mismatch and integrity separately',()=>{
  const cases=[
    {result:good,grading,modelIdentity:{status:'verified'}},
    {result:good,grading:{...grading,record:{pass:false}},modelIdentity:{status:'verified'}},
    {result:{...good,code:124,timedOut:true},grading:{...grading,record:{pass:false}},modelIdentity:{status:'verified'}},
    {result:{...good,code:1},grading,modelIdentity:{status:'verified'}},
    {result:good,grading,modelIdentity:{status:'mismatch'}},
    {result:good,grading,modelIdentity:{status:'verified'},integrity:false},
  ];
  const rows=frontierPlan().map((item,i)=>({...item,...sidecarOutcome(cases[i])}));
  assert.equal(rows.length,6);assert.deepEqual(rows.map(r=>r.outcome),['PASS','FAIL','TIMEOUT','OUTPUT_ONLY','MODEL_MISMATCH','INTEGRITY_ERROR']);
  assert.equal(rows.filter(r=>r.pass).length,1);
  assert.equal(sidecarOutcome({result:good,grading,modelIdentity:{status:'unknown'}}).outcome,'OUTPUT_ONLY');
  assert.equal(sidecarOutcome({...cases[0],tampered:['package.json']}).outcome,'FAIL');
  assert.equal(sidecarOutcome({...cases[0],result:{...good,bufferExceeded:true}}).outcome,'OUTPUT_ONLY');
});

test('same public and held-out judges run offline read-only with only exact support files',async()=>{
  const calls=[];const card='receipt-reducer',kit=path.join(ROOT,'examples/fights/factory-2026-09-06');
  const descriptor=JSON.parse(fs.readFileSync(path.join(kit,card,'card.json'),'utf8'));
  const record={schema:'bantam.factory-card-grade.v1',card,pass:true,groups:descriptor.groups.map(name=>({name,pass:true}))};
  const result=await gradeFrontier('/tmp/a candidate',card,{run:async(workspace,command,options)=>{
    calls.push({workspace,command,options});return {...good,stdout:command==='npm test'?'':JSON.stringify(record),stderr:''};
  }});
  assert.equal(calls.length,2);assert.equal(calls[0].command,'npm test');assert.deepEqual(result.record,record);
  for(const c of calls){assert.equal(c.workspace,'/tmp/a candidate');assert.equal(c.options.shellSandbox,'docker');
    assert.equal(c.options.shellNetwork,false);assert.equal(c.options.workspaceReadOnly,true);assert.equal(c.options.timeoutMs,60000);}
  assert.deepEqual(calls[1].options.readOnlyHostFiles,[path.join(kit,'grader-support.mjs'),path.join(kit,card,'grader.mjs'),path.join(kit,card,'card.json')]);
  assert.ok(calls[1].options.readOnlyHostFiles.every(p=>!p.includes('reviewer')&&!p.includes('starter')));
  assert.equal(result.timing.totalWallMs,result.timing.publicWallMs+result.timing.hiddenWallMs);
});

test('native response accounting remains unknown or incomplete, never fabricated zero',t=>{
  const dir=fixture(t);session(dir,[context()]);assert.equal(codexSessionUsage(dir),null);
  const usage={type:'token_usage_record',payload:{response_id:'resp-one',thread_id:'thread',
    usage:{input_tokens:100,cached_input_tokens:60,output_tokens:12,reasoning_output_tokens:3}}};
  session(dir,[context(),usage,usage]);let observed=codexSessionUsage(dir);
  assert.equal(observed.requests,1);assert.equal(observed.freshInputTokens,40);assert.equal(observed.complete,true);
  session(dir,[context(),usage,{...usage,payload:{...usage.payload,response_id:'resp-two',usage:{input_tokens:'wrong'}}}]);
  observed=codexSessionUsage(dir);assert.equal(observed.complete,false);assert.equal(observed.inputTokens,100);assert.ok(observed.errors.length);
});

test('source seal includes sidecar and shared execution but excludes concurrent reports/exporters',()=>{
  const seal=frontierSourceSeal();
  for(const file of ['scripts/factory-frontier-sidecar.mjs','scripts/factory-fights.mjs','scripts/astra-container-cli.mjs',
    'scripts/repobrief-astra-fights.mjs','scripts/fight-usage.mjs','src/executor.js','src/process-runner.js','src/fight.js','package.json'])assert.match(seal[file],/^[a-f0-9]{64}$/);
  assert.equal(seal['scripts/factory-fight-export.mjs'],undefined);assert.equal(seal['scripts/factory-fight-replay.mjs'],undefined);
});

test('run refuses reuse, relative paths and altered deadline before any model execution',async t=>{
  const dir=fixture(t);await assert.rejects(runFrontierSidecar({output:dir}),/fresh absolute/);
  await assert.rejects(runFrontierSidecar({output:'relative-output'}),/fresh absolute/);
  await assert.rejects(runFrontierSidecar({output:path.join(dir,'fresh'),timeoutMs:1000}),/fixed 600/);
  assert.equal(fs.existsSync(path.join(dir,'fresh')),false);
});
