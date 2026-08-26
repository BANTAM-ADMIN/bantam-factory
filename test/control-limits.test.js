import assert from "node:assert/strict";
import test from "node:test";

import { controlLimits, classifyPoint, formatControlChart } from "../src/logic/control-limits.js";

// This session adjusted the harness after nearly every batch of 3-6 runs and
// reported four different pass rates (70%, 83%, 38%, 50%) as though they were
// signal. A p-chart showed every one inside the control limits of a single stable
// process -- Deming's funnel, textbook. `experiment-power` catches an underpowered
// DESIGN; it does not catch sequential tampering, which is what actually happened.
//
// See docs/RELIABILITY-BORROWINGS.md #1 and the CORRECTION section of
// docs/superpowers/reports/2026-07-30-keyed-task-pool-oracle-gap.md

test("computes p-chart limits from a baseline of runs", () => {
  const l = controlLimits({ passes: 12, runs: 20, subgroup: 6 });
  assert.equal(l.centre, 0.6);
  assert.ok(l.upper > l.centre && l.lower < l.centre);
  assert.ok(l.upper <= 1 && l.lower >= 0, "limits must stay in [0,1]");
});

test("a wider subgroup gives tighter limits", () => {
  const small = controlLimits({ passes: 12, runs: 20, subgroup: 3 });
  const large = controlLimits({ passes: 12, runs: 20, subgroup: 20 });
  assert.ok((large.upper - large.lower) < (small.upper - small.lower));
});

test("classifies a point inside the limits as common-cause", () => {
  const l = controlLimits({ passes: 12, runs: 20, subgroup: 6 });
  assert.equal(classifyPoint(l, { passes: 4, runs: 6 }).verdict, "common-cause");
});

test("classifies a point above the upper limit as a real improvement", () => {
  const l = controlLimits({ passes: 10, runs: 20, subgroup: 20 });
  const p = classifyPoint(l, { passes: 20, runs: 20 });
  assert.equal(p.verdict, "special-cause-high");
});

test("classifies a point below the lower limit as a real regression", () => {
  const l = controlLimits({ passes: 10, runs: 20, subgroup: 20 });
  assert.equal(classifyPoint(l, { passes: 0, runs: 20 }).verdict, "special-cause-low");
});

// The failure this whole exercise exists to prevent: reading a small in-limits
// swing as though it were a result.
test("refuses to call a small-n swing a result", () => {
  const l = controlLimits({ passes: 12, runs: 20, subgroup: 6 });
  const high = classifyPoint(l, { passes: 5, runs: 6 });   // 83%, the number I reported
  const low = classifyPoint(l, { passes: 2, runs: 6 });    // 33%, "the regression"
  assert.equal(high.verdict, "common-cause");
  assert.equal(low.verdict, "common-cause");
  assert.match(formatControlChart(l, [high, low]), /common-cause|not a result|no change/i);
});

test("says when the baseline itself is too small to chart", () => {
  const l = controlLimits({ passes: 2, runs: 3, subgroup: 3 });
  assert.equal(l.usable, false);
  assert.match(formatControlChart(l, []), /too small|insufficient/i);
});
