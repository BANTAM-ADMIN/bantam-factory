import assert from 'node:assert/strict';
import test from 'node:test';
import {derivePerformance,publicPerformance,performanceView,phaseRate} from '../scripts/fight-performance.mjs';
const call=(tokens,ms,extra={})=>({generation:true,finished:true,status:200,usage:{timings:{predicted_n:tokens,predicted_ms:ms,prompt_n:400,prompt_ms:200}},...extra});
const report=requests=>({requests,integrity:{indexSha256:'a'.repeat(64)}});
test('generation rate weights actual server phase time, without tool time or averaging request rates',()=>{
 const p=derivePerformance(report([call(240,4000),call(60,500)]));
 assert.equal(phaseRate(p.generation),300/4.5);
 assert.equal(phaseRate(p.prefill),2000);
 assert.deepEqual(p.generation,{tokens:300,milliseconds:4500,measuredRequests:2,totalRequests:2});
 assert.equal(performanceView(p).generation,'66.7 tok/s');
});
test('missing, interrupted and failed responses stay in coverage without becoming zero-speed samples',()=>{
 const p=derivePerformance(report([call(100,1000),call(100,1000,{finished:false}),call(100,1000,{status:500}),call(1,0),call(1,1,{generation:false})]));
 assert.equal(phaseRate(p.generation),100);
 assert.equal(p.generation.totalRequests,4);
 assert.equal(p.generation.measuredRequests,1);
 assert.equal(performanceView(p).partial,true);
});
test('zero or missing generation time is unknown, never Infinity or a fabricated speed',()=>{
 const p=derivePerformance(report([call(0,0),call(1,NaN)]));
 assert.equal(phaseRate(p.generation),null);
 assert.equal(performanceView(p).generation,'Not recorded');
});
test('hardware is explicit and never inferred from the export machine',()=>{
 assert.equal(derivePerformance(null),null);
 assert.equal(derivePerformance(report([call(1,1)])).hardware,undefined);
 const p=derivePerformance(null,{hardware:'rtx-4090-24gb',modelId:'/private/Qwen-27B-Q4_K_P.gguf',contextTokens:72192});
 assert.equal(performanceView(p).hardware,'NVIDIA RTX 4090 · 24 GB');
 assert.equal(p.quantization,'Q4_K_P');
 assert.equal(p.contextTokens,72192);
 assert.ok(!JSON.stringify(p).includes('/private'));
 assert.throws(()=>derivePerformance(null,{hardware:'private-hostname'}),/Unsupported/);
});
test('public projection removes arbitrary data and rejects contradictory timing coverage',()=>{
 const clean=publicPerformance({hardware:'rtx-4090-24gb',hardwareBasis:'operator-confirmed',hostname:'PRIVATE',gpuUuid:'PRIVATE',generation:{tokens:10,milliseconds:100,measuredRequests:2,totalRequests:1},contextTokens:Infinity,quantization:'PRIVATE'});
 assert.deepEqual(clean,{hardware:'rtx-4090-24gb',hardwareBasis:'operator-confirmed'});
 assert.equal(publicPerformance({hardware:'rtx-4090-24gb',hardwareBasis:'guessed'}),null);
 assert.equal(publicPerformance({generation:{tokens:'100',milliseconds:100,measuredRequests:1,totalRequests:1}}),null);
});

test('public cards carry numeric speed receipts and never assign the local GPU to hosted contenders',async()=>{
 const {publicShowcaseData}=await import('../scripts/factory-showcase.mjs');
 const {buildLaunchData}=await import('../scripts/factory-launch.mjs');
 const {renderLaunchPage,renderShareCard}=await import('../scripts/factory-launch-page.mjs');
 const performance={...derivePerformance(report([call(100,1000)]),{hardware:'rtx-4090-24gb',modelId:'Qwen-27B-Q4_K_P.gguf',contextTokens:72192}),hostname:'PRIVATE_HOST'};
 const row=arm=>({arm,model:'Qwen 27B · same local model',recorded:true,outcome:'PASS',accepted:true,completed:true,wallMs:2500,
   groupsPassed:5,groupsTotal:5,publicExit:0,hiddenExit:0,protectedChanges:0,accounting:{},performance});
 const data=publicShowcaseData({generatedAt:'2026-09-08T00:00:00Z',series:[{kind:'comparison',complete:true,
   cards:[{card:'receipt-reducer',repeat:1,rows:[row('bantam-local-27b'),row('codex-astra')]}]}]});
 assert.equal(data.series[0].cards[0].rows[1].performance,undefined);
 assert.equal(data.series[0].cards[0].rows[0].performance.hardware,'rtx-4090-24gb');
 assert.ok(!JSON.stringify(data).includes('PRIVATE_HOST'));
 const launch=buildLaunchData(JSON.stringify(data));
 for(const render of [renderLaunchPage,renderShareCard]){
   const output=render(launch);
   assert.match(output,/NVIDIA RTX 4090/);
   assert.match(output,/100\.0 tok\/s/);
   assert.ok(!output.includes('PRIVATE_HOST'));
 }
});
