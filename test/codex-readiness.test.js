import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {checkCodexReadiness} from '../src/codex-readiness.js';
import {factoryCardsCommand} from '../src/factory-cards-command.js';
const temp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-codex-ready-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const proof={credentialFixture:true,authReadonly:true,workspaceWrite:true,hostConfigAbsent:true,home:'/home/ubuntu',uid:1234,gid:2345,codex:'fixture-codex'};
test('Codex readiness proves isolated runtime and cleanup, without handing real credentials to the probe',async t=>{
 const output=path.join(temp(t),'run');
 const report=await checkCodexReadiness({output,out:()=>{}},{authReadable:()=>false,run:async(exe,args,options)=>{
  assert.equal(args.at(-1),'--probe');assert.equal(options.env.OPENAI_API_KEY,undefined);assert.equal(options.env.CODEX_HOME,undefined);
  const runtime=path.join(options.env.ASTRA_CONTAINER_CID_DIR,'runtime-test');fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime,'cleanup.json'),JSON.stringify({absent:true}));
  return {code:0,stdout:JSON.stringify(proof),stderr:''};
 }});
 assert.equal(report.passed,true);assert.equal(report.authCacheReadable,false);assert.equal(report.realCredentialsMounted,false);
});
test('a missing account prerequisite or incomplete proof fails before scoring and retains a report',async t=>{
 let calls=0;const root=temp(t);
 await assert.rejects(checkCodexReadiness({output:path.join(root,'auth'),requireAuthentication:true,out:()=>{}},{authReadable:()=>false,run:()=>{calls++;}}),/file-backed/);
 assert.equal(calls,0);
 await assert.rejects(checkCodexReadiness({output:path.join(root,'proof'),out:()=>{}},{authReadable:()=>true,run:async()=>({code:0,stdout:'{}',stderr:''})}),/failed its offline/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'proof/readiness.json'))).passed,false);
});
test('cloud card must clear offline/account prerequisites before any scored contender; decline never checks',async t=>{
 const root=temp(t),calls=[];const args={card:'context-packet',arms:'bantam-local-27b,codex-astra',out:path.join(root,'run'),yes:true};
 const options={out:()=>{},interactive:false,registry:()=>({tools:{}}),discover:()=>[],preflight:()=>calls.push('preflight'),
  checkCodex:async p=>{assert.equal(p.requireAuthentication,true);calls.push('offline');return {passed:true};},
  run:async p=>{calls.push('scored');assert.equal(p.codexReadiness.passed,true);return {complete:true,results:[{pass:true}]};}};
 assert.equal(await factoryCardsCommand(args,options),0);assert.deepEqual(calls,['preflight','offline','scored']);calls.length=0;
 await assert.rejects(factoryCardsCommand(args,{...options,checkCodex:async()=>{throw Error('bad runtime');}}),/bad runtime/);
 assert.deepEqual(calls,['preflight']);calls.length=0;
 assert.equal(await factoryCardsCommand({...args,yes:false},{...options,interactive:true,ask:async()=>''}),0);assert.deepEqual(calls,[]);
});
