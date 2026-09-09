import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {renderFactoryShowcase,renderShowcaseResults,renderShowcaseHighlights,renderCodexEfficiency,renderCodexHighlight,showcaseAssets,SHOWCASE_STATIC_FILES} from '../scripts/factory-showcase-page.mjs';

const gallery=()=>({cards:[{id:'context-packet',recorded:true,rows:[
  {arm:'bantam-local-27b',model:'Qwen 27B · same local weights',wallMs:58123,passed:true,outcome:'PASS',groupsPassed:5,groupsTotal:5},
  {arm:'hermes',model:'Qwen 27B · same local weights',wallMs:512194,passed:true,outcome:'PASS',groupsPassed:5,groupsTotal:5},
]}]});

test('Codex comparison sums its fixed paired repeats and keeps a slower round in the result',()=>{
  const row=(factory,input,wall)=>({arm:factory?'bantam-codex-astra':'codex-astra',
    model:`GPT-6 Astra · ${factory?'wrapped':'native'} CLI`,passed:true,accountingComplete:true,
    wallMs:wall,tokens:{inputTokens:input,outputTokens:100,cacheHitTokens:1000}});
  const data={codex:{cards:[
    {id:'context-packet-astra-context-1',workOrder:'context-packet',recorded:true,rows:[row(true,2000,2000),row(false,4000,4000)]},
    {id:'context-packet-astra-context-2',workOrder:'context-packet',recorded:true,rows:[row(true,3000,6000),row(false,6000,5000)]},
  ]}},before=structuredClone(data),html=renderCodexEfficiency(data);
  assert.match(html,/50<span>%/);assert.match(html,/1\.1× faster/);
  assert.match(html,/>5,000</);assert.match(html,/>10,000</);
  assert.match(html,/8\.0 s/);assert.match(html,/9\.0 s/);
  assert.match(html,/2 paired runs/);assert.match(html,/Round 1/);assert.match(html,/Round 2/);
  assert.deepEqual(data,before);
  data.codex.cards[1].rows[0].passed=false;
  const failure=renderCodexEfficiency(data);
  assert.match(failure,/Completion differs/);assert.match(failure,/1<span>\/2<\/span>/);
  assert.doesNotMatch(failure,/faster|less input/);
  data.codex.cards[1].rows[0].accountingComplete=false;
  assert.equal(renderCodexEfficiency(data),'','partial usage cannot become a full comparison');
});

test('Codex comparison rejects missing pairs, different models and impossible cache totals',()=>{
  const row=arm=>({arm,model:'GPT-5.6 Terra · native CLI',passed:true,accountingComplete:true,
    wallMs:1000,tokens:{inputTokens:2000,outputTokens:100,cacheHitTokens:1000}});
  const card={id:'context-packet',recorded:true,rows:[row('bantam-codex-terra'),row('codex-terra')]};
  const data={codex:{cards:[card]}};
  assert.match(renderCodexEfficiency(data),/Terra/);
  card.rows[0].tokens.cacheHitTokens=2001;assert.equal(renderCodexEfficiency(data),'');
  card.rows[0].tokens.cacheHitTokens=1000;card.rows[0].model='GPT-6 Astra · wrapped CLI';
  assert.equal(renderCodexEfficiency(data),'');card.rows.pop();assert.equal(renderCodexEfficiency(data),'');
});

test('supervised test-strength highlight requires all four matching reviewed outcomes',()=>{
  const row=arm=>({arm,model:'GPT-5.6 Terra · native CLI',passed:true,accountingComplete:true,
    wallMs:1000,tokens:{inputTokens:2000,outputTokens:100,cacheHitTokens:1000}});
  const review={id:'stream-framer-qualified-1',workOrder:'stream-framer',recorded:true,
    testReviews:['codex-astra','bantam-codex-astra','bantam-astra-terra','bantam-astra-sol'].map(arm=>({arm,
      caseId:'base64-roundtrip',sourcePath:'stream-framer.js',caught:arm==='bantam-astra-sol'}))};
  const data={codex:{cards:[{id:'context-packet',recorded:true,rows:[row('bantam-codex-terra'),row('codex-terra')]},review]}};
  assert.match(renderCodexEfficiency(data),/caught a planted bug that the other three suites missed/);
  for(const mutate of [r=>r.testReviews.pop(),r=>r.testReviews[0].caught=true,r=>r.testReviews[0].caseId='different-bug']){
    const incomplete=structuredClone(data);mutate(incomplete.codex.cards[1]);
    assert.doesNotMatch(renderCodexEfficiency(incomplete),/caught a planted bug/);
  }
});

test('front-page results use recorded times and outcomes, and missing competitors remain absent attempts',()=>{
  const data=gallery(),before=structuredClone(data);
  const html=renderShowcaseResults(data);
  assert.match(html,/58\.1 s/);assert.match(html,/512\.2 s/);
  assert.equal((html.match(/Not run yet<\/td>/g)||[]).length,3);
  assert.match(html,/context-packet\/share\/index.html#card=context-packet/);
  assert.deepEqual(data,before);
  Object.assign(data.cards[0].rows[0],{wallMs:123456,passed:false,outcome:'TIMEOUT',groupsPassed:2});
  const changed=renderShowcaseResults(data);
  assert.match(changed,/123\.5 s<small>Timed out · 2\/5 checks/);
  assert.doesNotMatch(changed,/58\.1 s/);
});

test('Pi joins the public table only when a reviewed attempt exists',()=>{
  const data=gallery();
  assert.doesNotMatch(renderShowcaseResults(data),/>Pi</);
  data.cards[0].rows.push({arm:'pi',model:'Qwen 27B · same local weights',wallMs:87654,passed:true,outcome:'PASS',groupsPassed:5,groupsTotal:5});
  const html=renderShowcaseResults(data);
  assert.match(html,/>Pi</);assert.match(html,/87\.7 s/);
});
test('hero speedups require two completed same-model records and use their actual wall times',()=>{
  const data=gallery(),before=structuredClone(data);
  assert.match(renderShowcaseHighlights(data),/>8\.8<span>×/);
  assert.deepEqual(data,before);
  const peer=data.cards[0].rows[1];peer.wallMs=290615;
  assert.match(renderShowcaseHighlights(data),/>5\.0<span>×/);
  peer.passed=false;peer.outcome='TIMEOUT';
  assert.equal(renderShowcaseHighlights(data),'');
  peer.passed=true;peer.model='A different model';
  assert.equal(renderShowcaseHighlights(data),'');
  peer.model='Qwen 27B · same local weights';peer.wallMs=58000;
  assert.equal(renderShowcaseHighlights(data),'');
});

test('hero token savings distinguish complete counts from a conservative measured lower bound',()=>{
  const data=gallery(),[factory,peer]=data.cards[0].rows;
  Object.assign(factory,{accountingComplete:true,tokens:{inputTokens:100,outputTokens:10}});
  Object.assign(peer,{accountingComplete:true,tokens:{inputTokens:400,outputTokens:50}});
  let html=renderShowcaseHighlights(data);
  assert.match(html,/>75%<\/b> less input/);assert.match(html,/>80%<\/b> less output/);
  assert.doesNotMatch(html,/data-lower-bound/);
  Object.assign(peer,{accountingComplete:false,tokens:null,tokenSubset:{inputTokens:301,outputTokens:31},measuredRequests:18,requests:19});
  html=renderShowcaseHighlights(data);
  assert.match(html,/>≥66%<\/b> less input/);assert.match(html,/>≥67%<\/b> less output/);
  assert.match(html,/recorded requests alone/);
  peer.tokenSubset={inputTokens:50,outputTokens:null};
  assert.doesNotMatch(renderShowcaseHighlights(data),/proof-tokens|more input/,'partial counts cannot establish that the full total was smaller');
  factory.accountingComplete=false;
  assert.doesNotMatch(renderShowcaseHighlights(data),/proof-tokens/);
});

test('Codex hero uses its reviewed pair and only claims measured improvements with matching passes',()=>{
  const row=(arm,n)=>({arm,model:'GPT-6 Astra · '+(n===1?'wrapped':'native')+' CLI',passed:true,accountingComplete:true,
    groupsPassed:5,groupsTotal:5,wallMs:n*1000,tokens:{inputTokens:n*2000,outputTokens:n*100,cacheHitTokens:n*1500}});
  const card={id:'snapshot-drift-qualified-4',recorded:true,rows:[row('bantam-codex-astra',1),row('codex-astra',2)]};
  const data={codex:{cards:[card]}},html=renderCodexHighlight(data);
  assert.equal((html.match(/50<span>%/g)||[]).length,3);
  assert.match(html,/1,500 prefix-cache tokens reused/);
  assert.match(html,/Factory 500 · CLI 1,000/);
  assert.match(html,/same Astra/);assert.match(html,/one recorded pair/);
  for(const change of [r=>r.passed=false,r=>r.accountingComplete=false,r=>r.tokens.cacheHitTokens=9000,r=>r.model='Other model',r=>r.wallMs=3000]){
    const altered=structuredClone(data);change(altered.codex.cards[0].rows[0]);
    assert.equal(renderCodexHighlight(altered),'');
  }
});

test('the Astra hero combines both scheduled pairs, including a slower factory round',()=>{
  const row=(arm,n)=>({arm,model:'GPT-6 Astra · CLI',passed:true,accountingComplete:true,
    groupsPassed:5,groupsTotal:5,wallMs:n*1000,tokens:{inputTokens:n*2000,outputTokens:n*100,cacheHitTokens:n*1500}});
  const cards=[
    {id:'job-planner-codex-5',recorded:true,rows:[row('bantam-codex-astra',2),row('codex-astra',1)]},
    {id:'job-planner-codex-6',recorded:true,rows:[row('bantam-codex-astra',1),row('codex-astra',5)]},
  ];
  const html=renderCodexHighlight({codex:{cards}});
  assert.equal((html.match(/50<span>%/g)||[]).length,3);
  assert.match(html,/4,500 prefix-cache tokens reused/);
  assert.match(html,/Factory 1,500 · CLI 3,000/);
  assert.match(html,/50% less uncached input/);
  assert.match(html,/two paired runs/);
  assert.match(html,/job-planner-codex-5\/share\/index.html/);
  assert.match(html,/job-planner-codex-6\/share\/index.html/);
  for(const mutate of [c=>c.pop(),c=>c[0].recorded=false,c=>c[0].rows[0].passed=false,
    c=>c[1].rows[1].accountingComplete=false,c=>c[0].rows.push({...c[0].rows[0]})]){
    const altered=structuredClone(cards);mutate(altered);
    assert.equal(renderCodexHighlight({codex:{cards:altered}}),'','never select only the winning repeat');
  }
});

test('the scrolling race shares the table records and never includes private fields or archived references',()=>{
  const data=gallery();data.cards[0].rows[0].privatePrompt='PRIVATE_DO_NOT_PUBLISH';
  const html=renderFactoryShowcase(data),json=html.match(/<script id="fight-preview" type="application\/json">(.*?)<\/script>/s)[1];
  const preview=JSON.parse(json);
  const context={window:{},document:{getElementById:id=>({textContent:id==='hardware-preview'?fs.readFileSync(new URL('../site/hardware.json',import.meta.url),'utf8'):json})}};
  vm.runInNewContext(fs.readFileSync(new URL('../site/demos.js',import.meta.url),'utf8'),context);
  const race=context.window.DEMOS.ring.steps.find(s=>s.race).race;
  assert.equal(race.rows.length,2);assert.equal(race.rows[0].finish,58.123);
  assert.equal(race.rows[1].finish,512.194);assert.equal(preview.rows[0].wallMs,58123);
  assert.doesNotMatch(html,/PRIVATE_DO_NOT_PUBLISH|reference runs with Claude|References · same work/);
  assert.equal(context.window.DEMOS.hardware.steps.flatMap(s=>s.out||[]).some(s=>s.includes('17.92 GB')),true);
  assert.doesNotMatch(context.window.DEMOS.hardware.steps.flatMap(s=>s.out||[]).join('\n'),/19.0 GB|0.6 GB|3.2 GB/);
  assert.match(html,/headerRooster/);assert.match(html,/data-demo="sandbox"/);
  assert.match(html,/<meta property="og:description" content="Codex Astra, Sol, Terra, or a local 27B/);
  assert.match(html,/<meta property="og:image" content="[^"]*bantam-factory-stations\.png"/);
  assert.ok(html.indexOf('class="hero-factory"')<html.indexOf('id="stage"'));
});

test('the product page stages a finite local asset set without its template or private files',()=>{
  const files=showcaseAssets();
  assert.equal(files.length,SHOWCASE_STATIC_FILES.length);
  assert.ok(files.every(([name,bytes])=>name.startsWith('assets/showcase/')&&bytes.length>0));
  assert.ok(!files.some(([name])=>/README|\.md$/.test(name)||name==='assets/showcase/index.html'));
  assert.throws(()=>renderShowcaseResults({cards:[{id:'../private',recorded:true,rows:[]}]}),/Unrecognized/);
});

test('the playable game matches the recorded edits and the opening tour uses its real request',()=>{
  const source=fs.readFileSync(new URL('../site/examples/tetris/BANTAMTETRIS.html',import.meta.url));
  const build=JSON.parse(fs.readFileSync(new URL('../site/examples/tetris/build.json',import.meta.url)));
  const hash=crypto.createHash('sha256').update(source).digest('hex');
  assert.equal(hash,'08f6dc5b1857b6a3d3509f3bd19f0941cf9c5e5699b9e6cb730a055fed21f085');
  assert.equal(build.file.sha256,hash);assert.equal(build.file.bytes,source.length);
  let replay=build.actions[0].action.content;
  for(const row of build.actions.slice(1))if(row.action.a==='replace')replay=replay.replace(row.action.old,row.action.new);
  assert.equal(replay,source.toString());assert.equal(build.durationMs,148189);
  assert.ok(build.actions.every(row=>!Object.hasOwn(row,'reasoning')));
  const context={window:{},document:{getElementById:()=>null}};
  vm.runInNewContext(fs.readFileSync(new URL('../site/demos.js',import.meta.url),'utf8'),context);
  assert.equal(context.window.DEMOS.job.steps[0].prompt,build.request);
  assert.doesNotMatch(JSON.stringify(context.window.DEMOS.job.steps),/npm test|context-packet|all checks passed/i);
});
