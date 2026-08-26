import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { groundingEnabled, GROUNDING_FILE_BUDGET } from "../src/fixture-runner.js";

// Measured 2026-08-01, gpt-5.6-terra on keyed-task-pool-strong, n=5 per arm,
// exact permutation p = 0.040:
//
//                 turns            mean   mean cache miss
//   grounding ON   7,6,6,6,7        6.4      23,332
//   grounding off  7,8,7,9,7        7.6      29,745
//
// -16% turns, -22% cache misses, hidden contract 4/4 in all ten runs.
//
// It had been opt-in, which is why impactFooters, crossFileUsageNotes and
// peerFunctionFooters fired in 0 of 31 recorded Codex runs despite being wired:
// every one hangs off ground.db, and the KB was never built.

describe("grounding default", () => {
  it("is on for Codex on trees the size it was measured on", () => {
    assert.equal(groundingEnabled(undefined, { codex: true, sourceFiles: 2 }), true);
    assert.equal(groundingEnabled(undefined, { codex: true, sourceFiles: GROUNDING_FILE_BUDGET }), true);
  });

  // The benefit was measured where building the KB is free. It is not free at
  // scale, and the gap is 2,000x:
  //
  //   keyed-task-pool-strong   2 files       14 ms
  //   BANTAM itself          198 files   28,498 ms
  //
  // One fewer turn saves a Codex model about ten seconds, so a 28-second build
  // spends more than it returns. Defaulting it on everywhere would have made every
  // large-repo run slower while citing a fixture measurement as justification.
  it("stays off past the budget, where the cost was never measured", () => {
    assert.equal(groundingEnabled(undefined, { codex: true, sourceFiles: 198 }), null);
    assert.equal(groundingEnabled(undefined, { codex: true, sourceFiles: GROUNDING_FILE_BUDGET + 1 }), null);
  });

  it("still lets an explicit setting opt a large tree in", () => {
    assert.equal(groundingEnabled("1", { codex: true, sourceFiles: 5000 }), true);
  });

  // Not measured for local models, and a 27B has a far tighter context budget for
  // the code map and footers to compete in. Unmeasured defaults are how a harness
  // accumulates expensive habits.
  // Changed 2026-08-16: local models get the KB under the same file budget as
  // Codex. The old split rested on a 28,498 ms build that remeasured at
  // 2,467-3,645 ms on this tree, and the local model is the one that most needs
  // a structural answer rather than paging a large file by hand — a run wiring
  // a subcommand into a 4,718-line CLI read it 54 times with the KB unbuilt.
  it("is on for local models within the file budget, and off past it", () => {
    assert.equal(groundingEnabled(undefined, { codex: false, sourceFiles: 2 }), true);
    assert.equal(groundingEnabled(undefined, { codex: false, sourceFiles: GROUNDING_FILE_BUDGET }), true);
    assert.equal(groundingEnabled(undefined, { codex: false, sourceFiles: GROUNDING_FILE_BUDGET + 1 }), null);
    assert.equal(groundingEnabled(undefined), true);
  });

  it("lets an explicit setting override either default", () => {
    assert.equal(groundingEnabled("1", { codex: false }), true);
    assert.equal(groundingEnabled("on", { codex: false }), true);
    assert.equal(groundingEnabled("0", { codex: true }), false);
    assert.equal(groundingEnabled("off", { codex: true }), false);
  });
});
