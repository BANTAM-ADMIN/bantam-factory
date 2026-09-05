import test from "node:test";
import assert from "node:assert/strict";
import { parseTestCounts } from "../src/logic/test-focus.js";

test("a debug print of a SIZE followed by FAILED on the next line is not a test count", () => {
  assert.equal(parseTestCounts("target len: 4868\ndecoded len: 0 match: False\nstream size: 2421\nFAILED to write"), null);
  assert.equal(parseTestCounts("Total target bits: 54332\nErrors: 27415\nOutput bytes: 5066\nFAILED - too many errors"), null);
});

test("real runner summaries still parse", () => {
  assert.deepEqual(parseTestCounts("3 passed, 2 failed"), { passed: 3, failed: 2, total: 5 });
  assert.deepEqual(parseTestCounts("===== 5 passed, 1 failed in 0.31s ====="), { passed: 5, failed: 1, total: 6 });
  assert.deepEqual(parseTestCounts("# pass 4\n# fail 1"), { passed: 4, failed: 1, total: 5 });
});

test("stack locations and diagnostic prose do not invent runner totals", () => {
  for (const output of [
    "test/csv.test.js:62:32 failed to parse",
    "at /workspace/test/csv.test.js:62:32 failed",
    "The request failed after 32 failed attempts",
    "32 failed to parse",
    "message: 3 passed, 2 failed",
    "Tests: 32 failed to parse",
    "log 2/3 tests passed yesterday",
    "4/3 tests passed",
    "Test Suites: 5 failed, 7 passed, 12 total",
    "Test Files 5 failed | 7 passed (12)",
  ]) assert.equal(parseTestCounts(output), null, output);
});

test("runner-summary variants retain per-test totals while ignoring source locations", () => {
  const before = "test/csv.test.js:62:32 failed to parse\n";
  for (const summary of [
    "Tests: 2 failed, 3 passed, 5 total",
    "Tests 2 failed | 3 passed (5)",
    "=== 2 failed, 3 passed in 0.31s ===",
    "test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    "\u001b[32m3 passed\u001b[0m, \u001b[31m2 failed\u001b[0m",
    "3/5 tests passed",
    "Tests: 5 Failed: 2",
  ]) assert.deepEqual(parseTestCounts(before + summary), { passed: 3, failed: 2, total: 5 }, summary);
});

test("pytest collection errors remain failures in a recognized summary", () => {
  assert.deepEqual(parseTestCounts("=== 1 passed, 2 errors in 0.31s ==="), { passed: 1, failed: 2, total: 3 });
});
