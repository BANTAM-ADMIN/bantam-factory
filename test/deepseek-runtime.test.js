import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverDeepseekInstallation} from '../src/deepseek-runtime.js';
import {registerCompetitor} from '../src/competitor-registry.js';
import {discoverCardParticipants,makeCardsPlan,preflightCards,factoryCardsCommand} from '../src/factory-cards-command.js';
import {freshCommand} from '../scripts/factory-fights.mjs';
import {parseArgs,buildDockerArgs} from '../scripts/deepseek-fight-cli.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-dsh-layout-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const modules=path.join(root,'node_modules'),pkg=path.join(modules,'@deepseek-ai/dsh'),entry=path.join(pkg,'lib/bin.js');
 fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'#!/usr/bin/env node\nthrow Error("must not execute at discovery");\n',{mode:0o755});
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1.2-rc.1',bin:{dsh:'lib/bin.js'},dependencies:{example:'1'}}));
 fs.writeFileSync(path.join(pkg,'.env'),'PRIVATE_SENTINEL');
 const dep=path.join(modules,'example');fs.mkdirSync(dep);fs.writeFileSync(path.join(dep,'package.json'),JSON.stringify({name:'example',version:'1'}));
 fs.writeFileSync(path.join(root,'private-user-settings'),'PRIVATE_SENTINEL');
 return {root,pkg,dep,entry};
}
test('installed npm discovery includes dependency closure but not user settings or package dotfiles',t=>{
 const f=fixture(t),r=discoverDeepseekInstallation(f.entry);
 assert.equal(r.entry,f.entry);assert.equal(r.packages.length,2);assert.equal(r.version,'0.1.2-rc.1');
 assert.ok(r.mounts.every(m=>m.source===m.target&&m.source.startsWith(path.join(f.root,'node_modules')+path.sep)));
 assert.ok(!r.mounts.some(m=>m.source.endsWith('.env')||m.source.endsWith('private-user-settings')));
 fs.rmSync(f.dep,{recursive:true});assert.throws(()=>discoverDeepseekInstallation(f.entry),/dependency missing/);
});
test('registered DeepSeek reaches frozen runner with exact executable identity and no prepared-image requirement',t=>{
 const f=fixture(t),registration=registerCompetitor('deepseek',f.root,{home:path.join(f.root,'home')});
 const registrations={deepseek:registration},participants=discoverCardParticipants({registrations,find:()=>null});
 assert.equal(participants.find(p=>p.id==='deepseek-local-27b').executable,f.entry);
 const plan=makeCardsPlan({card:'context-packet',arms:'deepseek-local-27b',out:path.join(f.root,'output')},{registrations,connection:null});
 const cmd=freshCommand({arm:'deepseek-local-27b',task:'task',workspace:'/tmp/candidate',dir:'/tmp/attempt',endpoint:'http://127.0.0.1:8085',model:'m',peerExecutables:plan.peerExecutables});
 const args=parseArgs(cmd.args.slice(1));assert.equal(args.executable,f.entry);assert.equal(args.executableSha256,registration.sha256);
 const calls=[];preflightCards(plan,{participants,exec:(exe,args)=>calls.push([exe,...args])});
 assert.ok(!calls.flat().some(arg=>String(arg).startsWith('bantam/deepseek-fight:')));
 fs.appendFileSync(f.entry,'// updater\n');assert.throws(()=>preflightCards(plan,{participants,exec:()=>{throw Error('no Docker');}}),/changed/);
});
test('DeepSeek offline front door honors consent and precedes all scored model work',async t=>{
 const f=fixture(t),registration=registerCompetitor('deepseek',f.entry,{home:path.join(f.root,'home')}),order=[];
 const deps={registry:()=>({tools:{deepseek:registration}}),discover:()=>[{id:'deepseek-local-27b',installed:true,executable:f.entry}],
  out:()=>{},preflight:()=>order.push('preflight'),checkDeepseek:async args=>{order.push('offline');assert.equal(args.registration.sha256,registration.sha256);return {passed:true,network:'none'};},
  run:async plan=>{order.push('scored');assert.deepEqual(plan.deepseekReadiness,{passed:true,network:'none'});return {complete:true,results:[{pass:true}]};}};
 await factoryCardsCommand({card:'context-packet',arms:'deepseek-local-27b',out:path.join(f.root,'run'),'dry-run':true},deps);assert.deepEqual(order,[]);
 await factoryCardsCommand({check:true,arms:'deepseek-local-27b',out:path.join(f.root,'check'),yes:true},deps);assert.deepEqual(order,['preflight','offline']);
 order.length=0;
 await factoryCardsCommand({card:'context-packet',arms:'deepseek-local-27b',out:path.join(f.root,'run'),yes:true},deps);assert.deepEqual(order,['preflight','offline','scored']);
});
test('installed DeepSeek container is non-root, mounts runtime readonly, and probes without network',()=>{
 const args=buildDockerArgs({workspace:'/tmp/candidate',home:'/tmp/state',patchFile:'/tmp/patch',cidfile:'/tmp/cid',name:'deepseek-fight-test',image:'sha256:'+'a'.repeat(64),task:'offline',probe:true,control:'/tmp/control',
  runtime:{identity:{uid:2042,gid:3077},entry:'/opt/installed/lib/bin.js',mounts:[{source:'/opt/installed/lib',target:'/opt/installed/lib'}],toolMounts:[],libraries:[],gitCore:'/opt/git',npm:'/opt/npm'}});
 assert.equal(args[args.indexOf('--user')+1],'2042:3077');assert.equal(args[args.indexOf('--network')+1],'none');
 assert.ok(args.includes('type=bind,src=/opt/installed/lib,dst=/opt/installed/lib,readonly'));
 assert.ok(args.includes('HOME=/home/ubuntu'));
});
