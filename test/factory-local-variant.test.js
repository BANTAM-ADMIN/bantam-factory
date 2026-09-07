import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {variantKit,variantOptions,parseVariantArgs,localVariantCommand,gradeLocalVariant,variantVerdict,runLocalVariant,cleanupVariantWorkspace,verifyVariantServer} from '../scripts/factory-local-variant.mjs';
import {freshCommand} from '../scripts/factory-fights.mjs';

const base={output:'/tmp/tiel-variant-evidence',label:'Tiel35BA3B IQ4_XS',variantId:'tiel35ba3b-iq4-xs'};
const successfulProcess={code:0,timedOut:false,aborted:false,bufferExceeded:false};
const saved={result:{reachedDone:true,pass:true,interrupted:false}};
const grading={publicResult:successfulProcess,hidden:successfulProcess,record:{pass:true,groups:[{name:'one',pass:true}]}};

test('variant options name the actual model without historical 27B labels',()=>{
  const parsed=variantOptions(base);
  assert.equal(parsed.kitId,'factory-2026-09-06');
  assert.equal(parsed.arm,'bantam-local-tiel35ba3b-iq4-xs');assert.equal(parsed.label,'Tiel35BA3B IQ4_XS');
  assert.deepEqual(parsed.cards,['receipt-reducer','snapshot-drift','job-planner']);
  assert.equal(parsed.timeoutMs,600000);assert.equal(parsed.modelId,null);
  assert.equal(variantOptions({...base,endpoint:'http://127.0.0.1:8089/'}).endpoint,'http://127.0.0.1:8089');
});

test('explicit versioned kit selects only its own fresh cards without changing historical defaults',()=>{
  const prefix=['--output',base.output,'--label',base.label,'--variant-id',base.variantId];
  const selected=parseVariantArgs([...prefix,'--kit','factory-2026-09-07']);
  assert.equal(selected.kitId,'factory-2026-09-07');
  assert.deepEqual(selected.cards,['context-packet','patch-transaction','stream-framer']);
  assert.deepEqual(parseVariantArgs([...prefix,'--kit','factory-2026-09-07','--cards','stream-framer,context-packet']).cards,
    ['stream-framer','context-packet']);
  assert.deepEqual(variantOptions(base).cards,['receipt-reducer','snapshot-drift','job-planner']);
  assert.equal(selected.timeoutMs,600000);assert.equal(selected.contractAssertionStation,false);
  assert.equal(selected.verificationWorkspaceReadOnly,false);
  const kit=variantKit(selected.kitId);
  assert.equal(path.basename(kit.root),'factory-2026-09-07');assert.ok(path.isAbsolute(kit.root));
  kit.cards.push('injected');
  assert.deepEqual(variantKit(selected.kitId).cards,['context-packet','patch-transaction','stream-framer']);
});

test('kit selection rejects cross-kit cards, arbitrary directories and duplicate flags before execution',async()=>{
  const prefix=['--output',base.output,'--label',base.label,'--variant-id',base.variantId];
  for(const suffix of [
    ['--kit','factory-2026-09-07','--cards','snapshot-drift'],
    ['--cards','context-packet'],['--kit','factory-2026-09-07','--cards','context-packet,context-packet'],
    ['--kit','factory-2026-09-07','--kit','factory-2026-09-06'],
    ['--kit','../../private'],['--kit','/tmp/user-kit'],['--kit','unknown'],['--kit','__proto__'],['--kit'],
  ])assert.throws(()=>parseVariantArgs([...prefix,...suffix]));
  for(const kitId of [null,{},[],1])assert.throws(()=>variantKit(kitId));
  const run=async()=>{throw Error('must not launch a grading process');};
  await assert.rejects(gradeLocalVariant('/tmp/ws','snapshot-drift',{kitId:'factory-2026-09-07',run}),/invalid card/);
  await assert.rejects(gradeLocalVariant('/tmp/ws','context-packet',{run}),/invalid card/);
});

test('variant CLI rejects ambiguous options, remote endpoints, unsafe identities and duplicate cards',()=>{
  const prefix=['--output',base.output,'--label',base.label,'--variant-id',base.variantId];
  const parsed=parseVariantArgs([...prefix,'--model-id','server-exact-model','--endpoint','http://localhost:8089','--cards','snapshot-drift','--timeout-seconds','120']);
  assert.equal(parsed.modelId,'server-exact-model');assert.deepEqual(parsed.cards,['snapshot-drift']);assert.equal(parsed.timeoutMs,120000);
  for(const suffix of [['--wat','x'],['--cards'],['--label','duplicate'],['--cards','job-planner,job-planner'],['--timeout-seconds','601']])assert.throws(()=>parseVariantArgs([...prefix,...suffix]));
  for(const endpoint of ['https://127.0.0.1','http://example.com','http://x:y@127.0.0.1','http://127.0.0.1/v1','http://127.0.0.1/?x=1'])assert.throws(()=>variantOptions({...base,endpoint}));
  for(const mutation of [{output:'relative'},{label:''},{label:'a\nb'},{variantId:'../../old'},{cards:[]},{modelFile:'model.gguf'}])assert.throws(()=>variantOptions({...base,...mutation}));
});

test('local variant reuses exact BANTAM baseline command and budgets without inherited model-label claims',()=>{
  const context={task:'EXACT WORK ORDER',workspace:'/tmp/tiel/ws',dir:'/tmp/tiel',endpoint:'http://127.0.0.1:9191',modelId:'actual-model'};
  const command=localVariantCommand(context);
  const baseline=freshCommand({...context,model:context.modelId,arm:'bantam-local-27b',probeEnabled:true});
  assert.deepEqual(command,{exe:baseline.exe,args:baseline.args,env:baseline.env});
  const value=flag=>command.args[command.args.indexOf(flag)+1];
  assert.equal(value('--endpoint'),context.endpoint);assert.equal(value('--profile'),'qwen');assert.equal(value('--max-turns'),'60');
  assert.equal(value('--context-mode'),'extension');assert.equal(value('--verify'),'npm test');
  assert.equal(command.env.BANTAM_PROBE,'1');assert.equal(command.env.BANTAM_IMMUTABLE_HISTORY,'1');
  assert.equal(command.env.BANTAM_SAVE_PROMPTS,'1');assert.equal(command.env.BANTAM_TEACHER,'0');
  assert.equal(command.env.BANTAM_SHELL_SANDBOX,'docker');assert.equal(command.env.BANTAM_SHELL_NETWORK,'0');
  assert.ok(!JSON.stringify(command).includes('27b'),'recipe lookup key must not leak a false model identity into the actual command');
});

test('new local variant explicitly opts into readonly configured verification without altering task or legacy recipe',()=>{
  const prefix=['--output',base.output,'--label',base.label,'--variant-id',base.variantId];
  assert.equal(parseVariantArgs([...prefix,'--verify-workspace-read-only']).verificationWorkspaceReadOnly,true);
  assert.equal(variantOptions(base).verificationWorkspaceReadOnly,false);
  assert.throws(()=>parseVariantArgs([...prefix,'--verify-workspace-read-only','--verify-workspace-read-only']),/duplicate/);
  assert.throws(()=>variantOptions({...base,verificationWorkspaceReadOnly:'yes'}),/boolean/);
  const context={task:'UNCHANGED WORK ORDER',workspace:'/tmp/tiel/ws',dir:'/tmp/tiel',endpoint:'http://127.0.0.1:9191',modelId:'actual-model'};
  const original=localVariantCommand(context), selected=localVariantCommand({...context,verificationWorkspaceReadOnly:true});
  assert.deepEqual(selected.args,[...original.args,'--verify-workspace-read-only']);
  assert.deepEqual(selected.env,{...original.env,BANTAM_VERIFY_WORKSPACE_READ_ONLY:'1'});
  assert.equal(selected.args[selected.args.indexOf('--task')+1],context.task);
});

test('experimental assertion station requires a recorded explicit runner opt-in',()=>{
  const prefix=['--output',base.output,'--label',base.label,'--variant-id',base.variantId];
  assert.equal(variantOptions(base).contractAssertionStation,false);
  assert.equal(parseVariantArgs([...prefix,'--contract-assertion-station']).contractAssertionStation,true);
  assert.throws(()=>parseVariantArgs([...prefix,'--contract-assertion-station','--contract-assertion-station']),/duplicate/);
  assert.throws(()=>variantOptions({...base,contractAssertionStation:'on'}),/boolean/);
  const context={task:'UNCHANGED WORK ORDER',workspace:'/tmp/tiel/ws',dir:'/tmp/tiel',endpoint:'http://127.0.0.1:9191',modelId:'actual-model'};
  const baseline=localVariantCommand(context),enabled=localVariantCommand({...context,contractAssertionStation:true});
  assert.deepEqual(enabled.args,baseline.args);
  assert.deepEqual(enabled.env,{...baseline.env,BANTAM_CONTRACT_ASSERTION_STATION:'on'});
});

test('one DONE-only allowance is an explicit option, not an inherited work-budget increase',()=>{
  const prefix=['--output',base.output,'--label',base.label,'--variant-id',base.variantId];
  assert.equal(variantOptions(base).terminalClosure,false);
  assert.equal(parseVariantArgs([...prefix,'--terminal-closure']).terminalClosure,true);
  assert.throws(()=>parseVariantArgs([...prefix,'--terminal-closure','--terminal-closure']),/duplicate/);
  assert.throws(()=>variantOptions({...base,terminalClosure:1}),/boolean/);
  const context={task:'UNCHANGED WORK ORDER',workspace:'/tmp/tiel/ws',dir:'/tmp/tiel',endpoint:'http://127.0.0.1:9191',modelId:'actual-model'};
  const baseline=localVariantCommand(context),enabled=localVariantCommand({...context,terminalClosure:true});
  assert.deepEqual(enabled.args,baseline.args);
  assert.deepEqual(enabled.env,{...baseline.env,BANTAM_TERMINAL_CLOSURE:'1'});
  assert.equal(enabled.args[enabled.args.indexOf('--max-turns')+1],'60');
});

test('public and hidden grading reuse readonly offline Docker and exact five-group protocol without launching candidates',async()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),card='job-planner';
  const descriptor=JSON.parse(fs.readFileSync(path.join(root,'examples/fights/factory-2026-09-06',card,'card.json'),'utf8'));
  const calls=[],record={schema:'bantam.factory-card-grade.v1',card,pass:true,groups:descriptor.groups.map(name=>({name,pass:true}))};
  const result=await gradeLocalVariant('/tmp/tiel candidate/ws',card,{run:async(workspace,command,options)=>{
    calls.push({workspace,command,options});return {...successfulProcess,stdout:command==='npm test'?'public tests pass':JSON.stringify(record),stderr:''};
  }});
  assert.equal(calls.length,2);assert.equal(calls[0].command,'npm test');
  for(const call of calls){assert.equal(call.options.shellSandbox,'docker');assert.equal(call.options.shellNetwork,false);assert.equal(call.options.workspaceReadOnly,true);}
  assert.ok(calls[1].command.includes("'/tmp/tiel candidate/ws'"));
  assert.ok(calls[1].options.readOnlyHostFiles.some(file=>file.endsWith('/grader-support.mjs')));
  assert.ok(!calls[1].options.readOnlyHostFiles.some(file=>file.includes('/reviewer/')||file.includes('/starter/')));
  assert.deepEqual(result.record,record);
});

test('new-kit grading binds its own descriptor, grader and support while keeping reviewer code private',async()=>{
  const selected=variantKit('factory-2026-09-07'),card='context-packet';
  const descriptor=JSON.parse(fs.readFileSync(path.join(selected.root,card,'card.json'),'utf8'));
  const record={schema:'bantam.factory-card-grade.v1',card,pass:true,groups:descriptor.groups.map(name=>({name,pass:true}))};
  const calls=[],result=await gradeLocalVariant('/tmp/new-kit candidate/ws',card,{kitId:selected.id,run:async(workspace,command,options)=>{
    calls.push({workspace,command,options});
    return {...successfulProcess,stdout:command==='npm test'?'public passed':JSON.stringify(record),stderr:''};
  }});
  assert.equal(calls.length,2);assert.equal(calls[0].command,'npm test');
  assert.ok(calls[1].command.includes(path.join(selected.root,card,'grader.mjs')));
  assert.ok(calls[1].command.includes("'/tmp/new-kit candidate/ws'"));
  const mounts=calls[1].options.readOnlyHostFiles;
  assert.ok(mounts.includes(path.join(selected.root,'grader-support.mjs')));
  assert.ok(mounts.includes(path.join(selected.root,card,'card.json')));
  assert.ok(mounts.every(file=>file.startsWith(selected.root+path.sep)));
  assert.ok(mounts.every(file=>!file.includes('/reviewer/')&&!file.includes('/starter/')));
  for(const call of calls){assert.equal(call.options.shellSandbox,'docker');assert.equal(call.options.shellNetwork,false);assert.equal(call.options.workspaceReadOnly,true);}
  assert.deepEqual(result.record,record);
});

test('passing groups alone do not erase a timeout, public test failure, or protected-file change',()=>{
  const input={processResult:successfulProcess,grading,tampered:[],saved,usage:{requests:4}};
  assert.equal(variantVerdict(input).outcome,'PASS');
  const timeout={...successfulProcess,code:1,timedOut:true};
  assert.deepEqual(variantVerdict({...input,processResult:timeout}),{outcome:'OUTPUT_ONLY',pass:false,candidatePass:true,processCompleted:false,acceptedCompletion:true});
  const failedPublic={...grading,publicResult:{...successfulProcess,code:1}};
  const disagreement=variantVerdict({...input,processResult:timeout,grading:failedPublic});
  assert.equal(disagreement.outcome,'TIMEOUT');assert.equal(disagreement.candidatePass,false);
  assert.equal(variantVerdict({...input,tampered:['package.json']}).outcome,'FAIL');
  assert.equal(variantVerdict({...input,grading:{...grading,record:null}}).outcome,'FAIL');
  assert.equal(variantVerdict({...input,saved:null}).outcome,'OUTPUT_ONLY');
  assert.equal(variantVerdict({...input,usage:{requests:0}}).outcome,'SETUP_ERROR');
});

test('existing evidence is rejected before contacting the local endpoint',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'factory-local-variant-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  await assert.rejects(runLocalVariant({...base,output:directory,endpoint:'http://127.0.0.1:1'}),/overwrite/);
  assert.deepEqual(fs.readdirSync(directory),[]);
});

function cleanupFixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-variant-guard-')),workspace=path.join(dir,'ws');
  fs.mkdirSync(workspace);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,workspace};
}
const containerRecord=(digit,source,rw=true)=>({id:digit.repeat(64),name:`/bantam-shell-123-456-${digit}`,
  mounts:[{Type:'bind',Source:source,Destination:'/workspace',RW:rw}]});
function mockDocker(records,{removeFails=false,retainRemoved=false}={}){
  const remaining=new Map(records.map(record=>[record.id,record])),calls=[];
  return {calls,run:async(file,args)=>{
    calls.push({file,args});assert.equal(file,'docker');
    if(args[1]==='ls')return {...successfulProcess,stdout:[...remaining.keys()].join('\n'),stderr:''};
    if(args[1]==='inspect'){
      assert.ok(!args[3].includes('Config'));assert.ok(!args[3].includes('Env'));
      return {...successfulProcess,stdout:JSON.stringify(remaining.get(args.at(-1))),stderr:''};
    }
    assert.deepEqual(args.slice(0,3),['container','rm','--force']);
    if(removeFails)return {...successfulProcess,code:1,stdout:'',stderr:'mock removal refused'};
    if(!retainRemoved)remaining.delete(args[3]);
    return {...successfulProcess,stdout:args[3],stderr:''};
  }};
}

test('cleanup removes only validated exact-workspace writable BANTAM containers and saves receipts',async t=>{
  const {workspace,dir}=cleanupFixture(t),own=containerRecord('a',workspace);
  const mock=mockDocker([own,containerRecord('b',workspace+'-other'),containerRecord('c',workspace,false),containerRecord('d',path.join(workspace,'nested'))]);
  const receipt=await cleanupVariantWorkspace(workspace,dir,{run:mock.run});
  assert.deepEqual(mock.calls.filter(c=>c.args[1]==='rm').map(c=>c.args),[['container','rm','--force',own.id]]);
  assert.equal(receipt.confirmed,true);assert.equal(receipt.containers.length,1);
  assert.equal(receipt.containers[0].writableBindSource,workspace);assert.equal(receipt.containers[0].removed,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'operator-container-cleanup.json'))),receipt);
});

test('cleanup fails closed on malformed list IDs or mismatched inspect identity without removing anything',async t=>{
  const {workspace,dir}=cleanupFixture(t);
  for(const kind of ['bad-list','wrong-id','wrong-name']){
    const calls=[],id='a'.repeat(64),record=containerRecord('a',workspace);
    if(kind==='wrong-id')record.id='b'.repeat(64);
    if(kind==='wrong-name')record.name='/unrelated-user-container';
    await assert.rejects(cleanupVariantWorkspace(workspace,dir,{run:async(file,args)=>{
      calls.push(args);return {...successfulProcess,stderr:'',stdout:args[1]==='ls'?(kind==='bad-list'?'--all':id):JSON.stringify(record)};
    }}),/invalid/);
    assert.ok(!calls.some(args=>args[1]==='rm'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'operator-container-cleanup.json'))).confirmed,false);
  }
});

test('cleanup refuses grading if removal fails or a writable owner remains',async t=>{
  const {workspace,dir}=cleanupFixture(t);
  for(const options of [{removeFails:true},{retainRemoved:true}]){
    const mock=mockDocker([containerRecord('a',workspace)],options);
    await assert.rejects(cleanupVariantWorkspace(workspace,dir,{run:mock.run}),/cannot remove|still owns/);
    const receipt=JSON.parse(fs.readFileSync(path.join(dir,'operator-container-cleanup.json')));
    assert.equal(receipt.confirmed,false);assert.equal(typeof receipt.error,'string');
  }
});

test('cleanup rejects broad or symlinked workspace targets before Docker calls',async t=>{
  const {workspace,dir}=cleanupFixture(t),run=async()=>{throw Error('must not call Docker');};
  await assert.rejects(cleanupVariantWorkspace(dir,dir,{run}),/exact run workspace/);
  const sibling=path.join(dir,'linked');fs.mkdirSync(sibling);fs.symlinkSync(workspace,path.join(sibling,'ws'));
  await assert.rejects(cleanupVariantWorkspace(path.join(sibling,'ws'),sibling,{run}),/real directory/);
});

test('post-run identity guard records matching idle server and rejects any model/build/default change',async t=>{
  const {dir}=cleanupFixture(t),expected={id:'Tiel-exact',props:{model_path:'/models/Tiel.gguf',build_info:'b2814',default_generation_settings:{n_ctx:32768,temperature:1}}};
  const calls=[];
  assert.deepEqual(await verifyVariantServer('http://127.0.0.1:1',expected,dir,{inspect:async(endpoint,options)=>{
    calls.push({endpoint,options});return structuredClone(expected);
  }}),expected);
  assert.deepEqual(calls,[{endpoint:'http://127.0.0.1:1',options:{requireIdle:true}}]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'server-post-run.json'))).matched,true);
  for(const alter of [m=>m.id='wrong-model',m=>m.props.model_path='/models/other.gguf',m=>m.props.build_info='different-build',m=>m.props.default_generation_settings.n_ctx=16384]){
    const observed=structuredClone(expected);alter(observed);
    await assert.rejects(verifyVariantServer('unused',expected,dir,{inspect:async()=>observed}),/changed during contender/);
    const receipt=JSON.parse(fs.readFileSync(path.join(dir,'server-post-run.json')));
    assert.equal(receipt.matched,false);assert.deepEqual(receipt.observed,observed);assert.ok(receipt.error);
  }
  await assert.rejects(verifyVariantServer('unused',expected,dir,{inspect:async()=>{throw Error('server busy or unavailable');}}),/busy or unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'server-post-run.json'))).matched,false);
});
