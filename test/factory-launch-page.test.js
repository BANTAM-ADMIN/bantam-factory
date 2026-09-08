import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {publicShowcaseData} from '../scripts/factory-showcase.mjs';
import {renderLaunchPage, renderShareCard} from '../scripts/factory-launch-page.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-06T12:00:00.000Z';
const metrics = (inputTokens, outputTokens, cacheHitTokens, freshInputTokens) => ({inputTokens, outputTokens, cacheHitTokens, freshInputTokens});
const totals = metrics(200, 16, 140, 60);

function fixture() {
  const row = (arm, partial = false) => ({arm, model:'Qwen 27B · same local weights', recorded:true,
    outcome:partial?'OUTPUT_ONLY':'PASS', accepted:true, completed:!partial,
    wallMs:arm==='deepseek-local-27b'?4000:2000, groupsPassed:5, groupsTotal:5,
    publicExit:0, hiddenExit:0, protectedChanges:0,
    accounting:{full:partial?metrics(null,null,null,null):totals,
      subset:partial?metrics(100,8,70,30):null, complete:!partial, requests:2, measuredRequests:partial?1:2,
      coverage:Object.fromEntries(Object.keys(totals).map(field=>[field,{totalRequests:2,measuredRequests:partial?1:2,complete:!partial,missingRequestIndices:partial?[2]:[]}]))},
    tokenUpdates:[{t:800,...metrics(100,8,70,30),partial:false},...(!partial?[{t:1500,...totals,partial:false}]:[])],
    timedEvents:2, untimedEvents:1,
    prompt:'PRIVATE_PROMPT_MUST_NOT_SHIP', paths:['/home/private/worker.js'],
    events:[{t:1,detail:'PRIVATE_EVENT_MUST_NOT_SHIP'}],
  });
  const privateSource = {generatedAt:stamp,series:[{kind:'comparison',complete:true,startedAt:stamp,finishedAt:stamp,
    provenance:{root:'/home/private/benchmark',credentials:'PRIVATE_CREDENTIAL_MUST_NOT_SHIP'},
    cards:['receipt-reducer','snapshot-drift','job-planner'].map(card=>({card,repeat:1,
      rows:[row('codex-astra'),row('hermes',true),row('bantam-local-27b'),row('bantam-codex-astra'),row('deepseek-local-27b'),row('opencode')]}))},
    {kind:'variant',complete:true,startedAt:stamp,finishedAt:stamp,cards:[{card:'snapshot-drift',repeat:1,
      rows:[{...row('bantam-local-tiel35ba3b-iq4-xs-72k-mtp1',true),model:'Tiel 35B-A3B · IQ4_XS'}]}]}]};
  const series = publicShowcaseData(privateSource).series;
  return {schema:'bantam.launch-fight-card.v1',generatedAt:stamp,
    source:{sha256:sha('public fixture only'),schema:'bantam.factory-showcase.v1'},
    comparison:{seriesId:series[0].id,lessTimePercent:50,bantamWallMs:6000,deepseekWallMs:12000,cards:3,repeatCount:1},
    spotlight:{seriesId:series[1].id,cardId:series[1].cards[0].id},series};
}

function fourCornerFixture({missing=false}={}) {
  const original=fixture(),chosen=['codex-astra','hermes','bantam-local-27b','opencode'];
  const rows=chosen.map(arm=>structuredClone(original.series[0].cards[0].rows.find(row=>row.arm===arm)));
  const native=rows.find(row=>row.arm==='codex-astra');native.wallMs=1800;
  const open=rows.find(row=>row.arm==='opencode');
  Object.assign(open,{outcome:'FAIL',accepted:false,completed:true,groupsPassed:4,hiddenExit:1});
  if(missing)Object.assign(open,{recorded:false,outcome:'NOT RECORDED',accepted:null,completed:null,
    wallMs:null,groupsPassed:null,groupsTotal:null,publicExit:null,hiddenExit:null,protectedChanges:null,
    accounting:{full:metrics(null,null,null,null),complete:null,requests:null,measuredRequests:null},tokenUpdates:[]});
  const projected=publicShowcaseData({generatedAt:stamp,series:[{kind:'comparison',complete:!missing,
    startedAt:stamp,finishedAt:missing?null:stamp,cards:[{card:'patch-transaction',repeat:1,rows}]}]});
  return {...original,comparison:null,spotlight:null,series:projected.series};
}

const visibleProse=html=>html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');

test('local factory headlines earn their finish without claiming a win over a faster frontier', () => {
  const data=fourCornerFixture();
  for(const render of [renderLaunchPage,renderShareCard]) {
    const prose=visibleProse(render(data));
    assert.match(prose,/5\/5\s+BANTAM · checks passed\. Work completed\./);
    assert.match(prose,/2\.0s elapsed · 5\/5 acceptance groups/);
    assert.doesNotMatch(prose,/BANTAM wins|BANTAM is fastest/);
  }
  const row=data.series[0].cards[0].rows.find(row=>row.arm==='bantam-local-27b');
  for(const change of [{outcome:'OUTPUT_ONLY',completed:false},{outcome:'FAIL',hiddenExit:1},
    {outcome:'PASS',completed:true,hiddenExit:0,protectedChanges:1},
    {recorded:false,outcome:'NOT RECORDED',wallMs:null}]) {
    Object.assign(row,change);
    for(const render of [renderLaunchPage,renderShareCard]) {
      const prose=visibleProse(render(data));
      assert.doesNotMatch(prose,/BANTAM · checks passed\. Work completed\./);
      assert.match(prose,/BANTAM · recorded outcome/);
    }
  }
});

function embedded(html) {
  const block = html.match(/<script\b(?=[^>]*\bid=["']launch-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(block, 'public data must be independently inspectable');
  return JSON.parse(block[1]);
}

test('single-card share images put local BANTAM first without reordering evidence',()=>{
  const data=fixture();data.series[0].cards=data.series[0].cards.slice(0,1);
  data.series[0].cards[0].rows.reverse();const before=structuredClone(data);
  const svg=renderShareCard(data);
  assert.match(svg,/<text x="70" y="319"[^>]*>BANTAM/);
  assert.deepEqual(data,before);
});

test('launch exports only the supplied public record, preserving incomplete meters and completion distinctions', () => {
  const data=fixture(),before=structuredClone(data),html=renderLaunchPage(data),serialized=JSON.stringify(embedded(html));
  assert.ok(!html.includes('Work completed..'));
  assert.deepEqual(data,before,'rendering must not mutate the evidence projection');
  for(const forbidden of ['PRIVATE_PROMPT_MUST_NOT_SHIP','PRIVATE_EVENT_MUST_NOT_SHIP','PRIVATE_CREDENTIAL_MUST_NOT_SHIP','/home/private/']) {
    assert.ok(!html.includes(forbidden),forbidden);
    assert.ok(!renderShareCard(data).includes(forbidden),forbidden);
  }
  const exported=embedded(html),partial=exported.series[0].cards[0].rows.find(row=>row.arm==='hermes');
  assert.deepEqual(partial.accounting.full,metrics(null,null,null,null));
  assert.deepEqual(partial.accounting.subset,metrics(100,8,70,30));
  assert.equal(partial.outcome,'OUTPUT_ONLY');
  assert.equal(partial.accepted,true);assert.equal(partial.completed,false);
  assert.ok(serialized.includes(data.source.sha256));
  assert.match(html,/measured|partial|incomplete/i,'incomplete accounting needs an explicit scope explanation');
  assert.match(html,/one|single|repeat|sample/i,'the page must expose trial scope, not imply population reliability');
});

test('hostile text cannot terminate data scripts or SVG text, and inline scripts compile offline', () => {
  const data=fixture(),attack='</script><img src="https://evil.invalid/x" onerror="window.LAUNCH_XSS=1">';
  data.series[0].title=attack;data.series[0].cards[0].title=attack;
  data.series[0].cards[0].rows[0].label=attack;
  const html=renderLaunchPage(data),svg=renderShareCard(data);
  embedded(html);
  assert.ok(!html.includes('<img src="https://evil.invalid/x"'));
  assert.ok(!svg.includes('<img src="https://evil.invalid/x"'));
  assert.doesNotMatch(svg,/<script\b|<foreignObject\b/i);
  assert.doesNotMatch(html,/<(?:script|img|iframe|link)\b[^>]*(?:src|href)=["']https?:/i);
  assert.doesNotMatch(html,/@import\s|url\(["']?https?:/i);
  const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  const programs=scripts.filter(([,attrs])=>!attrs.includes('application/json'));
  assert.ok(programs.length>0);
  for(const [,attrs,body] of programs){assert.doesNotMatch(attrs,/\bsrc\s*=/i);assert.doesNotThrow(()=>new vm.Script(body));}
  assert.match(html,/prefers-reduced-motion/);
});

test('missing comparison has no invented speed claim and unknown data is not formatted as zero', () => {
  const data=fixture();data.comparison=null;data.spotlight=null;
  const html=renderLaunchPage(data),svg=renderShareCard(data);
  assert.equal(embedded(html).comparison,null);
  assert.doesNotMatch(svg,/50\s*%|0\s*%/);
  const partial=embedded(html).series[0].cards[0].rows.find(row=>row.arm==='hermes');
  assert.equal(partial.accounting.full.inputTokens,null);
});

test('public copy scopes selected development history without claiming every experiment is included', () => {
  const html=renderLaunchPage(fixture());
  // Check rendered prose only: embedded records and history.replaceState are
  // evidence/code, not claims about this publication's historical coverage.
  const prose=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
  assert.doesNotMatch(prose,/See every recorded attempt|The whole record|No runs hidden/i);
  assert.match(prose,/selected[^.!?]{0,100}(?:history|development|qualification|edition|attempt)/i,
    'the public development-history selection must be explicit');
});

test('single workshop comparison scopes four actual corners without legacy task, contender or speed claims', () => {
  const data=fourCornerFixture(),before=structuredClone(data),html=renderLaunchPage(data),svg=renderShareCard(data);
  assert.deepEqual(data,before,'display order must not rewrite recorded row order');
  assert.deepEqual(embedded(html),data);
  const series=data.series[0],card=series.cards[0];
  assert.equal(series.cards.length,1);assert.equal(card.card,'patch-transaction');
  assert.deepEqual(card.rows.map(row=>row.arm),['codex-astra','hermes','bantam-local-27b','opencode']);
  assert.deepEqual(series.counts,{observed:4,planned:4,accepted:3,completed:3,pass:2,
    groupsMeasured:4,groupsPassed:19,groupsTotal:20});
  const prose=visibleProse(html),share=visibleProse(svg);
  assert.match(prose,/1 WORK ORDER\b/);assert.match(prose,/2\/4\s*attempts passed and completed/);
  assert.match(prose,/Artifacts accepted:\s*3\/4/);
  assert.match(prose,/3 local configurations/);assert.match(prose,/1 frontier reference/);
  assert.match(prose,/No held-out-task claim is made/);
  assert.match(share,/1 work order · 4 systems · 4\/4 attempts recorded/);
  assert.match(share,/3\/4 artifacts accepted/);
  for(const label of ['BANTAM · local','OpenCode','Hermes','Codex · Astra'])assert.ok(share.includes(label),label);
  for(const text of [prose,share])assert.doesNotMatch(text,
    /DeepSeek|BANTAM · Astra|wrapped CLI|receipt reducer|snapshot tool|dependency planner|three (?:tasks|work orders)|six[- ]system|two Astra|frontier work overlapped|CPU\/I\/O contention|\d+(?:\.\d+)?\s*%\s*less|less recorded time|BANTAM finished .*sooner/i);
  const hermes=embedded(html).series[0].cards[0].rows.find(row=>row.arm==='hermes');
  assert.deepEqual(hermes.accounting.full,metrics(null,null,null,null));
  assert.deepEqual(hermes.accounting.subset,metrics(100,8,70,30));
  assert.equal(hermes.accounting.coverage.inputTokens.complete,false);
  assert.equal(hermes.completed,false);assert.equal(hermes.accepted,true);
});

test('an unrecorded fourth corner keeps the planned denominator and unknown counters in the share record', () => {
  const data=fourCornerFixture({missing:true}),html=renderLaunchPage(data),svg=renderShareCard(data);
  const series=embedded(html).series[0],missing=series.cards[0].rows.find(row=>row.arm==='opencode');
  assert.equal(series.complete,false);assert.equal(series.counts.observed,3);assert.equal(series.counts.planned,4);
  assert.equal(missing.outcome,'NOT RECORDED');assert.equal(missing.wallMs,null);
  assert.equal(missing.completed,null);assert.equal(missing.accepted,null);assert.deepEqual(missing.tokenUpdates,[]);
  assert.deepEqual(missing.accounting.full,metrics(null,null,null,null));
  assert.match(visibleProse(html),/2\/4\s*attempts passed and completed/);
  assert.match(visibleProse(svg),/3\/4 attempts recorded/);
  assert.match(visibleProse(svg),/OpenCode\s+NOT RECORDED\s+Unknown/);
});

// Adapted from the existing showcase CDP helper. Keep the browser process,
// profile and file fixture owned by this test; never reuse a user session.
async function browserPage({file,width,height,profile,reducedMotion=false}) {
  const binary=process.env.BANTAM_LAUNCH_BROWSER_PATH??process.env.BANTAM_SHOWCASE_BROWSER_PATH??'/snap/bin/chromium';
  const child=spawn(binary,['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',
    `--user-data-dir=${profile}`,'--remote-debugging-pipe'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  const pending=new Map(),requests=[],exceptions=[];let next=0,buffer='',stderr='';
  const fail=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
  child.on('error',fail);child.on('exit',()=>fail(Error('Chromium exited: '+stderr)));
  child.stdio[4].on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){
    const text=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!text)continue;
    const message=JSON.parse(text);
    if(message.method==='Network.requestWillBeSent')requests.push(message.params.request.url);
    if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails.text);
    const item=pending.get(message.id);if(!item)continue;pending.delete(message.id);clearTimeout(item.timer);
    if(message.error)item.reject(Error(JSON.stringify(message.error)));else item.resolve(message.result);
  }});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout ${method}: ${stderr}`));},8000);
    pending.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  try {
    const {targetId}=await call('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
    const tab=(method,params)=>call(method,params,sessionId);
    await tab('Page.enable');await tab('Runtime.enable');await tab('Network.enable');
    await tab('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600,screenWidth:width,screenHeight:height});
    await tab('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reducedMotion?'reduce':'no-preference'}]});
    await tab('Page.navigate',{url:pathToFileURL(file).href});
    let ready=false;
    for(let i=0;i<200;i++){
      const {result}=await tab('Runtime.evaluate',{expression:'document.documentElement.dataset.browserComplete !== undefined',returnByValue:true});
      if(result.value){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(ready,'browser assertions must finish: '+stderr);
    const {result}=await tab('Runtime.evaluate',{expression:'document.getElementById("browser-results").textContent',returnByValue:true});
    return {report:JSON.parse(result.value),requests,exceptions,stderr};
  } finally {
    await call('Browser.close').catch(()=>{});
    if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
}

test('actual Chromium verifies mobile/desktop replay, exports, accessibility and public scope', {
  skip:process.env.BANTAM_LAUNCH_BROWSER_TEST!=='1',timeout:90000,
},async t=>{
  const root=fs.mkdtempSync(path.join(os.homedir(),'bantam-launch-browser-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=fixture();
  const expectedInputs={'bantam-local-27b':200,'deepseek-local-27b':400,opencode:600,hermes:100,'codex-astra':800,'bantam-codex-astra':1000};
  for(const card of data.series[0].cards)for(const row of card.rows)if(row.accounting.complete){
    row.accounting.full.inputTokens=expectedInputs[row.arm];
    row.tokenUpdates.at(-1).inputTokens=expectedInputs[row.arm];
  }
  const script=`<script>setTimeout(async()=>{const report={};const expect=(name,value)=>{report[name]=Boolean(value);};
    const wait=async(fn)=>{for(let i=0;i<160;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('wait expired');};
    try{
      await wait(()=>window.__launchReady===true);
      const state=()=>window.__launchState(),get=id=>document.getElementById(id);
      const downloads=[],nativeURL=URL.createObjectURL;URL.createObjectURL=blob=>{downloads.push(blob);return nativeURL(blob);};
      HTMLAnchorElement.prototype.click=function(){};
      expect('layout',document.documentElement.scrollWidth<=innerWidth);
      expect('resultsDefault',state().mode!=='replay'&&!state().playing);
      const expectedInputs=${JSON.stringify(expectedInputs)};
      expect('displayOrder',JSON.stringify([...document.querySelectorAll('.lane')].map(n=>n.dataset.arm))===JSON.stringify(Object.keys(expectedInputs)));
      expect('groupHeadings',document.querySelectorAll('.lane-group').length===2);
      expect('frontierGroupIsNotAstraOnly',[...document.querySelectorAll('.lane-group')].some(h=>h.textContent==='Frontier references · different models from the local worker'));
      expect('counterBinding',[...document.querySelectorAll('.lane')].every(n=>Number(n.querySelector('.token-inputTokens').textContent.replaceAll(',',''))===expectedInputs[n.dataset.arm]));
      expect('accessibleButtons',[...document.querySelectorAll('button')].every(b=>(b.getAttribute('aria-label')||b.textContent).trim()));
      expect('accessibleTimeline',Boolean(get('timeline').getAttribute('aria-label')||get('timeline').labels?.length));
      get('download-data').click();await wait(()=>downloads.length>0);
      const exported=JSON.parse(await downloads.at(-1).text()),embedded=JSON.parse(get('launch-data').textContent);
      expect('dataExact',JSON.stringify(exported)===JSON.stringify(embedded));
      expect('sourceHash',exported.source.sha256===${JSON.stringify(data.source.sha256)});
      location.hash='card=receipt-reducer&t=0&view=replay';
      await wait(()=>state().mode==='replay'&&state().t===0);
      expect('hashReplay',state().card==='receipt-reducer');
      expect('pendingAtZero',[...document.querySelectorAll('.lane-status')].every(n=>/pending|running|replaying|not yet/i.test(n.textContent)));
      expect('acceptancePending',[...document.querySelectorAll('.lane .project,.lane .finish,.lane .groups')].every(n=>/pending/i.test(n.textContent)));
      expect('finalReceiptsHidden',[...document.querySelectorAll('.lane details')].every(n=>n.hidden));
      const meter=arm=>document.querySelector('.lane[data-arm="'+arm+'"] .token-inputTokens').textContent;
      expect('unknownAtZero',/unknown|—|not yet/i.test(meter('bantam-local-27b')));
      get('timeline').value='1200';get('timeline').dispatchEvent(new Event('input'));
      expect('stepMeter',/100/.test(meter('bantam-local-27b')));
      get('timeline').value='1300';get('timeline').dispatchEvent(new Event('input'));
      expect('noInterpolation',/100/.test(meter('bantam-local-27b')));
      if([...get('speed').options].some(o=>o.value==='1'))get('speed').value='1';
      get('speed').dispatchEvent(new Event('change'));get('play').click();
      await wait(()=>state().playing);const initial=state().t;await new Promise(r=>setTimeout(r,100));get('play').click();
      expect('playPause',!state().playing&&state().t>initial);
      get('results').click();expect('resultsRestore',state().mode!=='replay'&&!state().playing);
      const partial=document.querySelector('.lane[data-arm="hermes"]');
      expect('partialScope',/partial|subset|incomplete|unknown/i.test(partial.textContent));
      expect('outputOnly',/OUTPUT.ONLY|output only/i.test(partial.textContent));
      get('download-image').click();await wait(()=>downloads.some(b=>b.type==='image/png'));
      const png=downloads.find(b=>b.type==='image/png'),head=new Uint8Array(await png.arrayBuffer());
      expect('pngDownload',head.length>100&&head.slice(0,8).join(',')==='137,80,78,71,13,10,26,10');
      get('share-svg').click();await wait(()=>downloads.some(b=>b.type.includes('svg')));
      expect('svgDownload',/<svg[\\s>]/.test(await downloads.find(b=>b.type.includes('svg')).text()));
      get('work-tabs').querySelector('[aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      expect('keyboardTabs',state().card==='snapshot-drift'&&get('work-tabs').querySelector('[aria-selected="true"]').dataset.card==='snapshot-drift');
      get('focus').click();expect('focusControl',get('focus').getAttribute('aria-pressed')==='true');
      get('focus').click();expect('focusExit',get('focus').getAttribute('aria-pressed')==='false');
      get('method').querySelector('summary').click();expect('hashExposed',get('method').open&&get('method').textContent.includes(exported.source.sha256));
      expect('noXss',!window.LAUNCH_XSS);
      report.width=innerWidth;report.height=innerHeight;report.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
    }catch(error){report.error=error.stack||String(error);}
    const result=document.createElement('script');result.id='browser-results';result.type='application/json';result.textContent=JSON.stringify(report);document.body.append(result);
    document.documentElement.dataset.browserComplete='true';
  },20);</script>`;
  const file=path.join(root,'index.html');fs.writeFileSync(file,renderLaunchPage(data).replace('</body>',script+'</body>'));
  for(const [width,height] of [[1440,1000],[390,900]]){
    const {report,requests,exceptions}=await browserPage({file,width,height,profile:path.join(root,'profile-'+width),reducedMotion:width===390});
    assert.equal(report.error,undefined,JSON.stringify(report));
    assert.equal(report.width,width);assert.equal(report.height,height);assert.equal(report.reducedMotion,width===390);
    for(const [name,value] of Object.entries(report))if(!['width','height','reducedMotion'].includes(name))assert.equal(value,true,name+': '+JSON.stringify(report));
    assert.deepEqual(requests.filter(url=>/^https?:/i.test(url)),[],'offline page must not request remote resources');
    assert.deepEqual(exceptions,[]);
  }
});

test('actual Chromium keeps a one-work-order four-corner film and its exports scoped to recorded systems', {
  skip:process.env.BANTAM_LAUNCH_BROWSER_TEST!=='1',timeout:60000,
},async t=>{
  const root=fs.mkdtempSync(path.join(os.homedir(),'bantam-four-corner-launch-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=fourCornerFixture(),expected=['bantam-local-27b','opencode','hermes','codex-astra'];
  const script=`<script>setTimeout(async()=>{const report={};const expect=(name,value)=>{report[name]=Boolean(value);};
    try{
      const get=id=>document.getElementById(id),state=()=>window.__launchState();
      const wait=async fn=>{for(let i=0;i<160;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('wait expired');};
      await wait(()=>window.__launchReady===true);
      const data=JSON.parse(get('launch-data').textContent),rows=data.series[0].cards[0].rows;
      const lanes=()=>[...document.querySelectorAll('.lane')],meter=(arm,key='inputTokens')=>document.querySelector('.lane[data-arm="'+arm+'"] .token-'+key).textContent;
      expect('oneTab',get('work-tabs').querySelectorAll('[role="tab"]').length===1&&state().card==='patch-transaction');
      expect('fourCorners',JSON.stringify(lanes().map(n=>n.dataset.arm))===${JSON.stringify(JSON.stringify(expected))});
      expect('sourceRowBinding',lanes().every(n=>rows[Number(n.dataset.row)].arm===n.dataset.arm));
      expect('twoModelFamilies',document.querySelectorAll('.lane-group').length===2&&/3 different harnesses/.test(document.querySelector('.lane-group').textContent));
      expect('noAbsentSystems',!document.querySelector('.lane[data-arm="deepseek-local-27b"],.lane[data-arm="bantam-codex-astra"]'));
      expect('noLegacyMethod',!/Three useful Node|six-system series|frontier work overlapped|DeepSeek/.test(get('method').textContent));
      const partial=document.querySelector('.lane[data-arm="hermes"]');
      expect('partialNotZero',meter('hermes')==='100'&&meter('hermes','cacheHitTokens')==='70'&&/Measured subset/.test(partial.textContent));
      expect('outputOnlyNotClean',/OUTPUT_ONLY/.test(partial.textContent)&&/Finish not accepted/.test(partial.textContent));
      location.hash='card=patch-transaction&t=0&view=replay';
      await wait(()=>state().mode==='replay'&&state().t===0);
      expect('allPending',lanes().every(n=>/pending/i.test(n.querySelector('.project').textContent)&&/REPLAYING/.test(n.querySelector('.lane-status').textContent)));
      expect('allUnknownBeforeFirstResponse',lanes().every(n=>/Unknown|—/i.test(n.querySelector('.token-inputTokens').textContent)));
      get('timeline').value='1200';get('timeline').dispatchEvent(new Event('input'));
      expect('savedCounterStep',lanes().every(n=>n.querySelector('.token-inputTokens').textContent==='100'));
      get('timeline').value='1300';get('timeline').dispatchEvent(new Event('input'));
      expect('noCounterInterpolation',meter('bantam-local-27b')==='100');
      get('results').click();
      const downloads=[],originalURL=URL.createObjectURL;URL.createObjectURL=blob=>{downloads.push(blob);return originalURL(blob);};HTMLAnchorElement.prototype.click=function(){};
      get('download-data').click();await wait(()=>downloads.length>0);
      expect('exactFourCornerDownload',JSON.stringify(JSON.parse(await downloads.at(-1).text()))===JSON.stringify(data));
      get('share-svg').click();await wait(()=>downloads.some(blob=>blob.type.includes('svg')));
      const svg=await downloads.find(blob=>blob.type.includes('svg')).text();
      expect('scopedShare',svg.includes('4 systems')&&svg.includes('4/4 attempts recorded')&&!/DeepSeek|BANTAM · Astra/.test(svg));
      expect('layout',document.documentElement.scrollWidth<=innerWidth);
      report.width=innerWidth;report.height=innerHeight;
    }catch(error){report.error=error.stack||String(error);}
    const result=document.createElement('script');result.id='browser-results';result.type='application/json';result.textContent=JSON.stringify(report);document.body.append(result);
    document.documentElement.dataset.browserComplete='true';
  },20);</script>`;
  const file=path.join(root,'index.html');fs.writeFileSync(file,renderLaunchPage(data).replace('</body>',script+'</body>'));
  for(const [width,height] of [[1440,1000],[390,900]]){
    const {report,requests,exceptions}=await browserPage({file,width,height,profile:path.join(root,'profile-'+width),reducedMotion:width===390});
    assert.equal(report.error,undefined,JSON.stringify(report));assert.equal(report.width,width);assert.equal(report.height,height);
    for(const [name,value] of Object.entries(report))if(!['width','height'].includes(name))assert.equal(value,true,name+': '+JSON.stringify(report));
    assert.deepEqual(requests.filter(url=>/^https?:/i.test(url)),[]);assert.deepEqual(exceptions,[]);
  }
});
