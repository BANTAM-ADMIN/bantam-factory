import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {reviewAssertionGrounding} from '../src/assertion-grounding.js';
import {runAgent} from '../src/agent.js';

const task='Reading a buffer returns its appended bytes.';
const params={task,assertion:'assert.equal(read(append(empty(), "abc")), "abc");'};
const answer=(verdict='grounded',requirement='',reason='The observable is the appended bytes.')=>({
  content:JSON.stringify({requirement,reason,verdict}),tokens:100,
});

test('one incomplete generation retries identical evidence without feeding partial deliberation back',async()=>{
  const calls=[],partial='{"reason":"PARTIAL_REVIEW_MARKER';
  const result=await reviewAssertionGrounding({...params,model:{complete:async(prompt,settings)=>{
    calls.push({prompt,settings});
    return calls.length===1?{content:partial,tokens:2400,stoppedLimit:true}:answer();
  }}});
  assert.equal(calls.length,2);
  for(const call of calls){assert.ok(call.prompt.includes(task));assert.ok(call.prompt.includes('read(append(empty()'));assert.equal(call.settings.nPredict,2400);}
  assert.match(calls[1].prompt,/FORMAT RECOVERY ONLY/);
  assert.ok(!calls[1].prompt.includes('PARTIAL_REVIEW_MARKER'));
  assert.equal(calls[0].settings.signal,calls[1].settings.signal,'both calls share one total deadline');
  assert.equal(result.verdict,'grounded');assert.equal(result.executionEvidence,false);
  assert.equal(result.tokens,2500);assert.equal(result.reviewAttempts.length,2);
  assert.equal(result.reviewAttempts[0].raw,partial);
  assert.equal(result.reviewAttempts[0].failure.code,'output-limit');
  assert.equal(result.reviewAttempts[1].raw,answer().content);
  assert.notEqual(result.reviewAttempts[0].promptSha256,result.reviewAttempts[1].promptSha256);
  assert.equal(result.promptSha256,result.reviewAttempts[1].promptSha256);
  assert.equal(result.reviewFailure,undefined);
});

for(const response of [answer(),answer('revise',task,'The expected bytes disagree.'),
  answer('unknown','','The public interface is not specified.'),answer('revise','Invented requirement.','A substantive but unsupported objection.')])
test(`completed review is not rerolled: ${response.content}`,async()=>{
  let calls=0;
  const result=await reviewAssertionGrounding({...params,model:{complete:async()=>{calls++;return response;}}});
  assert.equal(calls,1);assert.equal(result.reviewAttempts.length,1);
  assert.equal(result.reviewFailure,undefined);
});

test('transport exception may retry once, preserving the error and subsequent semantic objection',async()=>{
  let calls=0;
  const result=await reviewAssertionGrounding({...params,model:{complete:async()=>{
    if(++calls===1)throw Error('connection interrupted');
    return answer('revise',task,'The fixture expects the wrong bytes.');
  }}});
  assert.equal(calls,2);assert.equal(result.verdict,'revise');
  assert.equal(result.reviewAttempts[0].failure.kind,'transport');
  assert.equal(result.reviewAttempts[0].failure.message,'connection interrupted');
  assert.equal(result.reviewFailure,undefined);
});

for(const output of [{content:'not json',tokens:9},
  {content:'{"verdict":"grounded"}',tokens:8},
  {content:'{"reason":"unfinished',tokens:2400,stoppedLimit:true}])
test(`two invalid outputs exhaust reviewer recovery without approval: ${output.content}`,async()=>{
  let calls=0;
  const result=await reviewAssertionGrounding({...params,model:{complete:async()=>{calls++;return output;}}});
  assert.equal(calls,2);assert.equal(result.verdict,'unknown');assert.equal(result.executionEvidence,false);
  assert.equal(result.reviewFailure.schema,1);assert.equal(result.reviewFailure.exhausted,true);
  assert.equal(result.reviewFailure.attempts,2);assert.equal(result.reviewAttempts.length,2);
  assert.equal(result.tokens,output.tokens*2);
  for(const attempt of result.reviewAttempts){assert.equal(attempt.raw,output.content);assert.equal(attempt.promptSha256.length,64);assert.ok(attempt.failure.code);}
  assert.match(result.reason,/No assertion defect was established/);
});

test('missing contract or unknown interface is not reviewer infrastructure failure',async()=>{
  const model={complete:()=>{throw Error('must not call');}};
  for(const assertion of [null,'const assert=require("assert");assert.equal(append(empty(),"a").privateBytes,1);']){
    const result=await reviewAssertionGrounding({...params,assertion,model});
    assert.equal(result.verdict,'unknown');assert.equal(result.reviewFailure,undefined);
  }
});

test('timeout uses one overall budget and cannot allocate a fresh second deadline',async()=>{
  let calls=0;
  const result=await reviewAssertionGrounding({...params,timeoutMs:15,model:{complete:()=>{calls++;return new Promise(()=>{});}}});
  assert.equal(calls,1);assert.equal(result.verdict,'unknown');
  assert.equal(result.reviewFailure.kind,'timeout');assert.equal(result.reviewFailure.budgetMs,15);
  assert.equal(result.reviewAttempts.length,1);
});

test('a retry receives only the original deadline remainder',async()=>{
  const signals=[];
  const result=await reviewAssertionGrounding({...params,timeoutMs:40,model:{complete:async(_prompt,settings)=>{
    signals.push(settings.signal);
    if(signals.length===1){await new Promise(resolve=>setTimeout(resolve,10));return {content:'malformed',tokens:1};}
    return new Promise(()=>{});
  }}});
  assert.equal(signals.length,2);assert.equal(signals[0],signals[1]);assert.equal(signals[1].aborted,true);
  assert.equal(result.reviewFailure.kind,'timeout');assert.equal(result.reviewFailure.budgetMs,40);
  assert.equal(result.reviewAttempts.length,2);
});

test('caller cancellation escapes immediately without reviewer retry or false approval',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(reviewAssertionGrounding({...params,signal:controller.signal,model:{complete:async()=>{
    calls++;controller.abort(Error('operator stopped'));return new Promise(()=>{});
  }}}),/operator stopped/);
  assert.equal(calls,1);
});

test('caller abort followed by an immediate valid response cannot grant approval',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(reviewAssertionGrounding({...params,signal:controller.signal,model:{complete:()=>{
    calls++;controller.abort(Error('operator stopped before reply'));return answer();
  }}}),/operator stopped before reply/);
  assert.equal(calls,1);
});

test('a synchronous valid response after the deadline is retained but never approved',async()=>{
  let calls=0;
  const result=await reviewAssertionGrounding({...params,timeoutMs:2,model:{complete:()=>{
    calls++;
    const until=Date.now()+10;
    while(Date.now()<until){ /* Simulate a provider blocking the timer callback. */ }
    return answer();
  }}});
  assert.equal(calls,1);assert.equal(result.verdict,'unknown');
  assert.equal(result.reviewFailure.kind,'timeout');assert.equal(result.reviewFailure.code,'deadline-exhausted');
  assert.equal(result.reviewAttempts[0].raw,answer().content,'late response remains available for diagnosis');
  assert.equal(result.reviewAttempts[0].tokens,100);
});

for(const scope of ['focused','completion'])test(`agent terminally reports ${scope} reviewer exhaustion without asking for different evidence`,async t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-review-retry-'));
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  fs.mkdirSync(path.join(workspace,'src'));fs.mkdirSync(path.join(workspace,'test'));
  fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test'}}));
  fs.writeFileSync(path.join(workspace,'src/items.js'),'export function collectItems(){throw Error("TODO");}\n');
  fs.writeFileSync(path.join(workspace,'test/public.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {collectItems} from '../src/items.js';test('order',()=>assert.deepEqual(collectItems('ok',[2,1]),[2,1]));\n");
  const actions=[{a:'write_file',p:'src/items.js',content:"export function collectItems(token,items){if(!Array.isArray(items)||typeof token!=='string'||!token.length)throw Error('invalid');return [...items];}\n"},
    {a:'shell',c:'npm test'},
    {a:'shell',c:`node --input-type=module -e "import assert from 'node:assert/strict';import {collectItems} from './src/items.js';assert.throws(()=>collectItems('',[]));assert.deepEqual(collectItems('ok',[]),[]);"`},
    {a:'done',summary:'Verified'}];
  const events=[];let failedCalls=0;
  const result=await runAgent({task:'Implement synchronous src/items.js collectItems(token, items). items must be an array; token must be a nonempty string even for empty arrays. Return items in order. Invalid calls throw Error. Run npm test.',
    workspace,maxTurns:4,maxInvalidPerTurn:0,verificationScript:'npm test',assertionGrounding:true,
    useGrammar:true,interactive:false,grounding:false,shellSandbox:'host',completionAudit:false,
    stateAudit:'off',contractStateAudit:'auto',contractAssertionStation:'off',diagnoseStuckTests:false,
    testFocus:false,regressionGuard:false,autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
    onEvent:event=>events.push(event),model:{assistantPrefill:'',actTemperature:null,complete:async prompt=>{
      if(prompt.includes('Review the ASSERTION')||prompt.includes('Review COVERAGE')){
        if(scope==='focused'||prompt.includes('COMPLETION COVERAGE REVIEW:')){failedCalls++;return {content:'not JSON',tokens:2};}
        return answer();
      }
      if(prompt.includes('You are a source-code state-machine auditor.'))return {content:JSON.stringify({findings:[],note:'Execute the public API assertion.'}),tokens:1};
      assert.ok(actions.length);return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true};
    }}});
  assert.equal(failedCalls,2);assert.equal(result.reachedDone,false);
  assert.equal(result.controllerStop.kind,'assertion-review-unavailable');
  assert.equal(result.controllerStop.scope,scope);assert.equal(result.controllerStop.reviewFailure.attempts,2);
  assert.match(result.summary,/Blocked: Reviewer unavailable/);
  assert.doesNotMatch(result.turns.at(-1).observation,/Correct an unsupported assertion|supply a different focused/);
  const failedReview=events.find(event=>event.type==='assertion_grounding'&&event.review.reviewFailure);
  assert.equal(failedReview.review.reviewAttempts.length,2,'full failed attempts survive in run events');
  if(scope==='focused')assert.equal(result.turns.at(-1).shellExecution??null,null);
});
