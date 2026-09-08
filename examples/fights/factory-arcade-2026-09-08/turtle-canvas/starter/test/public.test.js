import test from 'node:test';
import assert from 'node:assert/strict';
import {runTurtle} from '../turtle-canvas.js';
test('the turtle draws its path and reports where it stopped',()=>{
  assert.deepEqual(runTurtle([{op:'move',n:2},{op:'turn',deg:90},{op:'move',n:1}],{width:3,height:2}),
    {canvas:['###','  #'],marked:4,position:{col:2,row:1},heading:'south'});
});
test('an empty program marks nothing',()=>{
  assert.deepEqual(runTurtle([],{width:2,height:2}).marked,0);
});
