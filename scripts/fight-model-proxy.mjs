// Transparent, loopback-only evidence recorder for local fight contenders.
// Bodies are forwarded unchanged. No Authorization headers are retained or forwarded.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {usageFromResponse} from '../src/model-usage.js';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const generation = route => ['/completion','/completions','/v1/completions','/v1/chat/completions','/chat/completions'].includes(route);
const allowed = new Set(['/health','/props','/slots','/v1/models','/models','/api/v1/models','/tokenize','/detokenize','/apply-template','/completion','/completions','/v1/completions','/v1/chat/completions','/chat/completions']);
const diagnostics = new Set(['/health','/props','/slots','/v1/models','/models','/api/v1/models']);
const counter = value => Number.isSafeInteger(value) && value >= 0;

export function responseUsage(raw, contentType = '') {
  let objects = [];
  if (contentType.includes('event-stream')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { objects.push(JSON.parse(line.slice(5).trim())); } catch {}
    }
  } else { try { objects = [JSON.parse(raw)]; } catch {} }
  const final = {};
  for (const item of objects) {
    for (const key of ['usage','timings','tokens_evaluated','tokens_predicted','tokens_cached','truncated','stopped_limit']) {
      if (item[key] != null) final[key] = item[key];
    }
  }
  const hasInput = final.usage?.prompt_tokens != null || final.tokens_evaluated != null || final.timings?.prompt_n != null;
  const hasOutput = final.usage?.completion_tokens != null || final.tokens_predicted != null || final.timings?.predicted_n != null;
  if (!hasInput || !hasOutput) return null;
  const input=final.usage?.prompt_tokens ?? final.tokens_evaluated ?? final.timings?.prompt_n;
  const output=final.usage?.completion_tokens ?? final.tokens_predicted ?? final.timings?.predicted_n;
  const cache=final.usage?.prompt_cache_hit_tokens ?? final.usage?.prompt_tokens_details?.cached_tokens ?? final.timings?.cache_n;
  if(!counter(input)||!counter(output)||(cache!=null&&(!counter(cache)||cache>input)))return null;
  // Legacy tokens_cached is cache population, not comparable prefix reuse.
  // Without a true prefix counter, leave the cache total unknown.
  const normalized = usageFromResponse(final);
  const cacheReported = final.usage?.prompt_cache_hit_tokens != null || final.usage?.prompt_tokens_details?.cached_tokens != null
    || final.timings?.cache_n != null;
  return {inputTokens:normalized.inputTokens, outputTokens:normalized.outputTokens,
    cacheHitTokens:cacheReported ? normalized.cacheHitTokens : null,
    freshInputTokens:cacheReported ? normalized.inputTokens-normalized.cacheHitTokens : null,
    truncated:final.truncated ?? null, stoppedLimit:final.stopped_limit ?? null, timings:final.timings ?? null};
}

export function aggregateExchanges(exchanges) {
  const calls = exchanges.filter(row => row.generation);
  const measured = calls.filter(row => row.usage);
  const complete = calls.length > 0 && measured.length === calls.length && calls.every(row => row.finished && row.status === 200);
  const cacheComplete = complete && measured.every(row => row.usage.cacheHitTokens != null);
  const sum = key => measured.reduce((n,row)=>n+(row.usage[key] ?? 0),0);
  const input = sum('inputTokens');
  return {source:'local-wire-receipts',requests:calls.length,measuredRequests:measured.length,complete,
    inputTokens:complete ? input : null, outputTokens:complete ? sum('outputTokens') : null,
    cacheHitTokens:cacheComplete ? sum('cacheHitTokens') : null,
    freshInputTokens:cacheComplete ? sum('freshInputTokens') : null,
    prefixReuse:cacheComplete && input ? sum('cacheHitTokens')/input : null,
    observedPartial:{inputTokens:input,outputTokens:sum('outputTokens')},
    requestBytes:calls.reduce((n,r)=>n+r.requestBytes,0),
    responseBytes:calls.reduce((n,r)=>n+(r.responseBytes ?? 0),0)};
}

export async function startModelRecorder({upstream, output, maxBodyBytes=16*1024*1024}) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/') {
    throw Error('upstream must be a loopback HTTP origin without credentials');
  }
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw Error('recorder requires a fresh absolute directory');
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const exchanges = [], sockets = new Set(), outgoing = new Set();
  const append = row => fs.appendFileSync(path.join(output,'exchanges.jsonl'),JSON.stringify(row)+'\n');
  const server = http.createServer(async(req,res)=>{
    if(!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\')){res.writeHead(403);res.end('origin-form model route required');return;}
    const route = new URL(req.url,'http://localhost').pathname;
    if (!allowed.has(route) || req.method !== (diagnostics.has(route)?'GET':'POST')) {res.writeHead(403);res.end('route outside benchmark model API');return;}
    let body;
    try {
      const chunks=[];let size=0;
      for await (const chunk of req) {size+=chunk.length;if(size>maxBodyBytes)throw Error('request body limit');chunks.push(chunk);}
      body=Buffer.concat(chunks);
    } catch {if(!res.destroyed){res.writeHead(413);res.end('request body limit');}return;}
    const index=exchanges.length+1, stem=String(index).padStart(5,'0');
    const row={index,route,method:req.method,generation:generation(route),startedAt:new Date().toISOString(),
      requestBytes:body.length,requestSha256:sha(body),finished:false};
    exchanges.push(row);
    fs.writeFileSync(path.join(output,`${stem}.request.body`),body,{flag:'wx',mode:0o600});
    // Record only inference settings, never request headers (which can contain credentials).
    try {const parsed=JSON.parse(body);row.settings=Object.fromEntries(['model','temperature','top_p','top_k','min_p','seed','max_tokens','max_completion_tokens','n_predict','cache_prompt','stream','reasoning_effort','chat_template_kwargs'].filter(k=>k in parsed).map(k=>[k,parsed[k]]));}catch{}
    append({...row,phase:'request'});
    const started=Date.now(), received=[];
    let receivedBytes=0, completed=false, responseFd;
    try {responseFd=fs.openSync(path.join(output,`${stem}.response.body`),'wx',0o600);}catch(error){res.writeHead(500);res.end('recorder file error');row.error=error.message;append({...row,phase:'response'});return;}
    const finish = (error=null)=>{
      if(completed)return;completed=true;
      fs.closeSync(responseFd);
      const raw=Buffer.concat(received);
      row.wallMs=Date.now()-started;row.responseBytes=receivedBytes;row.responseSha256=sha(raw);
      row.finished=!error;row.error=error ? String(error.message ?? error) : null;
      row.usage=row.generation ? responseUsage(raw.toString('utf8'),row.contentType) : null;
      append({...row,phase:'response'});
    };
    const destination=new URL(target);destination.pathname=route;destination.search=new URL(req.url,'http://localhost').search;
    const upstreamRequest=http.request(destination,{method:req.method,headers:{'content-type':req.headers['content-type'] ?? 'application/json','content-length':String(body.length)}},upstreamResponse=>{
      row.status=upstreamResponse.statusCode;row.contentType=upstreamResponse.headers['content-type'] ?? '';
      res.writeHead(row.status,{'content-type':row.contentType});
      upstreamResponse.on('data',chunk=>{
        if(completed)return;
        receivedBytes+=chunk.length;
        if(receivedBytes>maxBodyBytes){upstreamRequest.destroy(Error('response body limit'));return;}
        received.push(chunk);fs.writeSync(responseFd,chunk);
        if(!res.destroyed && !res.write(chunk)){upstreamResponse.pause();res.once('drain',()=>upstreamResponse.resume());}
      });
      upstreamResponse.once('end',()=>{finish();res.end();});
      upstreamResponse.once('error',error=>{finish(error);res.destroy();});
      upstreamResponse.once('aborted',()=>{finish(Error('upstream aborted'));res.destroy();});
    });
    outgoing.add(upstreamRequest);
    upstreamRequest.once('close',()=>outgoing.delete(upstreamRequest));
    upstreamRequest.once('error',error=>{finish(error);if(!res.headersSent)res.writeHead(502);res.end('model upstream error');});
    res.once('close',()=>{if(!res.writableEnded){finish(Error('client disconnected'));upstreamRequest.destroy();}});
    upstreamRequest.end(body);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {endpoint:`http://127.0.0.1:${server.address().port}`,exchanges,
    async close(){for(const request of outgoing)request.destroy(Error('recorder closing'));for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
      const usage=aggregateExchanges(exchanges);fs.writeFileSync(path.join(output,'usage.json'),JSON.stringify(usage,null,2)+'\n');return usage;}};
}
