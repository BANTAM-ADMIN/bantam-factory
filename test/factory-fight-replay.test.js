import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReplayLane, localTimeSignal, normalizeReplayUsage, replayLineDiff, writeFactoryReplay } from '../scripts/factory-fight-replay.mjs';

const startedAt='2026-09-06T12:00:00.000Z';
const write=(root,file,data)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,typeof data==='string'?data:JSON.stringify(data));return target;};
const lines=rows=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-replay-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function baseResult(arm='bantam-local-27b'){
  return {card:'receipt-reducer',arm,repeat:1,outcome:'PASS',pass:true,candidatePass:true,processCompleted:true,
    startedAt,wallMs:10000,usage:{source:'local-wire-receipts',inputTokens:100,outputTokens:20,cacheHitTokens:70,freshInputTokens:30},
    grade:{pass:true,groups:[{name:'group-one',pass:true}]},materialSeal:{},finalFiles:{},tampered:[]};
}
function wire(root){
  write(root,'wire/exchanges.jsonl',lines([
    {index:1,generation:true,route:'/completion',phase:'request',startedAt:'2026-09-06T12:00:01.000Z',requestBytes:12},
    {index:1,generation:true,route:'/completion',phase:'response',startedAt:'2026-09-06T12:00:01.000Z',wallMs:2000,finished:true,status:200,usage:{inputTokens:40,outputTokens:5,cacheHitTokens:25}},
    {index:2,generation:true,route:'/completion',phase:'request',startedAt:'2026-09-06T12:00:04.000Z',requestBytes:14},
    {index:2,generation:true,route:'/completion',phase:'response',startedAt:'2026-09-06T12:00:04.000Z',wallMs:500,finished:true,status:200,usage:{inputTokens:60,outputTokens:15,cacheHitTokens:45}},
  ]));
  write(root,'wire/00001.request.body','{"prompt":"first exact context"}');
  write(root,'wire/00001.response.body','{"content":"first result"}');
  write(root,'wire/00002.request.body','{"prompt":"second exact context"}');
  write(root,'wire/00002.response.body','{"content":"second result"}');
}
function savedModelCall(index,start,end,usage){
  const response={status:200,rawBody:'{"a":"done"}',bodySha256:'recorded-response-hash',
    normalized:{content:'{"a":"done"}',usage:{provider:'codex',model:'gpt-6-astra',requests:1,codexRequests:1,...usage}}};
  return {schema:1,index,label:null,startedAt:start,completedAt:end,status:'ok',
    request:{url:'codex-app-server://local/gpt-6-astra',method:'POST',body:'{"prompt":"exact saved harness context"}'},
    transport:{timeoutMs:120000,retries:2},attempts:[{attempt:1,startedAt:start,completedAt:end,status:'ok',response:structuredClone(response),error:null}],
    response,error:null};
}

test('replay usage preserves unknown and derives fresh only from known valid totals',()=>{
  assert.deepEqual(normalizeReplayUsage(null),{inputTokens:null,outputTokens:null,cacheHitTokens:null,freshInputTokens:null});
  assert.deepEqual(normalizeReplayUsage({inputTokens:100,outputTokens:0}),{inputTokens:100,outputTokens:0,cacheHitTokens:null,freshInputTokens:null});
  assert.equal(normalizeReplayUsage({inputTokens:100,cacheHitTokens:75}).freshInputTokens,25);
  assert.equal(normalizeReplayUsage({inputTokens:10,cacheHitTokens:75}).freshInputTokens,null);
  assert.equal(normalizeReplayUsage({inputTokens:'100'}).inputTokens,null);
});

test('explicit local variant identity preserves its own label, arm and recorded events',t=>{
  const root=fixture(t),arm='bantam-local-tiel35ba3b-iq4-xs-confirmation1';wire(root);
  const {lane}=buildReplayLane({directory:root,result:baseResult(arm),arm,card:'receipt-reducer',repeat:1,
    identity:{label:'BANTAM · Tiel 35B-A3B',family:'local'},outer:lines([{arm,t:200,title:'own event',text:'variant only'}])});
  assert.equal(lane.arm,arm);assert.equal(lane.label,'BANTAM · Tiel 35B-A3B');assert.equal(lane.family,'local');
  assert.ok(lane.events.some(event=>event.detail==='variant only'));
  assert.equal(lane.tokenUpdates.at(-1).inputTokens,100);
});

test('variant adapter rejects traversal and implicit or incorrectly typed model identities',t=>{
  const root=fixture(t),args={directory:root,card:'receipt-reducer',repeat:1};
  for(const [arm,identity]of [['bantam-local-tiel',null],['../bantam-local-tiel',{label:'Tiel',family:'local'}],
    ['bantam-local-tiel',{label:'Tiel',family:'astra'}],['unrecorded-peer',{label:'Peer',family:'local'}]]){
    assert.throws(()=>buildReplayLane({...args,arm,identity}),/invalid replay lane identity/);
  }
  const {lane}=buildReplayLane({...args,arm:'bantam-local-27b',identity:{label:'Wrong replacement label',family:'local'}});
  assert.equal(lane.label,'BANTAM · 27B');
});

test('wire replay uses actual request and response clocks and cumulative receipt usage',t=>{
  const root=fixture(t);wire(root);
  const {lane,payload}=buildReplayLane({directory:root,result:baseResult(),arm:'bantam-local-27b',card:'receipt-reducer',repeat:1});
  assert.deepEqual(lane.events.map(event=>event.t),[1000,3000,4000,4500]);
  assert.deepEqual(lane.tokenUpdates.map(update=>[update.t,update.inputTokens,update.outputTokens,update.cacheHitTokens,update.freshInputTokens]),
    [[3000,40,5,25,15],[4500,100,20,70,30]]);
  assert.equal(lane.duration,10000);
  assert.ok(payload.artifacts.some(a=>a.path==='wire/00001.request.body'&&a.content==='{"prompt":"first exact context"}'));
  assert.equal(lane.events[0].line,undefined,'exchange line index is not a line in the request body');
});

test('Pi exports as its own local replay lane with recorded wire clocks',t=>{
  const root=fixture(t);wire(root);
  const {lane}=buildReplayLane({directory:root,result:baseResult('pi'),arm:'pi',card:'receipt-reducer',repeat:1});
  assert.equal(lane.arm,'pi');assert.equal(lane.label,'Pi');assert.equal(lane.family,'local');
  assert.deepEqual(lane.events.map(event=>event.t),[1000,3000,4000,4500]);
  assert.equal(lane.tokenUpdates.at(-1).outputTokens,20);
});

test('missing start clock never manufactures event timestamps or measured counters',t=>{
  const root=fixture(t);wire(root);const result=baseResult();delete result.startedAt;delete result.wallMs;delete result.usage;
  write(root,'run.json',{turns:[{i:0,tookMs:100,prompt:'exact saved prompt',parsedAction:{a:'read_file',p:'x'}}]});
  const {lane}=buildReplayLane({directory:root,result,arm:'bantam-local-27b',card:'receipt-reducer',repeat:1});
  assert.ok(lane.events.every(event=>event.t===null));
  assert.equal(lane.duration,null);assert.deepEqual(lane.tokenUpdates,[]);assert.equal(lane.usage.inputTokens,null);
  assert.equal(lane.untimedEvents,5);
});

test('controller elapsed-time console events and untimed turns retain separate authority',t=>{
  const root=fixture(t);
  write(root,'run.json',{turns:[{i:0,tookMs:1,parsedAction:{a:'shell',c:'npm test'},observation:'pass'}]});
  const outer=lines([{arm:'bantam-local-27b',t:350,kind:'line',text:'actual console line'},
    {arm:'hermes',t:900,kind:'line',text:'other lane'}]);
  const {lane,payload}=buildReplayLane({directory:root,result:baseResult(),arm:'bantam-local-27b',card:'receipt-reducer',repeat:1,outer});
  assert.deepEqual(lane.events.map(e=>e.t),[350,null]);assert.equal(lane.events[1].turn,0);
  assert.ok(payload.artifacts.some(a=>a.path==='../events.ndjson'&&a.content===outer));
});

test('Codex cumulative totals are not counted once per repeated snapshot',t=>{
  const root=fixture(t),token=(timestamp,input,output,cached)=>({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output,cached_input_tokens:cached}}}});
  write(root,'native-sessions/a.jsonl',lines([
    {timestamp:startedAt,type:'session_meta',payload:{id:'session-a'}},
    {timestamp:'2026-09-06T12:00:01.000Z',type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'{"cmd":"npm test"}'}},
    token('2026-09-06T12:00:02.000Z',100,10,80),token('2026-09-06T12:00:03.000Z',100,10,80),
    token('2026-09-06T12:00:04.000Z',250,30,180),
  ]));
  write(root,'native-sessions/b.jsonl',lines([{timestamp:startedAt,type:'session_meta',payload:{id:'session-b'}},token('2026-09-06T12:00:05.000Z',20,2,0)]));
  const {lane}=buildReplayLane({directory:root,result:baseResult('codex-astra'),arm:'codex-astra',card:'receipt-reducer',repeat:1});
  assert.deepEqual(lane.tokenUpdates.map(u=>u.inputTokens),[100,100,250,270]);
  assert.deepEqual(lane.tokenUpdates.map(u=>u.freshInputTokens),[20,20,70,90]);
  assert.equal(lane.events[0].kind,'tool');assert.equal(lane.events[0].t,1000);
});

test('distinct native response receipts are preferred to cumulative session snapshots',t=>{
  const root=fixture(t),result=baseResult('codex-astra');
  result.usage={source:'codex-native-response-records',calls:[
    {responseId:'one',timestamp:'2026-09-06T12:00:01.000Z',usage:{inputTokens:30,outputTokens:5,cacheHitTokens:20}},
    {responseId:'one',timestamp:'2026-09-06T12:00:01.000Z',usage:{inputTokens:30,outputTokens:5,cacheHitTokens:20}},
    {responseId:'two',timestamp:'2026-09-06T12:00:04.000Z',usage:{inputTokens:50,outputTokens:7,cacheHitTokens:40}},
  ]};
  write(root,'native-sessions/a.jsonl',lines([{timestamp:'2026-09-06T12:00:03.000Z',type:'event_msg',
    payload:{type:'token_count',info:{total_token_usage:{input_tokens:999,output_tokens:99,cached_input_tokens:1}}}}]));
  const {lane}=buildReplayLane({directory:root,result,arm:'codex-astra',card:'receipt-reducer',repeat:1});
  assert.deepEqual(lane.tokenUpdates.map(u=>[u.t,u.inputTokens,u.outputTokens,u.cacheHitTokens]),[[1000,30,5,20],[4000,80,12,60]]);
  assert.equal(lane.tokenUpdates[0].source,'recorded distinct native responses');
});

test('wrapped BANTAM model-call recorder provides actual clocks and counts settled usage once',t=>{
  const root=fixture(t);
  const calls=[
    savedModelCall(0,'2026-09-06T12:00:01.000Z','2026-09-06T12:00:03.000Z',{inputTokens:100,outputTokens:10,cacheHitTokens:20}),
    savedModelCall(1,'2026-09-06T12:00:04.000Z','2026-09-06T12:00:06.000Z',{inputTokens:150,outputTokens:30,cacheHitTokens:100}),
  ];
  write(root,'run.json',{modelCalls:calls,turns:[]});
  const {lane,payload}=buildReplayLane({directory:root,result:baseResult('bantam-codex-astra'),arm:'bantam-codex-astra',card:'receipt-reducer',repeat:1});
  assert.deepEqual(lane.events.map(e=>e.t),[1000,3000,4000,6000]);
  assert.deepEqual(lane.events.map(e=>e.kind),['context','response','context','response']);
  assert.deepEqual(lane.tokenUpdates.map(u=>[u.t,u.inputTokens,u.outputTokens,u.cacheHitTokens,u.freshInputTokens]),
    [[3000,100,10,20,80],[6000,250,40,120,130]]);
  assert.ok(lane.tokenUpdates.every(u=>u.partial===false));
  assert.equal(lane.events[0].modelCallPosition,0);assert.equal(lane.events[0].modelCallField,'request');
  assert.equal(lane.events[1].modelCallField,'response');
  assert.deepEqual(JSON.parse(payload.artifacts.find(a=>a.path==='run.json').content).modelCalls,calls);
});

test('wrapped model-call clocks stay unavailable instead of using invented durations',t=>{
  const root=fixture(t),call=savedModelCall(0,null,null,{inputTokens:100,outputTokens:10,cacheHitTokens:20});
  call.tookMs=20;write(root,'run.json',{modelCalls:[call]});
  const args={directory:root,result:baseResult('bantam-codex-astra'),arm:'bantam-codex-astra',card:'receipt-reducer',repeat:1};
  const {lane}=buildReplayLane(args);
  assert.deepEqual(lane.events.map(e=>e.t),[null,null]);assert.deepEqual(lane.tokenUpdates,[]);
  const dated=savedModelCall(1,'2026-09-06T12:00:04.000Z','2026-09-06T12:00:06.000Z',{inputTokens:20,outputTokens:2,cacheHitTokens:5});
  write(root,'run.json',{modelCalls:[call,dated]});
  const partial=buildReplayLane(args).lane.tokenUpdates;
  assert.equal(partial.length,1);assert.equal(partial[0].inputTokens,20);assert.equal(partial[0].partial,true);
});

test('wrapped retries, ambiguous usage, and duplicate call identities are not double-counted',t=>{
  const root=fixture(t),good=savedModelCall(1,'2026-09-06T12:00:04.000Z','2026-09-06T12:00:06.000Z',{inputTokens:20,outputTokens:2,cacheHitTokens:5});
  const original=savedModelCall(0,'2026-09-06T12:00:01.000Z','2026-09-06T12:00:03.000Z',{inputTokens:100,outputTokens:10,cacheHitTokens:20});
  const retries=structuredClone(original);retries.attempts.unshift({attempt:0,status:'error',response:null});
  const aggregate=structuredClone(original);aggregate.response.normalized.usage.requests=2;
  const missing=structuredClone(original);delete missing.attempts;
  const conflicting=structuredClone(original);conflicting.attempts[0].response.normalized.usage.inputTokens=101;
  for(const bad of [retries,aggregate,missing,conflicting]){
    write(root,'run.json',{modelCalls:[bad,good]});
    const {lane}=buildReplayLane({directory:root,result:baseResult('bantam-codex-astra'),arm:'bantam-codex-astra',card:'receipt-reducer',repeat:1});
    assert.equal(lane.tokenUpdates.length,1);assert.equal(lane.tokenUpdates[0].inputTokens,20);assert.equal(lane.tokenUpdates[0].partial,true);
  }
  write(root,'run.json',{modelCalls:[original,original]});
  assert.deepEqual(buildReplayLane({directory:root,result:baseResult('bantam-codex-astra'),arm:'bantam-codex-astra',card:'receipt-reducer',repeat:1}).lane.tokenUpdates,[]);
});

test('external wire takes precedence over duplicate saved BANTAM model-call usage',t=>{
  const root=fixture(t);wire(root);
  write(root,'run.json',{modelCalls:[savedModelCall(0,'2026-09-06T12:00:01.000Z','2026-09-06T12:00:03.000Z',
    {inputTokens:999,outputTokens:99,cacheHitTokens:1})]});
  const {lane}=buildReplayLane({directory:root,result:baseResult(),arm:'bantam-local-27b',card:'receipt-reducer',repeat:1});
  assert.equal(lane.tokenUpdates.at(-1).inputTokens,100);assert.equal(lane.events.length,4);
  assert.ok(lane.events.every(event=>event.modelCallPosition===undefined));
});

test('incomplete wire receipts do not turn unknown cache data into zero',t=>{
  const root=fixture(t);
  write(root,'wire/exchanges.jsonl',lines([
    {index:1,generation:true,phase:'response',startedAt,wallMs:100,status:500,finished:true,usage:null},
    {index:2,generation:true,phase:'response',startedAt,wallMs:200,status:200,finished:true,usage:{inputTokens:10,outputTokens:2}},
  ]));
  const {lane}=buildReplayLane({directory:root,result:baseResult(),arm:'bantam-local-27b',card:'receipt-reducer',repeat:1});
  assert.equal(lane.tokenUpdates[0].partial,true);assert.equal(lane.tokenUpdates[0].cacheHitTokens,null);assert.equal(lane.tokenUpdates[0].freshInputTokens,null);
});

test('native output-budget stops remain distinct from controller deadlines',t=>{
  const root=fixture(t),result={...baseResult('deepseek-local-27b'),outcome:'FAIL',pass:false,candidatePass:false,timedOut:false,
    nativeMetadata:{native:{sessions:[{turnEndReasons:['max-tokens']}]}}};
  const {lane}=buildReplayLane({directory:root,result,arm:'deepseek-local-27b',card:'receipt-reducer',repeat:1});
  assert.deepEqual(lane.stopReasons,['max-tokens']);assert.ok(!lane.stopReasons.includes('controller deadline'));
});

test('wire finish length is backed by exact response fields and remains a budget boundary',t=>{
  const root=fixture(t),result=baseResult('opencode');
  write(root,'wire/exchanges.jsonl',lines([{index:1,generation:true,phase:'response',startedAt,wallMs:50,status:200,finished:true,
    settings:{max_tokens:8192},usage:{inputTokens:20,outputTokens:8192,cacheHitTokens:0}}]));
  write(root,'wire/00001.response.body','data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n');
  const {lane}=buildReplayLane({directory:root,result,arm:'opencode',card:'receipt-reducer',repeat:1});
  assert.equal(lane.budgetLimited,true);assert.deepEqual(lane.stopReasons,['latest wire response: length']);
  assert.equal(lane.responseStops[0].outputLimit,8192);assert.equal(lane.responseStops[0].artifact,'wire/00001.response.body');
});

test('portable grader source is embedded only when it matches the frozen kit seal',t=>{
  const root=fixture(t),repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const source=fs.readFileSync(path.join(repo,'examples/fights/factory-2026-09-06/receipt-reducer/grader.mjs'));
  const expected=crypto.createHash('sha256').update(source).digest('hex');
  const args={directory:root,result:baseResult(),arm:'bantam-local-27b',card:'receipt-reducer',repeat:1};
  const good=buildReplayLane({...args,kitSeal:{'receipt-reducer/grader.mjs':expected}});
  assert.equal(good.payload.artifacts.find(a=>a.path==='judge/grader.mjs').content,source.toString('utf8'));
  const bad=buildReplayLane({...args,kitSeal:{'receipt-reducer/grader.mjs':'0'.repeat(64)}});
  assert.ok(!bad.payload.artifacts.some(a=>a.path==='judge/grader.mjs'));
  assert.ok(bad.lane.warnings.some(w=>w.includes('do not match frozen kit seal')));
});

test('artifact collection never follows symlinks or quietly truncates evidence',t=>{
  const root=fixture(t),outside=fixture(t);write(outside,'private.txt','outside secret');
  fs.symlinkSync(path.join(outside,'private.txt'),path.join(root,'stdout.log'));
  write(root,'native/auth.json','credential-shaped material');
  write(root,'stderr.log','recorded error longer than cap');
  const {lane,payload}=buildReplayLane({directory:root,result:null,arm:'hermes',card:'receipt-reducer',repeat:1,limits:{maxFileBytes:4}});
  assert.ok(!JSON.stringify(payload).includes('outside secret'));assert.ok(!JSON.stringify(payload).includes('credential-shaped material'));
  assert.equal(payload.artifacts.find(a=>a.path==='stderr.log').embedded,false);
  assert.ok(lane.warnings.some(w=>w.includes('stdout.log')));assert.ok(lane.warnings.some(w=>w.includes('credential-shaped')));
});

test('line comparison preserves exact changed bytes and does not claim semantic equivalence',()=>{
  assert.deepEqual(replayLineDiff('a\nold\nz\n','a\nnew\nz\n'),[
    {kind:'same',text:'a'},{kind:'removed',text:'old'},{kind:'added',text:'new'},{kind:'same',text:'z\n'},
  ]);
  assert.deepEqual(replayLineDiff('same','same'),[{kind:'same',text:'same'}]);
});

function series(root,{hostile=false}={}){
  const result=baseResult(),relative='repeat-1/receipt-reducer/bantam-local-27b';
  const attack='</script><script>document.documentElement.id="pwned"</script><img src=x onerror="alert(1)">';
  write(root,`${relative}/result.json`,result);wire(path.join(root,relative));
  write(root,`${relative}/task.md`,hostile?attack:'Build the receipt tool.');
  write(root,`${relative}/ws/receipt-report.js`,hostile?`// ${attack}\nexport const answer = 1;`:'export const answer = 1;');
  write(root,`${relative}/hidden.stdout.log`,JSON.stringify(result.grade));
  write(root,'fight-card.json',{schema:'test-fixture-portable-card',private:true});
  write(root,'manifest.json',{schema:'bantam.factory-fights.v1',startedAt,complete:true,
    modelId:'test-27b',design:hostile?attack:'One exploratory sample; no broad ranking.',
    plan:[{card:'receipt-reducer',arm:'bantam-local-27b',repeat:1}],results:[result],sourceSeal:{},kitSeal:{},configuration:{}});
  return {relative,attack};
}

test('self-contained replay keeps full exact evidence compressed and escapes hostile candidate text',t=>{
  const root=fixture(t),{attack}=series(root,{hostile:true});const result=writeFactoryReplay(root);
  assert.equal(result.cards,1);assert.equal(result.lanes,6);
  const html=fs.readFileSync(result.output,'utf8');
  assert.ok(html.includes('The complete score sheet'));assert.ok(html.includes('The fight.'));assert.ok(html.includes('./fight-card.json'));
  assert.ok(!html.includes(attack));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('\\u003c/script\\u003e'));
  const match=html.match(/id="payload-r1-receipt-reducer-bantam-local-27b" type="application\/octet-stream">([^<]+)<\/script>/);
  assert.ok(match);const payload=JSON.parse(gunzipSync(Buffer.from(match[1],'base64')));
  assert.equal(payload.artifacts.find(a=>a.path==='task.md').content,attack);
  const summary=JSON.parse(html.match(/id="summary-data" type="application\/json">([^<]+)<\/script>/)[1]);
  assert.equal(summary.cards[0].lanes[1].outcome,'NOT RUN');assert.equal(summary.cards[0].lanes[1].usage.inputTokens,null);
  assert.equal(summary.cards[0].advantages.length,0,'missing peers are not counted as wins');
  const exported=fs.readFileSync(path.join(root,'fight-card.json'));
  assert.deepEqual(Buffer.from(summary.presentation.exchange.content,'base64'),exported,'portable download must preserve exporter bytes exactly');
  assert.equal(summary.presentation.exchange.sha256,crypto.createHash('sha256').update(exported).digest('hex'));
  assert.ok(!/<script[^>]+src=|<link[^>]+href=https?:/.test(html),'no external executable/style assets');
});

test('invalid manifest paths and unsupported schemas are rejected',t=>{
  const root=fixture(t);assert.throws(()=>writeFactoryReplay(root));assert.throws(()=>writeFactoryReplay('relative'));
  write(root,'manifest.json',{schema:'bantam.factory-fights.v1',plan:[{card:'../../outside',repeat:1}],results:[]});
  assert.throws(()=>writeFactoryReplay(root),/identity/);
});

test('missing or symlinked exchange JSON is not silently embedded from another location',t=>{
  const root=fixture(t);series(root);fs.unlinkSync(path.join(root,'fight-card.json'));
  for(const symlink of [false,true]){
    if(symlink)fs.symlinkSync(path.join(root,'manifest.json'),path.join(root,'fight-card.json'));
    const html=fs.readFileSync(writeFactoryReplay(root).output,'utf8');
    const summary=JSON.parse(html.match(/id="summary-data" type="application\/json">([^<]+)<\/script>/)[1]);
    assert.equal(summary.presentation.exchange,null);
  }
});

test('prominent local time comparison uses fastest accepted peer and excludes missing or failed runs',()=>{
  const lane=(arm,duration,pass=true,family='local')=>({arm,label:arm,duration,family,result:{pass}});
  const lanes=[lane('bantam-local-27b',100),lane('opencode',400),lane('deepseek-local-27b',200),
    lane('hermes',50,false),lane('codex-astra',30,true,'astra')];
  assert.deepEqual(localTimeSignal(lanes),{bantam:'bantam-local-27b',peer:'deepseek-local-27b',bantamMs:100,peerMs:200,lessWallPercent:50});
  assert.equal(localTimeSignal([lane('bantam-local-27b',300),lane('opencode',200)]),null);
  assert.equal(localTimeSignal([lane('bantam-local-27b',null),lane('opencode',200)]),null);
  assert.equal(localTimeSignal([lane('bantam-local-27b',100),lane('opencode',null)]),null);
  assert.equal(localTimeSignal([lane('bantam-local-27b',100,false),lane('opencode',200)]),null);
});

test('presentation preserves grader/public-suite disagreement and measured wrapper disadvantages',t=>{
  const root=fixture(t);series(root);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  manifest.results.push({...baseResult('hermes'),outcome:'TIMEOUT',pass:false,candidatePass:false,processCompleted:false,publicExit:1,timedOut:true});
  manifest.results.push({...baseResult('codex-astra'),wallMs:1000});
  manifest.results.push({...baseResult('bantam-codex-astra'),wallMs:2000,usage:{freshInputTokens:60}});
  write(root,'manifest.json',manifest);
  const html=fs.readFileSync(writeFactoryReplay(root).output,'utf8');
  const summary=JSON.parse(html.match(/id="summary-data" type="application\/json">([^<]+)<\/script>/)[1]);
  const hermes=summary.cards[0].lanes.find(l=>l.arm==='hermes');
  assert.equal(hermes.outcome,'TIMEOUT');assert.equal(hermes.result.grade.pass,true);assert.equal(hermes.result.publicExit,1);
  assert.ok(summary.cards[0].advantages.some(s=>s.includes('BANTAM · Astra vs Codex · Astra')&&s.includes('100.0% more wall time')&&s.includes('100.0% more fresh input')));
  assert.ok(html.includes('Independent groups ≠ full acceptance'));
});

test('interrupted series embeds its exact stop note and does not promote partial comparative wins',t=>{
  const root=fixture(t);series(root);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  manifest.results.push({...baseResult('deepseek-local-27b'),outcome:'FAIL',pass:false,candidatePass:false});
  write(root,'manifest.json',manifest);
  const note='# Interrupted\nNative output budget made this partial card unsuitable as a completed comparison.\n';
  write(root,'INTERRUPTED.md',note);
  const before=fs.readFileSync(path.join(root,'manifest.json'),'utf8');
  const result=writeFactoryReplay(root),html=fs.readFileSync(result.output,'utf8');
  const summary=JSON.parse(html.match(/id="summary-data" type="application\/json">([^<]+)<\/script>/)[1]);
  assert.equal(summary.presentation.interruption.content,note);
  assert.deepEqual(summary.cards[0].advantages,[]);
  assert.ok(html.includes('INTERRUPTED SERIES / NOT A COMPLETED COMPARISON'));
  assert.equal(fs.readFileSync(path.join(root,'manifest.json'),'utf8'),before,'presentation must not amend original results');
});

test('offline Chromium renders interactive lanes and evidence inspector without script injection',{
  skip:process.env.BANTAM_REPLAY_BROWSER_TEST!=='1',timeout:45000,
},t=>{
  // Snap Chromium has a private /tmp namespace. A unique non-hidden home
  // directory is readable by both the test and that browser; never reuse HOME.
  const root=fs.mkdtempSync(path.join(os.homedir(),'factory-replay-browser-test-'));
  t.after(()=>{if(process.env.BANTAM_REPLAY_KEEP_BROWSER_FIXTURE==='1')process.stdout.write(`browser fixture: ${root}\n`);else fs.rmSync(root,{recursive:true,force:true});});
  series(root,{hostile:true});const result=writeFactoryReplay(root);
  // Exercise generated browser code, including lazy gzip decompression. This
  // helper is test-authored instrumentation, never candidate-provided code.
  const instrumentation=`<script>setTimeout(()=>{
    document.documentElement.dataset.layoutOverflow=String(document.documentElement.scrollWidth>innerWidth);
    document.documentElement.dataset.resultsDefault=String(document.body.classList.contains('results-view')&&document.querySelector('[data-metric="inputTokens"] strong').textContent==='100');
    document.getElementById('replay-view').click();
    document.documentElement.dataset.replayStartsUnknown=String(!document.body.classList.contains('results-view')&&document.querySelector('[data-metric="inputTokens"] strong').textContent==='unknown');
    document.getElementById('seek').value='3000';document.getElementById('seek').dispatchEvent(new Event('input'));
    document.documentElement.dataset.clockReceipt=String(document.querySelector('[data-metric="inputTokens"] strong').textContent==='40');
    document.documentElement.dataset.exportCorrect=String(document.querySelector('.export-card').getAttribute('href')==='./fight-card.json'&&document.querySelector('.export-card').hasAttribute('download'));
    document.getElementById('finish').click();
    document.documentElement.dataset.finalCounters=String(document.querySelector('[data-metric="inputTokens"] strong').textContent==='100');
    document.querySelector('.lane-bottom button').click();
    setTimeout(()=>{document.documentElement.dataset.evidenceLoaded=String(document.getElementById('inspect-body').textContent.includes('first exact context'));},750);
  },50);</script>`;
  fs.writeFileSync(result.output,fs.readFileSync(result.output,'utf8').replace('</body>',instrumentation+'</body>'));
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'factory-replay-browser-'));t.after(()=>fs.rmSync(profile,{recursive:true,force:true}));
  const browser=process.env.BANTAM_REPLAY_BROWSER_PATH??'/snap/bin/chromium';
  const output=spawnSync(browser,['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${profile}`,
    '--window-size=390,900','--dump-dom','--virtual-time-budget=2000',pathToFileURL(result.output).href],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
  assert.equal(output.error,undefined,String(output.error));assert.equal(output.status,0,output.stderr);
  assert.ok(output.stdout.includes('data-lane="r1-receipt-reducer-bantam-local-27b"'),output.stdout.slice(0,2000)+'\n'+output.stderr);
  assert.ok(!output.stdout.includes('<html lang="en" id="pwned"'));
  assert.ok(output.stdout.includes('id="interactive"><nav'));
  assert.ok(output.stdout.includes('data-layout-overflow="false"'),'mobile document must not overflow horizontally');
  assert.ok(output.stdout.includes('data-results-default="true"'),'completed series starts on compact final results');
  assert.ok(output.stdout.includes('data-replay-starts-unknown="true"'),'replay mode starts at real t0 without invented counters');
  assert.ok(output.stdout.includes('data-clock-receipt="true"'),'seeking shows only usage observed by that clock');
  assert.ok(output.stdout.includes('data-export-correct="true"'),'export points to portable JSON with download semantics');
  assert.ok(output.stdout.includes('data-final-counters="true"'),'Final receipts displays recorded totals');
  assert.ok(output.stdout.includes('data-evidence-loaded="true"'),'lazy offline evidence decompression and inspection works');
});
