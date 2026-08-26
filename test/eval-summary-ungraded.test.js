import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { summarizeEvalRows, formatEvalSummary } from "../src/reporting.js";

// The headline number counted every row in the denominator, so a run that never
// happened was reported as a run that failed. On 2026-08-01 an exhausted Codex
// account produced "0/1 passed" -- indistinguishable from a fixture the model got
// wrong, and the reason an hour went into debugging the harness.
//
// This is the third principle applied to the number everything else is judged by:
// an instrument that cannot see must say so, rather than defaulting to a result.

const row = (status, extra = {}) => ({
  name: "f", status, invalid: 0, protocolViolations: 0, turns: 0, ...extra,
});

describe("pass rate excludes runs that never happened", () => {
  it("does not count a quota-exhausted run as a failure", () => {
    const s = summarizeEvalRows([row("pass"), row("quota-exhausted")]);
    assert.equal(s.graded, 1, "only the run that actually executed is graded");
    assert.equal(s.passed, 1);
    assert.equal(s.ungraded, 1);
  });

  it("does not count a model error as a failure", () => {
    const s = summarizeEvalRows([row("pass"), row("model-error")]);
    assert.equal(s.graded, 1);
    assert.equal(s.ungraded, 1);
  });

  // A real failure must still count. The point is to separate "did not run" from
  // "ran and was wrong", not to make failures disappear.
  it("still counts contract and public failures", () => {
    const s = summarizeEvalRows([row("pass"), row("contract-fail"), row("fail")]);
    assert.equal(s.graded, 3);
    assert.equal(s.passed, 1);
    assert.equal(s.ungraded, 0);
  });

  it("says so in the summary rather than hiding the row", () => {
    const text = formatEvalSummary([row("pass"), row("quota-exhausted")]);
    assert.match(text, /1\/1 passed/, "the rate is over graded runs");
    assert.match(text, /1 run\(s\) not graded/i, "the ungraded run must still be reported");
  });

  it("reports honestly when nothing could be graded at all", () => {
    const text = formatEvalSummary([row("quota-exhausted")]);
    assert.match(text, /0 run\(s\) graded/i);
    assert.ok(!/0\/1 passed/.test(text), "must not imply a fixture failed");
  });
});
