import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Executor} from '../src/executor.js';
import {runAgent} from '../src/agent.js';
import {parseAction} from '../src/actions.js';
import {actionGrammar,actionJsonSchema} from '../src/grammar.js';
import {buildArtifact} from '../src/artifact.js';
import {RunCheckpoint} from '../src/run-checkpoint.js';

const before='export function report(xs) { const out = [...xs]; out.sort(); return out; }\n';
const after='export function report(xs) { const out = [...xs]; return out; }\nfunction cli() { console.log("ready"); }\n';
const proposal={a:'write_file',p:'source.mjs',content:after};
const receipt=text=>JSON.parse(String(text).match(/\{"a":"confirm_edit","id":"[a-f0-9]+"\}/)?.[0]??'null');
function fixture(t){
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-confirm-edit-'));
 t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
 fs.writeFileSync(path.join(workspace,'source.mjs'),before);
 return {workspace,executor:new Executor(workspace,{shellSandbox:'host',editConfirmations:true})};
}

test('a receipt applies exactly the reviewed source once without regenerated content',async t=>{
 const {workspace,executor}=fixture(t),first=await executor.execute(proposal),confirm=receipt(first.observation);
 assert.ok(confirm);assert.equal(first.editOutcome.applied,false);
 assert.equal(fs.readFileSync(path.join(workspace,'source.mjs'),'utf8'),before);
 assert.deepEqual(parseAction(JSON.stringify(confirm)).action,confirm);
 const applied=await executor.execute(confirm);
 assert.equal(applied.editOutcome.applied,true,applied.observation);
 assert.equal(applied.editOutcome.preservationReviews[0].decision,'confirmed');
 assert.equal(fs.readFileSync(path.join(workspace,'source.mjs'),'utf8'),after);
 assert.match((await executor.execute(confirm)).observation,/Unknown or consumed/);
});

test('a changed target invalidates a receipt before it can overwrite newer work',async t=>{
 const {workspace,executor}=fixture(t),confirm=receipt((await executor.execute(proposal)).observation);
 const updated=before+'// newer operator work\n';fs.writeFileSync(path.join(workspace,'source.mjs'),updated);
 assert.match((await executor.execute(confirm)).observation,/Stale edit confirmation/);
 assert.equal(fs.readFileSync(path.join(workspace,'source.mjs'),'utf8'),updated);
});

test('target identity, bytes and policy are checked again after receipt resolution',async t=>{
 for(const change of ['bytes','alias','policy','proposal']){
  const {workspace,executor}=fixture(t);
  const confirm=receipt((await executor.execute(proposal)).observation);
  if(!confirm)throw Error('Expected a fresh reviewed proposal');
  const resolved=executor.resolveEditConfirmation(confirm);
  if(change==='bytes')fs.appendFileSync(path.join(workspace,'source.mjs'),'// changed\n');
  if(change==='alias'){
   fs.writeFileSync(path.join(workspace,'other.mjs'),before);
   fs.unlinkSync(path.join(workspace,'source.mjs'));fs.symlinkSync('other.mjs',path.join(workspace,'source.mjs'));
  }
  if(change==='policy')executor.readOnlyWorkspacePaths=['source.mjs'];
  if(change==='proposal')resolved.content=before;
  const result=await executor.execute(resolved);
  assert.match(result.observation,/ERROR:/,change);assert.notEqual(result.editOutcome?.applied,true);
  if(change==='alias'){
   assert.equal(fs.readFileSync(path.join(workspace,'other.mjs'),'utf8'),before);
   fs.unlinkSync(path.join(workspace,'source.mjs'));
  }
 }
});

test('syntax errors, disabled receipts and another executor cannot supply write authority',async t=>{
 const {workspace,executor}=fixture(t),confirm=receipt((await executor.execute(proposal)).observation);
 const other=new Executor(workspace,{shellSandbox:'host',editConfirmations:true});
 assert.match((await other.execute(confirm)).observation,/Unknown or consumed/);
 const disabled=new Executor(workspace,{shellSandbox:'host'});
 assert.match((await disabled.execute(confirm)).observation,/disabled/);
 const invalid=await other.execute({...proposal,content:'export function broken( {'});
 assert.equal(receipt(invalid.observation),null);assert.equal(invalid.editOutcome.applied,false);
 assert.equal(fs.readFileSync(path.join(workspace,'source.mjs'),'utf8'),before);
});

test('receipt syntax is opt-in and its compact shape is shared by grammar and validation',()=>{
 assert.ok(!actionJsonSchema().properties.a.enum.includes('confirm_edit'));
 assert.ok(actionJsonSchema({features:['confirm_edit']}).properties.a.enum.includes('confirm_edit'));
 assert.match(actionGrammar({features:['confirm_edit']}),/confirm_edit/);
 assert.equal(parseAction('{"a":"confirm_edit"}').ok,false);
});

for(const blocked of [false,true])test(`agent keeps ordinary edit guards and compact durable history (blocked=${blocked})`,async t=>{
 const {workspace}=fixture(t),prompts=[],checkpoint=new RunCheckpoint({autosaveEvery:0});let calls=0,deny=false;
 const model={codex:true,assistantPrefill:'',stop:[],async complete(prompt){
  prompts.push(String(prompt));calls++;
  const action=calls===1?proposal:calls===2?receipt(prompt):{a:'respond',text:'Reviewed.'};
  if(calls===2){assert.ok(action);deny=blocked;}
  return {content:JSON.stringify(action),tokens:1,stoppedEos:true,timings:{}};
 }};
 const options={workspace,model,task:'Update source.mjs.',interactive:true,maxTurns:3,
  grounding:false,useGrammar:true,shellSandbox:'host',promptTrajectory:'extension',
  preGate:false,completionAudit:false,progressAwareness:false,regressionGuard:false,
  autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
  editGuard:()=>deny?'caller-protected':null,onEvent:e=>checkpoint.note(e)};
 const result=await runAgent(options);
 assert.equal(calls,3);
 const confirmed=result.turns[1];
 assert.deepEqual(confirmed.action,proposal);
 assert.equal(confirmed.editApplied,!blocked);
 assert.equal(fs.readFileSync(path.join(workspace,'source.mjs'),'utf8'),blocked?before:after);
 assert.deepEqual(checkpoint.turns()[1].editConfirmation,confirmed.editConfirmation);
 const film=buildArtifact({runId:'confirmation',stamp:'test',result,model:null});
 assert.deepEqual(film.turns[1].editConfirmation,confirmed.editConfirmation);
 assert.ok(prompts[2].startsWith(prompts[1]),'the provider prefix remains unchanged');
 const delta=prompts[2].slice(prompts[1].length);
 assert.match(delta,/"a":"confirm_edit"/);
 assert.ok(!delta.includes(JSON.stringify(proposal)),'the confirmed body is not retransmitted');
 await runAgent({...options,maxTurns:1,resumeTurns:film.turns.slice(0,2)});
 assert.match(prompts.at(-1),/"a":"confirm_edit"/);
});
