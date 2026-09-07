import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {gunzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildShowcase,publicShowcaseData,renderShowcase,writeShowcase,showcaseAcceptanceAt,sameModelObservation} from '../scripts/factory-showcase.mjs';

const start='2026-09-06T12:00:00.000Z';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(root,file,value)=>{const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof value==='string'?value:JSON.stringify(value));return p;};
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-showcase-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
// Chrome's --window-size may set a 390px screenshot surface while retaining a
// 500px minimum layout viewport. CDP emulation pins the *actual* CSS viewport.
export async function chromiumPage({file,width,height,profile,screenshot=null,instrumented=true}){
  const browser=process.env.BANTAM_SHOWCASE_BROWSER_PATH??process.env.BANTAM_REPLAY_BROWSER_PATH??'/snap/bin/chromium';
  const child=spawn(browser,['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',
    `--user-data-dir=${profile}`,'--remote-debugging-pipe'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  const pending=new Map();let next=0,buffer='',stderr='';
  child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8000);});
  const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',fail);child.on('exit',()=>fail(Error('Chromium exited: '+stderr)));
  child.stdio[4].on('data',chunk=>{
    buffer+=chunk.toString();let end;
    while((end=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!text)continue;
      const message=JSON.parse(text),p=pending.get(message.id);if(!p)continue;pending.delete(message.id);clearTimeout(p.timer);
      if(message.error)p.reject(Error(JSON.stringify(message.error)));else p.resolve(message.result);
    }
  });
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timed out: ${method}; ${stderr}`));},8000);
    pending.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  try{
    const target=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const tab=(method,params)=>call(method,params,sessionId);
    await tab('Page.enable');await tab('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600,screenWidth:width,screenHeight:height});
    await tab('Page.navigate',{url:pathToFileURL(file).href});
    const expression=instrumented?'document.documentElement.dataset.browserComplete !== undefined':'document.readyState === "complete" && document.getElementById("clock")?.textContent === "FINAL"';
    let ready=false;for(let i=0;i<150;i++){
      const result=await tab('Runtime.evaluate',{expression,returnByValue:true});if(result.result?.value===true){ready=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(!ready)throw Error('Browser page did not finish: '+stderr);
    const values=await tab('Runtime.evaluate',{expression:'JSON.stringify({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,html:document.documentElement.outerHTML})',returnByValue:true});
    const result=JSON.parse(values.result.value);
    if(screenshot){const capture=await tab('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(screenshot,Buffer.from(capture.data,'base64'));}
    return {...result,stderr};
  }finally{
    await call('Browser.close').catch(()=>{});
    if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
}
function fixture(t,{variant=false,outcome='PASS',missing=false,wire=false,partial=false,hostile='',root:providedRoot=null}={}){
  const root=providedRoot??temp(t),arm=variant?'bantam-local-tiel35ba3b-iq4-xs-72k-mtp1-confirmation1':'hermes';
  const dir=path.join(root,'repeat-1/receipt-reducer',arm);
  const r={card:'receipt-reducer',arm,repeat:1,outcome,pass:outcome==='PASS',candidatePass:true,processCompleted:outcome==='PASS',
    startedAt:start,wallMs:10000,publicExit:0,hiddenExit:0,grade:{pass:true,groups:[{name:hostile||'independent group',pass:true}]},tampered:[],
    usage:{source:'local-wire-receipts',requests:partial?2:1,measuredRequests:1,complete:!partial,inputTokens:partial?null:100,
      outputTokens:partial?null:20,cacheHitTokens:partial?null:70,freshInputTokens:partial?null:30},
    nativeUsage:{inputTokens:80,outputTokens:10,cacheHitTokens:60},serverUsage:{inputTokens:110,outputTokens:20,cacheHitTokens:75,freshInputTokens:35,idleBefore:true,idleAfter:false},
    materialSeal:{},finalFiles:{}};
  const plan=[{card:r.card,arm,repeat:1}],m={schema:variant?'bantam.factory-local-variant.v1':'bantam.factory-fights.v1',
    startedAt:start,finishedAt:'2026-09-06T12:00:10.000Z',complete:!missing,variantId:'tiel35ba3b-iq4-xs-72k-mtp1-confirmation1',arm,
    modelId:'/private/model/Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS.gguf',configuration:{secret:hostile||'/private/config'},sourceSeal:{},kitSeal:{},plan,results:missing?[]:[r]};
  write(root,'manifest.json',m);
  if(!missing){write(dir,'result.json',r);write(dir,'task.md',hostile||'Public test fixture task');
    write(dir,'run.json',{turns:[{i:0,parsedAction:{a:'read_file',p:'api.js'},observation:hostile||'actual observed source'}]});
    write(dir,'ws/api.js',hostile||'export const value=1;');
    write(root,'repeat-1/receipt-reducer/events.ndjson',JSON.stringify({arm,t:500,text:hostile||'real controller event'})+'\n');}
  if(wire){const rows=[];
    const add=(index,body,response,finished=true)=>{
      const stem=String(index).padStart(5,'0'),request={index,phase:'request',generation:true,route:'/completion',method:'POST',
        startedAt:'2026-09-06T12:00:01.000Z',requestBytes:Buffer.byteLength(body),requestSha256:sha(body)};
      const reply={...request,phase:'response',wallMs:2000,status:200,contentType:'application/json',finished,error:finished?null:'client disconnected',
        responseBytes:Buffer.byteLength(response),responseSha256:sha(response),usage:finished?{inputTokens:100,outputTokens:20,cacheHitTokens:70,freshInputTokens:30}:null};
      rows.push(request,reply);write(dir,`wire/${stem}.request.body`,body);write(dir,`wire/${stem}.response.body`,response);
    };
    add(1,JSON.stringify({prompt:hostile||'exact context',n_predict:8192}),JSON.stringify({content:'reply',tokens_evaluated:100,tokens_predicted:20,timings:{cache_n:70}}));
    if(partial)add(2,'{"prompt":"unfinished extra work"}','',false);
    write(dir,'wire/exchanges.jsonl',rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  }
  return {root,dir,m,r};
}

test('separate local variant editions retain true identity and acceptance/completion distinction',t=>{
  const a=fixture(t),b=fixture(t,{variant:true,outcome:'OUTPUT_ONLY'}),before=fs.readFileSync(path.join(b.root,'manifest.json'));
  const {data,payloads}=buildShowcase({roots:[a.root,b.root]});
  assert.equal(data.series.length,2);assert.equal(data.series[0].kind,'comparison');assert.equal(data.series[1].kind,'variant');
  const s=data.series[1],r=s.cards[0].rows[0];assert.equal(r.label,'BANTAM · Tiel');assert.equal(r.arm,b.r.arm);
  assert.equal(r.outcome,'OUTPUT_ONLY');assert.equal(s.counts.pass,0);assert.equal(s.counts.accepted,1);assert.equal(s.counts.completed,0);
  assert.equal(payloads.length,2);assert.notEqual(payloads[0].id,payloads[1].id);
  assert.ok(before.equals(fs.readFileSync(path.join(b.root,'manifest.json'))),'input evidence remains immutable');
  assert.ok(before.equals(Buffer.from(s.provenance.manifestBytes.content,'base64')),'manifest download preserves original formatting and bytes');
});

test('film never reveals acceptance or completion before the recorded lane endpoint',()=>{
  const row={wallMs:10000,accepted:true,completed:true};
  assert.deepEqual(showcaseAcceptanceAt(row,{t:0}),{ended:false,accepted:null,completed:null});
  assert.deepEqual(showcaseAcceptanceAt(row,{t:9999}),{ended:false,accepted:null,completed:null});
  assert.deepEqual(showcaseAcceptanceAt(row,{t:10000}),{ended:true,accepted:true,completed:true});
  assert.deepEqual(showcaseAcceptanceAt({...row,completed:false},{results:true}),{ended:true,accepted:true,completed:false});
  assert.equal(showcaseAcceptanceAt({...row,wallMs:null},{t:100000}).ended,false);
});

test('public allowlisted system enum retains genuine same-model comparisons only',t=>{
  const f=fixture(t),b={...f.r,arm:'bantam-local-27b',wallMs:10000},d={...f.r,arm:'deepseek-local-27b',wallMs:20000};
  f.m.results=[b,d];f.m.plan=[b,d].map(r=>({arm:r.arm,card:r.card,repeat:r.repeat}));write(f.root,'manifest.json',f.m);
  const {data}=buildShowcase({roots:[f.root],mode:'public'}),rows=data.series[0].cards[0].rows;
  assert.deepEqual(rows.map(r=>r.arm),['bantam-local-27b','deepseek-local-27b']);
  assert.deepEqual(sameModelObservation(rows),{ratio:2,savedWallMs:10000});
  assert.equal(sameModelObservation([{...rows[0],outcome:'OUTPUT_ONLY'},rows[1]]),null);
  assert.equal(sameModelObservation([rows[0],{...rows[1],arm:'codex-astra'}]),null);
});

test('saved wire subsets expose four counters and coverage without filling unknown full totals',t=>{
  const f=fixture(t,{wire:true,partial:true}),{data,payloads}=buildShowcase({roots:[f.root]}),r=data.series[0].cards[0].rows[0];
  assert.deepEqual(r.accounting.full,{inputTokens:null,outputTokens:null,cacheHitTokens:null,freshInputTokens:null});
  assert.deepEqual(r.accounting.subset,{inputTokens:100,outputTokens:20,cacheHitTokens:70,freshInputTokens:30});
  assert.deepEqual(r.accounting.coverage.cacheHitTokens,{measuredRequests:1,totalRequests:2,complete:false,missingRequestIndices:[2]});
  assert.equal(r.accounting.native.inputTokens,80);assert.equal(r.accounting.server.inputTokens,110);
  const p=JSON.parse(gunzipSync(Buffer.from(payloads[0].data,'base64')));
  assert.ok(p.artifacts.some(a=>a.path==='derived/saved-wire-usage.json'));
  assert.deepEqual(JSON.parse(p.artifacts.find(a=>a.path==='result.json').content),f.r,'original incomplete usage is not rewritten');
});

test('replay clocks come from actual evidence and untimed turns stay untimed',t=>{
  const f=fixture(t,{wire:true,variant:true}),{data}=buildShowcase({roots:[f.root]}),r=data.series[0].cards[0].rows[0];
  assert.deepEqual(r.events.map(e=>e.t),[500,1000,3000,null]);
  assert.deepEqual(r.tokenUpdates.map(u=>[u.t,u.inputTokens,u.outputTokens,u.cacheHitTokens,u.freshInputTokens]),[[3000,100,20,70,30]]);
  assert.equal(r.untimedEvents,1);
});

test('missing final records stay partial and never acquire invented metrics or outcomes',t=>{
  const f=fixture(t,{variant:true,missing:true}),{data}=buildShowcase({roots:[f.root]}),s=data.series[0],r=s.cards[0].rows[0];
  assert.equal(s.complete,false);assert.equal(s.counts.observed,0);assert.equal(s.counts.planned,1);
  assert.equal(r.outcome,'NOT RECORDED');assert.equal(r.wallMs,null);assert.equal(r.accepted,null);assert.equal(r.completed,null);
  assert.deepEqual(r.tokenUpdates,[]);assert.deepEqual(r.accounting.full,{inputTokens:null,outputTokens:null,cacheHitTokens:null,freshInputTokens:null});
});

test('public builder emits no private metadata, evidence payload, paths or free-text group names',t=>{
  const secret='__PRIVATE_SENTINEL__</script><img src=x onerror=alert(1)>',f=fixture(t,{variant:true,wire:true,partial:true,hostile:secret});
  const built=buildShowcase({roots:[f.root],mode:'public'}),serialized=JSON.stringify(built),html=renderShowcase(built);
  assert.equal(built.payloads.length,0);assert.equal(built.data.mode,'public');assert.equal(built.data.privacy.rawEvidenceIncluded,false);
  for(const forbidden of ['__PRIVATE_SENTINEL__','/private/model','/private/config',f.root,'exact context','"provenance"','"manifest"','"artifacts"']){
    assert.ok(!serialized.includes(forbidden),forbidden);assert.ok(!html.includes(forbidden),forbidden);
  }
  assert.ok(!html.includes('type="application/octet-stream"'));
  const r=built.data.series[0].cards[0].rows[0];assert.equal(r.model,'Tiel 35B-A3B · IQ4_XS');assert.equal(r.accounting.subset.cacheHitTokens,70);
});

test('exported public boundary independently strips hostile nested properties and labels',t=>{
  const f=fixture(t,{variant:true}),{data}=buildShowcase({roots:[f.root]}),r=data.series[0].cards[0].rows[0];
  const secret='NEVER_PUBLIC';data.series[0].title=secret;r.label=secret;r.family=secret;r.accounting.injected=secret;
  r.accounting.full.injected=secret;r.accounting.coverage.inputTokens.path=secret;r.accounting.gaps=[{index:1,reason:secret,missingFields:['inputTokens',secret],responseBytes:0}];
  r.tokenUpdates=[{t:10,inputTokens:12,outputTokens:1,cacheHitTokens:5,path:secret,prompt:secret}];
  const p=publicShowcaseData(data);assert.ok(!JSON.stringify(p).includes(secret));assert.equal(p.series[0].cards[0].rows[0].label,'BANTAM · Tiel');
  assert.deepEqual(p.series[0].cards[0].rows[0].tokenUpdates,[{t:10,inputTokens:12,outputTokens:1,cacheHitTokens:5,freshInputTokens:7,partial:false}]);
});

test('hostile private source stays data, inline scripts compile, and no remote resources are required',t=>{
  const f=fixture(t,{hostile:'</script><img src="https://evil.invalid/x" onerror="alert(1)">'}),built=buildShowcase({roots:[f.root]}),html=renderShowcase(built);
  assert.ok(!html.includes('<img src="https://evil.invalid'));
  assert.ok(!/(?:src|href)="https?:/i.test(html));assert.ok(!html.includes('.innerHTML'));
  const blocks=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)],last=blocks.at(-1)[1];
  assert.doesNotThrow(()=>new vm.Script(last));
  const json=JSON.parse(html.match(/<script id="showcase-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(json.series[0].cards[0].rows[0].events[0].detail,'</script><img src="https://evil.invalid/x" onerror="alert(1)">');
});

test('fresh output has matching package hashes and refuses existing destinations without source changes',t=>{
  const f=fixture(t),parent=temp(t),output=path.join(parent,'showcase'),manifest=fs.readFileSync(path.join(f.root,'manifest.json'));
  const result=writeShowcase({roots:[f.root],output,mode:'public'});assert.equal(result.output,path.join(output,'index.html'));
  const p=JSON.parse(fs.readFileSync(path.join(output,'package.json')));assert.equal(p.private,false);assert.equal(p.redacted,true);
  for(const file of p.files){const raw=fs.readFileSync(path.join(output,file.path));assert.equal(raw.length,file.bytes);assert.equal(sha(raw),file.sha256);}
  assert.ok(manifest.equals(fs.readFileSync(path.join(f.root,'manifest.json'))));assert.throws(()=>writeShowcase({roots:[f.root],output}),/fresh absolute/);
});

test('duplicate records, unsupported schemas and identities fail closed',t=>{
  const f=fixture(t,{variant:true});assert.throws(()=>buildShowcase({roots:[f.root,f.root]}),/duplicate series/);
  f.m.results.push(f.r);write(f.root,'manifest.json',f.m);assert.throws(()=>buildShowcase({roots:[f.root]}),/duplicate result/);
  f.m.results=[f.r];f.m.arm='bantam-local-other';write(f.root,'manifest.json',f.m);assert.throws(()=>buildShowcase({roots:[f.root]}),/unbound model/);
  f.m.schema='invented';write(f.root,'manifest.json',f.m);assert.throws(()=>buildShowcase({roots:[f.root]}),/unsupported/);
});

test('offline Chromium verifies desktop/mobile films, private evidence and the public boundary',{
  skip:process.env.BANTAM_SHOWCASE_BROWSER_TEST!=='1',timeout:120000,
},async t=>{
  // Snap Chromium cannot see the host /tmp namespace. All browser fixtures are
  // generated test data in a unique home directory, never real contender code.
  const root=fs.mkdtempSync(path.join(os.homedir(),'factory-showcase-browser-test-'));
  t.after(()=>{if(process.env.BANTAM_SHOWCASE_KEEP_BROWSER_FIXTURE==='1')process.stdout.write(`showcase browser fixture: ${root}\n`);
    else fs.rmSync(root,{recursive:true,force:true});});
  const privateFixture=fixture(t,{root:path.join(root,'private-input'),variant:true,wire:true,
    hostile:'exact context </script><script>document.documentElement.id="pwned"</script>'});
  const publicFixture=fixture(t,{root:path.join(root,'public-input'),wire:true,partial:true,hostile:'PRIVATE_SENTINEL_DO_NOT_PUBLISH'});
  const b={...publicFixture.r,arm:'bantam-local-27b',wallMs:10000},d={...publicFixture.r,arm:'deepseek-local-27b',wallMs:20000};
  publicFixture.m.results.push(b,d);publicFixture.m.plan.push(...[b,d].map(r=>({arm:r.arm,card:r.card,repeat:r.repeat})));
  write(publicFixture.root,'manifest.json',publicFixture.m);
  const files={private:writeShowcase({roots:[privateFixture.root],output:path.join(root,'private-page'),mode:'private'}).output,
    public:writeShowcase({roots:[publicFixture.root],output:path.join(root,'public-page'),mode:'public'}).output};
  for(const [mode,file]of Object.entries(files)){
    const instrument=`<script>setTimeout(async()=>{try{
      const ds=document.documentElement.dataset,data=JSON.parse(document.getElementById('showcase-data').textContent);
      const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('fixture wait expired');};
      const findButton=(selector,label)=>Array.from(document.querySelectorAll(selector)).find(b=>b.textContent.includes(label));
      const downloads=[],originalURL=URL.createObjectURL;URL.createObjectURL=blob=>{downloads.push(blob);return originalURL(blob);};
      HTMLAnchorElement.prototype.click=function(){};
      ds.layoutOverflow=String(document.documentElement.scrollWidth>innerWidth);
      ds.resultsDefault=String(document.getElementById('clock').textContent==='FINAL');
      document.getElementById('download-summary').click();
      ds.downloadExact=String(await downloads.at(-1).text()===JSON.stringify(data,null,2)+'\\n');
      document.getElementById('replay-view').click();
      ds.pendingAtZero=String(Array.from(document.querySelectorAll('.acceptance')).every(n=>n.textContent.includes('PROJECT PENDING')&&n.textContent.includes('FINISH PENDING')));
      ds.unknownAtZero=String(document.querySelector('.metric strong').textContent==='unknown');
      document.getElementById('seek').value='3000';document.getElementById('seek').dispatchEvent(new Event('input'));
      ds.clockReceipt=String(document.querySelector('.metric strong').textContent==='100');
      ds.pendingBeforeEnd=String(document.querySelector('.acceptance').textContent.includes('PROJECT PENDING'));
      document.getElementById('finish').click();
      ds.finalAcceptance=String(document.querySelector('.acceptance').textContent.includes('PROJECT ACCEPTED'));
      if(${JSON.stringify(mode)}==='private'){
        findButton('.lane-actions button','Inspect').click();
        findButton('#inspector-tabs button','Evidence').click();
        await wait(()=>document.querySelector('#inspector-body select'));
        const select=document.querySelector('#inspector-body select');select.value='wire/00001.request.body';select.dispatchEvent(new Event('change'));
        await wait(()=>document.getElementById('inspector-body').textContent.includes('exact context'));
        ds.evidenceLoaded='true';ds.inspectorOverflow=String(document.documentElement.scrollWidth>innerWidth);
        findButton('#inspector-body button','Download exact bytes').click();
        const request=await downloads.at(-1).text();ds.artifactExact=String(JSON.parse(request).prompt.includes('exact context '+String.fromCharCode(60)+'/script>'));
        findButton('#inspector-tabs button','Candidate').click();await wait(()=>document.querySelector('#inspector-body pre'));
        ds.candidateLoaded=String(document.querySelector('#inspector-body pre').textContent.includes('exact context'));
        findButton('#inspector-tabs button','Judge').click();await wait(()=>document.querySelector('.judge-group'));
        ds.judgeLoaded=String(document.querySelector('.judge-group').textContent.includes('PASS'));
        document.getElementById('close-inspector').click();document.getElementById('method-button').click();
        findButton('#inspector-body button','Download exact manifest').click();
        const bytes=Uint8Array.from(atob(data.series[0].provenance.manifestBytes.content),c=>c.charCodeAt(0));
        ds.manifestExact=String(await downloads.at(-1).text()===new TextDecoder().decode(bytes));
      }else{
        ds.publicTakeaway=String(document.getElementById('takeaway').textContent.includes('2.00× sooner than DeepSeek Harness'));
        ds.publicNoPayload=String(!document.querySelector('script[type="application/octet-stream"]'));
        ds.publicNoPrivateLinks=String(Array.from(document.querySelectorAll('a')).every(a=>a.getAttribute('href')==='#'));
        findButton('.lane-actions button','Inspect').click();
        ds.publicScopes=String(document.getElementById('inspector-body').textContent.includes('Measured wire subset')&&document.getElementById('inspector-body').textContent.includes('Receipt coverage by field'));
        findButton('#inspector-tabs button','Evidence').click();
        ds.publicOmissions=String(document.getElementById('inspector-body').textContent.includes('deliberately excludes private'));
      }
      ds.noInjection=String(document.documentElement.id!=='pwned');ds.browserComplete='true';
    }catch(error){document.documentElement.dataset.browserError=error.stack;document.documentElement.dataset.browserComplete='false';}},50);</script>`;
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('</body>',instrument+'</body>'));
  }
  for(const [mode,file]of Object.entries(files))for(const viewport of ['1440,1000','390,900']){
    const profile=fs.mkdtempSync(path.join(os.tmpdir(),'factory-showcase-chrome-'));t.after(()=>fs.rmSync(profile,{recursive:true,force:true}));
    const [width,height]=viewport.split(',').map(Number),output=await chromiumPage({file,width,height,profile,screenshot:path.join(root,`${mode}-${width}.png`)});
    const message=`${mode} ${viewport}\n${output.html?.slice(0,2000)}\n${output.stderr}`;
    assert.equal(output.width,width,'CDP must enforce actual CSS viewport width, not only screenshot dimensions');
    assert.equal(output.height,height,'CDP must enforce actual CSS viewport height');
    for(const attr of ['results-default','download-exact','pending-at-zero','unknown-at-zero','clock-receipt','pending-before-end','final-acceptance','no-injection','browser-complete']){
      assert.ok(output.html.includes(`data-${attr}="true"`),`${attr}: ${message}`);
    }
    assert.ok(output.html.includes('data-layout-overflow="false"'),message);
    if(mode==='private'){
      for(const attr of ['evidence-loaded','artifact-exact','candidate-loaded','judge-loaded','manifest-exact'])assert.ok(output.html.includes(`data-${attr}="true"`),`${attr}: ${message}`);
      assert.ok(output.html.includes('data-inspector-overflow="false"'),message);
    }else for(const attr of ['public-takeaway','public-no-payload','public-no-private-links','public-scopes','public-omissions'])assert.ok(output.html.includes(`data-${attr}="true"`),`${attr}: ${message}`);
  }
});
