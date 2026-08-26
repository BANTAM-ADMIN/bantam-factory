import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { completionAuditEnabled } from "../src/completion-audit.js";

// Measured per model, 2026-07-31, gpt-5.6-terra on keyed-task-pool-strong, n=3 per
// arm with complete separation (exact permutation p = 0.05):
//
//              mean turns   mean cache miss   hidden contract
//   audit ON      9.7           51,253        4/4, 4/4, 4/4
//   audit off     6.3           30,758        4/4, 4/4, 4/4
//
// Every ON run cost more than every OFF run -- +54% turns, +67% cache misses -- for
// an identical contract result. The audit asks "are you sure?"; a frontier model on
// a well-specified task already was.
//
// It stays on for local models, where premature `done` is a real failure mode. This
// is the per-model supervision fork: the same mechanism can be worth its cost for
// one worker and pure overhead for another.

describe("completion audit default", () => {
  it("stays on for local models", () => {
    assert.equal(completionAuditEnabled(undefined, { codex: false }), true);
    assert.equal(completionAuditEnabled(undefined), true);
  });

  it("is off by default for Codex", () => {
    assert.equal(completionAuditEnabled(undefined, { codex: true }), false);
  });

  // An explicit setting must beat both defaults, or the measurement cannot be
  // repeated and the finding cannot be challenged.
  it("lets an explicit setting override either default", () => {
    assert.equal(completionAuditEnabled("1", { codex: true }), true);
    assert.equal(completionAuditEnabled("on", { codex: true }), true);
    assert.equal(completionAuditEnabled("0", { codex: false }), false);
    assert.equal(completionAuditEnabled("off", { codex: false }), false);
  });

  // An empty string is someone explicitly disabling the audit, and has always
  // meant off. Only an UNSET variable falls through to the per-model default --
  // re-enabling it for local models would be a behaviour change hiding inside a
  // default change.
  it("keeps an empty value meaning off, as it always has", () => {
    assert.equal(completionAuditEnabled("", { codex: false }), false);
    assert.equal(completionAuditEnabled("", { codex: true }), false);
  });
});
