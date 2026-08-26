import test from "node:test";
import assert from "node:assert/strict";
import { prematureDoneObjection } from "../src/done-guard.js";
// The 2026-08-21 sweep: of the runs that claimed done and still scored 0, four
// had re-sent a BYTE-IDENTICAL done summary after being objected to
// (build-cython-ext 3, rstan-to-pystan 3, query-optimize 2, dna-insert 1).
// Under a plain rejection counter, repeating yourself verbatim was the fastest
// way to exhaust the gate — the wrong move was the lit button.
test("a verbatim done repeat does not buy its way past the rejection budget", () => {
  const failing = [{ action: { a: "shell", c: "npm test" }, observation: "2 failed, 1 passed" }];
  const done = (summary) => ({ action: { a: "done", summary }, observation: "" });

  const spam = failing.concat([done("same"), done("same"), done("same")]);
  const objection = prematureDoneObjection(spam, 2);
  assert.ok(objection, "repeating the identical summary must not release done");
  assert.match(objection, /\[repeat\]/, "and it must say so");

  // A model that actually engaged — different summaries — still gets through,
  // so the anti-wedge property the budget exists for is untouched.
  const engaged = failing.concat([done("first"), done("second"), done("third")]);
  assert.equal(prematureDoneObjection(engaged, 2), null, "genuine attempts still release");
});

test("a run that will only ever repeat itself is released, not spun to the turn cap", () => {
  const failing = [{ action: { a: "shell", c: "npm test" }, observation: "2 failed, 1 passed" }];
  const done = (summary) => ({ action: { a: "done", summary }, observation: "" });
  const forever = failing.concat(Array.from({ length: 5 }, () => done("same")));
  assert.equal(prematureDoneObjection(forever, 4), null, "maxVerbatimRepeats must still let go");
});
