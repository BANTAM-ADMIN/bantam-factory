import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePointer} from '../json-pointer.js';
test('a resolving pointer reports its value and depth',()=>{
  assert.deepEqual(resolvePointer({a:[{b:1}]},'/a/0/b'),{found:true,value:1,depth:3,reason:null});
});
test('a miss is a receipt, not an exception',()=>{
  assert.deepEqual(resolvePointer({a:[{b:1}]},'/a/1/b'),
    {found:false,value:null,depth:1,reason:'index-out-of-range'});
});
