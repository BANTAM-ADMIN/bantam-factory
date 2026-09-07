import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {chooseFirstRun,saveConnection} from './first-run.js';
import {STOCK_PROFILES,STOCK_REPO,stockPlan,installStockFiles,registerStockProfiles} from './stock-model.js';
import {findLlamaServer,llamaInstallRoot} from './llama-install.js';
import {formatBytes,renderProgress} from './provision.js';
import {ModelClient} from './model.js';

export function findInstalledLlama(){
 const explicit=process.env.BANTAM_LLAMA_SERVER||process.env.LLAMA_SERVER;
 if(explicit){fs.accessSync(explicit,fs.constants.X_OK);return path.resolve(explicit);}
 for(const dir of (process.env.PATH??'').split(path.delimiter)){
  const p=path.join(dir,process.platform==='win32'?'llama-server.exe':'llama-server');
  try{fs.accessSync(p,fs.constants.X_OK);return p;}catch{}
 }return findLlamaServer(llamaInstallRoot());
}
export async function startManagedStock(entry){
 const child=spawn('bash',[entry.script],{stdio:'inherit'});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 return code===0?entry.endpoint:null;
}
export function nvidiaMemory(){
 try{return Number(execFileSync('nvidia-smi',['--query-gpu=memory.total','--format=csv,noheader,nounits'],{encoding:'utf8',timeout:3000}).trim().split('\n')[0]);}catch{return null;}
}
export async function setupWizard({ask,out,hidden,advanced=false,profile=null,yes=false,home=os.homedir(),
 choose=chooseFirstRun,Client=ModelClient,install=installStockFiles,installLlama,findLlama=findInstalledLlama,
 gpuMemory=nvidiaMemory,platform=process.platform,fetchImpl=fetch,
 checkRuntime=server=>{const help=execFileSync(server,['--help'],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  for(const flag of ['--spec-type','--ctx-checkpoints','--no-mmproj-offload'])if(!help.includes(flag))throw Error(`Runtime lacks ${flag}; choose a compatible llama-server before downloading weights.`);} }={}){
 const selection=profile?{kind:'install-stock'}:await choose({ask,out,advanced});
 if(!selection||selection.kind==='advanced'||selection.kind==='choose-codex')return selection;
 if(selection.kind==='codex-help'){
  out('Install the Codex CLI yourself, then run codex login and retry bantam setup.\nOfficial instructions: https://developers.openai.com/codex/cli/\nBANTAM has not installed anything or enabled cloud access.\n');return null;
 }
 if(selection.kind==='connect-api'){
  const key=await hidden('API key if required (hidden; Enter for none): ');
  const url=new URL(selection.apiUrl);
  if(key&&url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){
   out('Warning: HTTP sends the API key without TLS. Prefer HTTPS outside a trusted private network.\n');
   if(!/^y(es)?$/i.test((await ask('Send the key to this HTTP server? [y/N] ')).trim()))return null;
  }
  const r=await fetchImpl(selection.apiUrl+'/models',{headers:key?{Authorization:`Bearer ${key}`}:{},signal:AbortSignal.timeout(4000),redirect:'error'});
  if(!r.ok)throw Error(`Model discovery failed: HTTP ${r.status}`);
  const data=await r.json(),models=data?.data?.filter(m=>typeof m.id==='string').map(m=>m.id)??[];
  if(!models.length)throw Error('Server returned no model IDs');
  models.forEach((m,i)=>out(`  [${i+1}] ${m}\n`));
  const answer=models.length===1?'1':(await ask('Model number [1]: '))||'1';
  const model=models[Number(answer)-1];if(!model)throw Error('Invalid model selection');
  out('Backend: [1] llama.cpp  [2] vLLM  [3] other OpenAI-compatible chat/schema API\n');
  const backend=(await ask('Backend [1]: '))||'1';
  const dialect=({'1':'llamacpp','2':'vllm','3':'chat'})[backend];if(!dialect)throw Error('Invalid backend');
  out(`Future tasks and relevant project context will be sent to ${selection.apiUrl}. Only use a server you trust.\nThis choice will be remembered across folders; bantam setup changes it.\n`);
  if(!/^y(es)?$/i.test((await ask('Allow this server and send a tiny compatibility test (no project data yet)? [y/N] ')).trim()))return null;
  const c=new Client({apiUrl:selection.apiUrl,apiKey:key||null,model,apiDialect:dialect});
  const schema={type:'object',properties:{ok:{type:'boolean',const:true}},required:['ok'],additionalProperties:false};
  const result=await c.complete(dialect==='chat'?'Return JSON {"ok":true}.':'Reply OKBANTAM.',{
   grammar: dialect==='chat'?'root ::= "{\\\"ok\\\":true}"':'root ::= "OKBANTAM"',
   ...(dialect==='chat'?{jsonSchema:schema}:{}),nPredict:64,retries:0,signal:AbortSignal.timeout(30000)});
  let valid=false;try{valid=dialect==='chat'?JSON.stringify(JSON.parse(result.content))==='{"ok":true}':result.content.trim()==='OKBANTAM';}catch{}
  if(!valid)throw Error('Compatibility test failed. No connection saved; select the correct backend or configure server grammar/schema support.');
  const config={kind:'api',apiUrl:selection.apiUrl,apiKey:key||null,model,dialect,grammar:true};
  saveConnection(config,home);out('Connection saved for future folders. Server configuration and processes were not changed.\n');
  return {kind:'api',config};
 }
 if(selection.kind!=='install-stock')return null;
 if(platform!=='linux')throw Error('Managed stock installation currently supports Linux. Use an existing server or Codex on this platform.');
 const mem=gpuMemory();if(!mem||mem<23500)throw Error('Easy mode requires a detected NVIDIA GPU with about 24GB VRAM. Your own offloaded model/server is still supported.');
 if(!profile){Object.entries(STOCK_PROFILES).forEach(([id,p],i)=>out(`  [${i+1}] ${p.label}${p.recommended?' (recommended)':''}${p.warning?' — '+p.warning:''}\n`));
  const n=(await ask('Profile [1]: '))||'1';profile=Object.keys(STOCK_PROFILES)[Number(n)-1];if(!profile)throw Error('Invalid stock profile');}
 const plan=stockPlan({home,profile});
 out(`\nStock: DavidAU community-tuned 27B Q4_K_S; embedded MTP\n${plan.label}\nDownload: ${formatBytes(plan.bytes)} (model + vision projector)\nLocation: ${plan.root}\nSource/terms: https://huggingface.co/${STOCK_REPO}\n72K CPU vision is the measured baseline; other profiles require a fit check.\n`);
 let server=findLlama();out(server?`Use installed llama-server: ${server}\n`:'llama-server is missing. BANTAM will offer its prebuilt runtime installer too.\n');
 if(!yes&&!/^y(es)?$/i.test((await ask('Download/verify these artifacts, register profiles, and start the selected profile? [y/N] ')).trim()))return null;
 if(!server){if(!installLlama)throw Error('No runtime installer available');await installLlama();server=findLlama();if(!server)throw Error('llama-server installation did not produce a usable binary');}
 checkRuntime(server);
 let last=0;await install(plan,{consent:true,onProgress:p=>{if(Date.now()-last>1000){last=Date.now();out(renderProgress(p)+'\n');}}});
 const entries=registerStockProfiles({home,server});
 return {kind:'local',name:'davidau-'+profile,model:entries.find(e=>e.name==='davidau-'+profile)};
}
