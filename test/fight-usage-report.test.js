import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {deriveSavedWireUsage} from '../scripts/fight-usage-report.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t,changes={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-saved-usage-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const body='{"messages":[{"role":"user","content":"private task"}]}';
  const raw='data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}}\n\n';
  fs.writeFileSync(path.join(dir,'00001.request.body'),body);
  fs.writeFileSync(path.join(dir,'00001.response.body'),raw);
  const request={index:1,phase:'request',route:'/v1/chat/completions',method:'POST',generation:true,
    requestBytes:Buffer.byteLength(body),requestSha256:hash(body),finished:false};
  const response={...request,phase:'response',finished:true,status:200,contentType:'text/event-stream',
    responseBytes:Buffer.byteLength(raw),responseSha256:hash(raw),usage:{inputTokens:999999,outputTokens:999999},...changes};
  const write=rows=>fs.writeFileSync(path.join(dir,'exchanges.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  write([request,response]);return {dir,request,response,write};
}

test('saved wire derivation recomputes counters from hashed bodies without modifying original evidence',t=>{
  const f=fixture(t);const before=fs.readdirSync(f.dir).map(name=>[name,hash(fs.readFileSync(path.join(f.dir,name)))]);
  const report=deriveSavedWireUsage(f.dir);
  assert.equal(report.schema,'bantam.fight-usage-report.v1');assert.equal(report.usage.inputTokens,10);
  assert.equal(report.usage.cacheHitTokens,3);assert.equal(report.integrity.verifiedBodies,2);
  assert.equal(report.integrity.verified,true);assert.deepEqual(report.gaps,[]);
  assert.ok(!JSON.stringify(report).includes('private task'),'projection exposes hashes, not source bodies');
  assert.deepEqual(fs.readdirSync(f.dir).map(name=>[name,hash(fs.readFileSync(path.join(f.dir,name)))]),before);
});

test('historical incomplete transport keeps whole-run unknown while retaining measured terminal counters',t=>{
  const f=fixture(t,{finished:false,error:'client disconnected'});
  const report=deriveSavedWireUsage(f.dir);
  assert.equal(report.usage.complete,false);assert.equal(report.usage.inputTokens,null);
  assert.equal(report.usage.measuredSubset.inputTokens,10);assert.equal(report.usage.measuredSubset.cacheHitTokens,3);
  assert.equal(report.usage.coverage.outputTokens.complete,true);
  assert.deepEqual(report.gaps[0].missingFields,[]);assert.equal(report.gaps[0].reason,'client-disconnected');
});

test('missing terminal usage and an unsealed admitted row remain explicit gaps',t=>{
  const f=fixture(t);f.write([f.request]);
  const report=deriveSavedWireUsage(f.dir);
  assert.equal(report.integrity.verified,false);assert.deepEqual(report.integrity.unsealedResponseIndices,[1]);
  assert.equal(report.usage.measuredSubset.outputTokens,null,'unsealed raw file cannot silently provide authoritative usage');
  assert.equal(report.gaps[0].reason,'unsettled-recording');
});

test('tampered bodies, duplicate records and cross-request binding are rejected',t=>{
  const f=fixture(t);
  f.write([f.request,{...f.response,requestSha256:hash('other')}]);
  assert.throws(()=>deriveSavedWireUsage(f.dir),/binding mismatch/);
  f.write([f.request,f.response,f.response]);assert.throws(()=>deriveSavedWireUsage(f.dir),/duplicate/);
  f.write([f.request,f.response]);fs.appendFileSync(path.join(f.dir,'00001.response.body'),'altered');
  assert.throws(()=>deriveSavedWireUsage(f.dir),/response body mismatch/);
});

test('unsafe metadata, malformed counters and symlink evidence do not gain trusted totals',t=>{
  const f=fixture(t);
  f.write([{...f.request,index:'../escape'},f.response]);assert.throws(()=>deriveSavedWireUsage(f.dir),/invalid/);
  f.write([f.request,{...f.response,responseBytes:-1}]);assert.throws(()=>deriveSavedWireUsage(f.dir),/invalid/);
  f.write([f.request,f.response]);
  const original=path.join(f.dir,'00001.response.body');fs.renameSync(original,path.join(f.dir,'elsewhere'));
  fs.symlinkSync('elsewhere',original);assert.throws(()=>deriveSavedWireUsage(f.dir),/ELOOP/);
  const link=path.join(f.dir,'linked-directory');fs.symlinkSync(f.dir,link,'dir');
  assert.throws(()=>deriveSavedWireUsage(link),/symlink/);
});

test('large declared counters cannot overflow the aggregate into a fabricated complete total',t=>{
  const f=fixture(t);
  const raw=`{"usage":{"prompt_tokens":${Number.MAX_SAFE_INTEGER+1},"completion_tokens":2}}`;
  fs.writeFileSync(path.join(f.dir,'00001.response.body'),raw);
  f.write([f.request,{...f.response,contentType:'application/json',responseBytes:Buffer.byteLength(raw),responseSha256:hash(raw)}]);
  const report=deriveSavedWireUsage(f.dir);
  assert.equal(report.usage.inputTokens,null);assert.equal(report.usage.measuredSubset.inputTokens,null);
  assert.equal(report.usage.measuredSubset.outputTokens,2);
});
