import test from 'node:test';
import assert from 'node:assert/strict';
import {planRedactions} from '../redaction-plan.js';
test('literal replacement has an original-position receipt',()=>{
  assert.deepEqual(planRedactions('a.b a.b',[{id:'dot',literal:'a.b',replacement:'X'}]),
    {text:'X X',edits:[{start:0,end:3,id:'dot'},{start:4,end:7,id:'dot'}],originalBytes:7,redactedBytes:3});
});
test('longest same-start match wins',()=>{
  assert.equal(planRedactions('ababa',[{id:'a',literal:'ab',replacement:'S'},{id:'b',literal:'aba',replacement:'L'}]).text,'Lba');
});
