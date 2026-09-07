import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPeerReadiness} from '../src/peer-readiness.js';
import {factoryCardsCommand} from '../src/factory-cards-command.js';
const temp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-peer-readiness-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const clean={code:0,timedOut:false,aborted:false,bufferExceeded:false,cleanup:{absent:true}};
function proof(options,extra={}){
 const file=path.join(options.output,'native','probe.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({arm:options.arm,version:'scripted fixture',probe:true,candidateWritable:true,uid:1007,gid:1008,home:'/home/ubuntu',...extra}));
}
test('offline readiness uses dedicated workspaces, closed-network probe mode, and explicit proof',async t=>{
 const output=path.join(temp(t),'evidence'),seen=[];
 const r=await checkPeerReadiness({arms:['hermes','opencode'],output},{run:async options=>{
  seen.push(options);assert.equal(options.probe,true);assert.equal(options.endpoint,'http://127.0.0.1:1/v1');
  assert.equal(options.model,'bantam-offline-readiness');proof(options);return clean;
 }});
 assert.equal(r.passed,true);assert.equal(r.results.length,2);assert.notEqual(seen[0].workspace,seen[1].workspace);
 assert.equal(JSON.parse(fs.readFileSync(path.join(output,'readiness.json'))).network,'none');
});
test('zero exit without a completion proof is not readiness; failed evidence remains',async t=>{
 const output=path.join(temp(t),'evidence');
 await assert.rejects(checkPeerReadiness({arms:['hermes'],output},{run:async()=>clean}),/failed its offline/);
 const r=JSON.parse(fs.readFileSync(path.join(output,'readiness.json')));
 assert.equal(r.passed,false);assert.equal(r.results[0].pass,false);assert.ok(r.finishedAt);assert.match(r.error,/failed/);
});
test('bad identity or unconfirmed cleanup fails closed and stops the readiness sequence',async t=>{
 for(const invalid of ['identity','cleanup']){
  const output=path.join(temp(t),'evidence');let calls=0;
  await assert.rejects(checkPeerReadiness({arms:['opencode','hermes'],output},{run:async options=>{
   calls++;proof(options,invalid==='identity'?{home:'/root'}:{});return invalid==='cleanup'?{...clean,cleanup:{absent:false}}:clean;
  }}),/failed/);assert.equal(calls,1);
 }
});
test('cloud/Claude participants and existing outputs are rejected before executing',async t=>{
 const output=temp(t);let calls=0;
 for(const arms of [['claude-sonnet'],['codex-astra'],['hermes','hermes']])await assert.rejects(checkPeerReadiness({arms,output},{run:()=>{calls++;}}));
 await assert.rejects(checkPeerReadiness({arms:['hermes'],output},{run:()=>{calls++;}}),/fresh/);assert.equal(calls,0);
});
test('offline front door requires explicit consent; dry-run and decline never execute tools',async t=>{
 const output=path.join(temp(t),'evidence');let calls=0;
 const options={out:()=>{},interactive:false,registry:()=>({tools:{}}),discover:()=>[],preflight:()=>{calls++;},checkPeers:async()=>{calls++;return {passed:true};}};
 await assert.rejects(factoryCardsCommand({check:true,arms:'hermes',out:output},options),/requires --yes/);
 assert.equal(await factoryCardsCommand({check:true,arms:'hermes',out:output,'dry-run':true},options),0);
 assert.equal(await factoryCardsCommand({check:true,arms:'hermes',out:output},{...options,interactive:true,ask:async()=>''}),0);
 assert.equal(calls,0);
 assert.equal(await factoryCardsCommand({check:true,arms:'hermes',out:output,yes:true},options),0);assert.equal(calls,2);
});
test('a real card must pass selected peer readiness before any scored execution',async t=>{
 const output=path.join(temp(t),'evidence'),calls=[];
 const args={arms:'bantam-local-27b,opencode',card:'context-packet',out:output,yes:true};
 const options={out:()=>{},interactive:false,registry:()=>({tools:{}}),discover:()=>[],preflight:()=>calls.push('prerequisites'),
  checkPeers:async p=>{assert.deepEqual(p.arms,['opencode']);calls.push('readiness');return {passed:true};},
  run:async p=>{assert.equal(p.peerReadiness.passed,true);calls.push('scored');return {complete:true,results:[{pass:true}]};}};
 assert.equal(await factoryCardsCommand(args,options),0);assert.deepEqual(calls,['prerequisites','readiness','scored']);calls.length=0;
 await assert.rejects(factoryCardsCommand(args,{...options,checkPeers:async()=>{throw Error('broken installed runtime');}}),/broken installed runtime/);
 assert.deepEqual(calls,['prerequisites']);
});
