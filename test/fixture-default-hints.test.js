import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureDefaultHints } from '../src/fixture-default-hints.js';

const source = "const row=(id, priority=0, required=false)=>({id,priority,required});\n";
test('visible fixture defaults explain why undefined does not reach an API', () => {
  const hint = fixtureDefaultHints({path:'test/public.test.js',source});
  assert.match(hint, /row \(line 1\): priority=0, required=false/);
  assert.match(hint, /Passing undefined or omitting that argument uses the default/);
  assert.match(hint, /not the API's behavior/);
  assert.equal(fixtureDefaultHints({path:'src/defaults.js',source}), '');
  assert.equal(fixtureDefaultHints({path:'test/public.test.js',source,startLine:2}), '');
  assert.equal(fixtureDefaultHints({path:'test/public.test.js',source,endLine:0}), '');
});
test('unsupported code and helpers without defaulted returned fields stay silent', () => {
  for (const source of ['broken(', 'const row=(x=0)=>x;', 'const row=(x=0)=>({a:1});', 'function row(x=0){ setup(); return {x}; }']) {
    assert.equal(fixtureDefaultHints({path:'row.test.js',source}), '');
  }
  const hint = fixtureDefaultHints({path:'row.test.js',source:"function row(x=123) { return {value:x}; }"});
  assert.match(hint, /x=123/);
  const many = Array.from({length:30},(_,i)=>`const r${i}=(x=0)=>({x});`).join('\n');
  const bounded = fixtureDefaultHints({path:'row.test.js',source:many});
  assert.ok(bounded.length < 1000); assert.doesNotMatch(bounded,/r3 \(/);
});
