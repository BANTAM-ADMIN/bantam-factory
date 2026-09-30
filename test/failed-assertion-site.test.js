import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { failedAssertionSite } from '../src/failed-assertion-site.js';

const sha = source => crypto.createHash('sha256').update(source).digest('hex');
function inline(source) {
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 1, result.stderr);
  return result.stderr;
}
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-site (fixture) '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function expected(source, expression) {
  const start = source.indexOf(expression), prefix = source.slice(0, start).split(/\r\n|[\n\r\u2028\u2029]/);
  return { sourceSha256: sha(source), start, end: start + expression.length,
    line: prefix.length, column: prefix.at(-1).length, expression };
}
const four = `const check = require('node:assert/strict');
const values = [1, 2];
check.equal(values.length, 2);
check.deepEqual(values.slice(0, 1), [1]);
check.equal(values[1], 9);
check.ok(values.length > 0);`;

test('a four-assertion inline check maps the actual later failure, not the first assertion', () => {
  assert.deepEqual(failedAssertionSite({ assertion: four, output: inline(four) }), expected(four, 'check.equal(values[1], 9)'));
});

test('same-line assertions, nested assertion calls, arrays and callbacks use exact innermost AST spans', () => {
  for (const [source, expression] of [
    ["const a=require('assert/strict');a.ok(true);a.equal([1,2][1], 4);a.ok(true);", 'a.equal([1,2][1], 4)'],
    ["const a=require('node:assert/strict');a.ok(a.strictEqual(1,2));", 'a.strictEqual(1,2)'],
    ["const a=require('node:assert/strict');[0,1].forEach(value => a.equal(value,0));", 'a.equal(value,0)'],
    ["const a=require('node:assert/strict');a['deepEqual']([[1]], [[2]]);", "a['deepEqual']([[1]], [[2]])"],
    ["const a=require('node:assert/strict');a(false);", 'a(false)'],
    ["const actual=require('node:assert/strict');const a={equal:(x,y)=>actual.equal(x,y)};a.equal(1,2);", 'actual.equal(x,y)'],
  ]) assert.deepEqual(failedAssertionSite({ assertion: source, output: inline(source) }), expected(source, expression));
});

test('real CommonJS paths and ESM default or namespace imports bind the exact selected file', t => {
  const root = workspace(t);
  for (const [extension, declaration] of [
    ['cjs', "const verify=require('node:assert/strict');"],
    ['mjs', "import verify from 'node:assert/strict';"],
    ['mjs', "import * as verify from 'node:assert/strict';"],
  ]) {
    const source = declaration + '\nverify.ok(true);\nverify.strictEqual(3, 4);\n';
    const file = path.join(root, `check ${extension}.${extension}`);
    fs.writeFileSync(file, source);
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1);
    assert.deepEqual(failedAssertionSite({ assertion: source, output: result.stderr, sourcePath: file }), expected(source, 'verify.strictEqual(3, 4)'));
    assert.equal(failedAssertionSite({ assertion: source, output: result.stderr, sourcePath: path.join(root, 'different.js') }), null);
    assert.equal(failedAssertionSite({ assertion: source, output: result.stderr }), null);
  }
});

test('a candidate/helper assertion frame cannot be skipped to blame a later assertion in the check', t => {
  const root = workspace(t), helper = path.join(root, 'helper.cjs');
  fs.writeFileSync(helper, "module.exports=()=>require('node:assert/strict').equal(1,2);");
  const source = `const a=require('node:assert/strict');const produce=require(${JSON.stringify(helper)});a.ok(produce());`;
  assert.equal(failedAssertionSite({ assertion: source, output: inline(source) }), null);
  const file = path.join(root, 'check.cjs');
  fs.writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 3000 });
  assert.equal(failedAssertionSite({ assertion: source, output: result.stderr, sourcePath: file }), null);
});

test('shadowed, reassigned, mutated or spoofed assert bindings are not accepted', () => {
  const sources = [
    "const a=require('node:assert/strict');function f(a){a.equal(1,2);}f(a);",
    "let a=require('node:assert/strict');const original=a;a=original;a.equal(1,2);",
    "const a=require('node:assert/strict');a.equal=a.strictEqual;a.equal(1,2);",
    "const a=require('node:assert/strict');Object.assign(a,{equal:a.strictEqual});a.equal(1,2);",
    "const a=require('node:assert/strict');for(a.strictEqual of [a.strictEqual]){}a.strictEqual(1,2);",
    "const {strictEqual}=require('node:assert/strict');strictEqual(1,2);",
  ];
  for (const source of sources) assert.equal(failedAssertionSite({ assertion: source, output: inline(source) }), null, source);
});

test('comments and messages mentioning other assertions do not redirect the actual callsite', () => {
  const source = `const a=require('node:assert/strict');
// a.equal(100, 200); a.fail('not executed');
a.ok(true);
a.equal(1,2,'message mentions a.deepEqual([3], [4])');`;
  assert.deepEqual(failedAssertionSite({ assertion: source, output: inline(source) }), expected(source, "a.equal(1,2,'message mentions a.deepEqual([3], [4])')"));
  const spoof = "const a=require('node:assert/strict');a.ok(true);a.ok(false,'fake frame\\n    at [eval]:1:37');";
  assert.equal(failedAssertionSite({ assertion: spoof, output: inline(spoof) }), null);
});

test('complete headers and inspected footers are required; clipped, duplicate or malformed logs cannot focus', () => {
  const output = inline(four);
  const variants = [
    output.replace('AssertionError [ERR_ASSERTION]:', 'log: AssertionError [ERR_ASSERTION]:'),
    output.replace("code: 'ERR_ASSERTION'", "code: 'ERR_OTHER'"),
    output.replace("  code: 'ERR_ASSERTION',", "  code: 'ERR_ASSERTION',\n  code: 'ERR_ASSERTION',"),
    output.replace(/  expected:.*\n/, ''),
    output.replace(/  expected:.*\n/, "  expected: 9,\n  expected: 10,\n"),
    output.replace(/\n}\n/, '\n'),
    output.replace(/Node\.js v[^\n]+\n?$/, ''),
    output + 'trailing unrelated output',
    output + output,
    output.replace('  actual:', '[300 chars clipped]\n  actual:'),
    output.replace('  actual:', '[output truncated]\n  actual:'),
    output.replace('  actual:', 'verification output clipped; tail preserved\n  actual:'),
    output.replace(/    at \[eval\]:\d+:\d+/, '    at <anonymous>'),
    output.replace(/    at \[eval\]:\d+:\d+/, '    at [eval]:99999:99999'),
    output.replace(/    at \[eval\]:\d+:\d+/, '    at [eval]:0:0'),
    output.replace(/    at \[eval\]:\d+:\d+/, '    at helper (/workspace/other.js:5:1)\n    at [eval]:5:7'),
  ];
  for (const altered of variants) assert.equal(failedAssertionSite({ assertion: four, output: altered }), null, altered);
  assert.equal(failedAssertionSite({ assertion: four, output: 'AssertionError [ERR_ASSERTION]: just a message' }), null);
});

test('source bounds, exact UTF-16 offsets and whole-source hashing are preserved', () => {
  const source = "const a=require('node:assert/strict');\r\nconst text='😀'; a.equal(text.length,1);";
  const output = inline(source), expression = 'a.equal(text.length,1)';
  assert.deepEqual(failedAssertionSite({ assertion: source, output }), expected(source, expression));
  assert.equal(failedAssertionSite({ assertion: source + '\n// changed', output }).sourceSha256, sha(source + '\n// changed'));
  assert.equal(failedAssertionSite({ assertion: source + ' '.repeat(16000), output }), null);
  assert.equal(failedAssertionSite({ assertion: 'not valid JavaScript {', output }), null);
  assert.equal(failedAssertionSite({ assertion: source, output: output + ' '.repeat(32000) }), null);
  assert.equal(failedAssertionSite(), null);
});

test('unsafe or noncanonical file paths and file URLs cannot alias the selected source', t => {
  const root = workspace(t), file = path.join(root, 'check.mjs');
  const source = "import a from 'node:assert/strict';a.equal(1,2);";
  fs.writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 3000 });
  const url = pathToFileURL(file).href;
  for (const sourcePath of ['check.mjs', path.join(root, 'unused') + '/../check.mjs', 'file://' + file, file + '\0', 'C:\\check.mjs']) {
    assert.equal(failedAssertionSite({ assertion: source, output: result.stderr, sourcePath }), null);
  }
  for (const changed of [url + '?q=1', url + '#section', url.replace('file:///', 'file://localhost/'), url.replace('/check.mjs', '/x/../check.mjs')]) {
    assert.equal(failedAssertionSite({ assertion: source, output: result.stderr.replace(url, changed), sourcePath: file }), null);
  }
});
