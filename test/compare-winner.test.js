import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compileCompareSummary, formatSummary } from "../src/logic/compare-plan.js";

// The scoreboard was rigged, and it was rigged in this project's favour.
//
// `bantam compare` exists to answer one question: is BANTAM+Codex better than bare
// Codex? It computed the answer as:
//
//   const WINNER_ORDER = ["bantam-codex", "bantam-dev", "claude-code", "codex", ...];
//   const winner = WINNER_ORDER.find((id) => arms.find((a) => a.id === id)?.pass);
//
// The first PASSING arm in a hardcoded preference order with bantam-codex FIRST. So
// BANTAM won every comparison it did not lose. The first real head-to-head
// (adapter-migration, 2026-08-01) had both arms at 4/4 on the hidden contract and
// printed "🏆 Winner: bantam-codex".
//
// This is the day's dominant defect -- an instrument returning a confident answer
// where the honest one is "no difference" -- sitting in the single most consequential
// line of output the tool produces. These tests exist so it cannot come back.

const arm = (passed, tests = 4) => ({
  public: { pass: passed === tests },
  contract: { passed, tests },
  scope: { violations: [] },
});

describe("a tie is not a win", () => {
  it("declares no winner when two arms score identically", () => {
    const summary = compileCompareSummary({
      task: "adapter-migration",
      results: { "bantam-codex": arm(4), codex: arm(4) },
    });
    assert.equal(summary.winner, null, "equal contract scores must not crown anyone");
    assert.deepEqual(summary.tied, ["bantam-codex", "codex"]);
  });

  it("says TIE in the rendered summary rather than naming a winner", () => {
    const text = formatSummary(compileCompareSummary({
      task: "adapter-migration",
      results: { "bantam-codex": arm(4), codex: arm(4) },
    }));
    assert.match(text, /TIE/);
    assert.doesNotMatch(text, /Winner: bantam-codex/,
      "the observed 4/4-vs-4/4 head-to-head must never print a BANTAM win");
  });

  // The preference order is still fine for ORDERING names. It just must not decide
  // who won.
  it("does not favour bantam when bantam is the one that tied second", () => {
    const summary = compileCompareSummary({
      task: "t",
      results: { codex: arm(4), "bantam-codex": arm(4) },
    });
    assert.equal(summary.winner, null);
  });
});

describe("a real win is still reported", () => {
  it("crowns the arm that is strictly best on the hidden contract", () => {
    const summary = compileCompareSummary({
      task: "t",
      results: { "bantam-codex": arm(4), codex: arm(2) },
    });
    assert.equal(summary.winner, "bantam-codex");
    assert.deepEqual(summary.tied, []);
  });

  it("crowns the competitor when the competitor is better", () => {
    const summary = compileCompareSummary({
      task: "t",
      results: { "bantam-codex": arm(3), codex: arm(4) },
    });
    assert.equal(summary.winner, "codex");
  });
});

// Absent is not zero -- the same rule the run statuses already follow.
describe("arms that never competed", () => {
  it("does not crown a solo arm over competitors that were never run", () => {
    const summary = compileCompareSummary({
      task: "t",
      results: { "bantam-codex": arm(4) },
    });
    assert.equal(summary.winner, null,
      "one arm alone is a result, not a victory over four phantom losers");
  });

  it("does not count a blocked arm as a defeated arm", () => {
    const summary = compileCompareSummary({
      task: "t",
      results: {
        "bantam-codex": arm(4),
        codex: { blocked: true, blockedReason: "read-only sandbox" },
      },
    });
    assert.equal(summary.winner, null,
      "beating an arm the harness prevented from starting is not beating it");
  });
});

// The tie line tells the reader to separate the arms on wall clock. It has to
// print the wall clock for that to be actionable -- the recorded head-to-head
// tied 4/4 and differed 97s vs 196s, and only the correctness half was in the
// table.
describe("what a tie reports instead of a winner", () => {
  const timed = (ms) => ({ ...arm(4), durationMs: ms });

  it("prints the wall clock spread between the tied arms", () => {
    const text = formatSummary(compileCompareSummary({
      task: "t",
      results: { "bantam-codex": timed(96_823), codex: timed(196_003) },
    }));
    assert.match(text, /97s/);
    assert.match(text, /196s/);
    assert.match(text, /2\.0x/);
  });

  it("says a single run is a lead rather than a finding", () => {
    const text = formatSummary(compileCompareSummary({
      task: "t",
      results: { "bantam-codex": timed(96_823), codex: timed(196_003) },
    }));
    assert.match(text, /lead, not a finding/);
  });

  it("reports an unmeasured duration as unmeasured, never as zero", () => {
    const text = formatSummary(compileCompareSummary({
      task: "t",
      results: { "bantam-codex": arm(4), codex: arm(2) },
    }));
    assert.match(text, /Wall: unmeasured/);
    assert.doesNotMatch(text, /Wall: 0s/);
  });
});

// The run that exposed all of this used `--only bantam-codex,codex` and printed
// the other three arms as "❌ FAIL, Contract 0/0" -- three defeats never staged.
describe("arms excluded from the run", () => {
  it("prints them as not run rather than as failures", () => {
    const text = formatSummary(compileCompareSummary({
      task: "t",
      results: { "bantam-codex": arm(4), codex: arm(4) },
    }));
    assert.match(text, /bantam-dev \(subject\): not run/);
    assert.doesNotMatch(text, /claude-code \(reference\): FAIL/);
  });
});

// Refusing to crown an uncontested arm must not become denying that it passed.
// Observed live on retry-consolidation: bantam-codex passed 5/5 alone (the codex
// arm was skipped for want of --allow-unsafe-competitors) and the summary read
// "No arm fully passed."
describe("an uncontested pass", () => {
  it("reports the pass and says there was nothing to compare against", () => {
    const text = formatSummary(compileCompareSummary({
      task: "retry-consolidation",
      results: { "bantam-codex": arm(5, 5) },
    }));
    assert.match(text, /PASSED, uncontested/);
    assert.doesNotMatch(text, /No arm fully passed/);
    assert.doesNotMatch(text, /🏆/);
  });

  it("still says no arm passed when none did", () => {
    const text = formatSummary(compileCompareSummary({
      task: "t",
      results: { "bantam-codex": arm(1, 4), codex: arm(2, 4) },
    }));
    assert.match(text, /No arm fully passed/);
  });
});

// Consolidating the tie/coverage rules into strictBest briefly changed a real
// semantic: only PASSING arms were handed to the primitive, so an arm that ran and
// lost stopped counting as competition and a genuine 4/4-over-2/4 win reported as
// "uncontested". An arm that ran and lost is exactly what a win is won against.
describe("what counts as competition", () => {
  it("counts an arm that ran and lost", () => {
    const summary = compileCompareSummary({
      task: "t",
      results: { "bantam-codex": arm(4), codex: arm(2) },
    });
    assert.equal(summary.winner, "bantam-codex");
  });

  it("does not count an arm that never ran", () => {
    assert.equal(compileCompareSummary({
      task: "t", results: { "bantam-codex": arm(4) },
    }).winner, null);
  });

  // "Least wrong" is not a victory.
  it("crowns nobody when the leading arm did not itself pass", () => {
    const summary = compileCompareSummary({
      task: "t",
      results: { "bantam-codex": arm(3, 4), codex: arm(1, 4) },
    });
    assert.equal(summary.winner, null, "being ahead of the field is not passing");
    assert.match(formatSummary(summary), /No arm fully passed/);
  });
});
