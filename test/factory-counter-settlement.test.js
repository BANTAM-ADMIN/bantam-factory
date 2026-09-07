// Synthetic transport/lifecycle qualification, not model benchmark results.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runFactoryFights} from '../scripts/factory-fights.mjs';
import {settleServerCounters} from '../scripts/fight-usage.mjs';

for(const stuck of [false,true])test(`local runner ${stuck?'stops':'settles'} cancellation tail before the next contender`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-settlement-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let launched=0,tailSamples=0,phase='idle';
  const server=http.createServer((req,res)=>{
    if(req.url==='/metrics'){
      const busy=phase==='tail'&&(stuck||tailSamples++===0);
      const fresh=phase==='idle'?10:busy?12:15;
      res.end(`llamacpp:prompt_tokens_total ${fresh}\nllamacpp:prompt_tokens_cached_total 30\nllamacpp:tokens_predicted_total 7\nllamacpp:requests_processing ${busy?1:0}\nllamacpp:requests_deferred 0\n`);
    }else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:5}}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const endpoint=`http://127.0.0.1:${server.address().port}`,output=path.join(root,'evidence');
  const processResult={code:0,stdout:'',stderr:'',wallMs:10,startedAt:'2026-09-07T00:00:00Z'};
  const model={id:'synthetic.gguf',props:{build_info:{},default_generation_settings:{n_ctx:100}}};
  const manifest=await runFactoryFights({output,endpoint,kitId:'factory-2026-09-07',cards:['context-packet'],
    arms:['hermes','opencode'],parallelQueues:false},{
    inspect:async()=>model,
    settle:url=>settleServerCounters(url,{timeoutMs:stuck?40:1000,pollMs:10}),
    contender:async command=>{
      launched++;
      if(launched===2)assert.ok(tailSamples>=3,'both idle confirmations precede the next contender');
      const proxy=command.args[command.args.indexOf('--endpoint')+1];
      await (await fetch(proxy+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"synthetic","messages":[]}'})).text();
      phase='tail';return processResult;
    },
    grade:async()=>({publicResult:processResult,hidden:processResult,record:{pass:false,groups:[]},timing:{totalWallMs:0}}),
  });
  assert.equal(launched,stuck?1:2);assert.equal(manifest.complete,!stuck);
  const window=JSON.parse(fs.readFileSync(path.join(output,'repeat-1/context-packet/hermes/server-usage.json')));
  assert.equal(window.settlement.settled,!stuck);assert.equal(window.settlement.observedBusy,true);
  if(stuck)assert.notEqual(window.delta?.idleAfter,true,'timeout or failed final read cannot claim idle');
  else assert.equal(window.delta.idleAfter,true);
  assert.equal(manifest.results[0].wallMs,10,'drain time is separate from measured contender wall time');
  assert.equal(manifest.results[0].usage.inputTokens,10,'server counters do not replace wire receipts');
  if(stuck)assert.match(manifest.stoppedEarly,/unsettled/);
  else{assert.equal(window.delta.freshInputTokens,5);assert.equal(window.settlement.samples.length,3);}
});
