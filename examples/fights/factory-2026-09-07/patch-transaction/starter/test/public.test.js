import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEdit,applyTransaction} from '../patch-transaction.js';
const edit=(start,end,before,after)=>({start,end,before,after});
test('preserve existing single-edit behavior',()=>{
  assert.equal(applyEdit('abc',edit(1,2,'b','LONG')),'aLONGc');
  assert.throws(()=>applyEdit('abc',edit(1,2,'wrong','x')),Error);
});
test('all coordinates refer to the original text',()=>{
  const edits=[edit(0,1,'a','LONG'),edit(3,5,'de','X')];
  assert.deepEqual(applyTransaction('abcdef',edits),{text:'LONGbcXf',applied:2});
  assert.deepEqual(applyTransaction('abcdef',[...edits].reverse()),{text:'LONGbcXf',applied:2});
});
test('adjacent replacements allowed; insertion touching a range rejected',()=>{
  assert.deepEqual(applyTransaction('abcd',[edit(0,2,'ab','x'),edit(2,4,'cd','y')]),{text:'xy',applied:2});
  assert.throws(()=>applyTransaction('abcd',[edit(0,2,'ab','x'),edit(2,2,'','y')]),Error);
});
test('empty transaction, empty source insertion, and validation',()=>{
  assert.deepEqual(applyTransaction('tail\r\n',[]),{text:'tail\r\n',applied:0});
  assert.deepEqual(applyTransaction('',[edit(0,0,'','new')]),{text:'new',applied:1});
  assert.throws(()=>applyTransaction(null,[]),Error);
});
