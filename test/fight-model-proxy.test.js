import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {responseUsage,aggregateExchanges,startModelRecorder} from '../scripts/fight-model-proxy.mjs';

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
