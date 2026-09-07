import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export function nonRootIdentity({uid=process.getuid?.(),gid=process.getgid?.()}={}){
 if(!Number.isSafeInteger(uid)||!Number.isSafeInteger(gid)||uid<1||gid<1||uid>2147483647||gid>2147483647)throw Error('Peer comparisons require a non-root numeric Linux uid/gid.');
 return {uid,gid};
}
export function identityFiles(identity){
 const {uid,gid}=nonRootIdentity(identity);
 return {passwd:`root:x:0:0:root:/root:/usr/sbin/nologin\nbantam:x:${uid}:${gid}:BANTAM contender:/home/ubuntu:/bin/sh\n`,
  group:`root:x:0:\nbantam:x:${gid}:\n`};
}
export function discoverPeerTools({exec=execFileSync,node=process.execPath}={}){
 const which=name=>fs.realpathSync(exec('which',[name],{encoding:'utf8',timeout:3000}).trim());
 const git=which('git'),npmEntry=which('npm');
 const npm=path.resolve(path.dirname(npmEntry),'..');
 if(!fs.existsSync(path.join(npm,'bin','npm-cli.js')))throw Error('Cannot resolve npm package from the installed npm executable.');
 const gitCore=exec(git,['--exec-path'],{encoding:'utf8',timeout:3000}).trim();
 if(!path.isAbsolute(gitCore)||!fs.statSync(gitCore).isDirectory())throw Error('Cannot resolve Git helper directory.');
 const toolMounts=[{source:fs.realpathSync(node),target:'/usr/bin/node'},{source:git,target:'/usr/bin/git'}];
 return {tools:toolMounts.map(t=>t.source),toolMounts,npm,gitCore};
}
export function linkedLibraries(files,{exec=execFileSync}={}){
 const libraries=new Set();
 for(const file of files){
  let output;
  try{output=exec('ldd',[file],{encoding:'utf8',timeout:5000});}
  catch(e){
   const message=String(e.stdout??'')+String(e.stderr??'');
   if(/not a dynamic executable|statically linked/i.test(message))continue;
   throw Error(`Cannot inspect runtime libraries for ${file}: ${message||e.message}`);
  }
  if(/=>\s+not found/.test(output))throw Error(`Missing shared library for ${file}`);
  for(const match of output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm))libraries.add(match[1]);
 }
 return [...libraries];
}
