import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateHand, compareHands} from '../poker-hand.js';
test('the wheel is a straight whose high card is the five',()=>{
  assert.deepEqual(evaluateHand(['Ah','2c','3d','4s','5h']),
    {rank:4,category:'straight',tiebreak:[5]});
});
test('a stronger category wins regardless of suits',()=>{
  assert.equal(compareHands(['Kc','Kd','9h','5s','2c'],['9c','9d','9h','5s','2c']),-1);
});
