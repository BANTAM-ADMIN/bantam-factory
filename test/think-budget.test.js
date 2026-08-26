import test from "node:test";
import assert from "node:assert/strict";

import { thinkBudget } from "../src/logic/think-budget.js";

test("no deep budget -> the normal budget, always", () => {
  assert.equal(thinkBudget({ normal: 4096 }), 4096);
  assert.equal(thinkBudget({ normal: 4096, deep: 0, editCount: 0 }), 4096);
});

test("deep budget applies while NO edit has landed — the analysis phase", () => {
  assert.equal(thinkBudget({ normal: 4096, deep: 16384, editCount: 0 }), 16384);
});

test("after the first edit the normal budget returns", () => {
  assert.equal(thinkBudget({ normal: 4096, deep: 16384, editCount: 1 }), 4096);
  assert.equal(thinkBudget({ normal: 4096, deep: 16384, editCount: 40 }), 4096);
});

test("a deep budget smaller than normal never shrinks the think", () => {
  assert.equal(thinkBudget({ normal: 4096, deep: 1024, editCount: 0 }), 4096);
});

test("a one-shot grant hands the deep budget to the next think even after edits", () => {
  assert.equal(thinkBudget({ normal: 4096, deep: 16384, editCount: 9, grant: true }), 16384);
  assert.equal(thinkBudget({ normal: 4096, deep: 16384, editCount: 9, grant: false }), 4096);
  // no deep budget configured -> a grant changes nothing
  assert.equal(thinkBudget({ normal: 4096, deep: 0, editCount: 9, grant: true }), 4096);
});
