import test from 'node:test';
import assert from 'node:assert/strict';
import {packContext} from '../context-packet.js';
const section=(id,text,priority=0,required=false)=>({id,text,priority,required});
test('required evidence is included before optional priority',()=>{
  assert.deepEqual(packContext([section('extra','x',50),section('rule','Do it.',0,true)],100),{
    text:'### "rule"\nDo it.\n### "extra"\nx\n',bytes:32,included:['rule','extra'],omitted:[]});
});
test('whole UTF-8 sections, exact fits, and skip instead of stop',()=>{
  const frame='### "雪"\né\n',bytes=Buffer.byteLength(frame);
  assert.deepEqual(packContext([section('large','x'.repeat(100),10),section('雪','é',1)],bytes),{
    text:frame,bytes,included:['雪'],omitted:['large']});
});
test('empty selection and required overflow',()=>{
  assert.deepEqual(packContext([],0),{text:'',bytes:0,included:[],omitted:[]});
  assert.throws(()=>packContext([section('rule','x',0,true)],0),Error);
});
test('validate omitted entries too and leave input unchanged',()=>{
  assert.throws(()=>packContext([section('x','x'),section('x','y')],0),Error);
  assert.throws(()=>packContext(new Array(1),0),Error);
  const input=[section('b','b',1),section('a','a',1)],before=JSON.stringify(input);
  assert.deepEqual(packContext(input,100).included,['b','a']);
  assert.equal(JSON.stringify(input),before);
});
