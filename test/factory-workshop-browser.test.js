import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {publicShowcaseData} from '../scripts/factory-showcase.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {renderLaunchPage,renderShareCard} from '../scripts/factory-launch-page.mjs';

const metrics=(inputTokens,outputTokens,cacheHitTokens,freshInputTokens)=>({inputTokens,outputTokens,cacheHitTokens,freshInputTokens});
const unknown=()=>metrics(null,null,null,null);
function fixture({outputOnly=false}={}) {
  const cards=['context-packet','patch-transaction','stream-framer'].map((card,i)=>({card,repeat:1,rows:[{
    arm:'bantam-local-tiel-workshop-1',model:'Tiel 35B-A3B · IQ4_XS',recorded:i<2||outputOnly,
    outcome:i===0?'PASS':i===1?'FAIL':outputOnly?'OUTPUT_ONLY':'NOT RECORDED',
    accepted:i===0?true:i===1?false:outputOnly?true:null,completed:i===0?true:i===1||outputOnly?false:null,
    wallMs:i<2?1000*(i+1):outputOnly?3000:null,
    publicExit:i===0||outputOnly?0:i===1?1:null,hiddenExit:i===0||outputOnly?0:i===1?1:null,
    groupsPassed:i===0||outputOnly?5:i===1?4:null,groupsTotal:i<2||outputOnly?5:null,protectedChanges:i<2||outputOnly?0:null,
    accounting:{full:i===0?metrics(1000,100,700,300):unknown(),subset:i===1?metrics(200,20,150,50):null,
      complete:i===0?true:i===1?false:null,requests:i===0?1:i===1?2:null,measuredRequests:i<2?1:null},
    tokenUpdates:i<2?[{t:400,...(i===0?metrics(1000,100,700,300):metrics(200,20,150,50)),partial:i===1}]:[],
    timedEvents:i<2?1:null,untimedEvents:i<2?0:null,
  }]}));
  return buildLaunchData(JSON.stringify(publicShowcaseData({generatedAt:'2026-09-07T00:00:00.000Z',
    series:[{kind:'variant',complete:false,startedAt:'2026-09-07T00:00:00.000Z',cards}]})));
}
const visibleProse=html=>html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');

test('qualification copy and social card preserve failed, unfinished and unrecorded work without a comparison claim',()=>{
  for(const outputOnly of [false,true]){
    const data=fixture({outputOnly}),before=structuredClone(data);
    const html=renderLaunchPage(data,{presentation:'qualification'}),svg=renderShareCard(data,{presentation:'qualification'});
    assert.deepEqual(data,before);
    assert.equal(data.comparison,null);
    assert.doesNotMatch(visibleProse(html)+visibleProse(svg),/27B|Astra|DeepSeek|same.model comparison|less recorded time|faster than/i);
    assert.match(visibleProse(html),/qualification/i);
    assert.match(visibleProse(svg),/1\/3/,'only actual clean accepted PASS counts in the headline');
    assert.match(visibleProse(svg),/FAIL/);
    assert.match(visibleProse(svg),outputOnly?/OUTPUT_ONLY/:/NOT RECORDED/);
    assert.match(visibleProse(svg),outputOnly?/0:06\.0 summed run time/:/Unknown summed run time/,
      'wall time includes every recorded attempt, and a missing wall time is not zero');
    for(const [,attrs,body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
      if(!attrs.includes('application/json'))assert.doesNotThrow(()=>new vm.Script(body));
  }
});

// Owned CDP session, patterned on the existing launch browser regression. A
// detached process group ensures descendants are also removed after failure.
async function browse(file,profile,width,height) {
  const binary=process.env.BANTAM_LAUNCH_BROWSER_PATH??process.env.BANTAM_SHOWCASE_BROWSER_PATH??'/snap/bin/chromium';
  const child=spawn(binary,['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',
    `--user-data-dir=${profile}`,'--remote-debugging-pipe'],{detached:true,stdio:['ignore','ignore','pipe','pipe','pipe']});
  let id=0,buffer='',stderr='',settled=false;const pending=new Map(),exceptions=[],requests=[];
  const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
  child.on('error',error=>{settled=true;fail(error);});child.on('exit',()=>{settled=true;fail(Error('browser exited: '+stderr));});
  child.stdio[3].on('error',fail);
  child.stdio[4].on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){
    const text=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!text)continue;
    const m=JSON.parse(text);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.text);
    if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);
    const p=pending.get(m.id);if(!p)continue;pending.delete(m.id);clearTimeout(p.timer);
    if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result);
  }});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const seq=++id;
    const timer=setTimeout(()=>{pending.delete(seq);reject(Error('CDP timeout: '+method+' '+stderr));},8000);
    pending.set(seq,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id:seq,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  try{
    const {targetId}=await call('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
    const tab=(method,params)=>call(method,params,sessionId);
    await tab('Page.enable');await tab('Runtime.enable');await tab('Network.enable');
    await tab('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600,screenWidth:width,screenHeight:height});
    await tab('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await tab('Page.navigate',{url:pathToFileURL(file).href+'#card=stream-framer&view=results'});
    let ready=false;for(let i=0;i<200;i++){
      const {result}=await tab('Runtime.evaluate',{expression:'document.documentElement.dataset.workshopChecked === "true"',returnByValue:true});
      if(result.value){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(ready,'qualification browser checks finished');
    const {result}=await tab('Runtime.evaluate',{expression:'document.getElementById("workshop-results").textContent',returnByValue:true});
    return {report:JSON.parse(result.value),exceptions,requests};
  }finally{
    fail(Error('test browser closing'));
    const signal=value=>{if(child.pid)try{process.kill(-child.pid,value);}catch(error){if(error.code!=='ESRCH')throw error;}};
    signal('SIGTERM');await new Promise(resolve=>setTimeout(resolve,200));signal('SIGKILL');
    for(let i=0;!settled&&i<50;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(settled,'owned browser settled before profile cleanup');
  }
}

test('actual desktop/mobile qualification has three selectable single-worker cards, truthful outcomes and exact export',{
  skip:process.env.BANTAM_LAUNCH_BROWSER_TEST!=='1',timeout:60000,
},async t=>{
  const root=fs.mkdtempSync(path.join(os.homedir(),'bantam-workshop-browser-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=fixture(),script=`<script>setTimeout(async()=>{const report={};const check=(k,v)=>report[k]=Boolean(v);
    const wait=async fn=>{for(let i=0;i<120;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI wait expired');};
    try{
      await wait(()=>window.__launchReady===true);const state=()=>window.__launchState(),get=id=>document.getElementById(id);
      const downloads=[],original=URL.createObjectURL;URL.createObjectURL=b=>{downloads.push(b);return original(b);};HTMLAnchorElement.prototype.click=function(){};
      check('initialDeepLink',state().card==='stream-framer'&&state().mode==='results');
      check('tabs',JSON.stringify([...get('work-tabs').querySelectorAll('button')].map(b=>b.dataset.card))===JSON.stringify(['context-packet','patch-transaction','stream-framer']));
      check('noComparison',!(/27B|Astra|DeepSeek|less recorded time|faster than/i.test(document.body.innerText)));
      const expected={'context-packet':{status:'PASS',input:'1,000'},'patch-transaction':{status:'FAIL',input:'200'},'stream-framer':{status:'NOT RECORDED',input:'Unknown'}};
      for(const [card,e] of Object.entries(expected)){
        get('work-tabs').querySelector('[data-card="'+card+'"]').click();
        check(card+'Selected',state().card===card&&get('work-tabs').querySelector('[aria-selected="true"]').dataset.card===card);
        const lanes=[...document.querySelectorAll('.lane')];check(card+'SingleLane',lanes.length===1&&/Tiel/.test(lanes[0].querySelector('.lane-model').textContent));
        check(card+'Status',lanes[0].querySelector('.lane-status').textContent===e.status);
        check(card+'Input',lanes[0].querySelector('.token-inputTokens').textContent===e.input);
        check(card+'Layout',document.documentElement.scrollWidth<=innerWidth);
        if(card==='patch-transaction')check('subsetDisclosure',/Measured subset/.test(lanes[0].querySelector('.receipt-scope').textContent));
      }
      location.hash='card=patch-transaction&t=0&view=replay';await wait(()=>state().card==='patch-transaction'&&state().mode==='replay'&&state().t===0);
      check('hashReplay',/pending/.test(document.querySelector('.lane .project').textContent)&&document.querySelector('.token-inputTokens').textContent==='Unknown');
      get('timeline').value='500';get('timeline').dispatchEvent(new Event('input'));
      check('recordedStep',document.querySelector('.token-inputTokens').textContent==='200');
      get('results').click();check('failedRestored',document.querySelector('.lane-status').textContent==='FAIL');
      get('download-data').click();await wait(()=>downloads.some(b=>b.type==='application/json'));
      const exported=JSON.parse(await downloads.find(b=>b.type==='application/json').text());
      check('exactExport',JSON.stringify(exported)===JSON.stringify(JSON.parse(get('launch-data').textContent)));
      check('sourceSha',exported.source.sha256===${JSON.stringify(data.source.sha256)});
      check('nullsPreserved',exported.comparison===null&&exported.series[0].cards[1].rows[0].accounting.full.inputTokens===null&&exported.series[0].cards[2].rows[0].wallMs===null);
      report.width=innerWidth;report.height=innerHeight;
    }catch(error){report.error=error.stack||String(error);}
    const node=document.createElement('script');node.id='workshop-results';node.type='application/json';node.textContent=JSON.stringify(report);document.body.append(node);document.documentElement.dataset.workshopChecked='true';
  },20);</script>`;
  const file=path.join(root,'index.html');fs.writeFileSync(file,renderLaunchPage(data,{presentation:'qualification'}).replace('</body>',script+'</body>'));
  for(const [width,height] of [[1440,1000],[390,900]]){
    const {report,exceptions,requests}=await browse(file,path.join(root,'profile-'+width),width,height);
    assert.equal(report.error,undefined,JSON.stringify(report));assert.equal(report.width,width);assert.equal(report.height,height);
    for(const [key,value] of Object.entries(report))if(!['width','height'].includes(key))assert.equal(value,true,key+': '+JSON.stringify(report));
    assert.deepEqual(exceptions,[]);assert.deepEqual(requests.filter(url=>/^https?:/i.test(url)),[]);
  }
});
