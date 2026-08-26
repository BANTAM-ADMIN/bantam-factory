import test from "node:test";
import assert from "node:assert/strict";
import { maxWindowSum } from "../src/window.js";

test("finds the best window", () => {
  assert.equal(maxWindowSum([1, 2, 30, 4, 5], 2), 34);
  assert.equal(maxWindowSum([5, -1, -1, 5], 2), 4);
});
test("edges", () => {
  assert.equal(maxWindowSum([7], 1), 7);
  assert.equal(maxWindowSum([1, 2], 5), null);
});
