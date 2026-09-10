import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createLiveReview} from '../src/live-review.js';
import {prepareRunContinuation,sha256,MAX_TRUSTED_REVIEW_BYTES,trustedReviewEvidenceEnd} from '../src/run-continuation.js';
import {RunCheckpoint} from '../src/run-checkpoint.js';
import {readJsonFile} from '../src/json-file.js';
import {runAgent} from '../src/agent.js';
import {parseArgs} from '../src/cli-args.js';

test('watch-review is a flag and does not swallow positional input',()=>{
  assert.deepEqual(parseArgs(['run','--review-file','/private/review.txt','--watch-review','remaining']),
    {_:['run','remaining'],'review-file':'/private/review.txt','watch-review':true});
  assert.throws(()=>parseArgs(['run','--watch-review=false']),/takes no value/);
});

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-live-review-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  return {root,workspace,file:path.join(root,'review.txt')};
}
function publish(file,text) {fs.writeFileSync(file+'.next',text);fs.renameSync(file+'.next',file);}

test('live review admits each exact update once, retains UTF-8/BOM and ignores incomplete updates',t=>{
  const {file,workspace}=fixture(t),first='\uFEFFInitial measured result. 雪🐔';
  publish(file,first);const warnings=[];
  const live=createLiveReview({file,workspace,task:'Continue.',initialSha256:sha256(first),onWarning:s=>warnings.push(s)});
  assert.deepEqual(live.poll(),[]);
  const second='\uFEFFRestart now passes.\nRemaining: real enemy rig. 雪🐔\u2028';publish(file,second);
  const rows=live.poll();assert.equal(rows.length,1);assert.equal(rows[0].kind,'review');
  assert.ok(rows[0].text.includes(second));assert.ok(rows[0].text.includes(sha256(second)));
  assert.equal(trustedReviewEvidenceEnd({action:null,observation:rows[0].text}),rows[0].text.length);
  assert.deepEqual(live.poll(),[]);
  publish(file,'');assert.deepEqual(live.poll(),[]);assert.deepEqual(live.poll(),[]);assert.equal(warnings.length,1);
  publish(file,'x'.repeat(MAX_TRUSTED_REVIEW_BYTES+1));assert.deepEqual(live.poll(),[]);
  publish(file,Buffer.from([0xff]));assert.deepEqual(live.poll(),[]);
  publish(file,'HUD now passes.');assert.equal(live.poll().length,1);
  assert.deepEqual(live.poll(),[]);
});

test('worker files, symlinks and nonregular replacements cannot become trusted live reviews',t=>{
  const {root,file,workspace}=fixture(t),inside=path.join(workspace,'review.txt');fs.writeFileSync(inside,'Worker text');
  assert.throws(()=>createLiveReview({file:inside,workspace,task:'Continue.'}),/outside/);
  const alias=path.join(root,'alias');fs.symlinkSync(workspace,alias,'dir');
  assert.throws(()=>createLiveReview({file:path.join(alias,'review.txt'),workspace,task:'Continue.'}),/outside/);
  publish(file,'Operator text');const live=createLiveReview({file,workspace,task:'Continue.',initialSha256:sha256('Operator text')});
  fs.unlinkSync(file);fs.symlinkSync(inside,file);assert.deepEqual(live.poll(),[]);
  fs.unlinkSync(file);fs.mkdirSync(file);assert.deepEqual(live.poll(),[]);
  fs.rmdirSync(file);publish(file,'New operator text');assert.equal(live.poll().length,1);
});

test('live review reaches the next real agent prompt and survives checkpoint/resume at its actual cursor',async t=>{
  const {root,file,workspace}=fixture(t),task='Inspect the files and address the measured review.';
  const first='Measured before changes: restart fails.';
  const second='Fresh review: restart passes.\n'+'Observed details.\n'.repeat(280)+'Remaining: implement the enemy rig.';
  publish(file,first);
  for(let i=0;i<6;i++)fs.writeFileSync(path.join(workspace,`source-${i}.txt`),`Source ${i}.`);
  const initial=prepareRunContinuation(null,{task,reviewText:first,reviewSource:file});
  const checkpoint=new RunCheckpoint({dest:path.join(root,'run.json'),initialEvidence:initial.initialEvidence,autosaveEvery:0,meta:{task}});
  const live=createLiveReview({file,workspace,task,initialSha256:sha256(first)});
  const controller=new AbortController(),prompts=[],events=[];
  const result=await runAgent({workspace,task,maxTurns:100,grounding:false,openFilesView:false,useGrammar:false,
    shellSandbox:'host',promptTrajectory:'extension',thinkMode:'never',signal:controller.signal,
    resumeTurns:initial.resumeTurns,drainInjections:()=>live.poll(),
    model:{contextWindowTokens:16000,assistantPrefill:'',async complete(prompt){
      const index=prompts.length;prompts.push(prompt);
      if(index===0)publish(file,second);
      if(index===3)controller.abort();
      return {content:JSON.stringify({a:'read_file',p:`source-${index}.txt`,start:1,limit:1}),tokens:1,stoppedEos:true,timings:{}};
    }},onEvent:event=>{events.push(event);checkpoint.note(event);}});
  assert.equal(prompts.length,4);
  assert.ok(!prompts[0].includes(second));
  for(const prompt of prompts.slice(1))assert.ok(prompt.includes(second),'complete new payload reaches every later decision');
  assert.ok(prompts[1].startsWith(prompts[0]),'a live review appends instead of rewriting the sent prefix');
  const injected=events.filter(e=>e.type==='trusted_review');assert.equal(injected.length,1);assert.equal(injected[0].turn,2);
  assert.equal(result.turns[2].observation.slice(0,trustedReviewEvidenceEnd(result.turns[2])),injected[0].observation);
  assert.equal(checkpoint.flush('test'),true);
  const saved=await readJsonFile(path.join(root,'run.json'));
  assert.equal(saved.turns[2].observation,result.turns[2].observation,'later controller annotations are retained too');
  assert.deepEqual(saved.turns.map(t=>t.i),saved.turns.map((_,i)=>i));
  assert.equal(saved.turns[3].parsedAction.p,'source-1.txt');
  const resumed=prepareRunContinuation(saved,{task});
  assert.equal(resumed.resumeTurns[2].observation,saved.turns[2].observation);
});
