import assert from "node:assert/strict";
import test from "node:test";

import { formatGovernedSelfImproveResult } from "../src/self-improve-controller.js";

// `self-improve --plan` is where an operator chooses what to build next. It
// listed candidates without ever mentioning that previously generated modules
// were never wired in -- so the loop could propose a 30th module while 26 sat
// unexecuted (audited 2026-07-30: 4,336 lines, 3 of 29 wired).
// See docs/superpowers/reports/2026-07-30-self-improvement-integration-audit.md

const PLAN = {
  mode: "plan",
  candidates: [{ id: "alpha", problem: "something is slow" }],
  selected: { id: "alpha" },
};

test("plan output still lists candidates when nothing is shelved", () => {
  const text = formatGovernedSelfImproveResult({
    ...PLAN,
    integrationAudit: { wired: [{ file: "a.js", lines: 1 }], testOnly: [], unreferenced: [], missing: [], totals: { shelvedLines: 0 } },
  });
  assert.match(text, /\[alpha\]/);
  assert.match(text, /Next managed candidate: alpha/);
  assert.doesNotMatch(text, /not wired/i);
});

test("plan output warns when generated modules were never wired in", () => {
  const text = formatGovernedSelfImproveResult({
    ...PLAN,
    integrationAudit: {
      wired: [{ file: "a.js", lines: 10 }],
      testOnly: [{ file: "b.js", lines: 100, importers: ["b.test.js"] }],
      unreferenced: [{ file: "c.js", lines: 200 }],
      missing: [],
      totals: { shelvedLines: 300 },
    },
  });
  assert.match(text, /2 previously generated module/i);
  assert.match(text, /300 lines/);
  assert.match(text, /not wired|never reaches/i);
  // Still a plan, not replaced by the warning.
  assert.match(text, /Next managed candidate: alpha/);
});

test("plan output is unchanged when no audit is supplied", () => {
  const text = formatGovernedSelfImproveResult(PLAN);
  assert.match(text, /Next managed candidate: alpha/);
  assert.doesNotMatch(text, /not wired/i);
});
