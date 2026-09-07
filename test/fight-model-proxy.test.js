import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {responseUsage,responseMeasurements,aggregateExchanges,startModelRecorder} from '../scripts/fight-model-proxy.mjs';

test('wire usage uses final cumulative SSE usage once and cache_n, not populated KV size',()=>{
  const usage=responseUsage('data: {"content":"x"}\n\ndata: {"tokens_evaluated":100,"tokens_predicted":20,"tokens_cached":120,"timings":{"cache_n":70}}\n\ndata: [DONE]\n','text/event-stream');
  assert.equal(usage.inputTokens,100);assert.equal(usage.cacheHitTokens,70);assert.equal(usage.freshInputTokens,30);
  assert.equal(responseUsage('data: {"content":"no terminal usage"}\n','text/event-stream'),null);
});
test('incomplete usage is unknown, not a low total',()=>{
  const result=aggregateExchanges([{generation:true,finished:false,status:200,requestBytes:1,usage:null}]);
  assert.equal(result.complete,false);assert.equal(result.inputTokens,null);assert.equal(result.cacheHitTokens,null);
});
test('malformed counters and impossible prefix values are unknown',()=>{
  for(const usage of [{prompt_tokens:'10',completion_tokens:1},{prompt_tokens:10,completion_tokens:-1},
    {prompt_tokens:10,completion_tokens:1,prompt_tokens_details:{cached_tokens:11}}])assert.equal(responseUsage(JSON.stringify({usage})),null);
  assert.equal(responseUsage(JSON.stringify({tokens_evaluated:10,tokens_predicted:1,tokens_cached:11})).cacheHitTokens,null);
});
test('records exact bodies without forwarding authorization or changing sampling',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-wire-test-'));
  const body='{"temperature":0.6,"messages":[{"role":"user","content":"héllo"}],"stream":true}';
  let delivered=null,auth=null;
  const upstream=http.createServer(async(req,res)=>{auth=req.headers.authorization;const chunks=[];for await(const chunk of req)chunks.push(chunk);delivered=Buffer.concat(chunks).toString();res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}}\n\ndata: [DONE]\n');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const recorder=await startModelRecorder({upstream:`http://127.0.0.1:${upstream.address().port}`,output:path.join(tmp,'receipt')});
  try {
    const res=await fetch(recorder.endpoint+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer never-log-this','content-type':'application/json'},body});
    await res.text();assert.equal(delivered,body);assert.equal(auth,undefined);
    assert.equal((await fetch(recorder.endpoint+'/arbitrary')).status,403);
    assert.equal((await fetch(recorder.endpoint+'/props',{method:'POST',body:'{}'})).status,403);
    const absoluteStatus=await new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:new URL(recorder.endpoint).port,path:'http://example.invalid/v1/chat/completions',method:'POST'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{}');
    });
    assert.equal(absoluteStatus,403);
    const usage=await recorder.close();assert.equal(usage.inputTokens,10);assert.equal(usage.freshInputTokens,7);
    assert.equal(fs.readFileSync(path.join(tmp,'receipt/00001.request.body'),'utf8'),body);
    assert.ok(!fs.readFileSync(path.join(tmp,'receipt/exchanges.jsonl'),'utf8').includes('never-log-this'));
  } finally {upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
});

test('per-field coverage exposes only measured counters, never inventing missing cache or output',()=>{
  const rows=[
    {index:1,generation:true,finished:true,status:200,requestBytes:1,
      usage:responseUsage('{"usage":{"prompt_tokens":10,"completion_tokens":2}}')},
    {index:2,generation:true,finished:false,status:200,requestBytes:1,
      measurements:responseMeasurements('{"usage":{"prompt_tokens":20,"prompt_tokens_details":{"cached_tokens":12}}}')},
    {index:3,generation:true,finished:false,status:200,requestBytes:1,usage:null},
  ];
  const result=aggregateExchanges(rows);
  assert.equal(result.complete,false);assert.equal(result.inputTokens,null);assert.equal(result.outputTokens,null);
  assert.deepEqual(result.measuredSubset,{inputTokens:30,outputTokens:2,cacheHitTokens:12,freshInputTokens:8,prefixReuse:null});
  assert.deepEqual(result.coverage.inputTokens,{measuredRequests:2,totalRequests:3,complete:false,missingRequestIndices:[3]});
  assert.deepEqual(result.coverage.outputTokens.missingRequestIndices,[2,3]);
  assert.deepEqual(result.coverage.cacheHitTokens.missingRequestIndices,[1,3]);
  const absent=aggregateExchanges([rows[2]]);
  assert.equal(absent.measuredSubset.inputTokens,null);assert.equal(absent.measuredSubset.cacheHitTokens,null);
  assert.equal(aggregateExchanges([]).coverage.inputTokens.complete,false);
});

test('timings-only total input includes cached prefix, while invalid fields remain individually unknown',()=>{
  assert.deepEqual(responseMeasurements('{"timings":{"prompt_n":4,"cache_n":8,"predicted_n":2}}'),
    {inputTokens:12,outputTokens:2,cacheHitTokens:8,freshInputTokens:4});
  assert.equal(responseUsage('{"timings":{"prompt_n":4,"predicted_n":2}}'),null,
    'fresh input alone cannot prove complete prompt size');
  assert.deepEqual(responseMeasurements('{"usage":{"prompt_tokens":10,"completion_tokens":-1,"prompt_tokens_details":{"cached_tokens":3}}}'),
    {inputTokens:10,outputTokens:null,cacheHitTokens:3,freshInputTokens:7});
  assert.deepEqual(responseMeasurements('{"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":11}}}'),
    {inputTokens:10,outputTokens:2,cacheHitTokens:null,freshInputTokens:null});
});

test('aggregate rejects impossible saved cache arithmetic and safe-integer overflow',()=>{
  const row={index:1,generation:true,finished:true,status:200,requestBytes:1,
    usage:{inputTokens:10,outputTokens:2,cacheHitTokens:11,freshInputTokens:0}};
  const invalid=aggregateExchanges([row]);
  assert.equal(invalid.measuredSubset.cacheHitTokens,null);assert.equal(invalid.measuredSubset.prefixReuse,null);
  const overflow=aggregateExchanges([row,row].map((value,index)=>({...value,index:index+1,
    usage:{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:2,cacheHitTokens:0,freshInputTokens:Number.MAX_SAFE_INTEGER}})));
  assert.equal(overflow.complete,false);assert.equal(overflow.inputTokens,null);
  assert.equal(overflow.coverage.inputTokens.complete,false);
});

const terminal='data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}}\n\n';
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
async function until(check){const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw Error('test condition timed out');await tick();}}
async function fixture(t,handler,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-wire-lifecycle-'));
  const upstream=http.createServer(handler);
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const output=path.join(root,'wire');
  const recorder=await startModelRecorder({upstream:`http://127.0.0.1:${upstream.address().port}`,output,...options});
  t.after(async()=>{await recorder.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const request=callback=>{
    const req=http.request(recorder.endpoint+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'}},callback);
    req.on('error',()=>{});req.end('{"stream":true}');return req;
  };
  return {recorder,output,request};
}
function finalizedRows(output){return fs.readFileSync(path.join(output,'exchanges.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.phase==='response');}

test('disconnect before upstream headers settles the admitted row exactly once',async t=>{
  let entered=false,upstreamClosed=false;
  const f=await fixture(t,(req,res)=>{req.resume();entered=true;res.on('close',()=>{upstreamClosed=true;});});
  const client=f.request(()=>{});await until(()=>entered);client.destroy();
  await until(()=>f.recorder.exchanges[0]?.settlement);
  const usage=await f.recorder.close();
  await until(()=>upstreamClosed);
  const rows=finalizedRows(f.output);
  assert.equal(rows.length,1);assert.equal(rows[0].settlement.reason,'client-disconnected');
  assert.equal(rows[0].responseBytes,0);assert.equal(rows[0].finished,false);
  assert.equal(usage.requests,1);assert.equal(usage.measuredSubset.outputTokens,null);
});

test('mid-SSE disconnect keeps partial bytes but cannot certify unreported token totals',async t=>{
  const f=await fixture(t,(req,res)=>{req.resume();res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');});
  f.request(res=>{res.on('error',()=>{});res.once('data',()=>res.destroy());});
  await until(()=>f.recorder.exchanges[0]?.settlement);
  const usage=await f.recorder.close(),row=finalizedRows(f.output)[0];
  assert.equal(row.settlement.reason,'client-disconnected');assert.ok(row.responseBytes>0);
  assert.equal(usage.measuredRequests,0);assert.equal(usage.outputTokens,null);
  assert.equal(usage.measuredSubset.outputTokens,null);
  const raw=fs.readFileSync(path.join(f.output,'00001.response.body'));
  assert.equal(row.responseBytes,raw.length);assert.equal(row.responseSha256,crypto.createHash('sha256').update(raw).digest('hex'));
});

test('terminal usage received before client disconnect remains measured, but transport completion remains false',async t=>{
  const f=await fixture(t,(req,res)=>{req.resume();res.writeHead(200,{'content-type':'text/event-stream'});res.write(terminal);});
  f.request(res=>{res.on('error',()=>{});res.once('data',()=>res.destroy());});
  await until(()=>f.recorder.exchanges[0]?.settlement);
  const usage=await f.recorder.close();
  assert.equal(usage.complete,false);assert.equal(usage.inputTokens,null);assert.equal(usage.measuredRequests,1);
  assert.deepEqual(usage.measuredSubset,{inputTokens:10,outputTokens:2,cacheHitTokens:3,freshInputTokens:7,prefixReuse:0.3});
  assert.equal(usage.coverage.inputTokens.complete,true,'counter coverage is distinct from HTTP completion');
});

test('close cancels paused/backpressured responses and leaves one consistent captured-body receipt',async t=>{
  let upstreamClosed=false,upstreamBackpressure=false;
  const payload=Buffer.alloc(8*1024*1024,120);
  const f=await fixture(t,(req,res)=>{req.resume();res.on('close',()=>{upstreamClosed=true;});
    res.writeHead(200,{'content-type':'text/event-stream'});upstreamBackpressure=!res.write(payload);});
  let response;
  f.request(res=>{response=res;res.on('error',()=>{});res.pause();});
  await until(()=>response&&f.recorder.exchanges[0]?.status===200);
  const usage=await f.recorder.close();await until(()=>upstreamClosed);
  assert.equal(upstreamBackpressure,true);assert.equal(usage.complete,false);
  const rows=finalizedRows(f.output);assert.equal(rows.length,1);assert.equal(rows[0].settlement.reason,'recorder-closing');
  assert.equal(rows[0].responseBytes,fs.statSync(path.join(f.output,'00001.response.body')).size);
  assert.ok(rows[0].responseBytes<payload.length,'paused downstream does not force unbounded draining');
});

test('close is idempotent and finalizes every admitted row before writing usage even without upstream headers',async t=>{
  let entered=0;
  const f=await fixture(t,(req,res)=>{req.resume();entered++;});
  f.request(()=>{});f.request(()=>{});await until(()=>entered===2);
  const first=f.recorder.close();assert.equal(f.recorder.close(),first);
  const usage=await first;assert.equal(await f.recorder.close(),usage);
  const rows=finalizedRows(f.output);assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.settlement.reason),['recorder-closing','recorder-closing']);
  assert.equal(usage.requests,2);assert.equal(usage.measuredSubset.inputTokens,null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output,'usage.json'),'utf8')),usage);
});

test('close during request-body upload admits no half-recorded generation',async t=>{
  let entered=false;
  const f=await fixture(t,()=>{entered=true;});
  const req=http.request(f.recorder.endpoint+'/v1/chat/completions',{method:'POST',headers:{'content-length':'1000'}});
  req.on('error',()=>{});req.write('{');await tick();
  const usage=await f.recorder.close();assert.equal(usage.requests,0);assert.equal(entered,false);
});

test('upstream end versus close race cannot double-finalize or change a returned aggregate',async t=>{
  let finish;
  const f=await fixture(t,(req,res)=>{req.resume();finish=()=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(terminal+'data: [DONE]\n\n');};});
  f.request(res=>{res.on('error',()=>{});res.resume();});await until(()=>finish);
  finish();const usage=await f.recorder.close();const serialized=JSON.stringify(usage);
  await tick();assert.equal(finalizedRows(f.output).length,1);
  assert.equal(JSON.stringify(await f.recorder.close()),serialized);
});

test('response body limits retain hashes and counts only for actually persisted bytes',async t=>{
  const f=await fixture(t,(req,res)=>{req.resume();res.writeHead(200,{'content-type':'text/event-stream'});res.end(Buffer.alloc(2048,120));},{maxBodyBytes:1024});
  f.request(res=>{res.on('error',()=>{});res.resume();});await until(()=>f.recorder.exchanges[0]?.settlement);
  const row=finalizedRows(f.output)[0];assert.equal(row.settlement.reason,'response-body-limit');
  assert.equal(row.responseBytes,fs.statSync(path.join(f.output,'00001.response.body')).size);
  assert.equal((await f.recorder.close()).inputTokens,null);
});
