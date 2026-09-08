import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {projectFightProgress,publicFightProgress,progressKey} from '../src/factory-card-progress.js';
import {startLiveFight,renderLiveFight} from '../src/factory-card-live.js';
import {factoryCardsCommand,makeCardsPlan} from '../src/factory-cards-command.js';

const item={card:'context-packet',arm:'bantam-local-27b',repeat:1};
const manifest=()=>({plan:[item],results:[],configuration:{},modelId:'PRIVATE_SENTINEL',endpoint:'PRIVATE_SENTINEL'});
test('all explicitly selects the complete frozen build/extend/repair kit',()=>{
 const plan=makeCardsPlan({card:'all',arms:'bantam-local-27b,hermes,codex-astra',out:'/tmp/bantam-all-plan-not-created'},{connection:null});
 assert.deepEqual(plan.cards,['context-packet','patch-transaction','stream-framer']);
 assert.deepEqual(plan.arms,['bantam-local-27b','hermes','codex-astra']);
});
test('live projection distinguishes work, grading, incomplete receipts and accepted completion',()=>{
 const m=manifest(),active=new Map([[progressKey(item),{phase:'running',startedAt:100,exchanges:[{generation:true,index:1,status:200,finished:true,usage:{inputTokens:100,outputTokens:10,cacheHitTokens:80,freshInputTokens:20}},{generation:true,index:2}]}]]);
 let data=projectFightProgress(m,active,300),row=data.lanes[0];
 assert.equal(row.phase,'running');assert.equal(row.candidatePass,null);assert.equal(row.elapsedMs,200);
 assert.equal(row.tokens.inputTokens,null);assert.equal(row.measuredSubset.inputTokens,100);assert.equal(row.accountingScope,'so-far');
 active.get(progressKey(item)).phase='grading';active.get(progressKey(item)).workElapsedMs=150;
 assert.equal(projectFightProgress(m,active,1000).lanes[0].elapsedMs,150);
 m.results.push({...item,outcome:'OUTPUT_ONLY',candidatePass:true,processCompleted:false,wallMs:150,grade:{groups:[{pass:true}]}});
 row=projectFightProgress(m,active,2000).lanes[0];assert.equal(row.outcome,'OUTPUT_ONLY');assert.equal(row.processCompleted,false);assert.equal(row.groupsPassed,1);
 assert.ok(!JSON.stringify(data).includes('PRIVATE_SENTINEL'));
 m.results=[];m.finishedAt='ended';assert.equal(projectFightProgress(m,active).lanes[0].phase,'unrecorded');
});
test('public progress and HTML strip arbitrary labels, errors, source and nested payloads',()=>{
 const data=projectFightProgress(manifest()),secret='PRIVATE_SENTINEL</script><img src=https://secret.invalid>';
 data.secret=secret;data.lanes[0].label=secret;data.lanes[0].tokens.secret=secret;data.lanes[0].outcome=secret;
 assert.ok(!JSON.stringify(publicFightProgress(data)).includes('PRIVATE_SENTINEL'));
 const html=renderLiveFight(data);assert.ok(!html.includes('PRIVATE_SENTINEL'));assert.match(html,/Watch the work/);
 assert.throws(()=>publicFightProgress({...data,lanes:[{id:'1/../../private'}]}),/Invalid progress lane/);
});
test('live server is token protected, read-only, same-origin, streams public snapshots and closes',async t=>{
 const viewer=await startLiveFight();t.after(()=>viewer.close());
 const url=new URL(viewer.url);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/[a-f0-9]{48}\/$/);
 assert.equal((await fetch(url.origin+'/')).status,404);
 assert.equal((await fetch(viewer.url,{method:'POST'})).status,405);
 assert.equal((await fetch(viewer.url,{headers:{Origin:'https://evil.invalid'}})).status,403);
 const wrongHost=await new Promise((resolve,reject)=>{http.get(viewer.url,{headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
 assert.equal(wrongHost,403);
 const page=await fetch(viewer.url);assert.equal(page.headers.get('cache-control'),'no-store');assert.match(await page.text(),/Waiting for recorded execution/);
 const controller=new AbortController(),response=await fetch(viewer.url+'events',{signal:controller.signal}),reader=response.body.getReader();
 assert.match(new TextDecoder().decode((await reader.read()).value),/fight-progress/);
 const data=projectFightProgress({...manifest(),finishedAt:'done',complete:false});data.secret='PRIVATE_SENTINEL';viewer.publish(data);
 const event=new TextDecoder().decode((await reader.read()).value);assert.match(event,/"finished":true/);assert.ok(!event.includes('PRIVATE_SENTINEL'));
 controller.abort();await reader.cancel().catch(()=>{});
});
test('live front door starts only after consent, saves public final page, and always closes',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-live-command-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const output=path.join(root,'run'),calls=[];let state=projectFightProgress(manifest());
 const deps={out:()=>{},registry:()=>({tools:{}}),discover:()=>[],preflight:()=>{},
  startLive:async()=>{calls.push('start');return {url:'http://127.0.0.1/token/',publish:s=>state=s,snapshot:()=>state,close:async()=>calls.push('close')};},
  run:async(plan,{onProgress})=>{calls.push('run');fs.mkdirSync(plan.output);onProgress(projectFightProgress({...manifest(),finishedAt:'done',complete:true}));return {complete:true,results:[{pass:true}]};}};
 const args={card:'context-packet',arms:'bantam-local-27b',out:output,live:true};
 await factoryCardsCommand({...args,'dry-run':true},deps);assert.deepEqual(calls,[]);
 assert.equal(await factoryCardsCommand({...args,yes:true},deps),0);assert.deepEqual(calls,['start','run','close']);
 const html=fs.readFileSync(path.join(output,'live-public.html'),'utf8');assert.match(html,/"finished":true/);assert.ok(!html.includes('PRIVATE_SENTINEL'));
});
