import assert from "node:assert/strict";
import test from "node:test";

import { requiredRunsPerArm, detectableLift, powerWarning } from "../src/logic/experiment-power.js";

// 2026-07-30: four preregistered pass-rate A/Bs returned nulls in a row, three of
// them because the design could not have detected the effect being looked for.
// weak-repro-keyed reached n=9 per arm before the arithmetic showed it needed 77.
// This encodes that check so it happens BEFORE the model time is spent.
// See docs/superpowers/reports/2026-07-30-keyed-task-pool-oracle-gap.md

test("computes the runs per arm a two-proportion comparison needs", () => {
  // 44% -> 67%, alpha .05 two-sided, power .80: the weak-repro case.
  assert.equal(requiredRunsPerArm(0.444, 0.667), 77);
  // A large effect needs far fewer.
  assert.ok(requiredRunsPerArm(0.1, 0.9) < 10);
});

test("a tiny effect needs an impractical sample", () => {
  assert.ok(requiredRunsPerArm(0.50, 0.55) > 1000);
});

test("reports the smallest lift a given sample can detect", () => {
  const lift = detectableLift(3, 0.0);
  assert.ok(lift > 0.7, `n=3 per arm can only detect near-total effects, got ${lift}`);
  assert.ok(detectableLift(77, 0.444) < detectableLift(9, 0.444));
});

test("warns when the planned rounds cannot detect a plausible effect", () => {
  // The real weak-repro figures: 4/9 vs 6/9 observed, which needs 77 per arm.
  const w = powerWarning({ rounds: 3, arms: [{ name: "control" }, { name: "candidate" }] }, { baseline: 0.444, target: 0.667 });
  assert.match(w, /underpowered/i);
  assert.match(w, /77/, "must name the required sample, not just complain");
  assert.match(w, /3 run\(s\) per compared group/);
  assert.match(w, /could not see/, "must say what a null from this design means");
});

test("stays silent when the design is adequately powered", () => {
  const w = powerWarning({ rounds: 80, arms: [{ name: "control" }, { name: "candidate" }] }, { baseline: 0.44, target: 0.67 });
  assert.equal(w, "");
});

// weak-repro-keyed-ab compares two FIXTURES under a single arm. A check that
// only counted arms saw one group and stayed silent on the very design that
// motivated it.
test("counts a fixture-vs-fixture comparison as two groups", () => {
  const w = powerWarning(
    { rounds: 3, arms: [{ name: "local" }], fixtures: ["a", "b"] },
    { baseline: 0.444, target: 0.667 },
  );
  assert.match(w, /underpowered/i);
  assert.match(w, /77/);
});

test("says nothing when there is no comparison to power", () => {
  assert.equal(powerWarning({ rounds: 3, arms: [{ name: "only" }] }, { baseline: 0.44, target: 0.67 }), "");
  assert.equal(powerWarning({ rounds: 3, arms: [] }, {}), "");
});

// A near-total effect IS detectable at small n -- channel-filter went 0/3 to 3/3.
// The warning must not cry wolf on designs that are genuinely adequate.
test("does not warn when the expected effect is near-total", () => {
  const w = powerWarning({ rounds: 6, arms: [{ name: "a" }, { name: "b" }] }, { baseline: 0.0, target: 1.0 });
  assert.equal(w, "");
});
