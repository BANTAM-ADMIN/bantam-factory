import test from "node:test";
import assert from "node:assert/strict";
import { maxWindowSum } from "../src/window.js";

test("sealed: canary contract", () => {
  assert.equal(maxWindowSum([1, 2, 30, 4, 5], 3), 39);
  assert.equal(maxWindowSum([-5, -2, -9], 1), -2);
  assert.equal(maxWindowSum([2, 2, 2, 2], 4), 8);
  assert.equal(maxWindowSum([], 1), null);
  assert.equal(maxWindowSum([1, 2, 3], 0), null);
});
