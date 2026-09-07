import test from 'node:test';
import assert from 'node:assert/strict';
import {collectNodeCliRoutingFacts,formatNodeCliRoutingFacts} from '../src/node-cli-routing-facts.js';
const inspect=source=>collectNodeCliRoutingFacts({source,path:'entry.mjs'});
const sliced=`function launch(args) { if(args.length !== 2) { console.error('usage'); return 2; } return args[0]; }
if(import.meta.url === 'file://'+process.argv[1]) process.exit(launch(process.argv.slice(2)));`;
const gated=`function main() { if(process.argv.length !== 3) process.exit(2); }
if(process.argv[1] && process.argv[1].endsWith('entry.mjs') && process.argv.length === 3) main();`;

test('literal argv slice and leading parameter length guard produce exact count cases, not expected values',()=>{
  const r=inspect(sliced);assert.equal(r.candidateVerified,false);assert.match(r.sourceSha256,/^[a-f0-9]{64}$/);
  const f=r.facts[0];assert.equal(f.kind,'sliced-argv-parameter-comparison');
  assert.deepEqual(f.cases.map(c=>c.parameterLength),[0,1,2]);
  assert.deepEqual(f.cases.map(c=>c.condition),[true,true,false]);
  assert.equal(f.sliceStart,2);
  assert.match(formatNodeCliRoutingFacts(r),/no expected arity, overall exit, bug verdict or verification/);
  assert.ok(formatNodeCliRoutingFacts(r).length<700);
  const long=inspect(sliced.replaceAll('launch','launch'+"x".repeat(100)).replaceAll('args','args'+"x".repeat(100)));
  assert.ok(formatNodeCliRoutingFacts(long).length<700);
});

test('correct and deliberately different CLI contracts yield facts without being labeled bugs',()=>{
  const one=inspect(sliced.replace('!== 2','!== 1'));assert.deepEqual(one.facts[0].cases.map(c=>c.condition),[true,false,true]);
  const raw=inspect(sliced.replace('process.argv.slice(2)','process.argv').replace('!== 2','!== 3'));
  assert.deepEqual(raw.facts[0].cases.map(c=>c.parameterLength),[2,3,4]);
  const reversed=inspect(sliced.replace('args.length !== 2','2 > args.length'));
  assert.deepEqual(reversed.facts[0].cases.map(c=>c.condition),[true,true,false]);
});

test('outer required length term excludes zero/two-argument dispatch without claiming whole-program exit',()=>{
  const r=inspect(gated),f=r.facts[0];assert.equal(f.kind,'argv-length-gated-dispatch');
  assert.deepEqual(f.cases.map(c=>c.lengthCondition),[false,true,false]);
  assert.deepEqual(f.cases.map(c=>c.excludedByLength),[true,false,true]);
  assert.match(formatNodeCliRoutingFacts(r),/not necessarily every program path/);
  assert.equal(inspect(gated.replace("process.argv[1] && process.argv[1].endsWith('entry.mjs') && process.argv.length === 3",'process.argv.length === 3 || other()')),null);
  assert.equal(inspect('function main() {} if(process.argv.length === 3) {} else main();'),null);
});

test('shadowing, mutation, aliases, opaque slicing and nonleading or nested guards fail closed',()=>{
  for(const code of [
    'const process = custom;'+sliced,
    'import {argv} from "node:process"; argv.pop();'+sliced,
    'Array.prototype.slice = custom;'+sliced,
    sliced.replace('function launch','function* launch'),
    sliced.replace('function launch(args)','function launch({args})'),
    sliced.replace('if(args.length','args = []; if(args.length'),
    sliced.replace('if(args.length','args.push(1); if(args.length'),
    sliced.replace('if(args.length','const alias=args; alias.pop(); if(args.length'),
    sliced.replace('if(args.length','function other(args) {} if(args.length'),
    sliced.replace('process.argv.slice(2)','process.argv.slice(offset)'),
    sliced.replace('process.argv.slice(2)','process.argv.slice(-1)'),
    sliced.replace('process.argv.slice(2)','process.argv.slice(2,4)'),
    'process.argv.push(1);'+sliced,
    'process.argv[2] = "added";'+sliced,
    'const alias=process.argv; alias.pop();'+sliced,
    'launch = other;'+sliced,
    'const p=process;'+sliced,
    sliced.replace('args.length !== 2','args["length"] !== 2'),
  ])assert.equal(inspect(code),null,code);
});

test('comments/strings/uncalled helpers and source bounds do not produce routing evidence',()=>{
  assert.equal(inspect('// '+sliced.replaceAll('\n',' ')),null);
  assert.equal(inspect('const text='+JSON.stringify(sliced)+';'),null);
  assert.equal(inspect('function launch(args) { if(args.length!==2) return 2; }'),null);
  assert.equal(inspect('{'),null);
  assert.equal(inspect(' '.repeat(256*1024+1)),null);
  assert.equal(inspect(sliced.replaceAll('launch','launch'+"x".repeat(121))),null);
  assert.equal(formatNodeCliRoutingFacts(null),'');
});
