import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGrid, run} from '../life-grid.js';
test('the existing parser still reads a grid',()=>{
  assert.deepEqual(parseGrid(['.#']),[[false,true]]);
});
test('a block is stable and stops early',()=>{
  const r=run(parseGrid(['##','##']),5);
  assert.equal(r.stable,true);
  assert.equal(r.generations,1);
});
