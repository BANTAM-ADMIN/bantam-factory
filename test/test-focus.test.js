import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatFailingTestFocus, parseTestFailures, parseTestCounts, renderFailingTests } from "../src/logic/test-focus.js";

test('real plain Node CommonJS and ESM assertions retain source, operands and stable diagnostic identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-assert-fixture '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const extension of ['cjs', 'mjs']) {
    const file = path.join(root, `revision-check.${extension}`);
    const source = (extension === 'cjs' ? "const assert = require('node:assert/strict');" : "import assert from 'node:assert/strict';")
      + "\nconst actual = Number(process.argv[2]);\nassert.strictEqual(actual, 12, 'revision must advance');\n";
    fs.writeFileSync(file, source);
    const outputs = ['7', '8'].map(value => spawnSync(process.execPath, [file, value], { encoding: 'utf8' }));
    for (const [index, output] of outputs.entries()) {
      assert.equal(output.status, 1);
      const failures = parseTestFailures(output.stderr);
      assert.equal(failures.length, 1, output.stderr);
      assert.deepEqual(failures[0], { name: `revision must advance (${file}:3)`, file, line: 3,
        actual: String(7 + index), expected: '12', operator: 'strictEqual', message: 'revision must advance',
        diff: [`+ ${7 + index}`, '- 12'], assertionLine: 3 });
      assert.equal(parseTestCounts(output.stderr), null, 'An uncaught assertion cannot invent test counts');
      const focus = formatFailingTestFocus(output.stderr, requested => requested === file ? source : null);
      assert.match(focus, /revision must advance/);
      assert.match(focus, /assert\.strictEqual\(actual, 12/);
      assert.doesNotMatch(focus, /already pass/);
    }
    assert.equal(parseTestFailures(outputs[0].stderr)[0].name, parseTestFailures(outputs[1].stderr)[0].name,
      'Changed actual values do not reset the same assertion failure streak');
  }
});

const PLAIN_NODE_ASSERTION = `node:assert:90
  throw new AssertionError(obj);
  ^

AssertionError [ERR_ASSERTION]: revision must advance

7 !== 12

    at new AssertionError (node:internal/assert/assertion_error:452:5)
    at strictEqual (/workspace/node_modules/helper/index.js:8:3)
    at checkRevision (/workspace/test/revisions.js:18:7)
    at Object.<anonymous> (/workspace/test/revisions.js:22:1)
    at Module._compile (node:internal/modules/cjs/loader:1529:14) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: 7,
  expected: 12,
  operator: 'strictEqual'
}

Node.js v20.19.4`;

test('plain Node20-style assertions ignore internal frames, preserve nested operands, and accept ANSI or ESM URLs', () => {
  const base = parseTestFailures(PLAIN_NODE_ASSERTION);
  assert.equal(base.length, 1);
  assert.equal(base[0].file, '/workspace/test/revisions.js');
  assert.equal(base[0].line, 18);
  assert.deepEqual(parseTestFailures('\u001b[31m' + PLAIN_NODE_ASSERTION + '\u001b[0m'), base);
  const esm = PLAIN_NODE_ASSERTION.replace('at checkRevision (/workspace/test/revisions.js:18:7)', 'at file:///workspace/test/revision%20check.mjs:18:7');
  assert.equal(parseTestFailures(esm)[0].file, '/workspace/test/revision check.mjs');
  const parenthesized = PLAIN_NODE_ASSERTION.replace('/workspace/test/revisions.js:18:7', '/workspace/revision (copy)/revisions.js:18:7');
  assert.equal(parseTestFailures(parenthesized)[0].file, '/workspace/revision (copy)/revisions.js');
  const nested = PLAIN_NODE_ASSERTION.replace('  actual: 7,', '  actual: {\n    groups: [ 1, 2 ]\n  },')
    .replace('  expected: 12,', '  expected: {\n    groups: [ 1, 2, 3 ]\n  },')
    .replace("operator: 'strictEqual'", "operator: 'deepStrictEqual'");
  assert.equal(parseTestFailures(nested)[0].actual, '{\n    groups: [ 1, 2 ]\n  }');
  assert.equal(parseTestFailures(nested)[0].expected, '{\n    groups: [ 1, 2, 3 ]\n  }');
  assert.equal(parseTestFailures(nested)[0].operator, 'deepStrictEqual');
});

test('plain Node assertion parser does not promote generic logs, clipped fragments, incomplete footers or passing summaries', () => {
  const cases = [
    'A log mentioned AssertionError [ERR_ASSERTION]: revision must advance',
    'AssertionError [ERR_ASSERTION]: revision must advance\n    at /workspace/test/revisions.js:18:7',
    PLAIN_NODE_ASSERTION.replace('AssertionError [ERR_ASSERTION]:', 'log: AssertionError [ERR_ASSERTION]:'),
    PLAIN_NODE_ASSERTION.replace("  code: 'ERR_ASSERTION',", "  code: 'ERR_OTHER',"),
    PLAIN_NODE_ASSERTION.replace("  code: 'ERR_ASSERTION',", '  code: 0,'),
    PLAIN_NODE_ASSERTION.replace("  code: 'ERR_ASSERTION',", "  code: 'ERR_ASSERTION',\n  code: 'ERR_OTHER',"),
    PLAIN_NODE_ASSERTION.replace('  expected: 12,\n', ''),
    PLAIN_NODE_ASSERTION.replace('  expected: 12,', '  expected: 12,\n  expected: 13,'),
    PLAIN_NODE_ASSERTION.replace('  expected: 12,', '[3400 chars clipped]\n  expected: 12,'),
    PLAIN_NODE_ASSERTION.replace(/    at checkRevision.*\n    at Object\.<anonymous>.*\n/, ''),
    PLAIN_NODE_ASSERTION.replace(/    at checkRevision.*\n    at Object\.<anonymous>.*\n/, '    at node:internal/process/task_queues:105:5\n'),
    PLAIN_NODE_ASSERTION.replace('  actual: 7,', '  actual: ' + 'x'.repeat(4200) + ','),
    PLAIN_NODE_ASSERTION.replace(/\n}\n/, '\n'),
    PLAIN_NODE_ASSERTION + '\n12 passed, 0 failed',
  ];
  for (const output of cases) assert.deepEqual(parseTestFailures(output), [], output.slice(0, 220));
  assert.deepEqual(parseTestCounts(PLAIN_NODE_ASSERTION + '\n12 passed, 0 failed'), { passed: 12, failed: 0, total: 12 });
});

test('TAP dispatch remains authoritative and does not duplicate an embedded plain assertion', () => {
  const tap = `TAP version 13
not ok 1 - tracks revisions
  ---
  location: '/workspace/test/revisions.js:10:1'
  error: 'revision must advance'
  actual: 7
  expected: 12
  ...
1..1
# tests 1
# pass 0
# fail 1`;
  assert.deepEqual(parseTestFailures(PLAIN_NODE_ASSERTION + '\n' + tap), parseTestFailures(tap));
  assert.equal(parseTestFailures(PLAIN_NODE_ASSERTION + '\n' + tap).length, 1);
});

test('named runner summaries retain counts without treating source locations or prose as results', () => {
  assert.deepEqual(parseTestCounts('UV check: 17 passed, 0 failed'), {passed:17, failed:0, total:17});
  assert.deepEqual(parseTestCounts('UV check: 0 passed, 0 failed'), {passed:0, failed:0, total:0});
  for (const output of ['test/uv-check.js:17:3 failed to parse', 'UV check: 17 failed to parse',
    'The UV check: 17 passed, 0 failed yesterday', 'Review: UV check: 17 passed, 0 failed']) {
    assert.equal(parseTestCounts(output), null, output);
  }
});

test("custom runner comparisons retain their name and assertion instead of inventing a Vitest location", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    let failed = 0;
    try { assert.ok(0 > 0, 'luminance=0'); }
    catch (error) { failed++; console.log('  FAIL luminance > 0 - ' + error.message); }
    console.log('0 passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  `], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(parseTestFailures(result.stdout), [{
    name: "luminance > 0", message: "luminance=0", file: null, line: null,
    expected: null, actual: null, diff: [],
  }]);
  assert.match(renderFailingTests(result.stdout), /luminance > 0 — luminance=0/);
  const focus = formatFailingTestFocus(result.stdout, () => { assert.fail("No source location was reported"); });
  assert.match(focus, /FAILING: "luminance > 0"/);
  assert.match(focus, /luminance=0/);
  assert.doesNotMatch(focus, /luminance:null|No concrete failure detail/);
});

test("custom failure prose needs a failing runner summary", () => {
  assert.deepEqual(parseTestFailures("  FAIL luminance > 0 - luminance=0"), []);
  assert.deepEqual(parseTestFailures("  FAIL luminance > 0 - luminance=0\n12 passed, 0 failed"), []);
});

test("Vitest file headers still retain nested names, assertion values and locations", () => {
  const output = ` FAIL  test/post.test.ts > post > measures light
AssertionError: expected 0 to be 1
 ❯ test/post.test.ts:17:5
 FAIL  other.test.js > second
AssertionError: expected false to be true
 ❯ other.test.js:9:3`;
  const fails = parseTestFailures(output);
  assert.equal(fails.length, 2);
  assert.deepEqual(fails[0], { name: "post > measures light", file: "test/post.test.ts", line: 17,
    actual: "0", expected: "1", diff: ["+ 0", "- 1"] });
  assert.equal(fails[1].file, "other.test.js");
  assert.equal(fails[1].line, 9);
});

test("focused test context offers a conditional timing hypothesis for an empty side effect", () => {
  const output = `TAP version 13
not ok 7 - coalesces a queued key, not just a running one
  ---
  location: '/workspace/test/public.test.js:1:1'
  error: |-
    the queued task must not have started yet
    + actual - expected

    + []
    - [
    -   'busy'
    - ]
  code: 'ERR_ASSERTION'
  ...
1..1
# tests 1
# pass 0
# fail 1`;
  const source = `test("coalesces a queued key, not just a running one", async () => {
  const started = [];
  const running = pool.run("busy", () => { started.push("busy"); });
  assert.deepEqual(started, ["busy"]);
});\n`;

  const focus = formatFailingTestFocus(output, () => source);

  assert.match(focus, /your code produced \{ \[\] \}/);
  assert.match(focus, /TIMING HYPOTHESIS/);
  assert.match(focus, /Promise\.then\(task\).*can defer/i);
  assert.match(focus, /If synchronous admission is required/);
  assert.match(focus, /published Promise and its rejection behavior/i);
});

test("focused test context does not invent a timing cause for ordinary value mismatches", () => {
  const output = `not ok 1 - returns the configured value
  ---
  location: '/workspace/test/public.test.js:1:1'
  + 2
  - 3
  ...
1..1`;
  const source = `test("returns the configured value", () => { assert.equal(subject(), 3); });\n`;

  const focus = formatFailingTestFocus(output, () => source);
  assert.doesNotMatch(focus, /TIMING (?:CAUSE|HYPOTHESIS)/);
});
