import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {checkWorkshopCLI,workshopCLICase} from '../scripts/factory-workshop-cli-check.mjs';

const cards=['context-packet','patch-transaction','stream-framer'];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function workspace(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workshop-cli-mock-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const card of cards)fs.writeFileSync(path.join(dir,card+'.js'),'// Mock subject. Never executed by these unit tests.\n');
  return dir;
}
function record(card,changes={}){
  const expected=Buffer.from(JSON.stringify(workshopCLICase(card).expected)+'\n');
  return {schema:'bantam.workshop-cli-check.v1',card,payloadBytes:128*1024,
    expectedStdoutBytes:expected.length,actualStdoutBytes:expected.length,
    expectedStdoutSha256:sha(expected),actualStdoutSha256:sha(expected),
    stdoutExact:true,stderrBytes:0,stderrEmpty:true,exitCode:0,signal:null,spawnErrorCode:null,...changes};
}
const response=(card,changes={},outer={})=>({code:0,stdout:JSON.stringify(record(card,changes))+'\n',stderr:'',timedOut:false,aborted:false,bufferExceeded:false,...outer});

test('large cases are bounded valid JSON pipeline specimens, not opaque expected success text',()=>{
  for(const card of cards){
    const specimen=workshopCLICase(card),bytes=Buffer.byteLength(JSON.stringify(specimen.expected)+'\n');
    assert.ok(bytes>=128*1024&&bytes<129*1024);
    if(card==='context-packet')assert.equal(specimen.input.maxBytes,specimen.expected.bytes);
    if(card==='patch-transaction'){assert.equal(specimen.input.edits.length,1);assert.equal(specimen.expected.applied,1);}
    if(card==='stream-framer')assert.ok(Buffer.from(specimen.input.chunks[0],'base64').toString().endsWith('data: [DONE]\n\n'));
  }
  assert.throws(()=>workshopCLICase('snapshot-drift'));
});

test('diagnostic uses offline readonly Docker and validates complete exact receipts without host candidate execution',async t=>{
  const dir=workspace(t);
  for(const card of cards){
    let called=0;
    const run=async(cwd,command,options)=>{
      called++;assert.equal(cwd,dir);
      assert.deepEqual(options,{shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,timeoutMs:15000});
      assert.ok(command.startsWith("node --input-type=module -e '"));
      const script=command.slice("node --input-type=module -e '".length,-1).replaceAll("'\\''","'");
      // Compile the controller only; never evaluate it or execute a subject.
      new vm.Script('(async()=>{'+script+'})');
      assert.ok(script.includes('maxBuffer:1024*1024'));assert.ok(script.includes("stdio:['ignore','pipe','pipe']"));
      assert.ok(script.includes('fs.rmSync(dir,{recursive:true,force:true})'));
      return response(card);
    };
    const checked=await checkWorkshopCLI(dir,card,{run});
    assert.equal(called,1);assert.equal(checked.status,'PASS');assert.equal(checked.pass,true);
    assert.equal(checked.supplementary,true);assert.equal(checked.canonicalScoreChanged,false);
    assert.equal(checked.candidateUnchanged,true);assert.equal(checked.candidateBeforeSha256,checked.candidateAfterSha256);
    assert.ok(JSON.stringify(checked).length<2000);assert.ok(!JSON.stringify(checked).includes('xxxx'));
  }
});

test('exit zero does not excuse truncated stdout, wrong bytes or nonempty stderr',async t=>{
  const dir=workspace(t),card='context-packet';
  for(const changes of [
    {actualStdoutBytes:8192,actualStdoutSha256:sha('partial'),stdoutExact:false},
    {actualStdoutSha256:sha('wrong'),stdoutExact:true},
    {stderrBytes:7,stderrEmpty:true},{exitCode:2},{signal:'SIGTERM',exitCode:null},
    {spawnErrorCode:'ENOBUFS',exitCode:null},
  ]){
    const checked=await checkWorkshopCLI(dir,card,{run:async()=>response(card,changes)});
    assert.equal(checked.status,'FAIL');assert.equal(checked.pass,false);assert.equal(checked.canonicalScoreChanged,false);
  }
});

test('missing, malformed, mismatched or interrupted controller receipts are unavailable, never passes',async t=>{
  const dir=workspace(t),card='stream-framer';
  for(const outer of [{code:1},{timedOut:true},{aborted:true},{bufferExceeded:true},{stdout:''},{stdout:'{"pass":true}'},
    {stdout:JSON.stringify(record('context-packet'))},{stdout:JSON.stringify(record(card,{actualStdoutBytes:null}))}]){
    const checked=await checkWorkshopCLI(dir,card,{run:async()=>response(card,{},outer)});
    assert.equal(checked.status,'UNAVAILABLE');assert.equal(checked.pass,null);
  }
  const thrown=await checkWorkshopCLI(dir,card,{run:async()=>{throw Error('do not echo arbitrary infrastructure details');}});
  assert.equal(thrown.status,'UNAVAILABLE');assert.ok(!JSON.stringify(thrown).includes('arbitrary infrastructure'));
});

test('candidate hash changes cannot produce a pass, and unknown subjects fail before any sandbox call',async t=>{
  const dir=workspace(t),card='patch-transaction';
  const checked=await checkWorkshopCLI(dir,card,{run:async()=>{
    fs.writeFileSync(path.join(dir,card+'.js'),'// Changed mock bytes, not candidate execution.\n');
    return response(card);
  }});
  assert.equal(checked.pass,false);assert.equal(checked.candidateUnchanged,false);
  const run=async()=>assert.fail('must reject before sandbox execution');
  await assert.rejects(checkWorkshopCLI(dir,'unknown',{run}));
  await assert.rejects(checkWorkshopCLI('relative',card,{run}));
  fs.symlinkSync(dir,path.join(dir,'alias'),'dir');
  await assert.rejects(checkWorkshopCLI(path.join(dir,'alias'),card,{run}));
});
