import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNameStatusZ } from '../changed-paths.js';

test('empty and ordinary modifications', () => {
  assert.deepEqual(parseNameStatusZ(''), []);
  assert.deepEqual(parseNameStatusZ('M\0src/main.js\0'), [{status:'M',source:null,path:'src/main.js'}]);
});
test('scored rename preserves both paths', () => {
  assert.deepEqual(parseNameStatusZ('R100\0before.js\0after.js\0'), [{status:'R100',source:'before.js',path:'after.js'}]);
});
test('incomplete records are rejected', () => {
  assert.throws(() => parseNameStatusZ('R100\0before.js\0'));
  assert.throws(() => parseNameStatusZ('M\0file.js'));
});
