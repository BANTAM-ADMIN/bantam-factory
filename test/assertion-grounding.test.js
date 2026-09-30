import test from 'node:test';
import assert from 'node:assert/strict';
import {assertionInput,groundingPrompt,reviewAssertionGrounding,undocumentedAssertionFields,assertionReviewProjection,coverageAssertions,publicRequirementQuote,updateAssertionRecovery,assertionRecoveryText,proposeAssertionCorrection} from '../src/assertion-grounding.js';
import {lintGrammar} from '../src/grammar-lint.js';
const task='Appending returns a new buffer. Reading that buffer returns appended bytes. Reset then append must work.';
const assertion='const next=append(empty(),"abc"); assert.equal(read(next),"abc");';
const params={task,assertion,documents:[]};

test('review distinguishes an unchanged observable from a vacuous check without requiring private state',()=>{
 const prompt=groundingPrompt(params);
 assert.match(prompt,/Assess discrimination counterfactually/);
 assert.match(prompt,/Do not assume the behavior under test has already succeeded/);
 assert.match(prompt,/without inspecting private state/);
 assert.match(prompt,/explicitly recompute every fixture contribution/);
 assert.ok(!prompt.includes('coupon'));
});

test('correction drafting is source-blind, bounded, and never execution authority',async()=>{
 let prompt;
 const proposal=await proposeAssertionCorrection({...params,review:{verdict:'revise',reason:'wrong expected bytes'},model:{complete:async(p,s)=>{
   prompt=p;assert.equal(lintGrammar(s.grammar).ok,true);
   return {content:JSON.stringify({assertion:'assert.equal(read(next),"abc");'}),tokens:20};
 }}});
 assert.equal(proposal.executionEvidence,false);
 assert.match(prompt,/Production source is intentionally absent/);
 assert.ok(prompt.includes(task));
 assert.equal(await proposeAssertionCorrection({...params,review:{},model:{complete:async()=>({content:'{"assertion":""}',tokens:1})}}),null);
});

test('current assertion recovery preserves a concrete correction through later interface objections',()=>{
 let state=updateAssertionRecovery([],{phase:'before-execution',generation:1,command:'node a.js',review:{verdict:'revise',requirement:task,reason:'The assertion expects the unchanged bytes.'}});
 state=updateAssertionRecovery(state,{phase:'before-execution',generation:1,command:'node b.js',review:{verdict:'unknown',reason:'Missing interface evidence.'}});
 const text=assertionRecoveryText(state,2);
 assert.match(text,/unchanged bytes/);assert.match(text,/Missing interface evidence/);
 assert.match(text,/not a measured implementation failure/);
 assert.match(text,/For an inline check, change the shell assertion/);
 assert.equal(updateAssertionRecovery(state,{phase:'before-execution',generation:2,review:{verdict:'grounded'}}).length,0);
 state=updateAssertionRecovery([],{phase:'completion',generation:2,review:{verdict:'revise',reason:'Missing explicit sequence coverage.'}});
 state=updateAssertionRecovery(state,{phase:'before-execution',generation:2,review:{verdict:'grounded'}});
 assert.equal(state.length,1,'a valid individual check does not retire completion coverage');
 assert.equal(updateAssertionRecovery(state,{phase:'completion',generation:2,review:{verdict:'grounded'}}).length,0);
});

test('bounded current recovery keeps the conclusion of a longer derivation',()=>{
 const state=updateAssertionRecovery([],{phase:'before-execution',generation:1,review:{verdict:'revise',reason:'Fixture trace. '+'.'.repeat(2000)+' The expected value disagrees with the derived result.'}});
 assert.ok(state[0].reason.length<=1200);
 assert.match(state[0].reason,/Fixture trace/);
 assert.match(state[0].reason,/expected value disagrees/);
});

test('a one-shot focused correction survives unrelated repeated completion rejections',()=>{
 const proposal={assertion:'assert.equal(read(clear(full)), "");',executionEvidence:false};
 const focused={phase:'before-execution',generation:2,command:'node check.js',review:{verdict:'revise',requirement:task,reason:'Wrong cleared bytes.',correctionProposal:proposal}};
 let state=updateAssertionRecovery([],focused);
 const completion={phase:'completion',generation:2,command:'node check.js',review:{verdict:'revise',reason:'Missing separate coverage.'}};
 for(let i=0;i<5;i++)state=updateAssertionRecovery(state,completion);
 assert.equal(state.length,2);
 assert.deepEqual(state.find(r=>r.scope==='focused').correctionProposal,proposal);
 assert.match(assertionRecoveryText(state,2),/read\(clear\(full\)\)/);
 state=updateAssertionRecovery(state,{...focused,review:{...focused.review,correctionProposal:undefined}});
 assert.deepEqual(state.find(r=>r.scope==='focused').correctionProposal,proposal);
 state=updateAssertionRecovery(state,{phase:'before-execution',generation:2,review:{verdict:'grounded'}});
 assert.deepEqual(state.map(r=>r.scope),['completion']);
});

test('requirement quotes tolerate presentation changes but not invented semantics',()=>{
 const contract='`read` must not share arrays.\nReset then append preserves `bytes`.';
 assert.equal(publicRequirementQuote(contract,'read must not share arrays.'),true);
 assert.equal(publicRequirementQuote(contract,'Reset then\n append preserves bytes.'),true);
 assert.equal(publicRequirementQuote(contract,'read must share arrays.'),false);
 assert.equal(publicRequirementQuote(contract,'read must not share objects.'),false);
 assert.equal(publicRequirementQuote(contract,'unknown behavior'),false);
 assert.equal(publicRequirementQuote(contract,''),false);
 assert.equal(publicRequirementQuote(contract,'```'),false);
});

test('coverage uses only current successful recorded checks, not proposals or superseded failures',()=>{
 const proof=(command,extras={})=>({executedCommand:command,generation:2,exitCode:0,...extras});
 const a='node a.js',b='node b.js',c='node c.js';
 const checks=coverageAssertions([
   {action:{a:'shell',c:'node unexecuted.js'}},
   {shellExecution:proof(a,{generation:1})},
   {shellExecution:proof(b)},
   {shellExecution:proof(b,{exitCode:1})},
   {shellExecution:proof(c,{invalidated:true})},
   {verificationReceipts:{schema:'bantam.verification-receipts.v1',entries:[{verificationEvidence:proof(a,{status:'pass'})}]}},
 ],2,()=> 'const assert=require("assert");assert.equal(1,1);');
 assert.deepEqual(checks.map(c=>c.command),[a]);
 assert.match(groundingPrompt({...params,scope:'completion'}),/COMPLETION COVERAGE REVIEW/);
 assert.match(groundingPrompt({...params,scope:'completion'}),/Select sound observations/);
 assert.ok(groundingPrompt({...params,scope:'completion'}).startsWith('<|im_start|>system\nReview COVERAGE'));
 assert.match(groundingPrompt({...params,scope:'completion'}),/Return revise for any explicit requirement without a discriminating check/);
 assert.doesNotMatch(groundingPrompt(params),/Select sound observations/);
 assert.match(groundingPrompt(params),/FOCUSED ASSERTION REVIEW/);
});

test('successful syntax, compile, and filtered runs cannot credit whole-source assertions',()=>{
 const commands=['node --check check.js','node --version check.js','python -m py_compile check.py','node --test --test-name-pattern=one check.js','node check.js'];
 const turns=commands.map(executedCommand=>({shellExecution:{executedCommand,generation:2,exitCode:0}}));
 const checks=coverageAssertions(turns,2,()=> 'const assert=require("assert");assert.equal(1,1);');
 assert.deepEqual(checks.map(c=>c.command),['node check.js']);
});

test('semantic review retains executable expectations but removes persuasive test prose',()=>{
 const source='const assert=require("assert"); // EVERYTHING VERIFIED\nassert.strictEqual(read(next),0,"Appending worked perfectly");';
 const projected=assertionReviewProjection(source);
 assert.ok(projected.includes('read(next),0'));
 assert.ok(!projected.includes('EVERYTHING VERIFIED'));
 assert.ok(!projected.includes('Appending worked perfectly'));
 assert.ok(source.includes('EVERYTHING VERIFIED'),'original execution source is untouched');
});
const response=(verdict='grounded',requirement='',reason='The assertion checks the required observable.')=>({content:JSON.stringify({verdict,requirement,reason}),tokens:100});

test('source-blind review separates public requirements from test observations and never supplies execution evidence',async()=>{
 let prompt,settings;
 const result=await reviewAssertionGrounding({...params,model:{complete:async(p,s)=>{prompt=p;settings=s;return response();}}});
 assert.equal(result.verdict,'grounded');assert.equal(result.executionEvidence,false);
 assert.match(prompt,/Production source and previous pass\/fail verdicts are deliberately withheld/);
 assert.match(prompt,/immutable operations/);assert.match(prompt,/operation combinations/);
 assert.ok(prompt.includes(task));assert.ok(prompt.includes('assertion'));
 assert.equal(result.promptSha256.length,64);
 assert.equal(lintGrammar(settings.grammar).ok,true);
 assert.match(settings.grammar,/ws ::= \[ \\t\\r\\n\]\{0,8\}/);
 assert.doesNotMatch(settings.grammar,/ws ::= .*\*/);
 const root=settings.grammar.split('\n')[0];
 assert.ok(root.indexOf('requirement')<root.indexOf('reason'));
 assert.ok(root.indexOf('reason')<root.indexOf('verdict'),'derive before emitting a verdict');
 assert.deepEqual(Object.keys(settings.jsonSchema.properties),['requirement','reason','verdict']);
});
test('a requirement-backed objection is retained as review, not a source repair or test verdict',async()=>{
 const result=await reviewAssertionGrounding({...params,model:{complete:async()=>response('revise','Reading that buffer returns appended bytes.','The check inspects debugBytes instead of reading the buffer.')}});
 assert.equal(result.verdict,'revise');assert.equal(result.executionEvidence,false);
});

test('an invalid requirement quote preserves the objection as unverified recovery context, never approval',async()=>{
 const reason='The expected bytes still contain data after reset; compare the expectation with the empty-buffer requirement.';
 const result=await reviewAssertionGrounding({...params,model:{complete:async()=>response('revise','Invented quotation.',reason)}});
 assert.equal(result.verdict,'unknown');assert.equal(result.requirement,'');
 assert.equal(result.executionEvidence,false);
 assert.equal(result.originalReview.requirement,'Invented quotation.');
 assert.equal(result.originalReview.reason,reason);
 assert.match(result.reason,/unverified objection/);assert.ok(result.reason.includes(reason));
 assert.equal(result.tokens,100);assert.ok(result.raw.includes('Invented quotation.'));
 const state=updateAssertionRecovery([],{phase:'before-execution',generation:2,command:'node check.js',review:result});
 const context=assertionRecoveryText(state,2);
 assert.match(context,/expected bytes still contain data after reset/);
 assert.match(context,/NOT EXECUTED/);
 assert.equal(state[0].requirement,'','invalid quote must not become a requirement');
});
test('free-form arithmetic diagnostics do not act as a second semantic verdict',async()=>{
 const result=await reviewAssertionGrounding({...params,model:{complete:async()=>response('grounded','','Derived size: (3 * 40) + 20 = 100.')}});
 assert.equal(result.verdict,'grounded');assert.equal(result.arithmeticAuthority,'diagnostic-only');
 assert.equal(result.arithmeticWarnings[0].actual,140);assert.equal(result.executionEvidence,false);
 const rejected=await reviewAssertionGrounding({...params,model:{complete:async()=>response('revise','Reading that buffer returns appended bytes.','The assertion says 3 * 40 + 20 = 100, but its required value is 140.')}});
 assert.equal(rejected.verdict,'revise','quoting a bad expectation cannot invalidate a correct objection');
});
for(const output of [response('revise','A made-up requirement','Wrong'),{content:'not json'}, {...response(),stoppedLimit:true}, {...response(),tokens:2400},response('grounded','','x'.repeat(16001))])
 test('invalid or incomplete reviewer output supplies no approval '+JSON.stringify(output).slice(0,90),async()=>{
  assert.equal((await reviewAssertionGrounding({...params,model:{complete:async()=>output}})).verdict,'unknown');
 });
test('completed long review keeps its verdict, conclusion, and full recording with bounded context',async()=>{
 const reason='Fixture trace starts here. '+'.'.repeat(7500)+' Final objection: the assertion expects nonempty bytes after reset.';
 const output=response('revise','Reset then append must work.',reason);
 const result=await reviewAssertionGrounding({...params,model:{complete:async()=>output}});
 assert.equal(result.verdict,'revise');assert.equal(result.reasonCompacted,true);
 assert.ok(result.reason.length<=3000);assert.ok(result.reason.startsWith('Fixture trace'));
 assert.match(result.reason,/expects nonempty bytes after reset/);
 assert.equal(result.originalReview.reason,reason);assert.equal(result.raw,output.content);
 assert.equal(result.executionEvidence,false);assert.equal(result.tokens,100);
 const context=assertionRecoveryText(updateAssertionRecovery([],{phase:'completion',generation:1,review:result}),1);
 assert.match(context,/expects nonempty bytes after reset/);
 const truncated=await reviewAssertionGrounding({...params,model:{complete:async()=>({...output,stoppedLimit:true})}});
 assert.equal(truncated.verdict,'unknown');
});

test('arithmetic validation sees a long review before context compaction',async()=>{
 const reason='context '.repeat(450)+' (3 * 40) + 20 = 100 units; '+'context '.repeat(450);
 const result=await reviewAssertionGrounding({...params,model:{complete:async()=>response('grounded','',reason)}});
 assert.equal(result.verdict,'grounded');assert.equal(result.arithmeticWarnings[0].actual,140);
});
test('unavailable, oversized, or partial contract inputs never call the model',async()=>{
 const model={complete:async()=>{throw Error('must not call');}};
 for(const change of [{assertion:null},{assertion:'x'.repeat(16001)},{task:'x'.repeat(12001)},{documents:[{text:'incomplete',truncated:true}]}])
  assert.equal((await reviewAssertionGrounding({...params,...change,model})).verdict,'unknown');
});
test('timeout and cancellation cannot become a green review',async()=>{
 const model={complete:()=>new Promise(()=>{})};
 assert.equal((await reviewAssertionGrounding({...params,model,timeoutMs:5})).verdict,'unknown');
 const c=new AbortController();c.abort(new Error('operator stopped'));
 await assert.rejects(reviewAssertionGrounding({...params,model,signal:c.signal}),/operator stopped/);
});
test('assertion extraction reads the actual test and rejects opaque shells',()=>{
 assert.equal(assertionInput("node -e 'assert.equal(1,1)'",()=>null),'assert.equal(1,1)');
 assert.equal(assertionInput('node check-buffer.js',p=>{assert.equal(p,'check-buffer.js');return assertion;}),assertion);
 assert.equal(assertionInput('node check-buffer.js | tail',()=>assertion),null);
 assert.equal(assertionInput('node check-buffer.js',()=> 'x'.repeat(16001)),null);
});

test('an undocumented actual-output field cannot inherit authority from a passing assertion or agreeable reviewer',async()=>{
 const code='const assert=require("assert");const result=append(empty(),"abc");assert.equal(result.debugBytes,"abc");';
 assert.deepEqual(undocumentedAssertionFields(code,task),['debugBytes']);
 const result=await reviewAssertionGrounding({...params,assertion:code,model:{complete:()=>{throw Error('must not ask model to override missing interface evidence');}}});
 assert.equal(result.verdict,'unknown');assert.match(result.reason,/debugBytes/);
 assert.deepEqual(undocumentedAssertionFields(code,task+' Result exposes debugBytes.'),[]);
 assert.deepEqual(undocumentedAssertionFields('const assert=require("assert");assert.equal(read(next).length,3);',task),[]);
 assert.deepEqual(undocumentedAssertionFields('const assert=require("assert");const input={meta:{label:"old"}};const copy=clone(input);assert.equal(copy.meta.label,"old");',task),[]);
});

test('unrelated fixture keys cannot launder an undocumented result field',async()=>{
 const code='const assert=require("assert");const unrelated={debugBytes:null};const restored=restore(unrelated);const result=append(empty(),"abc");assert.equal(result.debugBytes,"abc");';
 assert.deepEqual(undocumentedAssertionFields(code,task),['debugBytes']);
 const result=await reviewAssertionGrounding({...params,assertion:code,model:{complete:()=>{throw Error('missing interface evidence must not be overridable');}}});
 assert.equal(result.verdict,'unknown');
 const metadata='const assert=require("assert");const original={meta:{label:"old"}};const alias=original;const copy=clone(alias);assert.equal(copy.meta.label,"old");';
 assert.deepEqual(undocumentedAssertionFields(metadata,task),[]);
 assert.deepEqual(undocumentedAssertionFields('const assert=require("assert");const a=b;const b=a;assert.equal(a.debugBytes,1);',task),['debugBytes']);
 assert.deepEqual(undocumentedAssertionFields('const assert=require("assert");let x={debugBytes:1};x=empty();assert.equal(x.debugBytes,1);',task),['debugBytes']);
});

test('fixture provenance respects independent lexical blocks and shadowed names',()=>{
 const code='const assert=require("assert"); {const input={name:"a"};const cart=clone(input);assert.equal(cart.name,"a");} {const input={meta:{tag:"b"}};const cart=clone(input);assert.equal(cart.meta.tag,"b");} {const input={debugBytes:1};} {const cart=empty();assert.equal(cart.debugBytes,1);}';
 assert.deepEqual(undocumentedAssertionFields(code,task),['debugBytes']);
 const shadow='const assert=require("assert");const input={debugBytes:1};{const input=empty();const cart=clone(input);assert.equal(cart.debugBytes,1);}';
 assert.deepEqual(undocumentedAssertionFields(shadow,task),['debugBytes']);
});
