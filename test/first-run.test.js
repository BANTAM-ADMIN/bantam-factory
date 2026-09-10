import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {chooseFirstRun,normalizeServerUrl,discoverModelServers,saveConnection,loadConnection,clearConnection,codexAvailable,confirmCodexConsent} from '../src/first-run.js';
import {setupWizard} from '../src/setup-wizard.js';
import {stockPlan,stockServerArgs,STOCK_PROFILES,STOCK_REVISION,installStockFiles,registerStockProfiles} from '../src/stock-model.js';
import {TIEL_REVISION,stockRuntimeFlags} from '../src/stock-model.js';
import {checkStockReadiness} from '../src/stock-readiness.js';
const home=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-setup-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
test('first screen prioritizes existing models; cancel never installs or probes',async()=>{
 let output='',calls=0;const result=await chooseFirstRun({ask:async()=>'',out:s=>output+=s,hasCodex:false,discover:async()=>{calls++;return [];}});
 assert.equal(result,null);assert.equal(calls,0);assert.match(output,/\[1\] Use an existing/);assert.match(output,/Codex CLI not detected/);
 assert.match(output,/\[3\] Easy mode/);
});
test('discovery is bounded to loopback model metadata, tolerates unrelated services',async()=>{
 const urls=[];const found=await discoverModelServers({ports:[8080,8000,1234],fetchImpl:async(url,options)=>{
  urls.push(url);assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);
  if(url.includes(':8000'))throw Error('offline');
  return {ok:true,json:async()=>url.includes(':8080')?{data:[{id:'my-model'}]}:{hello:'not an inference server'}};
 }});
 assert.deepEqual(found,[{apiUrl:'http://127.0.0.1:8080/v1',models:['my-model']}]);
 assert.ok(urls.every(u=>/^http:\/\/127\.0\.0\.1:\d+\/v1\/models$/.test(u)));
});
test('manual URL normalization preserves reverse proxy paths and rejects embedded secrets',()=>{
 assert.equal(normalizeServerUrl('192.168.1.2:8080'),'http://192.168.1.2:8080/v1');
 assert.equal(normalizeServerUrl('https://example.test/llm/v1/'),'https://example.test/llm/v1');
 for(const u of ['', 'file:///tmp/test','http://user:secret@host','http://host?key=secret'])assert.throws(()=>normalizeServerUrl(u));
});
test('manual or discovered model choice uses the exact selected endpoint',async()=>{
 for(const [answer,expected]of [['1','http://127.0.0.1:1234/v1'],['10.0.0.8:8000','http://10.0.0.8:8000/v1']]){
  const answers=['1',answer];const r=await chooseFirstRun({ask:async()=>answers.shift(),out:()=>{},hasCodex:true,discover:async()=>[{apiUrl:'http://127.0.0.1:1234/v1',models:['x']}]});assert.equal(r.apiUrl,expected);
 }
});
test('Codex availability checks only the installed executable, not authentication files',()=>{
 assert.equal(codexAvailable({run:(cmd,args)=>{assert.equal(cmd,'test-codex');assert.deepEqual(args,['--version']);},command:'test-codex'}),true);
 assert.equal(codexAvailable({run:()=>{throw Error('absent');}}),false);
});
test('stock plans pin both artifacts and expose exact context/projector profiles',t=>{
 for(const profile of Object.keys(STOCK_PROFILES)){
  const p=stockPlan({home:home(t),profile}),args=stockServerArgs(p);
  assert.ok(p.files.every(f=>f.url.includes(STOCK_REVISION)&&f.sha256.length===64));
  assert.equal(args[args.indexOf('--ctx-size')+1],profile.startsWith('92k')?'92000':'72000');
  assert.equal(args.includes('--no-mmproj-offload'),!profile.includes('gpu-vision'));
  assert.equal(args[args.indexOf('--host')+1],'127.0.0.1');
  assert.ok(args.includes('draft-mtp'));assert.equal(args.includes('-md'),false,'MTP is embedded, not a mismatched sidecar');
 }
 assert.throws(()=>stockPlan({profile:'92k-gpu-vision'}));
});
test('download consent, integrity and existing-file protection use actual tiny files',async t=>{
 const root=home(t),dest=path.join(root,'model.gguf'),bytes=Buffer.from('verified model');
 const plan={root,files:[{dest,url:'https://example.test/pinned',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]};
 let downloads=0;const download=async({dest})=>{downloads++;fs.writeFileSync(dest,bytes);};
 await assert.rejects(installStockFiles(plan,{download}),/consent/);assert.equal(downloads,0);
 await installStockFiles(plan,{consent:true,download});assert.equal(downloads,1);assert.deepEqual(fs.readFileSync(dest),bytes);
 await installStockFiles(plan,{consent:true,download});assert.equal(downloads,1);
 fs.writeFileSync(dest,'broken');await assert.rejects(installStockFiles(plan,{consent:true,download}),/not overwriting/);assert.equal(fs.readFileSync(dest,'utf8'),'broken');
});
test('corrupt download is retained but never promoted',async t=>{
 const root=home(t),dest=path.join(root,'m.gguf'),plan={root,files:[{dest,url:'https://example.test/m',bytes:1,sha256:'a'.repeat(64)}]};
 await assert.rejects(installStockFiles(plan,{consent:true,download:async({dest})=>fs.writeFileSync(dest,'x')}),/SHA-256/);
 assert.equal(fs.existsSync(dest),false);assert.equal(fs.existsSync(dest+'.download'),true);
});
test('managed registration is global, safely quoted and refuses changed configs',t=>{
 const h=home(t),server="/tmp/runtime with ' quote/llama-server";
 const entries=registerStockProfiles({home:h,server});assert.equal(entries.length,3);
 assert.equal(registerStockProfiles({home:h,server}).length,3);
 assert.ok(entries.every(e=>e.script.startsWith(h)&&e.vision&&e.slots===1));
 for(const entry of entries)assert.equal(spawnSync('bash',['-n',entry.script]).status,0);
 assert.throws(()=>registerStockProfiles({home:h,server:'/different/runtime'}),/refusing overwrite/);
});
test('runtime incompatibility prevents stock artifact downloads',async t=>{
 let downloads=0;
 await assert.rejects(setupWizard({home:home(t),profile:'72k-cpu-vision',yes:true,out:()=>{},
  platform:'linux',gpuMemory:()=>24564,findLlama:()=>'/runtime',
  checkRuntime:()=>{throw Error('unsupported runtime');},install:async()=>{downloads++;}}),/unsupported runtime/);
 assert.equal(downloads,0);
});
test('stock wizard refuses silent installs, unsupported hardware and invalid profiles',async t=>{
 let installed=0;const args={home:home(t),ask:async()=>'',out:()=>{},hidden:async()=>'',choose:async()=>({kind:'install-stock'}),platform:'linux',gpuMemory:()=>24564,findLlama:()=>'/usr/bin/llama-server',install:async()=>{installed++;}};
 assert.equal(await setupWizard(args),null);assert.equal(installed,0);
 await assert.rejects(setupWizard({...args,profile:'oops',yes:true}),/Unknown/);
 await assert.rejects(setupWizard({...args,gpuMemory:()=>8192}),/24GB/);
 await assert.rejects(setupWizard({...args,platform:'win32'}),/existing server or Codex/);
});
test('API compatibility needs consent and successful evidence before saving',async t=>{
 const h=home(t);let inference=0;
 const args={home:h,out:()=>{},hidden:async()=>'',choose:async()=>({kind:'connect-api',apiUrl:'http://127.0.0.1:1234/v1'}),
  fetchImpl:async()=>({ok:true,json:async()=>({data:[{id:'exact-model'}]})}),
  Client:class{constructor(c){assert.equal(c.model,'exact-model');}async complete(){inference++;return {content:'OKBANTAM'};}}};
 let answers=['1',''];assert.equal(await setupWizard({...args,ask:async()=>answers.shift()}),null);assert.equal(inference,0);assert.equal(loadConnection(h),null);
 answers=['1','yes'];const r=await setupWizard({...args,ask:async()=>answers.shift()});assert.equal(r.kind,'api');assert.equal(inference,1);assert.equal(loadConnection(h).model,'exact-model');
 assert.equal(fs.statSync(path.join(h,'.bantam','connection.json')).mode&511,0o600);
 const h2=home(t);answers=['1','yes'];await assert.rejects(setupWizard({...args,home:h2,ask:async()=>answers.shift(),Client:class{async complete(){return {content:'not constrained'};}}}),/Compatibility/);assert.equal(loadConnection(h2),null);
});
test('saved user choice is readable from any workspace and local selection clears cloud preference',t=>{
 const h=home(t);saveConnection({kind:'codex',model:'gpt-6-astra',effort:'high'},h);assert.equal(loadConnection(h),null,'unconsented cloud config must not auto-enable');
 saveConnection({kind:'codex',model:'gpt-6-astra',effort:'high',consent:'cloud-context-v1'},h);assert.equal(loadConnection(h).model,'gpt-6-astra');
 saveConnection({kind:'local',name:'davidau-72k-cpu-vision'},h);assert.equal(loadConnection(h).kind,'local');
});
test('clearConnection forgets a sticky Codex pin so auto-detection can run again',t=>{
 // The regression: once Codex was remembered, bare `bantam` stayed cloud-only
 // with no non-interactive exit, and detectEndpoint() was never reached.
 const h=home(t);
 saveConnection({kind:'codex',model:'gpt-6-astra',effort:'medium',consent:'cloud-context-v1'},h);
 assert.equal(loadConnection(h).kind,'codex');
 assert.equal(clearConnection(h),path.join(h,'.bantam','connection.json'));
 assert.equal(loadConnection(h),null,'forgetting the pin restores auto-detection');
 assert.equal(fs.existsSync(path.join(h,'.bantam','connection.json')),false);
 clearConnection(h); // absent file is a no-op, not an error
 assert.equal(loadConnection(h),null);
});
test('Codex consent describes context and quota; Enter and refusal never authorize',async()=>{
 for(const answer of ['', 'no','yes']){
  let output='';const accepted=await confirmCodexConsent({ask:async()=>answer,out:s=>output+=s,model:'gpt-6-astra'});
  assert.equal(accepted,answer==='yes');assert.match(output,/project context/);assert.match(output,/OpenAI/);assert.match(output,/quota/);assert.match(output,/API billing/);
 }
});
test('connection wizard uses real HTTP transport and persists only after constrained response',async t=>{
 const requests=[];const server=http.createServer(async(req,res)=>{
  let body='';for await(const b of req)body+=b;requests.push({url:req.url,body:body?JSON.parse(body):null});
  res.setHeader('content-type','application/json');
  if(req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'bring-your-own'}]}));
  else if(req.url==='/v1/completions')res.end(JSON.stringify({choices:[{text:'OKBANTAM',finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}));
  else{res.statusCode=404;res.end('{}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const h=home(t),apiUrl=`http://127.0.0.1:${server.address().port}/v1`,answers=['1','yes'];
 const result=await setupWizard({home:h,out:()=>{},hidden:async()=>'',ask:async()=>answers.shift(),choose:async()=>({kind:'connect-api',apiUrl})});
 assert.equal(result.kind,'api');assert.equal(loadConnection(h).apiUrl,apiUrl);
 const inference=requests.find(r=>r.url==='/v1/completions');assert.ok(inference);assert.equal(inference.body.model,'bring-your-own');
 assert.ok(JSON.stringify(inference.body).includes('OKBANTAM'));assert.ok(requests.every(r=>r.url.startsWith('/v1/')));
});
test('Tiel is explicit, pinned, text-only and offloads main and draft experts',async t=>{
 const choice=await chooseFirstRun({ask:async()=>'5',out:()=>{},hasCodex:false,discover:async()=>{throw Error('unexpected discovery');}});
 assert.deepEqual(choice,{kind:'install-stock',profile:'tiel-32k-cpu-experts'});
 const h=home(t),plan=stockPlan({home:h,profile:choice.profile}),args=stockServerArgs(plan);
 assert.equal(plan.files.length,1);assert.equal(plan.bytes,18629540384);
 assert.ok(plan.files[0].url.includes(TIEL_REVISION));assert.equal(plan.files[0].sha256.length,64);
 assert.ok(args.includes('--cpu-moe'));assert.ok(args.includes('--spec-draft-cpu-moe'));
 assert.equal(args.includes('--mmproj'),false);assert.equal(args[args.indexOf('--ctx-size')+1],'32768');
 assert.ok(stockRuntimeFlags(plan).includes('--cpu-moe'));
 registerStockProfiles({home:h,server:'/runtime'});
 const entries=registerStockProfiles({home:h,server:'/runtime',family:'tiel'});
 assert.equal(entries.length,4);const tiel=entries.find(e=>e.name===choice.profile);
 assert.equal(tiel.vision,false);assert.equal(tiel.priority,10);
 assert.equal(spawnSync('bash',['-n',tiel.script]).status,0);
 assert.equal(registerStockProfiles({home:h,server:'/runtime',family:'tiel'}).length,4);
});
test('experimental Tiel checks GPU/RAM, requires consent, and does not install DavidAU profiles',async t=>{
 let installs=0,output='';const h=home(t);
 const options={home:h,profile:'tiel-32k-cpu-experts',platform:'linux',gpuMemory:()=>8192,systemMemory:()=>32*1024**3,
  ask:async()=>'',out:s=>output+=s,findLlama:()=>'/runtime',checkRuntime:(_server,plan)=>assert.ok(stockRuntimeFlags(plan).includes('--spec-draft-cpu-moe')),
  install:async plan=>{installs++;assert.equal(plan.files.length,1);}};
 assert.equal(await setupWizard(options),null);assert.equal(installs,0);
 assert.match(output,/NOT been benchmarked/);assert.match(output,/larger than DavidAU/);
 await assert.rejects(setupWizard({...options,yes:true,gpuMemory:()=>4096}),/8GB/);
 await assert.rejects(setupWizard({...options,yes:true,systemMemory:()=>16*1024**3}),/32GB/);
 assert.equal(installs,0);
 const result=await setupWizard({...options,yes:true});assert.equal(installs,1);
 assert.equal(result.name,'tiel-32k-cpu-experts');assert.equal(result.model.vision,false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(h,'.bantam','managed-models.json'))).length,1);
 assert.equal(loadConnection(h),null,'download/registration is not proof of a working server');
});
test('stock readiness requires inference, records measured timing, never claims qualification',async()=>{
 const fetchImpl=async(url,options)=>{
  assert.equal(url,'http://127.0.0.1:8085/completion');assert.equal(options.redirect,'error');
  const body=JSON.parse(options.body);assert.equal(body.grammar,'root ::= "OKBANTAM"');
  assert.equal(body.n_predict,32);
  return {ok:true,json:async()=>({content:'OKBANTAM',timings:{prompt_n:7,predicted_n:4}})};
 };
 const result=await checkStockReadiness({fetchImpl});assert.equal(result.passed,true);
 assert.equal(result.timings.prompt_n,7);assert.equal(result.fullContextQualified,false);assert.equal(result.taskQualityQualified,false);
 await assert.rejects(checkStockReadiness({fetchImpl:async()=>({ok:false,status:503})}),/HTTP 503/);
 await assert.rejects(checkStockReadiness({fetchImpl:async()=>({ok:true,json:async()=>({content:'wrong'})})}),/did not match/);
 await assert.rejects(checkStockReadiness({fetchImpl:async()=>{throw Error('timeout');}}),/timeout/);
});
