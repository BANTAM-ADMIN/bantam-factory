// Independent usage reconciliation. Missing or malformed evidence is unknown.
import fs from 'node:fs';
import path from 'node:path';

const count=value=>Number.isSafeInteger(value)&&value>=0;
export function codexSessionUsage(directory){
  const calls=new Map(),errors=[];
  function walk(dir){
    if(!fs.existsSync(dir))return;
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,e.name);
      if(e.isSymbolicLink()){errors.push('symlink evidence skipped');continue;}
      if(e.isDirectory())walk(file);
      else if(e.isFile()&&e.name.endsWith('.jsonl')){
        for(const line of fs.readFileSync(file,'utf8').split('\n')){
          if(!line.trim())continue;
          let row;try{row=JSON.parse(line);}catch{errors.push('malformed session line');continue;}
          if(row.type!=='token_usage_record')continue;
          const p=row.payload,u=p?.usage;
          if(typeof p?.response_id!=='string'||!u||!['input_tokens','cached_input_tokens','output_tokens'].every(k=>count(u[k]))||u.cached_input_tokens>u.input_tokens){errors.push('invalid native usage record');continue;}
          const value={inputTokens:u.input_tokens,cacheHitTokens:u.cached_input_tokens,outputTokens:u.output_tokens,reasoningTokens:u.reasoning_output_tokens??0};
          if(!count(value.reasoningTokens)){errors.push('invalid reasoning usage');continue;}
          const old=calls.get(p.response_id);
          if(old&&JSON.stringify(old.usage)!==JSON.stringify(value)){errors.push('conflicting duplicate response usage');continue;}
          calls.set(p.response_id,{responseId:p.response_id,timestamp:row.timestamp,threadId:p.thread_id,usage:value});
        }
      }
    }
  }
  walk(directory);
  if(!calls.size)return null;
  const sum=key=>[...calls.values()].reduce((n,r)=>n+r.usage[key],0);
  const input=sum('inputTokens'),cache=sum('cacheHitTokens');
  return {source:'codex-native-response-records',complete:errors.length===0,requests:calls.size,inputTokens:input,cacheHitTokens:cache,
    freshInputTokens:input-cache,outputTokens:sum('outputTokens'),reasoningTokens:sum('reasoningTokens'),prefixReuse:input?cache/input:null,errors,
    calls:[...calls.values()]};
}

export function parseServerCounters(text){
  const names=['prompt_tokens_total','prompt_tokens_cached_total','tokens_predicted_total','prompt_seconds_total','tokens_predicted_seconds_total','requests_processing','requests_deferred'];
  const counters={};
  for(const name of names){const line=text.split('\n').find(line=>line.startsWith(`llamacpp:${name} `));if(line){const n=Number(line.split(' ')[1]);if(Number.isFinite(n)&&n>=0)counters[name]=n;}}
  return counters;
}
export async function serverCounters(endpoint,{timeoutMs=5000}={}){
  const r=await fetch(endpoint.replace(/\/$/,'')+'/metrics',{signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok)throw Error('server metrics unavailable');
  const raw=await r.text();return {at:new Date().toISOString(),raw,counters:parseServerCounters(raw)};
}

// Closing an HTTP recorder does not prove a canceled generation has stopped.
// Preserve every observation and require two unchanged idle samples. This is
// supplementary global accounting, never a replacement for missing wire usage.
export async function settleServerCounters(endpoint,{timeoutMs=10000,pollMs=250}={},
  {read=serverCounters,now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000
    ||!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>timeoutMs)throw Error('invalid counter settlement limits');
  const started=now(),samples=[];
  let previousIdle=null,observedBusy=false;
  const finish=reason=>({schema:'bantam.server-counter-settlement.v1',settled:reason==='idle',reason,
    elapsedMs:Math.max(0,now()-started),observedBusy,samples,after:samples.at(-1)??null});
  const totals=['prompt_tokens_total','prompt_tokens_cached_total','tokens_predicted_total'];
  while(now()-started<timeoutMs){
    let snapshot;
    try{snapshot=await read(endpoint,{timeoutMs:Math.max(1,Math.min(5000,Math.ceil(timeoutMs-(now()-started))))});}
    catch(error){snapshot={at:new Date().toISOString(),unavailable:true,error:error.message};}
    samples.push(snapshot);
    if(snapshot.unavailable)return finish('unavailable');
    const c=snapshot.counters;
    if(!c||!count(c.requests_processing)||!count(c.requests_deferred))return finish('missing-activity-counters');
    const idle=c.requests_processing===0&&c.requests_deferred===0;
    observedBusy ||= !idle;
    if(idle&&previousIdle&&totals.every(key=>count(c[key])&&c[key]===previousIdle[key]))return finish('idle');
    previousIdle=idle?c:null;
    const remaining=timeoutMs-(now()-started);
    if(remaining>0)await sleep(Math.min(pollMs,remaining));
  }
  return finish('timeout');
}
export function counterDelta(before,after){
  const a=before?.counters,b=after?.counters;
  const fields=['prompt_tokens_total','prompt_tokens_cached_total','tokens_predicted_total'];
  if(!a||!b||fields.some(k=>!count(a[k])||!count(b[k])||b[k]<a[k]))return null;
  const fresh=b.prompt_tokens_total-a.prompt_tokens_total,cache=b.prompt_tokens_cached_total-a.prompt_tokens_cached_total;
  return {source:'server-counter-window',freshInputTokens:fresh,cacheHitTokens:cache,inputTokens:fresh+cache,outputTokens:b.tokens_predicted_total-a.tokens_predicted_total,
    promptSeconds:b.prompt_seconds_total-a.prompt_seconds_total,generationSeconds:b.tokens_predicted_seconds_total-a.tokens_predicted_seconds_total,
    idleBefore:a.requests_processing===0&&a.requests_deferred===0,idleAfter:b.requests_processing===0&&b.requests_deferred===0,
    attribution:'Global endpoint counters in this serial-run window; attribution assumes no external inference client.'};
}
