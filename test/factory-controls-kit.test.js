import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runShellProcess} from '../src/executor.js';
import {factoryKit} from '../scripts/factory-card-catalog.mjs';
const kit=factoryKit('factory-controls-2026-09-07'),read=(...p)=>fs.readFileSync(path.join(kit.root,...p),'utf8');
const refs=Object.fromEntries(kit.cards.map(id=>[id,read(id,'reviewer',id+'.js')]));
const docker={skip:process.env.BANTAM_FIGHT_KIT_DOCKER_TEST!=='1',timeout:45000};
const q=s=>`'${s.replaceAll("'","'\\''")}'`;
async function checkSource(t,id,source,publicTests=false){
  const ws=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-controls-gauge-'));t.after(()=>fs.rmSync(ws,{recursive:true,force:true}));
  fs.cpSync(path.join(kit.root,id,'starter'),ws,{recursive:true});fs.writeFileSync(path.join(ws,id+'.js'),source);
  const grader=path.join(kit.root,id,'grader.mjs');
  const r=await runShellProcess(ws,`${publicTests?'npm test && ':''}node ${q(grader)} ${q(ws)}`,{shellSandbox:'docker',shellNetwork:false,
    workspaceReadOnly:true,dockerImage:'ubuntu:24.04',readOnlyHostFiles:[grader,path.join(kit.root,'grader-support.mjs')],timeoutMs:30000});
  assert.equal(r.timedOut,false,r.stderr);assert.equal(r.aborted,false,r.stderr);assert.equal(r.bufferExceeded,false,r.stderr);
  const receipt=JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual(receipt.groups.map(g=>g.name),JSON.parse(read(id,'card.json')).groups);
  return {r,receipt};
}
test('fresh controls kit has protected public starters and five declared groups per work order',()=>{
  for(const id of kit.cards){
    const d=JSON.parse(read(id,'card.json'));assert.equal(d.id,id);assert.equal(new Set(d.groups).size,5);
    for(const p of [...d.protected,...d.deliverables])assert.ok(fs.statSync(path.join(kit.root,id,'starter',p)).isFile());
    assert.ok(!fs.existsSync(path.join(kit.root,id,'starter','reviewer')));
    for(const group of d.groups)assert.ok(read(id,'grader.mjs').includes(`check('${group}'`));
  }
});
for(const id of kit.cards){
  test(`controls gauge accepts ${id} reference and public tests`,docker,async t=>{
    const {r,receipt}=await checkSource(t,id,refs[id],true);assert.equal(r.code,0,r.stdout+r.stderr);assert.equal(receipt.pass,true);
  });
  test(`controls gauge rejects ${id} starter`,docker,async t=>{
    const {r,receipt}=await checkSource(t,id,read(id,'starter',id+'.js'));assert.equal(r.code,1);assert.equal(receipt.pass,false);
  });
}
const mutations=[
  ['redaction-plan','wrong longest-first rule','(b.end-b.start)-(a.end-a.start)','(a.end-a.start)-(b.end-b.start)'],
  ['redaction-plan','character count replaces byte count',"Buffer.byteLength(text,'utf8')",'text.length'],
  ['redaction-plan','duplicate IDs accepted','||ids.has(r.id)',''],
  ['redaction-plan','touching edits rejected','if(m.start<cursor)','if(m.start<=cursor)'],
  ['retry-budget','wrong attempt exponent','2**(o.attempt-1)','2**o.attempt'],
  ['retry-budget','server hint wrongly capped','Math.max(exponential,o.retryAfterMs??0)','Math.min(o.maxDelayMs,Math.max(exponential,o.retryAfterMs??0))'],
  ['retry-budget','exact budget boundary rejected','delayMs>o.budgetMs-o.elapsedMs','delayMs>=o.budgetMs-o.elapsedMs'],
  ['retry-budget','zero base lost at huge attempt','o.baseMs===0?0:',''],
];
for(const [id,label,before,after]of mutations)test(`controls gauge catches ${label}`,docker,async t=>{
  assert.ok(refs[id].includes(before));const {r,receipt}=await checkSource(t,id,refs[id].replace(before,after));
  assert.equal(r.code,1);assert.equal(receipt.pass,false);
});
