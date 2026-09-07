import assert from 'node:assert/strict';
import test from 'node:test';
import {currentConfiguredFailure,verificationFailureContext} from '../src/verification-failure-context.js';
const options={generation:2,configuredCommand:'npm test',workspace:'/tmp/work'};
const proof=(status='fail',changes={})=>({schema:1,source:'automatic',command:'npm test',executedCommand:'npm test',configuredCommand:'npm test',
  statusCommand:'npm test',statusScope:'execution',generation:2,cwd:'/tmp/work',exitCode:status==='fail'?1:0,status,
  outputSha256:'a'.repeat(64),counts:{passed:status==='fail'?1:4,failed:status==='fail'?3:0,total:4},countsScope:'single-execution',
  failingTests:status==='fail'?['required evidence','UTF8 bytes','input immutability']:[],...changes});
const row=(p=proof())=>({verificationEvidence:p});
function ordered(ps,index=0){const entries=ps.map((verificationEvidence,sequence)=>({sequence,verificationEvidence,shellExecution:null}));return{
  verificationEvidence:entries.at(-1).verificationEvidence,verificationReceipts:{schema:'bantam.verification-receipts.v1',authority:'controller-execution-order',turn:index,entries}};}
test('current configured failure persists across newer notes, print probes and unrelated green',()=>{
  const turns=[row(),{reasoning:'frameFor returns undefined',observation:'All tests pass'},row(proof('pass',{command:'node --check app.js',executedCommand:'node --check app.js',statusCommand:'node --check app.js',configuredCommand:null}))];
  const before=JSON.stringify(turns),f=currentConfiguredFailure(turns,options);
  assert.equal(f.turn,0);assert.equal(f.generation,2);assert.equal(f.command,'npm test');assert.equal(f.exitCode,1);assert.equal(f.counts.failed,3);
  assert.equal(JSON.stringify(turns),before);
});
test('only a later exact valid pass retires; changed generation is not current failure',()=>{
  assert.equal(currentConfiguredFailure([row(),row(proof('pass'))],options),null);
  assert.equal(currentConfiguredFailure([row()],{...options,generation:3}),null);
  assert.equal(currentConfiguredFailure([row(proof('pass')),row()],options)?.turn,1);
  assert.equal(currentConfiguredFailure([row(),row(proof('pass',{generation:1}))],options)?.turn,0);
});
test('ordered actual executions preserve failure/pass order and reject forged aliases',()=>{
  assert.equal(currentConfiguredFailure([ordered([proof(),proof('pass')])],options),null);
  assert.equal(currentConfiguredFailure([ordered([proof('pass'),proof()])],options)?.turn,0);
  const alias=ordered([proof('pass')],1);alias.verificationEvidence={...alias.verificationEvidence,exitCode:1};
  assert.equal(currentConfiguredFailure([row(),alias],options)?.turn,0);
  for(const mutate of [r=>r.verificationReceipts.authority='model',r=>r.verificationReceipts.turn=3,r=>r.verificationReceipts.entries[0].sequence=7]){
    const malformed=ordered([proof()]);mutate(malformed);assert.equal(currentConfiguredFailure([malformed],options),null);
  }
});
test('unknown, stopped, stale, masked or mismatched evidence cannot start or retire failure',()=>{
  for(const patch of [{source:'model'},{schema:2},{status:'unverified'},{generation:1},{cwd:'/tmp/elsewhere'},{invalidated:true},{timedOut:true},
    {blocked:true},{error:'infrastructure'},{cached:true},{outputSha256:'bad'},{statusScope:'final-configured-command'},
    {statusCommand:'other'},{configuredCommand:'other'},{command:'other'}, {exitCode:0}, {exitCode:null}])
    assert.equal(currentConfiguredFailure([row(proof('fail',patch))],options),null,JSON.stringify(patch));
  for(const patch of [{invalidated:true},{timedOut:true},{source:'model'},{outputSha256:'bad'},{cwd:'/tmp/elsewhere'},
    {statusScope:'final-configured-command'},{counts:{passed:0,failed:0,total:0}}])
    assert.equal(currentConfiguredFailure([row(),row(proof('pass',patch))],options)?.turn,0,JSON.stringify(patch));
  assert.equal(currentConfiguredFailure([{...row(),controllerStop:{kind:'stop'}}],options),null);
});
test('shell evidence requires a consistent actual execution partner',()=>{
  const p=proof('fail',{source:'shell'}),s={...p};delete s.status;
  assert.equal(currentConfiguredFailure([{verificationEvidence:p,shellExecution:s}],options)?.command,'npm test');
  assert.equal(currentConfiguredFailure([row(p)],options),null);
  assert.equal(currentConfiguredFailure([{verificationEvidence:p,shellExecution:{...s,executedCommand:'echo pass'}}],options),null);
  assert.equal(currentConfiguredFailure([{verificationEvidence:proof(),shellExecution:{...s,executedCommand:'echo pass'}}],options),null);
});
test('bounded injected Node timeout preserves configured identity, changed selectors do not',()=>{
  const o={...options,configuredCommand:'node --test test/all.js'};
  const p=proof('fail',{command:o.configuredCommand,configuredCommand:o.configuredCommand,executedCommand:'node --test --test-timeout=30000 test/all.js',statusCommand:'node --test --test-timeout=30000 test/all.js'});
  assert.equal(currentConfiguredFailure([row(p)],o)?.exitCode,1);
  assert.equal(currentConfiguredFailure([row({...p,executedCommand:'node --test test/other.js',statusCommand:'node --test test/other.js'})],o),null);
});
test('bounded facts-only current slot stays within2400 and makes no general private-helper claim',()=>{
  const f=currentConfiguredFailure([row()],options),context=verificationFailureContext(f,{facts:['frame is a property of the new object; s.frame reads the original input']});
  assert.equal(context.phase,'failure');assert.match(context.text,/^EXECUTION FAILURE:/);assert.match(context.text,/CURRENT tree/);
  assert.match(context.text,/new working hypothesis is not execution evidence/);assert.match(context.text,/actual failing API call and operand/);
  assert.doesNotMatch(context.text,/private helper|not exported|returns undefined/);
  const huge=verificationFailureContext({...f,command:'x'.repeat(4096),failingTests:Array(10).fill('"'.repeat(1000))},{facts:Array(10).fill('"'.repeat(10000))});
  assert.ok(huge.text.length<=2400);assert.match(huge.text,/command \(excerpt\)/);assert.match(huge.text,/Unrelated green checks cannot settle/);
  assert.equal(verificationFailureContext(null),null);
});
test('JSON escape expansion never exceeds the typed slot budget or loses the instruction',()=>{
  const f=currentConfiguredFailure([row()],options);
  for(const unit of ['"','\\','\ud800']){
    const context=verificationFailureContext({...f,generation:Number.MAX_SAFE_INTEGER,turn:Number.MAX_SAFE_INTEGER,
      command:unit.repeat(4096),counts:{passed:0,failed:Number.MAX_SAFE_INTEGER,total:Number.MAX_SAFE_INTEGER},
      failingTests:Array(3).fill(unit.repeat(1000))},{facts:Array(4).fill(unit.repeat(10000))});
    assert.ok(context.text.length<=2400,String(context.text.length));
    assert.match(context.text,/command \(excerpt\)/);assert.match(context.text,/Unrelated green checks cannot settle/);
    assert.match(context.text,/not an oracle or permission to finish\.$/);
  }
});
test('a complete structural fact is prioritized over optional test names without clipping its limits',()=>{
  const f=currentConfiguredFailure([row()],options);
  const fact='[source dataflow] sample.js:53: In this callback, { frame: expr } initializes NEW result.frame; that property syntax does not assign INPUT s.frame. The later bytes initializer reads INPUT s.frame. This does not establish whether that input property exists or helper calls mutate it. Inspect the actual input at the failing public call; do not infer the earlier helper returned undefined from this read alone. '.padEnd(660,' ')+'Structural fact only, not a bug verdict or verification.';
  const context=verificationFailureContext({...f,command:'"'.repeat(4096),generation:Number.MAX_SAFE_INTEGER,
    turn:Number.MAX_SAFE_INTEGER,counts:{passed:0,failed:Number.MAX_SAFE_INTEGER,total:Number.MAX_SAFE_INTEGER},
    failingTests:Array(3).fill('"'.repeat(1000))},{facts:[fact,'x'.repeat(1200)]});
  assert.ok(context.text.length<=2400);assert.ok(context.text.includes(JSON.stringify(fact)));
  assert.match(context.text,/Structural fact only, not a bug verdict or verification/);
  assert.ok(context.text.indexOf('Current source fact:')<context.text.indexOf('Failing case:'));
  assert.match(context.text,/not an oracle or permission to finish\.$/);
  assert.ok(!context.text.includes('x'.repeat(100)));
});
