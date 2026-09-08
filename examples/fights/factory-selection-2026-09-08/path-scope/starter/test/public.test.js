import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSegments, resolveWithin} from '../path-scope.js';
test('the existing helper keeps normalizing segments',()=>{
  assert.deepEqual(normalizeSegments('/a//b/./c'),['a','b','c']);
  assert.deepEqual(normalizeSegments('a/../../b'),['b']);
});
test('a candidate that stays inside reports its path from the root',()=>{
  assert.deepEqual(resolveWithin('/srv/ws','sub/../file.txt'),
    {inside:true,resolved:'/srv/ws/file.txt',relative:'file.txt'});
});
