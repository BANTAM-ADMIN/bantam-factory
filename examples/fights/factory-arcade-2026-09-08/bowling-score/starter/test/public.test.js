import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreGame} from '../bowling-score.js';
test('a perfect game totals 300',()=>{
  const g=scoreGame(Array(12).fill(10));
  assert.equal(g.total,300);
  assert.equal(g.complete,true);
});
test('an unfinished game leaves later frames null',()=>{
  const g=scoreGame([10]);
  assert.equal(g.frames[0].score,null);
  assert.equal(g.complete,false);
});
