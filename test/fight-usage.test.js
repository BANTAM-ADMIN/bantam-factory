import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {codexSessionUsage,parseServerCounters,counterDelta} from '../scripts/fight-usage.mjs';
test('native Codex sums unique response records, not repeated cumulative token events',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fight-usage-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const row={type:'token_usage_record',timestamp:'2026-09-06T00:00:00Z',payload:{response_id:'one',usage:{input_tokens:100,cached_input_tokens:80,output_tokens:5}}};
  fs.writeFileSync(path.join(dir,'one.jsonl'),[row,row,{type:'event_msg',payload:{info:{total_token_usage:row.payload.usage}}}].map(JSON.stringify).join('\n'));
  const u=codexSessionUsage(dir);assert.equal(u.requests,1);assert.equal(u.inputTokens,100);assert.equal(u.freshInputTokens,20);assert.equal(u.outputTokens,5);
  fs.appendFileSync(path.join(dir,'one.jsonl'),'\n'+JSON.stringify({...row,payload:{...row.payload,usage:{...row.payload.usage,output_tokens:6}}}));
  assert.equal(codexSessionUsage(dir).complete,false);
});
test('native Codex includes nested child responses once without double-counting inherited root history',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fight-usage-children-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const childDir=path.join(dir,'2026','09','07','children');fs.mkdirSync(childDir,{recursive:true});
  const response=(id,thread,input,cached,output,reasoning)=>({type:'token_usage_record',timestamp:'2026-09-07T00:00:00Z',
    payload:{response_id:id,thread_id:thread,usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_output_tokens:reasoning}}});
  const first=response('root-first','root-thread',100,80,5,2);
  const last=response('root-last','root-thread',200,150,10,3);
  const child=response('child-only','child-thread',70,20,7,4);
  const cumulative={type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:370,cached_input_tokens:250,output_tokens:22}}}};
  const write=(file,rows)=>fs.writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');
  write(path.join(dir,'root.jsonl'),[first,last,cumulative,{type:'turn.completed',usage:last.payload.usage}]);
  write(path.join(childDir,'child.jsonl'),[first,child,child,cumulative]);
  const usage=codexSessionUsage(dir);
  assert.equal(usage.complete,true);assert.deepEqual(usage.errors,[]);
  assert.equal(usage.requests,3);assert.equal(usage.inputTokens,370);
  assert.equal(usage.cacheHitTokens,250);assert.equal(usage.freshInputTokens,120);
  assert.equal(usage.outputTokens,22);assert.equal(usage.reasoningTokens,9);
  assert.equal(usage.prefixReuse,250/370);
  assert.deepEqual(new Set(usage.calls.map(call=>call.responseId)),new Set(['root-first','root-last','child-only']));
  assert.deepEqual(new Set(usage.calls.map(call=>call.threadId)),new Set(['root-thread','child-thread']));
});
test('server counters separate fresh prefill from reused prefix and guard resets',()=>{
  const c=parseServerCounters('llamacpp:prompt_tokens_total 10\nllamacpp:prompt_tokens_cached_total 30\nllamacpp:tokens_predicted_total 7\nllamacpp:requests_processing 0\nllamacpp:requests_deferred 0');
  const delta=counterDelta({counters:c},{counters:{...c,prompt_tokens_total:15,prompt_tokens_cached_total:39,tokens_predicted_total:10}});
  assert.equal(delta.inputTokens,14);assert.equal(delta.freshInputTokens,5);assert.equal(delta.cacheHitTokens,9);assert.equal(delta.outputTokens,3);
  assert.equal(counterDelta({counters:c},{counters:{...c,tokens_predicted_total:1}}),null);
});
