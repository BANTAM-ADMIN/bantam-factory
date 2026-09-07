import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {renderLaunchPage, renderShareCard} from '../scripts/factory-launch-page.mjs';

const options={presentation:'qualification'};
const model='Tiel 35B-A3B · IQ4_XS';
const totals={inputTokens:100,outputTokens:10,cacheHitTokens:75,freshInputTokens:25};
function fixture(){
  const cards=[['context-packet','Context packet','BUILD'],['patch-transaction','Patch transaction','EXTEND'],['stream-framer','Stream framer','REPAIR']]
    .map(([card,title,kind],i)=>({id:card,card,title,kind,number:String(i+1),description:'A public work order.',repeat:1,
      rows:[{id:card+'-worker',arm:'bantam-local-variant',label:'BANTAM · Tiel',model,family:'local',bantam:true,
        recorded:true,outcome:'PASS',accepted:true,completed:true,wallMs:(i+1)*1000,
        publicExit:0,hiddenExit:0,protectedChanges:0,groupsPassed:5,groupsTotal:5,
        accounting:{full:{...totals},subset:null,complete:true,requests:1,measuredRequests:1},
        tokenUpdates:[{t:500,...totals}],timedEvents:1,untimedEvents:0}]}));
  return {schema:'bantam.launch-fight-card.v1',generatedAt:'2026-09-07T00:00:00.000Z',
    source:{sha256:'a'.repeat(64),schema:'bantam.factory-showcase.v1'},comparison:null,spotlight:null,
    series:[{id:'qualification-1',kind:'variant',title:'Local qualification',complete:true,cards}]};
}
const prose=html=>html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
const embedded=html=>JSON.parse(html.match(/<script id="launch-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const program=html=>[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].find(([,attrs])=>!attrs.includes('application/json'))[2];

// Exercise the renderer's actual browser-side cohort selection without opening
// a browser. DOM/layout/export interactions remain covered by the existing
// opt-in browser suite; this checks that replay binds the same recorded rows.
function replaySelection(html){
  const code=program(html),start=code.indexOf('function browser('),end=code.indexOf('  let ci=');
  assert.ok(start>=0&&end>start);
  const data=embedded(html),share=JSON.parse(html.match(/<script id="share-card-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const invocation=code.slice(code.lastIndexOf(';browser(')+1);
  const context={document:{getElementById:id=>({textContent:JSON.stringify(id==='launch-data'?data:share)})}};
  vm.runInNewContext(code.slice(start,end)+'globalThis.replayCards=cards; }\n'+invocation,context);
  return JSON.parse(JSON.stringify(context.replayCards));
}

test('qualification hero and 1200×630 share card count all three completed accepted tasks',()=>{
  const data=fixture(),before=structuredClone(data),html=renderLaunchPage(data,options),svg=renderShareCard(data,options);
  assert.match(html,/<div class="hero-number">3\/3<\/div>/);
  assert.match(prose(html),/Summed run time 0:06\.0/);
  assert.match(prose(html),/3 work orders inside BANTAM/);
  for(const title of ['Context packet','Patch transaction','Stream framer'])assert.ok(prose(html).includes(title));
  for(const value of [prose(html),svg])assert.doesNotMatch(value,/DeepSeek|Astra|27B|less recorded time|46\.6%|same.model comparison/i);
  assert.match(svg,/width="1200" height="630"/);
  assert.match(svg,/>3\/3<\/text>/);
  assert.match(svg,/3\/3 attempts recorded/);
  assert.match(svg,/not a model comparison or a reliability estimate/i);
  assert.deepEqual(embedded(html),before,'public export is the identical supplied payload');
  assert.deepEqual(data,before,'rendering does not mutate records');
  new vm.Script(program(html));
});

test('FAIL and OUTPUT_ONLY reduce the pass count without hiding acceptance or elapsed time',()=>{
  const data=fixture(),rows=data.series[0].cards.map(c=>c.rows[0]);
  Object.assign(rows[1],{outcome:'FAIL',accepted:false,groupsPassed:4,hiddenExit:1});
  Object.assign(rows[2],{outcome:'OUTPUT_ONLY',accepted:true,completed:false});
  const html=renderLaunchPage(data,options),svg=renderShareCard(data,options);
  assert.match(html,/<div class="hero-number">1\/3<\/div>/);
  assert.match(prose(html),/Artifacts accepted: 2\/3/);
  assert.match(svg,/2\/3 artifacts accepted/);
  assert.match(prose(html),/Summed run time 0:06\.0/);
  assert.match(svg,/FAIL/);assert.match(svg,/OUTPUT_ONLY/);
  assert.equal(embedded(html).series[0].cards[2].rows[0].accepted,true);
  assert.equal(embedded(html).series[0].cards[2].rows[0].completed,false);
});

test('missing timing and unrecorded attempts stay unknown and remain in the denominator',()=>{
  const data=fixture(),row=data.series[0].cards[2].rows[0];
  Object.assign(row,{recorded:false,outcome:'NOT RECORDED',accepted:null,completed:null,wallMs:null});
  row.accounting.full=Object.fromEntries(Object.keys(totals).map(k=>[k,null]));
  row.accounting.complete=false;row.accounting.subset={...totals};
  const html=renderLaunchPage(data,options);
  assert.match(html,/<div class="hero-number">2\/3<\/div>/);
  assert.match(prose(html),/Summed run time Unknown/);
  assert.match(prose(html),/Attempts recorded 2\/3/);
  assert.equal(embedded(html).series[0].cards[2].rows[0].accounting.full.inputTokens,null);
  assert.match(renderShareCard(data,options),/Unknown summed run time/);
});

test('strict qualification cannot promote contradictory passing labels',()=>{
  for(const mutation of [r=>{r.completed=null;},r=>{r.accepted=false;},r=>{r.protectedChanges=1;},
    r=>{r.publicExit=1;},r=>{r.hiddenExit=null;},r=>{r.groupsPassed=4;},r=>{r.bantam=false;}]){
    const data=fixture();mutation(data.series[0].cards[0].rows[0]);
    assert.match(renderLaunchPage(data,options),/<div class="hero-number">2\/3<\/div>/);
  }
});

test('explicit qualification selects first variant for both static results and replay, not a later success',()=>{
  const data=fixture(),first=data.series[0],later=structuredClone(first);
  first.cards[0].rows[0].outcome='FAIL';first.cards[0].rows[0].accepted=false;
  later.id='later-passing-variant';later.cards[0].rows[0].accounting.full.inputTokens=999;
  const comparison={id:'old-comparison',kind:'comparison',cards:[{...structuredClone(first.cards[0]),card:'older-card',title:'Older comparison'}]};
  data.series=[comparison,first,later];data.comparison={seriesId:comparison.id,lessTimePercent:50,bantamWallMs:1,deepseekWallMs:2,cards:3,repeatCount:1};
  data.spotlight={seriesId:later.id,cardId:later.cards[0].id};
  const html=renderLaunchPage(data,options),selected=replaySelection(html);
  assert.match(html,/<div class="hero-number">2\/3<\/div>/);
  assert.deepEqual(selected,first.cards);
  assert.equal(selected[0].rows[0].accounting.full.inputTokens,100);
  assert.equal(selected[0].rows[0].tokenUpdates[0].inputTokens,100);
  assert.deepEqual(embedded(html),data);
  assert.doesNotMatch(renderShareCard(data,options),/50%|DeepSeek/);
  const defaultHtml=renderLaunchPage(data);
  assert.match(prose(defaultHtml),/less recorded time/);
  assert.deepEqual(replaySelection(defaultHtml),comparison.cards);
});

test('qualification without a variant does not fall back to comparison or invent completion',()=>{
  const data=fixture();data.series[0].kind='comparison';data.comparison={seriesId:data.series[0].id,lessTimePercent:50,bantamWallMs:1,deepseekWallMs:2};
  const html=renderLaunchPage(data,options);
  assert.match(html,/<div class="hero-number">—<\/div>/);
  assert.deepEqual(replaySelection(html),[]);
  assert.match(prose(html),/no recorded qualification cohort/);
  assert.doesNotMatch(renderShareCard(data,options),/>0\/0<\/text>|50%/);
  assert.throws(()=>renderLaunchPage(data,{presentation:'guess'}),/Unknown launch presentation/);
  assert.throws(()=>renderShareCard(data,{presentation:'guess'}),/Unknown launch presentation/);
});

test('qualification labels cannot escape HTML or SVG and preview remains a generated local file',()=>{
  const data=fixture();data.series[0].cards[0].title='</text><script>BAD()</script>';
  const html=renderLaunchPage(data,options),svg=renderShareCard(data,options);
  assert.doesNotMatch(svg,/<script\b|<foreignObject\b/);
  assert.doesNotMatch(html,/<script>BAD/);
  assert.deepEqual(embedded(html),data);
  assert.throws(()=>renderLaunchPage(data,{...options,previewImage:'https://private.invalid/a.png'}),/generated local/);
});
