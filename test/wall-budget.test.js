import test from "node:test";
import assert from "node:assert/strict";

import { wallBudgetLine } from "../src/logic/wall-budget.js";

test("silent when no wall budget is known — most runs have none", () => {
  assert.equal(wallBudgetLine({}), "");
  assert.equal(wallBudgetLine({ budgetMs: 0, elapsedMs: 10 }), "");
  assert.equal(wallBudgetLine({ budgetMs: null }), "");
});

test("names the budget and says which one actually kills the run", () => {
  const line = wallBudgetLine({ budgetMs: 1_800_000, elapsedMs: 600_000 });
  assert.match(line, /10m used of 30m \(33%\)/);
  assert.match(line, /wall deadline and configured turn cap both apply/);
});

test("escalates past halfway, and hard near the end", () => {
  assert.doesNotMatch(wallBudgetLine({ budgetMs: 1000, elapsedMs: 100 }), /Past halfway|nearly out/);
  assert.match(wallBudgetLine({ budgetMs: 1000, elapsedMs: 700 }), /Past halfway/);
  const late = wallBudgetLine({ budgetMs: 1000, elapsedMs: 900 });
  assert.match(late, /nearly out of time/);
  // the specific failure it exists for: dying with no deliverable on disk
  assert.match(late, /required output EXISTS on disk/);
});

test("never reports negative time when the budget is already blown", () => {
  const line = wallBudgetLine({ budgetMs: 1000, elapsedMs: 5000 });
  assert.doesNotMatch(line, /-\d/);
  assert.match(line, /~0m left/);
});
