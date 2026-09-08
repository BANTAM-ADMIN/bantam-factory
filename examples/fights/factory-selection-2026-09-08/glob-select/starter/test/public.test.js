import test from 'node:test';
import assert from 'node:assert/strict';
import {selectPaths} from '../glob-select.js';
test('a star stays inside one segment and every path gets a decision',()=>{
  assert.deepEqual(selectPaths(['a.js','x/b.js'],['*.js']),
    {selected:['a.js'],decisions:[{path:'a.js',included:true,pattern:0},{path:'x/b.js',included:false,pattern:-1}]});
});
test('the last matching pattern decides',()=>{
  assert.deepEqual(selectPaths(['a.js','b.js'],['*.js','!a.js']).selected,['b.js']);
});
