import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'acorn';
import {factoryKit} from '../scripts/factory-card-catalog.mjs';
import {fightPlan,FIGHT_ARMS,DEFAULT_FIGHT_ARMS,NATIVE_CODEX_MODELS,WRAPPED_CODEX_MODELS,FIGHT_CARDS,freshCommand,parseGrade,cleanFightEnv,gradeFactoryFight,runFactoryFights,optionalServerCounters,inspectLocalModel} from '../scripts/factory-fights.mjs';
import {counterDelta} from '../scripts/fight-usage.mjs';
test('fresh plan covers all18corner/card cells once, with rotated order',()=>{
  const plan=fightPlan();assert.equal(plan.length,18);assert.equal(new Set(plan.map(r=>r.card+':'+r.arm)).size,18);
  assert.notEqual(plan[0].arm,plan[6].arm);assert.notEqual(plan[6].arm,plan[12].arm);
  assert.throws(()=>fightPlan({arms:['opencode','opencode']}));assert.throws(()=>fightPlan({cards:['old-card']}));
});
test('all arms get exact task or task file and same explicit local endpoint/Astra model',()=>{
  for(const arm of FIGHT_ARMS){
    const command=freshCommand({arm,task:'EXACT_TASK',workspace:'/tmp/fresh/ws',dir:'/tmp/fresh',endpoint:'http://127.0.0.1:9999',model:'exact27b'});
    assert.ok(command.args.includes('EXACT_TASK')||command.args.includes('/tmp/fresh/task.md'));
    if(arm.includes('codex'))assert.ok(command.args.includes(NATIVE_CODEX_MODELS[arm]??WRAPPED_CODEX_MODELS[arm]));
    else if(arm.startsWith('claude-'))assert.ok(command.args.includes(arm.slice('claude-'.length)));
    else assert.ok(command.args.includes('http://127.0.0.1:9999'));
    if(arm.startsWith('bantam')){assert.equal(command.env.BANTAM_TEACHER,'0');assert.equal(command.env.BANTAM_PROBE,'1');assert.ok(command.args.includes('--factory'));}
    if(NATIVE_CODEX_MODELS[arm])assert.ok(!command.args.includes('--ephemeral'));
  }
});
test('grade requires complete expected groups, booleans and matching conjunction',()=>{
  const row={schema:'bantam.factory-card-grade.v1',card:'a',pass:true,groups:[{name:'one',pass:true}]};
  assert.deepEqual(parseGrade(JSON.stringify(row),'a',['one']),row);
  assert.equal(parseGrade('', 'a',['one']),null);
  assert.equal(parseGrade(JSON.stringify(row),'a',['one','two']),null);
  assert.equal(parseGrade(JSON.stringify({...row,pass:false}),'a',['one']),null);
  assert.equal(parseGrade(JSON.stringify(row),'b',['one']),null);
});
test('native peer response allowance is explicit, bounded, and does not alter BANTAM prompts',()=>{
  const base={task:'EXACT',workspace:'/tmp/fresh/ws',dir:'/tmp/fresh',endpoint:'http://127.0.0.1:9999',model:'exact27b'};
  for(const arm of ['deepseek-local-27b','opencode','hermes','pi']){
    const a=freshCommand({...base,arm}),b=freshCommand({...base,arm,peerOutputTokens:32768});
    assert.equal(a.args[a.args.indexOf('--max-output-tokens')+1],'8192');
    assert.equal(b.args[b.args.indexOf('--max-output-tokens')+1],'32768');
    assert.throws(()=>freshCommand({...base,arm,peerOutputTokens:32769}));
  }
  assert.deepEqual(freshCommand({...base,arm:'bantam-local-27b'}),freshCommand({...base,arm:'bantam-local-27b',peerOutputTokens:32768}));
});
test('environment does not inherit endpoint, credentials or Node hooks',()=>{
  const env=cleanFightEnv({BANTAM_TEACHER:'0'});assert.equal(env.BANTAM_TEACHER,'0');
  for(const key of ['OPENAI_API_KEY','NODE_OPTIONS','BANTAM_TEACHER_CMD','OPENROUTER_API_KEY'])assert.ok(!(key in env));
});

test('legacy default retains exact eighteen card/arm identities and ordering',()=>{
  const arms=['bantam-local-27b','deepseek-local-27b','opencode','hermes','codex-astra','bantam-codex-astra'];
  const cards=['receipt-reducer','snapshot-drift','job-planner'];
  const expected=cards.flatMap((card,index)=>[...arms.slice(index*2),...arms.slice(0,index*2)].map(arm=>({card,arm,repeat:1})));
  assert.deepEqual(DEFAULT_FIGHT_ARMS,arms);assert.deepEqual(FIGHT_CARDS,cards);
  assert.deepEqual(FIGHT_ARMS,[...arms,'pi','codex-sol','codex-terra','claude-sonnet','claude-opus','claude-fable','bantam-codex-sol','bantam-codex-terra']);
  assert.deepEqual(fightPlan(),expected);
  assert.deepEqual(fightPlan({kitId:'factory-2026-09-06'}),expected);
});

test('workshop catalog defaults to its three cards and supports an exact four-corner Patch card',()=>{
  const plan=fightPlan({kitId:'factory-2026-09-07'});
  assert.equal(plan.length,18);
  assert.deepEqual([...new Set(plan.map(row=>row.card))],['context-packet','patch-transaction','stream-framer']);
  assert.equal(new Set(plan.map(row=>row.card+':'+row.arm)).size,18);
  for(const card of ['context-packet','patch-transaction','stream-framer']){
    assert.deepEqual(new Set(plan.filter(row=>row.card===card).map(row=>row.arm)),new Set(DEFAULT_FIGHT_ARMS));
  }
  const arms=['bantam-local-27b','hermes','opencode','codex-astra'],cards=['patch-transaction'];
  const before=JSON.stringify({arms,cards});
  assert.deepEqual(fightPlan({kitId:'factory-2026-09-07',cards,arms}),arms.map(arm=>({card:'patch-transaction',arm,repeat:1})));
  assert.equal(JSON.stringify({arms,cards}),before,'planning must not mutate caller choices');
});

test('invalid catalog/card identities fail before any endpoint request or output creation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-fight-plan-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const output=path.join(root,'not-created');let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error('unexpected endpoint request');});
  const invalid=[
    {kitId:'unknown'},{kitId:'../../private'},{kitId:'/tmp/kit'},{kitId:'__proto__'},{kitId:{}},
    {kitId:'factory-2026-09-07',cards:['snapshot-drift']},
    {cards:['patch-transaction']},{kitId:'factory-2026-09-07',cards:['../patch-transaction']},
    {kitId:'factory-2026-09-07',cards:['patch-transaction','patch-transaction']},
    {kitId:'factory-2026-09-07',cards:[]},{arms:['opencode','opencode']},{arms:['new-arm']},
  ];
  for(const options of invalid){
    assert.throws(()=>fightPlan(options));
    await assert.rejects(runFactoryFights({output,...options}));
  }
  assert.equal(requests,0);assert.equal(fs.existsSync(output),false);
});

test('readonly verification and closure are explicit BANTAM-only additions to unchanged legacy recipes',()=>{
  const base={task:'EXACT PUBLIC WORK ORDER',workspace:'/tmp/fight/ws',dir:'/tmp/fight',endpoint:'http://127.0.0.1:9999',model:'exact-model'};
  for(const arm of FIGHT_ARMS){
    const original=freshCommand({...base,arm}),selected=freshCommand({...base,arm,verificationWorkspaceReadOnly:true,terminalClosure:true});
    assert.ok(!original.args.includes('--verify-workspace-read-only'));
    assert.ok(!Object.hasOwn(original.env,'BANTAM_VERIFY_WORKSPACE_READ_ONLY'));
    assert.ok(!Object.hasOwn(original.env,'BANTAM_TERMINAL_CLOSURE'));
    if(arm.startsWith('bantam-')){
      assert.deepEqual(selected.args,[...original.args,'--verify-workspace-read-only']);
      assert.deepEqual(selected.env,{...original.env,BANTAM_VERIFY_WORKSPACE_READ_ONLY:'1',BANTAM_TERMINAL_CLOSURE:'1'});
      assert.equal(selected.args[selected.args.indexOf('--max-turns')+1],'60','closure never adds an implementation action');
      assert.equal(selected.args[selected.args.indexOf('--task')+1],base.task);
      const readonlyOnly=freshCommand({...base,arm,verificationWorkspaceReadOnly:true});
      assert.equal(readonlyOnly.env.BANTAM_TERMINAL_CLOSURE,undefined);
      const closureOnly=freshCommand({...base,arm,terminalClosure:true});
      assert.deepEqual(closureOnly.args,original.args);assert.equal(closureOnly.env.BANTAM_VERIFY_WORKSPACE_READ_ONLY,undefined);
    }else assert.deepEqual(selected,original,'BANTAM switches cannot alter native contender configuration');
    assert.throws(()=>freshCommand({...base,arm,verificationWorkspaceReadOnly:'true'}),/boolean/);
    assert.throws(()=>freshCommand({...base,arm,terminalClosure:1}),/boolean/);
  }
});

test('grader uses only selected kit support and grader files, offline and readonly, without executing a candidate',async()=>{
  for(const [kitId,card]of [['factory-2026-09-06','receipt-reducer'],['factory-2026-09-07','patch-transaction']]){
    const selected=factoryKit(kitId),cardRoot=path.join(selected.root,card),workspace="/tmp/fight space's workspace";
    const descriptor=JSON.parse(fs.readFileSync(path.join(cardRoot,'card.json'),'utf8'));
    const record={schema:'bantam.factory-card-grade.v1',card,groups:descriptor.groups.map(name=>({name,pass:true})),pass:true};
    const calls=[],run=async(cwd,command,options)=>{
      calls.push({cwd,command,options});
      return {code:0,stdout:command==='npm test'?'public verifier completed':JSON.stringify(record)+'\n',stderr:'',timedOut:false,aborted:false,bufferExceeded:false};
    };
    const result=await gradeFactoryFight(workspace,card,{kitId,run});
    assert.equal(calls.length,2);assert.deepEqual(result.record,record);
    assert.equal(calls[0].command,'npm test');assert.equal(calls[0].options.readOnlyHostFiles,undefined);
    for(const call of calls){assert.equal(call.cwd,workspace);assert.equal(call.options.shellSandbox,'docker');assert.equal(call.options.shellNetwork,false);assert.equal(call.options.workspaceReadOnly,true);assert.equal(call.options.timeoutMs,60000);}
    const files=calls[1].options.readOnlyHostFiles;
    assert.ok(files.includes(path.join(selected.root,'grader-support.mjs')));
    assert.ok(files.includes(path.join(cardRoot,'grader.mjs')));
    assert.ok(files.every(file=>file.startsWith(selected.root+path.sep)&&!file.includes('/reviewer/')&&!file.includes('/starter/')));
    assert.ok(files.every(file=>fs.statSync(file).isFile()));
    assert.ok(calls[1].command.includes(path.join(cardRoot,'grader.mjs')));
    assert.equal(result.timing.totalWallMs,result.timing.publicWallMs+result.timing.hiddenWallMs);
  }
  let calls=0;const run=async()=>{calls++;throw Error('unexpected grading execution');};
  for(const [workspace,card,kitId]of [['relative','patch-transaction','factory-2026-09-07'],
    ['/tmp/ws','receipt-reducer','factory-2026-09-07'],['/tmp/ws','patch-transaction','factory-2026-09-06'],
    ['/tmp/ws','patch-transaction','../../private']])await assert.rejects(gradeFactoryFight(workspace,card,{kitId,run}));
  assert.equal(calls,0);
});

test('runtime execution seal inventory includes the versioned kit catalog',()=>{
  const source=fs.readFileSync(new URL('../scripts/factory-fights.mjs',import.meta.url),'utf8');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const inventory=ast.body.flatMap(node=>node.type==='VariableDeclaration'?node.declarations:[]).find(node=>node.id.name==='EXECUTION_SCRIPTS');
  assert.equal(inventory.init.type,'ArrayExpression');
  assert.ok(inventory.init.elements.map(node=>node.value).includes('factory-card-catalog.mjs'));
  const seal=ast.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='sourceSeal');
  assert.match(source.slice(seal.start,seal.end),/EXECUTION_SCRIPTS\.map/);
});

test('optional server counters preserve explicit unavailable snapshots without inventing usage',async t=>{
  const endpoint='http://127.0.0.1:9999',calls=[];
  const current={counters:{prompt_tokens_total:12,prompt_tokens_cached_total:8,tokens_predicted_total:4}};
  const fetch=t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,options});throw Error('connection refused after inference server exited');
  });
  const before=Date.now(),missing=await optionalServerCounters(endpoint+'/'),after=Date.now();
  assert.equal(calls[0].url,endpoint+'/metrics');assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(missing.unavailable,true);assert.match(missing.error,/connection refused/);
  assert.ok(Date.parse(missing.at)>=before&&Date.parse(missing.at)<=after);
  assert.equal(Object.hasOwn(missing,'counters'),false);assert.equal(Object.hasOwn(missing,'raw'),false);
  assert.equal(counterDelta(current,missing),null);assert.equal(counterDelta(missing,current),null);
  assert.equal(counterDelta(missing,missing),null);
  fetch.mock.mockImplementation(async()=>({ok:false,status:503}));
  const unavailable=await optionalServerCounters(endpoint);
  assert.equal(unavailable.unavailable,true);assert.match(unavailable.error,/metrics unavailable/);
  assert.equal(counterDelta(current,unavailable),null);
  fetch.mock.mockImplementation(async()=>({ok:true,async text(){throw Error('response body interrupted');}}));
  assert.match((await optionalServerCounters(endpoint)).error,/response body interrupted/);
  fetch.mock.mockImplementation(async()=>{throw Error('endpoint still down');});
  await assert.rejects(inspectLocalModel(endpoint),/endpoint still down/,'next-boundary health/identity checks stay mandatory');
});

test('available supplemental counters retain measured deltas and remain separate from contender usage',async t=>{
  const bodies=[
    'llamacpp:prompt_tokens_total 10\nllamacpp:prompt_tokens_cached_total 20\nllamacpp:tokens_predicted_total 30\nllamacpp:prompt_seconds_total 1\nllamacpp:tokens_predicted_seconds_total 2\nllamacpp:requests_processing 0\nllamacpp:requests_deferred 0\n',
    'llamacpp:prompt_tokens_total 14\nllamacpp:prompt_tokens_cached_total 26\nllamacpp:tokens_predicted_total 38\nllamacpp:prompt_seconds_total 2\nllamacpp:tokens_predicted_seconds_total 4\nllamacpp:requests_processing 0\nllamacpp:requests_deferred 0\n',
  ];let i=0;
  t.mock.method(globalThis,'fetch',async()=>({ok:true,async text(){return bodies[i++];}}));
  const before=await optionalServerCounters('http://127.0.0.1:9999'),after=await optionalServerCounters('http://127.0.0.1:9999');
  assert.equal(before.raw,bodies[0]);assert.equal(after.raw,bodies[1]);assert.equal(before.unavailable,undefined);
  const delta=counterDelta(before,after);
  assert.equal(delta.source,'server-counter-window');assert.equal(delta.inputTokens,10);
  assert.equal(delta.freshInputTokens,4);assert.equal(delta.cacheHitTokens,6);assert.equal(delta.outputTokens,8);
  assert.equal(delta.promptSeconds,1);assert.equal(delta.generationSeconds,2);
  assert.equal(delta.idleBefore,true);assert.equal(delta.idleAfter,true);
});
