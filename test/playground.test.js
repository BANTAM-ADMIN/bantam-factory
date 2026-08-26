// Tests for src/playground.js — A/B benchmark runner

import {
  runTask,
  runAB,
  aggregateResults,
  computeTrends,
  BUILTIN_TASKS,
  defaultBaseline,
  defaultVariant,
} from "../src/playground.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "playground-test-"));
  temporaryDirectories.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// 1. BUILTIN_TASKS exist and are well-formed
// ---------------------------------------------------------------------------

assert.ok(Array.isArray(BUILTIN_TASKS), "BUILTIN_TASKS is an array");
assert.ok(BUILTIN_TASKS.length > 0, "BUILTIN_TASKS has at least one task");

for (const t of BUILTIN_TASKS) {
  assert.ok(typeof t.id === "string" && t.id, "task has an id");
  assert.ok(typeof t.prompt === "string" && t.prompt, "task has a prompt");
  assert.ok(typeof t.check === "function", "task has a check function");
}

// ---------------------------------------------------------------------------
// 2. Configurations are well-formed
// ---------------------------------------------------------------------------

assert.ok(defaultBaseline.name, "baseline has a name");
assert.ok(defaultVariant.name, "variant has a name");
assert.ok(defaultBaseline.max_turns > 0, "baseline has max_turns");
assert.ok(defaultVariant.max_turns > 0, "variant has max_turns");
assert.strictEqual(defaultBaseline.max_turns, defaultVariant.max_turns, "A/B turn budgets are equal");
assert.strictEqual(defaultBaseline.action_budget, defaultVariant.action_budget, "A/B action budgets are equal");

// ---------------------------------------------------------------------------
// 3. runTask executes a simple task
// ---------------------------------------------------------------------------

{
  const tmp = tmpDir();
  const task = BUILTIN_TASKS[0];
  const result = await runTask(task, defaultBaseline, tmp);

  assert.ok(result.turns > 0, "runTask used at least one turn");
  assert.ok(typeof result.success === "boolean", "runTask returns success boolean");
  assert.ok(Array.isArray(result.actions), "runTask returns actions array");
  assert.strictEqual(result.promotionEligible, false, "simulation is not promotion evidence");
  assert.deepStrictEqual(result.actionBreakdown, { read_file: 1, write_file: 1 });
  assert.ok(!Object.hasOwn(result.actionBreakdown, "[object Object]"));
}

// ---------------------------------------------------------------------------
// 4. runAB runs both configurations and returns a comparison
// ---------------------------------------------------------------------------

{
  const tmp = tmpDir();
  const task = BUILTIN_TASKS[0];
  const result = await runAB(task, defaultBaseline, defaultVariant, tmp);

  assert.ok(result.baseline, "runAB has baseline result");
  assert.ok(result.variant, "runAB has variant result");
  assert.ok(["baseline", "variant", "tie", "error"].includes(result.winner), "runAB has a valid winner");
  assert.strictEqual(result.promotionEligible, false, "comparison is explicitly simulation-only");
}

// ---------------------------------------------------------------------------
// 5. aggregateResults computes correct aggregates
// ---------------------------------------------------------------------------

{
  const mockResults = [
    { winner: "baseline", baseline: { turns: 5, success: true }, variant: { turns: 8, success: true } },
    { winner: "variant", baseline: { turns: 10, success: true }, variant: { turns: 6, success: true } },
    { winner: "variant", baseline: { turns: 7, success: false }, variant: { turns: 5, success: true } },
    { winner: "tie", baseline: { turns: 4, success: true }, variant: { turns: 4, success: true } },
  ];

  const agg = aggregateResults(mockResults);

  assert.strictEqual(agg.totalTasks, 4);
  assert.strictEqual(agg.baselineWins, 1);
  assert.strictEqual(agg.variantWins, 2);
  assert.strictEqual(agg.ties, 1);
  assert.strictEqual(agg.avgTurns.baseline, 6.5); // (5+10+7+4)/4
  assert.strictEqual(agg.avgTurns.variant, 5.75); // (8+6+5+4)/4
  assert.strictEqual(agg.successRate.baseline, 75); // 3/4
  assert.strictEqual(agg.successRate.variant, 100); // 4/4
}

// ---------------------------------------------------------------------------
// 6. computeTrends detects improving/declining/stable
// ---------------------------------------------------------------------------

{
  // Improving: recent turns < older turns
  const improving = [
    { avgTurns: { variant: 10 } },
    { avgTurns: { variant: 9 } },
    { avgTurns: { variant: 8 } },
    { avgTurns: { variant: 5 } },
    { avgTurns: { variant: 4 } },
    { avgTurns: { variant: 3 } },
  ];
  const t1 = computeTrends(improving);
  assert.strictEqual(t1.turns, "improving");

  // Declining: recent turns > older turns
  const declining = [
    { avgTurns: { variant: 3 } },
    { avgTurns: { variant: 4 } },
    { avgTurns: { variant: 5 } },
    { avgTurns: { variant: 8 } },
    { avgTurns: { variant: 9 } },
    { avgTurns: { variant: 10 } },
  ];
  const t2 = computeTrends(declining);
  assert.strictEqual(t2.turns, "declining");

  // Stable: equal
  const stable = [
    { avgTurns: { variant: 5 } },
    { avgTurns: { variant: 5 } },
    { avgTurns: { variant: 5 } },
    { avgTurns: { variant: 5 } },
    { avgTurns: { variant: 5 } },
    { avgTurns: { variant: 5 } },
  ];
  const t3 = computeTrends(stable);
  assert.strictEqual(t3.turns, "stable");

  // Insufficient data
  const sparse = [{ avgTurns: { variant: 5 } }];
  const t4 = computeTrends(sparse);
  assert.strictEqual(t4.turns, "insufficient-data");
}

// ---------------------------------------------------------------------------
// 7. Empty aggregates don't crash
// ---------------------------------------------------------------------------

{
  const agg = aggregateResults([]);
  assert.strictEqual(agg.totalTasks, 0);
  assert.strictEqual(agg.avgTurns.baseline, 0);
  assert.strictEqual(agg.avgTurns.variant, 0);
}

console.log("✓ All playground tests passed");
