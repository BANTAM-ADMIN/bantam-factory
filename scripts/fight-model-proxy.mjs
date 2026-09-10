// Transparent, loopback-only evidence recorder for local fight contenders.
// Bodies are forwarded unchanged. No Authorization headers are retained or forwarded.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const generation = route => ['/completion','/completions','/v1/completions','/v1/chat/completions','/chat/completions'].includes(route);
const allowed = new Set(['/health','/props','/slots','/v1/models','/models','/api/v1/models','/tokenize','/detokenize','/apply-template','/completion','/completions','/v1/completions','/v1/chat/completions','/chat/completions']);
const diagnostics = new Set(['/health','/props','/slots','/v1/models','/models','/api/v1/models']);
const counter = value => Number.isSafeInteger(value) && value >= 0;
const fields = ['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'];

function responseSummary(raw, contentType = '') {
  let objects = [];
  if (contentType.includes('event-stream')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { objects.push(JSON.parse(line.slice(5).trim())); } catch {}
    }
  } else { try { objects = [JSON.parse(raw)]; } catch {} }
  const final = {};
  for (const item of objects) {
    for (const key of ['usage','timings','tokens_evaluated','tokens_predicted','tokens_cached','truncated','stopped_limit','stop_type']) {
      if (item[key] != null) final[key] = item[key];
    }
  }
  return final;
}

function measurementsFromSummary(final) {
  let input=final.usage?.prompt_tokens ?? final.tokens_evaluated;
  const output=final.usage?.completion_tokens ?? final.tokens_predicted ?? final.timings?.predicted_n;
  const cache=final.usage?.prompt_cache_hit_tokens ?? final.usage?.prompt_tokens_details?.cached_tokens ?? final.timings?.cache_n;
  // llama.cpp prompt_n is freshly evaluated input, not the complete prompt.
  if(input==null && counter(final.timings?.prompt_n) && counter(cache)) input=final.timings.prompt_n+cache;
  const invalid = (input!=null&&!counter(input)) || (output!=null&&!counter(output))
    || (cache!=null&&(!counter(cache)||(counter(input)&&cache>input)));
  const inputTokens=counter(input)?input:null, outputTokens=counter(output)?output:null;
  const cacheHitTokens=counter(cache)&&(inputTokens==null||cache<=inputTokens)?cache:null;
  // Legacy tokens_cached describes cache population, never prefix reuse.
  return {values:{inputTokens,outputTokens,cacheHitTokens,
    freshInputTokens:inputTokens!=null&&cacheHitTokens!=null?inputTokens-cacheHitTokens:null},invalid};
}

export function responseMeasurements(raw, contentType = '') {
  return measurementsFromSummary(responseSummary(raw,contentType)).values;
}

export function responseUsage(raw, contentType = '') {
  const final=responseSummary(raw,contentType), {values,invalid}=measurementsFromSummary(final);
  if(invalid||values.inputTokens==null||values.outputTokens==null)return null;
  // Current native llama.cpp reports stop_type instead of the old boolean.
  // Keep an unreported reason unknown; token totals alone do not prove a stop.
  const stoppedLimit=final.stop_type==='limit'||final.stopped_limit===true ? true
    : typeof final.stopped_limit==='boolean' ? final.stopped_limit
      : ['eos','word'].includes(final.stop_type) ? false : null;
  return {...values,truncated:final.truncated??null,stoppedLimit,timings:final.timings??null};
}

export function aggregateExchanges(exchanges) {
  const calls = exchanges.filter(row => row.generation);
  const values=new Map(calls.map(row=>{
    const raw=row.status===200?(row.measurements??row.usage):null;
    const value=Object.fromEntries(fields.map(field=>[field,counter(raw?.[field])?raw[field]:null]));
    if(value.inputTokens!=null&&value.cacheHitTokens>value.inputTokens){value.cacheHitTokens=null;value.freshInputTokens=null;}
    if(value.inputTokens!=null&&value.freshInputTokens!=null&&(value.freshInputTokens>value.inputTokens
        ||(value.cacheHitTokens!=null&&value.cacheHitTokens+value.freshInputTokens!==value.inputTokens)))value.freshInputTokens=null;
    return [row,value];
  }));
  const measured = calls.filter(row => row.status===200 && counter(row.usage?.inputTokens) && counter(row.usage?.outputTokens));
  const transportComplete = calls.length > 0 && measured.length === calls.length && calls.every(row => row.finished && row.status === 200);
  const coverage={},measuredSubset={};
  for(const field of fields){
    const known=calls.filter(row=>counter(values.get(row)[field]));
    const sum=known.reduce((n,row)=>n+values.get(row)[field],0);
    measuredSubset[field]=known.length&&counter(sum)?sum:null;
    const knownSet=new Set(known);
    coverage[field]={measuredRequests:known.length,totalRequests:calls.length,
      complete:calls.length>0&&known.length===calls.length&&counter(sum),
      missingRequestIndices:calls.filter(row=>!knownSet.has(row)).map(row=>row.index??null)};
  }
  // A ratio needs the same measured requests in numerator and denominator.
  const cacheInputSame=calls.every(row=>{
    const value=values.get(row);
    return counter(value?.inputTokens)===counter(value?.cacheHitTokens);
  });
  measuredSubset.prefixReuse=cacheInputSame&&measuredSubset.inputTokens>0&&measuredSubset.cacheHitTokens!=null
    ?measuredSubset.cacheHitTokens/measuredSubset.inputTokens:null;
  const complete=transportComplete&&coverage.inputTokens.complete&&coverage.outputTokens.complete;
  const cacheComplete=complete&&coverage.cacheHitTokens.complete&&coverage.freshInputTokens.complete;
  const input=measuredSubset.inputTokens;
  const sumBytes=key=>{if(calls.some(row=>!counter(row[key]??0)))return null;
    const value=calls.reduce((n,row)=>n+(row[key]??0),0);return counter(value)?value:null;};
  return {source:'local-wire-receipts',requests:calls.length,measuredRequests:measured.length,complete,
    inputTokens:complete ? input : null, outputTokens:complete ? measuredSubset.outputTokens : null,
    cacheHitTokens:cacheComplete ? measuredSubset.cacheHitTokens : null,
    freshInputTokens:cacheComplete ? measuredSubset.freshInputTokens : null,
    prefixReuse:cacheComplete ? measuredSubset.prefixReuse : null,
    measuredSubset,coverage,
    observedPartial:{inputTokens:measuredSubset.inputTokens??0,outputTokens:measuredSubset.outputTokens??0},
    requestBytes:sumBytes('requestBytes'),responseBytes:sumBytes('responseBytes')};
}

export async function startModelRecorder({upstream, output, maxBodyBytes=16*1024*1024}) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/') {
    throw Error('upstream must be a loopback HTTP origin without credentials');
  }
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw Error('recorder requires a fresh absolute directory');
  if(!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1)throw Error('positive safe body limit required');
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const exchanges = [], sockets = new Set(), outgoing = new Set(), active = new Set(), handlers = new Set();
  let closing=false,closePromise;
  const append = row => fs.appendFileSync(path.join(output,'exchanges.jsonl'),JSON.stringify(row)+'\n');
  const handle=async(req,res)=>{
    if(closing){res.writeHead(503);res.end('recorder closing');return;}
    if(!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\')){res.writeHead(403);res.end('origin-form model route required');return;}
    const route = new URL(req.url,'http://localhost').pathname;
    if (!allowed.has(route) || req.method !== (diagnostics.has(route)?'GET':'POST')) {res.writeHead(403);res.end('route outside benchmark model API');return;}
    let body;
    try {
      const chunks=[];let size=0;
      for await (const chunk of req) {size+=chunk.length;if(size>maxBodyBytes)throw Error('request body limit');chunks.push(chunk);}
      body=Buffer.concat(chunks);
    } catch {if(!res.destroyed){res.writeHead(413);res.end('request body limit');}return;}
    if(closing||res.destroyed){if(!res.destroyed){res.writeHead(503);res.end('recorder closing');}return;}
    const index=exchanges.length+1, stem=String(index).padStart(5,'0');
    const row={index,route,method:req.method,generation:generation(route),startedAt:new Date().toISOString(),
      requestBytes:body.length,requestSha256:sha(body),finished:false};
    exchanges.push(row);
    fs.writeFileSync(path.join(output,`${stem}.request.body`),body,{flag:'wx',mode:0o600});
    // Record only inference settings, never request headers (which can contain credentials).
    try {const parsed=JSON.parse(body);row.settings=Object.fromEntries(['model','temperature','top_p','top_k','min_p','seed','max_tokens','max_completion_tokens','n_predict','cache_prompt','stream','reasoning_effort','chat_template_kwargs'].filter(k=>k in parsed).map(k=>[k,parsed[k]]));}catch{}
    append({...row,phase:'request'});
    const started=Date.now(), received=[];
    let receivedBytes=0,completed=false,responseFd,upstreamRequest,upstreamResponse,drain;
    const state={upstreamEnded:false,clientDisconnected:false,recorderClosing:false};
    const control={cancel:()=>cancel('recorder-closing',Error('recorder closing'))};
    const finish = (reason,error=null)=>{
      if(completed)return;completed=true;
      if(drain)res.removeListener('drain',drain);
      if(responseFd!==undefined)fs.closeSync(responseFd);
      const raw=Buffer.concat(received);
      row.wallMs=Date.now()-started;row.responseBytes=receivedBytes;row.responseSha256=sha(raw);
      row.finished=reason==='upstream-ended';row.error=error ? String(error.message ?? error) : null;
      row.usage=row.generation ? responseUsage(raw.toString('utf8'),row.contentType) : null;
      row.measurements=row.generation?responseMeasurements(raw.toString('utf8'),row.contentType):null;
      row.settlement={reason,at:new Date().toISOString(),...state};
      append({...row,phase:'response'});
      active.delete(control);
    };
    const cancel=(reason,error)=>{
      if(completed)return;
      if(reason==='client-disconnected')state.clientDisconnected=true;
      if(reason==='recorder-closing')state.recorderClosing=true;
      finish(reason,error);
      upstreamResponse?.destroy();upstreamRequest?.destroy();
    };
    active.add(control);
    try {responseFd=fs.openSync(path.join(output,`${stem}.response.body`),'wx',0o600);}
    catch(error){finish('recorder-file-error',error);res.writeHead(500);res.end('recorder file error');return;}
    const destination=new URL(target);destination.pathname=route;destination.search=new URL(req.url,'http://localhost').search;
    upstreamRequest=http.request(destination,{method:req.method,headers:{'content-type':req.headers['content-type'] ?? 'application/json','content-length':String(body.length)}},response=>{
      upstreamResponse=response;
      if(completed){response.destroy();return;}
      row.status=response.statusCode;row.contentType=response.headers['content-type'] ?? '';
      res.writeHead(row.status,{'content-type':row.contentType});
      response.on('data',chunk=>{
        if(completed)return;
        if(receivedBytes+chunk.length>maxBodyBytes){cancel('response-body-limit',Error('response body limit'));res.destroy();return;}
        try{fs.writeSync(responseFd,chunk);}catch(error){cancel('recorder-file-error',error);res.destroy();return;}
        receivedBytes+=chunk.length;received.push(chunk);
        if(!res.destroyed && !res.write(chunk)){
          response.pause();drain=()=>{drain=null;if(!completed)response.resume();};res.once('drain',drain);
        }
      });
      response.once('end',()=>{state.upstreamEnded=true;finish('upstream-ended');res.end();});
      response.once('error',error=>{finish('upstream-error',error);res.destroy();});
      response.once('aborted',()=>{finish('upstream-aborted',Error('upstream aborted'));res.destroy();});
      response.once('close',()=>{if(!completed){finish('upstream-closed',Error('upstream closed before end'));res.destroy();}});
    });
    outgoing.add(upstreamRequest);
    upstreamRequest.once('close',()=>outgoing.delete(upstreamRequest));
    upstreamRequest.once('error',error=>{finish('upstream-error',error);if(!res.destroyed){if(!res.headersSent)res.writeHead(502);res.end('model upstream error');}});
    res.once('close',()=>{if(!res.writableEnded)cancel('client-disconnected',Error('client disconnected'));});
    upstreamRequest.end(body);
  };
  const server = http.createServer((req,res)=>{
    const handling=handle(req,res).catch(error=>{if(!res.destroyed){if(!res.headersSent)res.writeHead(500);res.end('recorder failure');}server.emit('recorder-error',error);});
    handlers.add(handling);handling.finally(()=>handlers.delete(handling));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {endpoint:`http://127.0.0.1:${server.address().port}`,exchanges,
    close(){
      if(!closePromise)closePromise=(async()=>{
        closing=true;
        const closed=new Promise(resolve=>server.close(resolve));
        const upstreamClosed=Promise.all([...outgoing].map(request=>request.closed?Promise.resolve()
          :new Promise(resolve=>request.once('close',resolve))));
        // Settle admitted rows synchronously before destroying sockets. Do not
        // drain an unfinished generation beyond the contender's deadline.
        for(const control of [...active])control.cancel();
        for(const request of outgoing)request.destroy();
        for(const socket of sockets)socket.destroy();
        await closed;await upstreamClosed;await Promise.all([...handlers]);
        if(exchanges.some(row=>!row.settlement))throw Error('unsettled admitted recorder request');
        const usage=aggregateExchanges(exchanges);fs.writeFileSync(path.join(output,'usage.json'),JSON.stringify(usage,null,2)+'\n');return usage;
      })();
      return closePromise;
    }};
}
