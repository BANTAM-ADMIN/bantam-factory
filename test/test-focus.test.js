import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { formatFailingTestFocus, parseTestFailures, renderFailingTests } from "../src/logic/test-focus.js";

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
