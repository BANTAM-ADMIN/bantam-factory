// Managed stock profile. Existing user models/servers are never replaced.
import fs from 'node:fs';
import os from 'node:os';
import {bantamConfigDirectory} from './config-directory.js';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {downloadResumable, freeDiskBytes} from './provision.js';

export const STOCK_REPO='DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NEO-CODER-MAX-MTP-GGUF';
export const STOCK_REVISION='a51791d22b62b03aa5132feaac27147f32f289f7';
export const STOCK_FILES=[
 {role:'model',file:'Qwen3.8-27B-TurboFCFusion-735-882-Here-Uncen-NEO-CODER-MAX-MTP-Q4_K_S.gguf',bytes:17537488416,sha256:'889caf9975ef423464dd319f8bc97318d5bab7d034060efee8711cdb15708766'},
 {role:'vision',file:'mmproj-BF16.gguf',bytes:931145920,sha256:'b0d8d89e9c9c90e0fb8ca74742d9d9bd7cc0f966a29b6f8c14227000ea6bd89e'},
];
export const STOCK_PROFILES={
 '72k-cpu-vision':{ctx:72000,gpuVision:false,label:'72K · vision on CPU',recommended:true},
 '92k-cpu-vision':{ctx:92000,gpuVision:false,label:'92K · vision on CPU',warning:'Higher KV memory; fit and workload qualification required.'},
 '72k-gpu-vision':{ctx:72000,gpuVision:true,label:'72K · vision on GPU',warning:'Image processing adds VRAM pressure; fit check required. Use CPU vision if allocation fails.'},
};
export const TIEL_REPO='peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP';
export const TIEL_REVISION='199cff20cda0575344172543809cb0f990bfbceb';
export const TIEL_FILES=[{role:'model',file:'Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS.gguf',bytes:18629540384,sha256:'bf12bfacb04f587be6eecd578a5dc3d06861797d3a4cf81b1fad3d72b29dbbce'}];
export const TIEL_PROFILES={
 'tiel-32k-cpu-experts':{ctx:32768,gpuVision:false,label:'Experimental Tiel 35B-A3B · 32K · CPU experts · text only',warning:'Lower-VRAM offload candidate, not a qualified 8–16GB performance guarantee. Requires about 32GB system RAM; CPU bandwidth affects speed.'},
};
export const isTielProfile=profile=>Object.hasOwn(TIEL_PROFILES,profile);
export const stockRuntimeFlags=plan=>['--spec-type','--ctx-checkpoints',...(isTielProfile(plan.profile)?['--cpu-moe','--spec-draft-cpu-moe']:['--no-mmproj-offload'])];
export const stockRoot=home=>path.join(bantamConfigDirectory(home),'stock','davidau-27b');
export const managedRegistryPath=home=>path.join(bantamConfigDirectory(home),'managed-models.json');
export function stockPlan({home,configDir,profile='72k-cpu-vision'}={}){
 const base=bantamConfigDirectory(home,configDir);
 if(isTielProfile(profile)){
  const root=path.join(base,'stock','tiel-35b-a3b');
  return {profile,...TIEL_PROFILES[profile],root,files:TIEL_FILES.map(f=>({...f,dest:path.join(root,f.file),url:`https://huggingface.co/${TIEL_REPO}/resolve/${TIEL_REVISION}/${encodeURIComponent(f.file)}`})),bytes:TIEL_FILES[0].bytes};
 }
 if(!Object.hasOwn(STOCK_PROFILES,profile))throw Error('Unknown stock profile');
 const root=path.join(base,'stock','davidau-27b');
 return {profile,...STOCK_PROFILES[profile],root,files:STOCK_FILES.map(f=>({...f,dest:path.join(root,f.file),url:`https://huggingface.co/${STOCK_REPO}/resolve/${STOCK_REVISION}/${encodeURIComponent(f.file)}`})),bytes:STOCK_FILES.reduce((n,f)=>n+f.bytes,0)};
}
export async function fileMatches(file,artifact){
 try{if(fs.statSync(file).size!==artifact.bytes)return false;}catch{return false;}
 const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
 return hash.digest('hex')===artifact.sha256;
}
export async function installStockFiles(plan,{consent=false,download=downloadResumable,verify=fileMatches,onProgress=()=>{},freeBytes=freeDiskBytes(plan.root)}={}){
 if(!consent)throw Error('Explicit download consent required');
 const missing=[];
 for(const f of plan.files){
  if(fs.existsSync(f.dest)){if(!await verify(f.dest,f))throw Error(`Existing file failed integrity check; not overwriting: ${f.dest}`);}
  else missing.push(f);
 }
 if(freeBytes!==null&&freeBytes<missing.reduce((n,f)=>n+f.bytes,0)*1.1)throw Error('Insufficient disk space for stock model download');
 for(const f of missing){
  // Bad/interrupted data never becomes the usable model filename.
  const staging=f.dest+'.download';
  if(!fs.existsSync(staging))await download({url:f.url,dest:staging,onProgress});
  if(!await verify(staging,f))throw Error(`Downloaded file failed SHA-256/size verification: ${staging}. Retained for inspection; not installed.`);
  fs.linkSync(staging,f.dest); // exclusive publication: do not overwrite a raced-in destination
  fs.unlinkSync(staging);
 }
 return plan;
}
export function stockServerArgs(plan,{port=8085}={}){
 if(isTielProfile(plan.profile))return [
  '-m',plan.files[0].dest,'--host','127.0.0.1','--port',String(port),
  '--ctx-size','32768','--n-gpu-layers','99','--cpu-moe','--parallel','1',
  '--ctx-checkpoints','8','--cache-ram','1024','--jinja',
  '--cache-type-k','q8_0','--cache-type-v','q8_0','--reasoning','on',
  '--temp','1.0','--top-p','0.95','--top-k','20','--min-p','0.0',
  '--batch-size','512','--ubatch-size','128','--spec-type','draft-mtp',
  '--spec-draft-cpu-moe','--spec-draft-n-max','1','--perf','--metrics',
 ];
 if(!Object.hasOwn(STOCK_PROFILES,plan.profile))throw Error('Unknown stock profile');
 const p=STOCK_PROFILES[plan.profile];
 return ['-m',plan.files.find(f=>f.role==='model').dest,'--mmproj',plan.files.find(f=>f.role==='vision').dest,
  ...(p.gpuVision?[]:['--no-mmproj-offload']),'--host','127.0.0.1','--port',String(port),
  '--ctx-size',String(p.ctx),'--n-gpu-layers','99','--parallel','1','--ctx-checkpoints','32','--cache-ram','8000',
  '--jinja','--chat-template-kwargs','{"preserve_thinking":true,"reasoning_effort":"xhigh"}',
  '--cache-type-k','q8_0','--cache-type-v','q8_0','--reasoning','on','--temp','1.0','--top-p','0.95',
  '--top-k','20','--min-p','0.0','--presence-penalty','0.0','--repeat-penalty','1.0','--keep','4096',
  '--batch-size','8192','--ubatch-size','1024','--spec-type','draft-mtp','--spec-draft-n-max','3','--perf','--metrics'];
}
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
export function registerStockProfiles({home,server,node=process.execPath,family='davidau'}={}){
 if(!['davidau','tiel'].includes(family))throw Error('Unknown stock family');
 const file=managedRegistryPath(home);let entries=[];
 if(fs.existsSync(file)){entries=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(entries))throw Error('Invalid managed registry');}
 const launcher=fileURLToPath(new URL('../bin/stock-server.js',import.meta.url));
 const profiles=family==='tiel'?TIEL_PROFILES:STOCK_PROFILES;
 const root=stockPlan({home,profile:Object.keys(profiles)[0]}).root;fs.mkdirSync(root,{recursive:true});
 for(const [profile,p]of Object.entries(profiles)){
  const name=family==='tiel'?profile:'davidau-'+profile,config=path.join(root,profile+'.json'),script=path.join(root,profile+'.sh');
  const location=home===undefined&&process.env.BANTAM_CONFIG_DIR!==undefined?{configDir:bantamConfigDirectory()}:{home:home??os.homedir()};
  const body=JSON.stringify({schema:1,profile,server,...location},null,2)+'\n';
  const sh=`#!/usr/bin/env bash\nset -euo pipefail\nexec ${quote(node)} ${quote(launcher)} ${quote(config)}\n`;
  for(const [dest,value]of [[config,body],[script,sh]]){
   if(fs.existsSync(dest)&&fs.readFileSync(dest,'utf8')!==value)throw Error(`Managed configuration differs; refusing overwrite: ${dest}`);
   if(!fs.existsSync(dest))fs.writeFileSync(dest,value,{flag:'wx',mode:dest===script?0o700:0o600});
  }
  const entry={name,label:`DavidAU 27B · ${p.label}`,script,endpoint:'http://127.0.0.1:8085',profile:'qwen',slots:1,vision:true,ctx:p.ctx,priority:p.recommended?100:50,notes:'Managed stock; embedded MTP. '+(p.warning??'72K CPU-vision profile passed the recorded adaptive stream card.'),managed:true};
  if(family==='tiel')Object.assign(entry,{label:p.label,vision:false,priority:10,notes:p.warning});
  const old=entries.find(e=>e.name===name);
  if(old&&JSON.stringify(old)!==JSON.stringify(entry))throw Error(`Managed registry entry differs: ${name}`);
  if(!old)entries.push(entry);
 }
 fs.writeFileSync(file,JSON.stringify(entries,null,2)+'\n',{mode:0o600});return entries;
}
