import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJsonFile,snapshotJsonValue} from '../src/json-file.js';
import {writeJsonAtomic} from '../src/atomic-file.js';

test('JSON snapshots retain native coercion, omissions, shared values and safe property names',()=>{
  const shared={text:'🐔\n雪\u2028\\"'};
  const value={a:shared,b:shared,array:[,undefined,()=>{},Symbol(),NaN,Infinity,-0],
    date:new Date('2026-09-09T00:00:00Z'),number:new Number(2),string:new String('text'),bool:new Boolean(false),
    ignored:undefined,fn:()=>{},symbol:Symbol(),map:new Map(),
    nested:{toJSON(key){return {key,answer:42};}},
    ...JSON.parse('{"__proto__":{"safe":true},"constructor":"ordinary data"}')};
  assert.deepEqual(snapshotJsonValue(value),JSON.parse(JSON.stringify(value)));
  const snapshot=snapshotJsonValue(value);shared.text='changed';assert.notEqual(snapshot.a.text,shared.text);
  assert.equal(Object.getPrototypeOf(snapshot),Object.prototype);
  assert.equal(Object.hasOwn(snapshot,'__proto__'),true);
  assert.equal({}.safe,undefined);
  const cycle={};cycle.self=cycle;assert.throws(()=>snapshotJsonValue(cycle),/circular/);
  assert.throws(()=>snapshotJsonValue({value:1n}),/BigInt/);
  assert.equal(snapshotJsonValue({toJSON(){return undefined;}}),undefined);
});

test('atomic JSON reads split UTF-8 and escapes across chunks and hash the original bytes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-json-file-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'run.json');
  let getters=0,conversions=0;
  const record={turns:[{prompt:'🐔 雪\u2028\n \\"'.repeat(100)}],get result(){getters++;return {toJSON(key){conversions++;return {key,pass:true};}};}};
  writeJsonAtomic(file,record);assert.equal(getters,1);assert.equal(conversions,1);
  const bytes=fs.readFileSync(file);
  for(const highWaterMark of [1,3,11,128]){
    const {value,sha256}=await readJsonFile(file,{withHash:true,highWaterMark});
    assert.deepEqual(value,JSON.parse(bytes.toString()));
    assert.equal(sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  const original=fs.readFileSync(file);
  for(const invalid of [undefined,()=>{},Symbol(),{toJSON(){return undefined;}},{value:1n}]){
    assert.throws(()=>writeJsonAtomic(file,invalid));assert.deepEqual(fs.readFileSync(file),original);
  }
  fs.writeFileSync(file,'{"turns":[{"prompt":"broken"}');
  await assert.rejects(readJsonFile(file,{highWaterMark:3}),SyntaxError);
  assert.deepEqual(fs.readdirSync(dir),['run.json']);
});
