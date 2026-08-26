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
