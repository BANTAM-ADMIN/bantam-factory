import test from 'node:test';
import assert from 'node:assert/strict';
import {readRecords} from '../csv-record.js';
test('a quoted field carries the delimiter and a doubled quote',()=>{
  assert.deepEqual(readRecords('a,"b,1"\r\nc,"d""e"'),
    {fields:null,records:[['a','b,1'],['c','d"e']]});
});
test('an empty text has no records',()=>{
  assert.deepEqual(readRecords(''),{fields:null,records:[]});
});
