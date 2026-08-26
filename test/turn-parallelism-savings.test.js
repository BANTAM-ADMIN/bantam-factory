import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { estimateSavings, actionKind } from "../src/turn-parallelism.js";

// estimateSavings computed `optimizedTurns = inspectTurns + writes.length`, which
// silently DROPS every action classified neither read nor write -- `done` above
// all, which every run has exactly one of. Each dropped action was counted as a
// turn saved.
//
// Measured across 34 recorded Codex runs and 383 turns, the function reported
// 178 turns removable (46.5%). Hand-checking the actual trajectories gives 17
// (4.4%). The difference is almost entirely phantom: `done` actions counted as
// savings, plus anything else the classifier does not recognise.
//
// A 46.5% headroom figure would have justified building parallel dispatch. The
// real figure says the models already batch well and that lever is nearly spent.

describe("estimating batchable turns", () => {
  it("does not count a done action as a saving", () => {
    const actions = [{ a: "read_file", p: "a" }, { a: "done" }];
    const s = estimateSavings(actions);
    assert.equal(actionKind({ a: "done" }), "unknown");
    assert.equal(s.turnsSaved, 0,
      "one read plus one done cannot be collapsed into fewer than two turns");
  });

  it("keeps unrecognised actions in the optimized count", () => {
    const actions = [{ a: "respond" }, { a: "done" }];
    const s = estimateSavings(actions);
    assert.equal(s.optimizedTurns, 2, "unknown actions still occupy a turn each");
    assert.equal(s.turnsSaved, 0);
  });

  it("still credits genuinely batchable reads", () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({ a: "read_file", p: `f${i}` }));
    const s = estimateSavings(actions);
    assert.equal(s.optimizedTurns, 1, "six reads fit one inspect");
    assert.equal(s.turnsSaved, 5);
  });

  it("does not pretend writes can be collapsed", () => {
    const actions = [{ a: "write_file", p: "a" }, { a: "write_file", p: "b" }];
    assert.equal(estimateSavings(actions).turnsSaved, 0);
  });

  it("reports a realistic figure for a real trajectory", () => {
    // The observed retry-consolidation run: inspect, 4 edits, done.
    const actions = [
      { a: "inspect", ops: [] },
      { a: "write_file", p: "src/retry.js" },
      { a: "replace", p: "src/clients/billing.js" },
      { a: "replace", p: "src/clients/search.js" },
      { a: "replace", p: "src/clients/audit.js" },
      { a: "done" },
    ];
    const s = estimateSavings(actions);
    assert.equal(s.turnsSaved, 0,
      `one inspect, four writes and a done are already minimal for this classifier, got ${s.turnsSaved}`);
  });
});
