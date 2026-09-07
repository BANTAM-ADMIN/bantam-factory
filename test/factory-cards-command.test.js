import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {factoryCardsCommand,makeCardsPlan,normalizeCardEndpoint,discoverCardParticipants,preflightCards,findCardImage} from '../src/factory-cards-command.js';
import {runFactoryFights} from '../scripts/factory-fights.mjs';
import {writeFactoryReplay} from '../scripts/factory-fight-replay.mjs';
import {writeFightCardExport} from '../scripts/factory-fight-export.mjs';
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-cards-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};

test('card discovery checks executables, never invokes Claude or installs rivals',()=>{
 const calls=[];const p=discoverCardParticipants({find:n=>{calls.push(n);return n==='hermes'?'/tools/hermes':null;}});
 assert.equal(p.find(p=>p.id==='hermes').installed,true);assert.equal(p.find(p=>p.id==='opencode').installed,false);
 assert.equal(calls.includes('claude'),false);assert.equal(p.some(p=>p.id.includes('claude')),false);
});
test('explicit listing recognizes prepared DeepSeek image using metadata only; planning does not inspect Docker',async()=>{
 const digest='sha256:'+'a'.repeat(64),calls=[];
 const inspectImage=image=>findCardImage(image,{exec:(exe,args)=>{calls.push([exe,args]);return digest+'\n';}});
 const find=()=>null;
 assert.equal(discoverCardParticipants({find,inspectImage}).find(p=>p.id==='deepseek-local-27b').installed,false);
 assert.equal(calls.length,0);
 const peer=discoverCardParticipants({find,inspectImages:true,inspectImage}).find(p=>p.id==='deepseek-local-27b');
 assert.equal(peer.installed,true);assert.equal(peer.imageId,digest);
 assert.deepEqual(calls,[['docker',['image','inspect','--format','{{.Id}}','bantam/deepseek-fight:0.1.2-rc.1']]]);
 assert.equal(findCardImage('fixture',{exec:()=>{throw Error('Docker offline');}}),null);
 let output='',metadataCalls=[];
 assert.equal(await factoryCardsCommand({list:true},{registry:()=>({tools:{}}),discover:()=>[peer],
  findExecutable:name=>{metadataCalls.push(name);return '/tools/claude';},out:s=>output+=s,
  run:()=>{throw Error('must not invoke an agent');}}),0);
 assert.deepEqual(metadataCalls,['claude']);assert.match(output,/Claude Code: detected/);
 assert.match(output,/explicit direct agent comparison only/);
});
test('plans respect saved llama endpoint and never require one for cloud-only cards',t=>{
 const root=tmp(t),base={card:'context-packet',out:path.join(root,'run')};
 assert.equal(makeCardsPlan(base,{connection:{kind:'api',dialect:'llamacpp',apiUrl:'http://localhost:1234/v1'}}).endpoint,'http://localhost:1234');
 const cloud=makeCardsPlan({...base,arms:'codex-astra,bantam-codex-astra',endpoint:'not a URL'});
 assert.equal(cloud.endpoint,null);assert.equal(cloud.arms.length,2);
 for(const u of ['http://user:secret@localhost:1234','http://192.168.1.2:8085','http://localhost:8085/proxy','file:///tmp'])assert.throws(()=>normalizeCardEndpoint(u));
 assert.throws(()=>makeCardsPlan({...base,arms:'bantam-local-27b,bantam-local-27b'}),/duplicate/);
 assert.throws(()=>makeCardsPlan({...base,'timeout-seconds':0}),/timeout/);
 assert.throws(()=>makeCardsPlan({...base,out:root}),/never overwritten/);
});
test('list, help, dry run, and declined consent cannot launch or preflight execution',async t=>{
 const out=path.join(tmp(t),'run');let calls=0;
 const options={out:()=>{},interactive:false,discover:()=>[],preflight:()=>{calls++;},run:async()=>{calls++;},connection:null};
 for(const args of [{help:true},{list:true},{'dry-run':true,card:'context-packet',out}])assert.equal(await factoryCardsCommand(args,options),0);
 await assert.rejects(factoryCardsCommand({card:'context-packet',out},options),/Noninteractive/);
 await assert.rejects(factoryCardsCommand({yes:true,out},options),/explicit/);
 await assert.rejects(factoryCardsCommand({'allow-cluade':true},options),/Unknown/);
 assert.equal(await factoryCardsCommand({card:'context-packet',arms:'bantam-local-27b',endpoint:'http://localhost:8085',out},{...options,interactive:true,ask:async()=>''}),0);
 assert.equal(calls,0);assert.equal(fs.existsSync(out),false);
});
test('approved cards preflight before execution and render exact output; failures are nonzero',async t=>{
 const root=tmp(t);let ran=0,checks=0,rendered=0;
 const options={out:()=>{},interactive:false,discover:()=>[],preflight:()=>{checks++;},run:async p=>{
  assert.equal(checks,ran+1);ran++;fs.mkdirSync(p.output);fs.writeFileSync(path.join(p.output,'manifest.json'),'{}');return {complete:true,results:[{pass:false}]};
 },exportCard:()=>{},replay:p=>{rendered++;return {output:path.join(p,'fight-cards.html')};}};
 assert.equal(await factoryCardsCommand({card:'context-packet',arms:'bantam-local-27b',yes:true,out:path.join(root,'run')},options),1);
 assert.equal(ran,1);assert.equal(rendered,1);
 await assert.rejects(factoryCardsCommand({card:'context-packet',arms:'bantam-local-27b',yes:true,out:path.join(root,'second')},{...options,preflight:()=>{throw Error('no docker');}}),/no docker/);
 assert.equal(ran,1);
});
test('missing selected tools and images fail without pulling or running anything',()=>{
 const plan={arms:['hermes']};let calls=[];
 assert.throws(()=>preflightCards(plan,{participants:[],exec:()=>{calls.push('unexpected');}}),/not installed/);assert.equal(calls.length,0);
 assert.throws(()=>preflightCards(plan,{participants:[{id:'hermes',installed:true}],exec:(exe,args)=>{calls.push([exe,args]);if(args[0]==='image')throw Error('missing');}}),/image missing/);
 assert.ok(calls.every(([,args])=>args[0]==='info'||args[0]==='image'));
});
test('actual front door help and dry run need no local or cloud inference',()=>{
 for(const args of [['--help'],['--card','context-packet','--arms','codex-astra','--endpoint','invalid','--dry-run']]){
  const r=spawnSync(process.execPath,['bin/bantam.js','cards',...args],{encoding:'utf8',timeout:15000,env:{...process.env,BANTAM_ENDPOINT:'http://127.0.0.1:1'}});
  assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout,/No local model is running/);
 }
});
test('replay recovery never discovers participants or reruns a model',async t=>{
 const root=tmp(t);let exports=0,renders=0;
 const options={out:()=>{},discover:()=>{throw Error('discovery forbidden');},run:()=>{throw Error('execution forbidden');},
  exportCard:p=>{assert.equal(p,root);exports++;},replay:p=>{renders++;return {output:path.join(p,'fight-cards.html')};}};
 assert.equal(await factoryCardsCommand({replay:root},options),0);assert.equal(exports,1);assert.equal(renders,1);
 await assert.rejects(factoryCardsCommand({replay:root,yes:true},options),/mixed/);
 await assert.rejects(factoryCardsCommand({replay:root},{...options,exportCard:()=>{throw Error('bad export');}}),/bad export/);
 assert.equal(renders,2,'a failed export must still attempt the readable replay');
});
test('cloud-only factory execution skips every local-model probe and produces selected-lane replay',async t=>{
 const output=path.join(tmp(t),'cloud-fixture');let executions=0;
 const manifest=await runFactoryFights({output,arms:['codex-astra'],cards:['context-packet'],kitId:'factory-2026-09-07',endpoint:'http://127.0.0.1:1'}, {
  inspect:async()=>{throw Error('must not contact local server');},
  contender:async()=>{executions++;return {code:0,stdout:'',stderr:'',wallMs:1,startedAt:new Date().toISOString(),timedOut:false,aborted:false,bufferExceeded:false};},
  grade:async()=>({publicResult:{code:0,stdout:'',stderr:'',timedOut:false},hidden:{code:0,stdout:'',stderr:'',timedOut:false},record:{schema:'bantam.factory-card-grade.v1',card:'context-packet',pass:true,groups:[{name:'synthetic test-double grade',pass:true}]},timing:{publicWallMs:0,hiddenWallMs:0,totalWallMs:0}}),
 });
 assert.equal(executions,1);assert.equal(manifest.modelId,null);assert.equal(manifest.endpoint,null);assert.equal(manifest.complete,true);
 writeFightCardExport(output);
 const rendered=writeFactoryReplay(output);assert.equal(rendered.lanes,1);
 const html=fs.readFileSync(rendered.output,'utf8');assert.ok(html.includes('1 selected participants. 1 frozen work orders.'));assert.ok(html.includes('Your tools.'));
});
test('legacy REPL no longer includes Claude or Codex in implicit fight selection',()=>{
 const source=fs.readFileSync(new URL('../bin/bantam.js',import.meta.url),'utf8');
 assert.match(source,/const arms = armsArg \?\? \["bantam", "hermes", "opencode"\]/);
 assert.doesNotMatch(source,/armsArg \?\?.*claude-sonnet/);
});
test('public flag exports only the sanitized derivative after execution, retaining a failed score and never uploading',async t=>{
 const root=tmp(t),output=path.join(root,'run');let exports=0,ran=0;
 const options={out:()=>{},interactive:false,registry:()=>({tools:{}}),discover:()=>[],preflight:()=>{},
  run:async p=>{ran++;fs.mkdirSync(p.output);fs.writeFileSync(path.join(p.output,'manifest.json'),'{}');return {complete:true,results:[{pass:false}]};},
  exportCard:()=>{},replay:()=>({output:'private.html'}),showcase:p=>{exports++;assert.equal(p.mode,'public');assert.deepEqual(p.roots,[output]);assert.equal(p.output,path.join(output,'public'));return {output:path.join(p.output,'index.html')};}};
 const args={public:true,card:'context-packet',arms:'bantam-local-27b',out:output};
 assert.equal(await factoryCardsCommand({...args,'dry-run':true},options),0);assert.equal(exports,0);assert.equal(ran,0);
 assert.equal(await factoryCardsCommand({...args,yes:true},options),1);assert.equal(exports,1);assert.equal(ran,1);
});
