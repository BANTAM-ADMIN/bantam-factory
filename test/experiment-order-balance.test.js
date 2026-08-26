import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExperimentSchedule,
  createExperimentManifest,
  experimentOrderBalance,
  formatExperimentSummary,
  summarizeExperiment,
} from "../src/experiment.js";

function spec(rounds = 3, arms = ["control", "treatment"]) {
  return {
    schema: 1,
    name: "order-balance",
    fixtures: ["fixture"],
    rounds,
    arms: arms.map((name) => ({ name })),
  };
}

test("rotating odd-round A/B schedules report best-possible counterbalancing", () => {
  const input = spec(3);
  const schedule = buildExperimentSchedule(input);
  const balance = experimentOrderBalance(input, schedule);
  assert.equal(balance.status, "best-possible");
  assert.equal(balance.maxPositionImbalance, 1);
  assert.deepEqual(balance.positions, {
    control: [2, 1],
    treatment: [1, 2],
  });

  const manifest = createExperimentManifest({ spec: input, id: "odd-ab" });
  const totals = summarizeExperiment(manifest);
  assert.equal(totals.balancedOrder, false);
  assert.equal(totals.orderBalance.status, "best-possible");
  assert.match(
    formatExperimentSummary(manifest),
    /Order counterbalancing: best possible \(max position imbalance 1\)/,
  );
});

test("divisible rotations are exact and malformed ordering is identified", () => {
  const input = spec(2);
  assert.equal(
    experimentOrderBalance(input, buildExperimentSchedule(input)).status,
    "exact",
  );

  const imbalanced = [
    { sequence: 0, round: 1, arm: "control" },
    { sequence: 1, round: 1, arm: "treatment" },
    { sequence: 2, round: 2, arm: "control" },
    { sequence: 3, round: 2, arm: "treatment" },
    { sequence: 4, round: 3, arm: "control" },
    { sequence: 5, round: 3, arm: "treatment" },
  ];
  const balance = experimentOrderBalance(spec(3), imbalanced);
  assert.equal(balance.status, "imbalanced");
  assert.equal(balance.maxPositionImbalance, 3);

  const invalid = imbalanced.slice(0, -1);
  assert.equal(experimentOrderBalance(spec(3), invalid).status, "invalid");
});
