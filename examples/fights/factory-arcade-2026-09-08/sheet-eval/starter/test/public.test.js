import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSheet} from '../sheet-eval.js';
test('a reference cycle is reported, not fatal',()=>{
  assert.deepEqual(evaluateSheet({A1:'=B1+1',B1:'=A1'}),
    {values:{},errors:{A1:'cycle',B1:'cycle'},order:[]});
});
test('multiplication binds tighter than addition',()=>{
  assert.equal(evaluateSheet({A1:'=2+3*4'}).values.A1,14);
});
