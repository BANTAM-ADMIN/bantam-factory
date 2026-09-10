import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {RunCheckpoint} from '../src/run-checkpoint.js';
import {prepareRunContinuation, mergeContinuationResult} from '../src/run-continuation.js';
import {buildArtifact, saveArtifact} from '../src/artifact.js';
import {readJsonFile} from '../src/json-file.js';

test('large recorded bodies survive resume and finalization within a bounded heap', () => {
  // Eight retained 8 MiB transport bodies through resume -> checkpoint ->
  // merge -> artifact. JSON round trips allocate the immutable text repeatedly
  // and exhaust this heap; detached containers need only one copy of the text.
  const script = `
    import assert from 'node:assert/strict';
    import {RunCheckpoint} from './src/run-checkpoint.js';
    import {prepareRunContinuation,mergeContinuationResult} from './src/run-continuation.js';
    import {buildArtifact} from './src/artifact.js';
    const body = Buffer.alloc(8 * 1024 * 1024, 120).toString() + '雪🐔';
    const source = {task:'Continue the full project.', turns:[{i:0,modelCallIndex:7,observation:'checked'}],
      modelCalls:Array.from({length:8},(_,index)=>({index,status:'ok',request:{body,headers:{accept:'original'}}}))};
    const resume = prepareRunContinuation(source,{task:source.task});
    const checkpoint = new RunCheckpoint({initialEvidence:resume.initialEvidence,autosaveEvery:0});
    const calls = checkpoint.modelCalls();
    const result = mergeContinuationResult({turns:resume.resumeTurns,modelCalls:calls,metrics:{}},resume);
    const artifact = buildArtifact({runId:'memory-regression',stamp:'now',task:source.task,result});
    assert.equal(artifact.modelCalls.length,8);
    for(const call of artifact.modelCalls) assert.equal(call.request.body,body);
    artifact.modelCalls[0].request.headers.accept='changed';
    assert.equal(checkpoint.modelCalls()[0].request.headers.accept,'original');
    assert.equal(source.modelCalls[0].request.headers.accept,'original');
    console.log('all evidence preserved');
  `;
  const output = execFileSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {...process.env, NODE_OPTIONS:''}, encoding:'utf8', timeout:30000, maxBuffer:1024*1024,
  });
  assert.match(output,/all evidence preserved/);
});

test('record snapshots detach mutable data and preserve exact bytes through checkpoint and artifact files', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-evidence-copies-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const body=JSON.stringify({prompt:'user\n雪🐔\u2028\n"quoted" \\ literal',grammar:'root ::= "ok"'});
  const source={task:'Build it.',turns:[{i:0,modelCallIndex:0,observation:'observed',workspaceCoherence:{generation:7}}],
    modelCalls:[{index:0,status:'ok',request:{body,headers:{accept:'original'}},response:{body:'{"answer":"ok"}'}}],
    events:[{seq:0,type:'observation',turn:0,contextUpdates:[{text:'exact\nsource'}]}]};
  const resume=prepareRunContinuation(source,{task:source.task});
  const checkpoint=new RunCheckpoint({dest:path.join(dir,'checkpoint.json'),initialEvidence:resume.initialEvidence,autosaveEvery:0});
  source.modelCalls[0].request.headers.accept='source changed';
  resume.initialEvidence.modelCalls[0].request.body='resume changed';
  const exposed=checkpoint.modelCalls();exposed[0].request.headers.accept='consumer changed';
  const events=checkpoint.events();events[0].contextUpdates[0].text='consumer changed';
  assert.equal(checkpoint.flush('test'),true);
  const saved=await readJsonFile(path.join(dir,'checkpoint.json'));
  assert.equal(saved.modelCalls[0].request.body,body);
  assert.equal(saved.modelCalls[0].request.headers.accept,'original');
  assert.equal(saved.events[0].contextUpdates[0].text,'exact\nsource');
  assert.equal(saved.turns[0].workspaceCoherence.generation,7);
  const artifact=buildArtifact({runId:'detached',stamp:'now',task:source.task,
    result:{turns:saved.turns,modelCalls:saved.modelCalls,metrics:{}}});
  saved.modelCalls[0].response.body='mutated';
  saveArtifact(path.join(dir,'run.json'),artifact);
  const final=await readJsonFile(path.join(dir,'run.json'));
  assert.equal(final.modelCalls[0].request.body,body);
  assert.equal(final.modelCalls[0].response.body,'{"answer":"ok"}');
});
