import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import {runAgent} from '../src/agent.js';
import {ModelClient} from '../src/model.js';
import {acquireModelLock} from '../src/model-lock.js';

async function fixture(t){
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-cloud-lock-'));
 t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
 let probes=0;
 const server=http.createServer((req,res)=>{
  probes++;res.writeHead(200,{'content-type':'application/json'});res.end('[{}]');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint=`http://127.0.0.1:${server.address().port}`;
 const held=await acquireModelLock({endpoint,slots:1,enabled:true});
 t.after(()=>held.release());
 return {workspace,endpoint,held,probes:()=>probes};
}

for(const transport of ['codex','codexBacked','api'])test(`${transport} ignores a busy fallback local endpoint`,async t=>{
 const {workspace,endpoint,held,probes}=await fixture(t);
 const model=transport==='codex'?new ModelClient({codex:true,endpoint,apiUrl:null})
  :{endpoint,apiMode:transport==='api',codexBacked:transport==='codexBacked',assistantPrefill:'',stop:[]};
 if(transport==='codex'){
  assert.equal(model.codex,true);assert.equal(model.apiMode,false);
  t.after(()=>model.close());
 }
 let calls=0;const events=[];
 model.complete=async()=>{
  calls++;return {content:'{"a":"respond","text":"Hello."}',tokens:1,stoppedEos:true,timings:{}};
 };
 // A pre-fix regression must finish and report the erroneous wait, not hang
 // the suite behind this deliberately occupied local slot.
 const result=await runAgent({workspace,model,task:'Tell me about yourself.',interactive:true,
  grounding:false,useGrammar:false,maxTurns:1,shellSandbox:'host',onEvent:e=>{
   events.push(e);if(e.type==='model_lock_wait')held.release();
  }});
 assert.equal(result.responded,true);assert.equal(calls,1);
 assert.equal(events.filter(e=>e.type==='model_lock_wait').length,0);
 assert.equal(probes(),0,'cloud dispatch never even queries local slot capacity');
 assert.ok(fs.existsSync(held.path),'cloud completion cannot release another session’s local lock');
});

test('a local-model run still waits for the occupied slot before generating',async t=>{
 const {workspace,endpoint,held,probes}=await fixture(t);const events=[];let calls=0;
 const model={endpoint,assistantPrefill:'',stop:[],async complete(){
  calls++;return {content:'{"a":"respond","text":"Hello."}',tokens:1,stoppedEos:true,timings:{}};
 }};
 const result=await runAgent({workspace,model,task:'Hello.',interactive:true,grounding:false,
  useGrammar:false,maxTurns:1,shellSandbox:'host',onEvent:e=>{
   events.push(e);
   if(e.type==='model_lock_wait'){
    assert.equal(calls,0);assert.equal(e.holderPid,process.pid);held.release();
   }
  }});
 assert.equal(result.responded,true);assert.equal(calls,1);
 assert.equal(probes(),1);assert.equal(events.filter(e=>e.type==='model_lock_wait').length,1);
 assert.equal(fs.existsSync(held.path),false,'local run releases its own slot on completion');
});
