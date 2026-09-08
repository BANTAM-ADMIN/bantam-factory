import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeIntervals} from '../interval-merge.js';
test('overlapping and touching ranges coalesce',()=>{
  assert.deepEqual(mergeIntervals([{start:5,end:7},{start:1,end:3},{start:3,end:4}]),
    {merged:[{start:1,end:4},{start:5,end:7}],covered:5,dropped:1});
});
test('an empty input covers nothing',()=>{
  assert.deepEqual(mergeIntervals([]),{merged:[],covered:0,dropped:0});
});
