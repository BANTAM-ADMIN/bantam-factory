import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapStyled} from '../ansi-wrap.js';
test('plain text breaks at a space and the space is dropped',()=>{
  assert.deepEqual(wrapStyled('ab cd',3),{lines:['ab','cd'],widths:[2,2]});
});
test('escapes take no display width',()=>{
  assert.deepEqual(wrapStyled('[31mabc[0m',3).widths,[3]);
});
