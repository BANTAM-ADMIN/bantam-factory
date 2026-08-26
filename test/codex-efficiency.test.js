import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { codexEfficiency, formatCodexEfficiency } from "../src/logic/codex-efficiency.js";

// The two most valuable findings of 2026-07-31 were already in telemetry BANTAM
// collected and nothing read: firstChangedSections { actionHistory: 8 } and
// replacedSuffixChars 21,820. Reading a recorded run costs seconds; re-running one
// costs a Codex call. This turns that asymmetry into a loop.

const artifact = {
  turns: [{}, {}, {}, {}],
  result: { status: "pass", contract: { passed: 4, tests: 4 } },
  metrics: {
    codexPromptDelivery: { calls: 4, deltaCalls: 3, fallbackCalls: 0, savedRatio: 0.4 },
    promptChurn: {
      commonPrefixRatio: 0.74,
      replacedSuffixChars: 1000,
      addedSuffixChars: 3000,
      // changedSections names the earliest DIFFERING section, and actionHistory
      // grows every turn by construction, so it wins that count and means nothing.
      firstChangedSections: { actionHistory: 3, openFiles: 1 },
      // The actionable one: sections whose ALREADY-SENT bytes changed.
      firstRewrittenSections: { openFiles: 2, none: 2 },
    },
    codexThreads: { mode: "run", uniqueThreads: 1, rebasedCalls: 0 },
  },
  modelCalls: [
    { response: { normalized: { usage: { cacheHitTokens: 800, cacheMissTokens: 200, outputTokens: 50, reasoningTokens: 10 } } } },
    { response: { normalized: { usage: { cacheHitTokens: 900, cacheMissTokens: 100, outputTokens: 40, reasoningTokens: 5 } } } },
  ],
};

describe("summarising a recorded Codex run", () => {
  it("totals cache behaviour across calls", () => {
    const r = codexEfficiency(artifact);
    assert.equal(r.tokens.cacheHit, 1700);
    assert.equal(r.tokens.cacheMiss, 300);
    assert.equal(r.tokens.input, 2000);
    assert.equal(r.cacheHitRatio, 0.85);
  });

  it("reports per-turn cost, since turn counts differ between runs", () => {
    const r = codexEfficiency(artifact);
    assert.equal(r.perTurn.cacheMiss, 75);
    assert.equal(r.perTurn.replacedChars, 250);
  });

  // The actionable number: appended bytes are the cost of progress, rewritten
  // bytes are the cost of changing our mind about what was already said.
  it("separates rewriting history from extending it", () => {
    const r = codexEfficiency(artifact);
    assert.equal(r.churn.rewriteRatio, 0.25);
  });

  // The report must name the REWRITTEN section, not the merely-changed one. An
  // earlier version led with changedSections and told readers it showed where
  // history was being rewritten; it showed actionHistory on every turn, which is
  // true by construction and carries no information.
  it("names the section whose already-sent bytes changed, not the one that grew", () => {
    const text = formatCodexEfficiency(codexEfficiency(artifact), "run-1");
    assert.match(text, /REWRITES history in: openFiles x2/);
    assert.match(text, /paid twice/);
    assert.ok(!/actionHistory/.test(text),
      "a section that merely grew must not be reported as a rewrite");
  });

  it("carries the hidden contract into the headline", () => {
    assert.match(formatCodexEfficiency(codexEfficiency(artifact)), /4\/4 hidden/);
  });

  it("warns loudly about a thread rebase, which re-sends everything", () => {
    const rebased = { ...artifact, metrics: { ...artifact.metrics, codexThreads: { mode: "run", uniqueThreads: 2, rebasedCalls: 1 } } };
    assert.match(formatCodexEfficiency(codexEfficiency(rebased)), /WARNING.*rebase/);
  });

  // A local run has none of these metrics; the report must not fabricate them.
  it("survives an artifact with no Codex telemetry", () => {
    const r = codexEfficiency({ turns: [], modelCalls: [] });
    assert.equal(r.cacheHitRatio, null);
    assert.equal(r.delivery.savedRatio, null);
    assert.equal(r.churn.rewriteRatio, null);
    assert.ok(typeof formatCodexEfficiency(r) === "string");
  });
});
