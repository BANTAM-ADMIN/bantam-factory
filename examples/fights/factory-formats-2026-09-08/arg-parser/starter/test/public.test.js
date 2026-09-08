import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs} from '../arg-parser.js';
const spec={a:{type:'boolean',short:'a'},b:{type:'boolean',short:'b'},out:{type:'string'}};
test('bundled shorts and a terminator',()=>{
  assert.deepEqual(parseArgs(['-ab','--out=x','--','-z'],spec),
    {options:{a:true,b:true,out:'x'},positionals:['-z']});
});
test('an absent option is absent, not defaulted',()=>{
  assert.deepEqual(parseArgs([],spec),{options:{},positionals:[]});
});
