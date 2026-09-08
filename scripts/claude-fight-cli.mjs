#!/usr/bin/env node
// Opt-in native Claude comparison. Only the disposable candidate is writable;
// the existing file credential is read-only and user customizations are absent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nonRootIdentity,identityFiles,discoverPeerTools,linkedLibraries} from '../src/linux-peer-runtime.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const absolute=value=>{
  if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f,:]/.test(value))throw Error('Expected absolute path without mount separators');
  return path.resolve(value);
};
export function claudeDockerArgs({runtime,workspace,control,model='sonnet',task='',timeoutSeconds=600,probe=false,name}){
  workspace=absolute(workspace);control=absolute(control);
  if(['/',os.homedir(),ROOT].includes(workspace)||control===workspace||control.startsWith(workspace+path.sep)||workspace.startsWith(control+path.sep))throw Error('Use separate disposable workspace and control directory');
  if(!['sonnet','opus'].includes(model)||!/^bantam-claude-[a-z0-9-]+$/.test(name))throw Error('Invalid Claude contender');
  if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>1800)throw Error('Invalid deadline');
  const {uid,gid}=nonRootIdentity(runtime.identity);
  const mount=(source,target,readonly=true)=>['--mount',`type=bind,src=${absolute(source)},dst=${absolute(target)}${readonly?',readonly':''}`];
  const args=['run','--rm','--pull','never','--init','--interactive','--name',name,'--cidfile',path.join(control,'container.cid'),
    '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','2g','--cpus','2','--user',`${uid}:${gid}`,
    '--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--tmpfs',`/home/ubuntu:rw,nosuid,nodev,size=128m,uid=${uid},gid=${gid},mode=700`,
    '--tmpfs',`/home/ubuntu/.claude:rw,nosuid,nodev,size=128m,uid=${uid},gid=${gid},mode=700`,
    ...mount(path.join(control,'passwd'),'/etc/passwd'),...mount(path.join(control,'group'),'/etc/group'),
    ...mount(path.join(control,'config.json'),'/home/ubuntu/.claude.json'),
    ...mount(runtime.auth,'/home/ubuntu/.claude/.credentials.json'),
    ...mount(runtime.binary,'/opt/claude'),...mount(workspace,workspace,false),
    ...mount('/etc/ssl/certs/ca-certificates.crt','/etc/ssl/certs/ca-certificates.crt'),
    ...runtime.toolMounts.flatMap(t=>mount(t.source,t.target)),
    ...runtime.libraries.flatMap(lib=>mount(fs.realpathSync(lib),lib)),
    ...mount(runtime.gitCore,'/opt/git-core'),...mount('/usr/share/git-core','/usr/share/git-core'),...mount(runtime.npm,'/opt/npm'),
    '--env','PATH=/tmp/claude-tools:/usr/bin:/bin','--env','GIT_EXEC_PATH=/opt/git-core','--env','LANG=C.UTF-8',
    '--env','DISABLE_AUTOUPDATER=1','--env','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1','--workdir',workspace,
    ...(probe?['--network','none']:[]),'ubuntu:24.04'];
  const setup='mkdir -p /tmp/claude-tools && ln -s /opt/npm/bin/npm-cli.js /tmp/claude-tools/npm && ln -s /opt/npm/bin/npx-cli.js /tmp/claude-tools/npx && exec "$@"';
  const command=probe?['/usr/bin/node','-e',`const fs=require('fs'),cp=require('child_process');
    if(require('os').homedir()!=='/home/ubuntu'||process.getuid()===0)throw Error('identity');
    fs.accessSync('/home/ubuntu/.claude/.credentials.json',fs.constants.R_OK);
    let ro=false;try{fs.accessSync('/home/ubuntu/.claude/.credentials.json',fs.constants.W_OK)}catch{ro=true}if(!ro)throw Error('credential writable');
    fs.writeFileSync('probe.txt','disposable probe',{flag:'wx'});
    const version=cp.execFileSync('/opt/claude',['--version'],{encoding:'utf8'}).trim();
    cp.execFileSync('npm',['--version']);cp.execFileSync('git',['init','--quiet']);
    console.log(JSON.stringify({version,nonRoot:true,workspaceWrite:true,credentialFixture:true,credentialReadonly:true,network:'none'}));`]:
    ['/opt/claude','--print','--model',model,'--effort','medium','--dangerously-skip-permissions',
      '--output-format','stream-json','--verbose','--no-session-persistence','--setting-sources','',
      '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands',task];
  return [...args,'/bin/sh','-c',setup,'claude-runtime','/usr/bin/timeout','--signal=TERM','--kill-after=5s',`${probe?30:timeoutSeconds}s`,...command];
}

export async function runClaude({workspace,output,task='',model='sonnet',timeoutSeconds=600,probe=false}){
  if(process.platform!=='linux'||process.arch!=='x64')throw Error('Claude comparison currently requires Linux x64');
  workspace=fs.realpathSync(absolute(workspace));output=absolute(output);
  if(['/',os.homedir(),ROOT].includes(workspace)||['/',os.homedir(),ROOT].includes(output)
    ||output===workspace||output.startsWith(workspace+path.sep)||workspace.startsWith(output+path.sep))throw Error('Use separate disposable workspace and evidence directory');
  if(fs.existsSync(output))throw Error('Fresh Claude evidence directory required');
  const binary=fs.realpathSync(execFileSync('which',['claude'],{encoding:'utf8',timeout:3000}).trim());
  const fd=fs.openSync(binary,'r'),header=Buffer.alloc(20);try{fs.readSync(fd,header);}finally{fs.closeSync(fd);}
  if(!header.subarray(0,4).equals(Buffer.from([127,69,76,70]))||header[4]!==2||header.readUInt16LE(18)!==62)throw Error('An existing standalone Linux x64 Claude executable is required; nothing installed');
  const tools=discoverPeerTools(),runtime={...tools,binary,identity:nonRootIdentity(),libraries:linkedLibraries([...tools.tools,binary]),auth:path.join(os.homedir(),'.claude','.credentials.json')};
  if(!probe)fs.accessSync(runtime.auth,fs.constants.R_OK);
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  for(const [name,content]of Object.entries({...identityFiles(runtime.identity),'config.json':JSON.stringify({hasCompletedOnboarding:true})}))fs.writeFileSync(path.join(output,name),content,{flag:'wx',mode:0o600});
  if(probe){runtime.auth=path.join(output,'auth-fixture.json');fs.writeFileSync(runtime.auth,'{}',{flag:'wx',mode:0o600});}
  const name=`bantam-claude-${crypto.randomUUID()}`;
  const args=claudeDockerArgs({runtime,workspace,control:output,model,task,timeoutSeconds,probe,name});
  fs.writeFileSync(path.join(output,'launch.json'),JSON.stringify({schema:'bantam.claude-launch.v1',modelAlias:model,effort:'medium',probe,
    executableSha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),isolation:'outer-docker',credentialReadonly:true})+'\n',{mode:0o600});
  const child=spawn('docker',args,{stdio:'inherit'});
  const cleanup=()=>{try{execFileSync('docker',['rm','-f',name],{stdio:'ignore',timeout:10000});}catch{} };
  const signals=['SIGINT','SIGTERM','SIGHUP'];for(const signal of signals)process.once(signal,cleanup);
  try{return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});}
  finally{
    cleanup();for(const signal of signals)process.off(signal,cleanup);
    let absent=false;try{execFileSync('docker',['inspect',name],{stdio:['ignore','pipe','pipe'],timeout:5000});}catch(e){absent=/No such (?:object|container)/i.test(String(e.stderr??''));}
    fs.writeFileSync(path.join(output,'cleanup.json'),JSON.stringify({name,absent})+'\n',{mode:0o600});
    if(!absent)throw Error('Claude container cleanup was not confirmed; do not report clean completion');
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--probe'){options.probe=true;continue;}
    const key={'--workspace':'workspace','--output':'output','--task-file':'taskFile','--model':'model','--timeout-seconds':'timeoutSeconds'}[args[i]];
    if(!key||!args[i+1])throw Error('Invalid Claude adapter argument');options[key]=args[++i];
  }
  if(options.taskFile)options.task=fs.readFileSync(absolute(options.taskFile),'utf8');
  if(options.timeoutSeconds)options.timeoutSeconds=Number(options.timeoutSeconds);
  runClaude(options).then(code=>{process.exitCode=code;}).catch(e=>{process.stderr.write(`claude-fight: ${e.message}\n`);process.exitCode=1;});
}
