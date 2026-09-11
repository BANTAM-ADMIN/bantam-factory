// First-run choices are explicit. Discovery sends no prompts or credentials.
import fs from 'node:fs';import path from 'node:path';
import {bantamConfigDirectory} from './config-directory.js';
import {execFileSync} from 'node:child_process';
// Loopback ports scanned for an already-running OpenAI-compatible server.
// 18020 is the BANTAM host's vLLM port (Qwen3.8-27B on an RTX 3090); it was
// missing, so a server the operator was already running was invisible to every
// discovery path — the wizard offered to install a model instead of using it.
export const COMMON_MODEL_PORTS=[8085,8080,8000,1234,5000,18086,18020,11434];
export function normalizeServerUrl(input){
 const text=String(input??'').trim();if(!text)throw Error('Enter a server address');
 const u=new URL(/^[a-z]+:\/\//i.test(text)?text:'http://'+text);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Use an HTTP(S) URL without embedded credentials, query or fragment');
 return u.href.replace(/\/$/,'').replace(/\/v1$/,'')+'/v1';
}
/**
 * Running loopback OpenAI-compatible servers, with what each one is.
 *
 * The model card is the server's own self-description, so the dialect costs no
 * extra request: vLLM labels every card `owned_by: "vllm"` and reports its real
 * window as `max_model_len`, while llama.cpp does neither. `dialect` is what
 * grammarFieldFor() turns into the right grammar encoding — getting this wrong
 * is silent, because a server accepts the field name it does not read.
 */
export async function discoverOpenAiServers({fetchImpl=fetch,ports=COMMON_MODEL_PORTS}={}){
 const results=await Promise.all(ports.map(async port=>{
  const apiUrl=`http://127.0.0.1:${port}/v1`;
  try{const r=await fetchImpl(apiUrl+'/models',{signal:AbortSignal.timeout(800),redirect:'error'});if(!r.ok)return null;
   const b=await r.json();const cards=(b?.data??[]).filter(m=>typeof m?.id==='string');
   if(!cards.length)return null;
   const window=Math.max(0,...cards.map(m=>Number(m?.max_model_len)||0));
   return {apiUrl,models:cards.map(m=>m.id),
    dialect:cards.some(m=>m?.owned_by==='vllm')?'vllm':'llamacpp',
    ...(window>0?{contextTokens:window}:{})};
  }catch{return null;}
 }));return results.filter(Boolean);
}
export async function discoverModelServers({fetchImpl=fetch,ports=COMMON_MODEL_PORTS}={}){
 // Projection only: callers that just need "which URL, which model ids" keep
 // the exact shape they have always received.
 return (await discoverOpenAiServers({fetchImpl,ports})).map(({apiUrl,models})=>({apiUrl,models}));
}
export function codexAvailable({run=execFileSync,command='codex'}={}){
 try{run(command,['--version'],{timeout:3000,stdio:'ignore'});return true;}catch{return false;}
}
export const connectionPath=home=>path.join(bantamConfigDirectory(home),'connection.json');
export function loadConnection(home){
 try{const c=JSON.parse(fs.readFileSync(connectionPath(home),'utf8'));if(c.kind==='codex'&&c.consent==='cloud-context-v1')return c;
  if(c.kind==='local'&&typeof c.name==='string')return c;
  if(c.kind==='api'&&normalizeServerUrl(c.apiUrl)===c.apiUrl&&typeof c.model==='string'&&['llamacpp','vllm','chat'].includes(c.dialect))return c;
 }catch{}return null;
}
export function saveConnection(value,home){
 const dest=connectionPath(home);fs.mkdirSync(path.dirname(dest),{recursive:true});
 fs.writeFileSync(dest,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.chmodSync(dest,0o600);return dest;
}
// Forget the remembered backend so the next bare run falls back to endpoint
// auto-detection. Opting into Codex is deliberately sticky, but before this
// there was no non-interactive exit: a remembered connection.json made every
// bare `bantam` cloud-only and suppressed detectEndpoint(), so a llama.cpp
// server answering on :8085 was never even probed.
export function clearConnection(home){
 const dest=connectionPath(home);
 try{fs.rmSync(dest,{force:true});return dest;}catch{return null;}
}
export async function chooseFirstRun({ask,out,discover=discoverModelServers,hasCodex=codexAvailable(),advanced=false}={}){
 out('\nWelcome to BANTAM — choose how to power your factory.\n');
 out('  [1] Use an existing model server (scan this PC or enter IP/port)\n');
 out('  [2] Codex subscription · Luna / Terra / Sol / Astra (explicit opt-in)\n');
 out(hasCodex?'      Codex CLI detected; uses your signed-in account and sends context to OpenAI.\n':'      Codex CLI not detected; installation/sign-in help is available. No automatic cloud use.\n');
 out('  [3] Easy mode: install stock DavidAU 27B (24GB NVIDIA GPU; confirmation required)\n');
 if(advanced)out('  [4] Advanced model menu\n');
 out('  [5] Experimental lower-VRAM Tiel 35B-A3B (CPU expert offload; about 32GB RAM)\n');
 out('  [q / Enter] Cancel — no installs or changes\n');
 const answer=(await ask('Select: ')).trim();
 if(answer==='3')return {kind:'install-stock'};
 if(answer==='5')return {kind:'install-stock',profile:'tiel-32k-cpu-experts'};
 if(answer==='2')return {kind:hasCodex?'choose-codex':'codex-help'};
 if(answer==='4'&&advanced)return {kind:'advanced'};
 if(answer!=='1')return null;
 const servers=await discover();
 servers.forEach((s,i)=>out(`  [${i+1}] ${s.apiUrl} · ${s.models.join(', ').slice(0,150)}\n`));
 const raw=await ask('Choose server number or enter IP:port / URL (Enter cancels): ');
 if(!raw.trim())return null;
 const selected=/^\d+$/.test(raw.trim())?servers[Number(raw)-1]:null;
 if(/^\d+$/.test(raw.trim())&&!selected)throw Error('Unknown server number');
 return {kind:'connect-api',apiUrl:selected?.apiUrl??normalizeServerUrl(raw),models:selected?.models??[]};
}
export async function confirmCodexConsent({ask,out,model}={}){
 out(`\nUse Codex ${model} with BANTAM?\nTask prompts and relevant project context will be sent to OpenAI through your installed Codex CLI.\nThis uses the signed-in account's access/quota (or API billing if Codex is signed in with an API key).\nModel availability depends on your account. BANTAM does not log in, buy access, or copy your credentials.\nYour choice will be remembered across folders; run bantam setup to change it.\n`);
 return /^y(es)?$/i.test((await ask('Agree and enable Codex for BANTAM? [y/N] ')).trim());
}
