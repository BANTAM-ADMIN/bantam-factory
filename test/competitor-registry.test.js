import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {competitorRegistryPath,registerCompetitor,readCompetitorRegistry,resolveCompetitorInstallation,verifyCompetitorRegistration} from '../src/competitor-registry.js';
import {nonRootIdentity,identityFiles,linkedLibraries,discoverPeerTools} from '../src/linux-peer-runtime.js';
import {factoryCardsCommand,discoverCardParticipants,makeCardsPlan,preflightCards} from '../src/factory-cards-command.js';
import {freshCommand} from '../scripts/factory-fights.mjs';
import {buildDockerArgs,parseOptions} from '../scripts/peer-fight-cli.mjs';
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-competitor-registry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
function binary(root,name,content='#!/bin/sh\nexit 90\n'){
 const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content,{mode:0o755});return file;
}
test('Pi registration locates its maintained npm CLI and passes the pinned executable to shared cards',t=>{
 const root=temp(t),home=path.join(root,'home'),exe=binary(root,'pi-install/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
 const record=registerCompetitor('pi',path.join(root,'pi-install'),{home});
 assert.equal(record.executable,exe);
 const command=freshCommand({arm:'pi',task:'EXACT',workspace:'/tmp/pi-card/ws',dir:'/tmp/pi-card',endpoint:'http://127.0.0.1:1234',model:'local27b',peerOutputTokens:32768,peerExecutables:{pi:record}});
 assert.equal(command.args[command.args.indexOf('--executable')+1],exe);
 assert.equal(command.args[command.args.indexOf('--executable-sha256')+1],record.sha256);
 assert.equal(command.args[command.args.indexOf('--arm')+1],'pi');
 assert.equal(command.args[command.args.indexOf('--max-output-tokens')+1],'32768');
});

test('one Codex registration serves native and factory-wrapped cards even when Codex is off PATH',t=>{
 const root=temp(t),exe=binary(root,'Codex install/bin/codex'),record=registerCompetitor('codex',path.join(root,'Codex install'),{home:root});
 const arms=['codex-astra','bantam-codex-astra'],registrations={codex:record};
 const participants=discoverCardParticipants({find:()=>null,registrations});
 for(const arm of arms){
  assert.equal(participants.find(p=>p.id===arm).executable,exe);
  assert.equal(participants.find(p=>p.id===arm).installed,true);
  const command=freshCommand({arm,task:'EXACT',workspace:'/tmp/codex-card/ws',dir:'/tmp/codex-card',peerExecutables:registrations});
  assert.equal(command.env.ASTRA_CONTAINER_CODEX_EXECUTABLE,exe);
  assert.equal(command.env.ASTRA_CONTAINER_CODEX_SHA256,record.sha256);
 }
 const plan=makeCardsPlan({card:'context-packet',arms:arms.join(','),out:path.join(root,'run')},{registrations});
 assert.equal(plan.peerExecutables.codex.executable,exe);
});

test('registration resolves explicit executable or bounded folder candidates, never executes them',t=>{
 const root=temp(t),home=path.join(root,'home'),exe=binary(root,'Hermes install/.venv/bin/hermes');
 const record=registerCompetitor('hermes',path.join(root,'Hermes install'),{home});
 assert.equal(record.executable,exe);assert.match(record.sha256,/^[a-f0-9]{64}$/);
 assert.equal(verifyCompetitorRegistration(record),exe);
 assert.equal(fs.statSync(competitorRegistryPath(home)).mode&511,0o600);
 assert.deepEqual(readCompetitorRegistry(home).tools.hermes,record);
 assert.throws(()=>registerCompetitor('claude',exe,{home}),/currently supports/);
 const link=path.join(root,'hermes-link');fs.symlinkSync(exe,link);assert.equal(resolveCompetitorInstallation('hermes',link),exe);
 binary(root,'Hermes install/bin/hermes','#!/bin/sh\nexit 91\n');
 assert.throws(()=>resolveCompetitorInstallation('hermes',path.join(root,'Hermes install')),/Multiple/);
 assert.throws(()=>resolveCompetitorInstallation('opencode',path.join(root,'home')),/No supported/);
});
test('re-registering an updated program is explicit; changed bytes fail execution preflight',t=>{
 const root=temp(t),exe=binary(root,'opencode'),record=registerCompetitor('opencode',exe,{home:root});
 fs.appendFileSync(exe,'# changed by updater\n');assert.throws(()=>verifyCompetitorRegistration(record),/changed/);
 const next=registerCompetitor('opencode',exe,{home:root});assert.notEqual(next.sha256,record.sha256);
 assert.equal(verifyCompetitorRegistration(next),exe);
});
test('invalid or linked registries fail closed and do not overwrite unrelated files',t=>{
 const root=temp(t),file=competitorRegistryPath(root),exe=binary(root,'opencode');
 fs.mkdirSync(path.dirname(file));const other=path.join(root,'other.json');fs.writeFileSync(other,'keep');fs.symlinkSync(other,file);
 assert.throws(()=>registerCompetitor('opencode',exe,{home:root}),/non-symlink/);assert.equal(fs.readFileSync(other,'utf8'),'keep');
 fs.unlinkSync(file);fs.writeFileSync(file,JSON.stringify({schema:1,tools:{opencode:{executable:'/tmp/x',sha256:'bad'}}}));
 assert.throws(()=>readCompetitorRegistry(root),/Invalid/);
});
test('registered peers outrank PATH, remain visible when missing, and select exact executable hashes',t=>{
 const root=temp(t),exe=binary(root,'custom/opencode'),record=registerCompetitor('opencode',exe,{home:root});
 const registrations={opencode:record};let peers=discoverCardParticipants({registrations,find:()=>'/wrong/PATH'});
 assert.equal(peers.find(p=>p.id==='opencode').executable,exe);
 const plan=makeCardsPlan({card:'context-packet',arms:'bantam-local-27b,opencode',out:path.join(root,'evidence')},{registrations,connection:null});
 const command=freshCommand({arm:'opencode',task:'t',workspace:'/tmp/candidate',dir:'/tmp/run',endpoint:'http://127.0.0.1:8085',model:'m',peerExecutables:plan.peerExecutables});
 const parsed=parseOptions(command.args.slice(1));assert.equal(parsed.executable,exe);assert.equal(parsed.executableSha256,record.sha256);
 fs.unlinkSync(exe);peers=discoverCardParticipants({registrations,find:()=>'/wrong/PATH'});
 assert.equal(peers.find(p=>p.id==='opencode').installed,false,'do not silently fall back to another executable');
 assert.throws(()=>preflightCards(plan,{participants:peers,exec:()=>{throw Error('must not run Docker');}}),/not installed/);
});
test('register command persists only a location and never authorizes or starts an agent',async t=>{
 const root=temp(t),exe=binary(root,'opencode');let output='';
 const options={out:s=>output+=s,register:(name,location)=>registerCompetitor(name,location,{home:root}),
  discover:()=>{throw Error('no discovery');},run:()=>{throw Error('no execution');},preflight:()=>{throw Error('no Docker');}};
 assert.equal(await factoryCardsCommand({register:'opencode',path:exe},options),0);
 assert.match(output,/No harness was executed/);
 await assert.rejects(factoryCardsCommand({register:'opencode',path:exe,yes:true},options),/without run options/);
 const saved=readCompetitorRegistry(root);assert.equal(saved.tools.opencode.executable,exe);
 assert.equal(fs.existsSync(path.join(root,'.bantam','connection.json')),false);
});
test('non-root UID/GID are not hardcoded; clean passwd/group resolve a private container home',()=>{
 const identity={uid:2042,gid:3077};assert.deepEqual(nonRootIdentity(identity),identity);
 assert.match(identityFiles(identity).passwd,/bantam:x:2042:3077:BANTAM contender:\/home\/ubuntu:/);
 const args=buildDockerArgs({options:{arm:'opencode',workspace:'/tmp/candidate',taskFile:'/tmp/task',output:'/tmp/evidence',endpoint:'http://127.0.0.1:8085',model:'m',timeoutSeconds:30,maxOutputTokens:8192},
  runtime:{arm:'opencode',identity,mounts:[],tools:[],libraries:[],npm:'/opt/local/npm',gitCore:'/opt/local/git-core'},control:'/tmp/control',state:'/tmp/state',cidfile:'/tmp/id',name:'bantam-peer-opencode-test'});
 assert.equal(args[args.indexOf('--user')+1],'2042:3077');assert.ok(args.some(a=>a.includes('uid=2042,gid=3077')));
 assert.ok(args.includes('type=bind,src=/tmp/control/passwd,dst=/etc/passwd,readonly'));
 assert.ok(args.includes('type=bind,src=/opt/local/git-core,dst=/opt/git-core,readonly'));
 for(const uid of [0,-1,1.5,NaN,'1000',2147483648])assert.throws(()=>nonRootIdentity({uid,gid:1000}));
});
test('shared-library inspection handles static binaries but never hides missing dependencies',()=>{
 assert.deepEqual(linkedLibraries(['/bin/static'],{exec:()=>{throw {stdout:'not a dynamic executable'};}}),[]);
 assert.deepEqual(linkedLibraries(['/bin/dynamic'],{exec:()=> 'libz.so => /lib/libz.so (0xab)\n /lib/ld-linux.so (0xcd)\n'}),['/lib/libz.so','/lib/ld-linux.so']);
 assert.throws(()=>linkedLibraries(['/bin/broken'],{exec:()=> 'libfoo.so => not found\n'}),/Missing shared library/);
});
test('tool discovery uses selected Node, npm symlink target, and Git helper path',t=>{
 const root=temp(t),node=binary(root,'custom/node'),git=binary(root,'custom/git'),npm=binary(root,'npm/bin/npm-cli.js');
 const core=path.join(root,'git-core');fs.mkdirSync(core);
 const r=discoverPeerTools({node,exec:(exe,args)=>exe==='which'?(args[0]==='git'?git:npm):core});
 assert.equal(r.npm,path.dirname(path.dirname(npm)));assert.equal(r.gitCore,core);
 assert.deepEqual(r.toolMounts,[{source:node,target:'/usr/bin/node'},{source:git,target:'/usr/bin/git'}]);
});
