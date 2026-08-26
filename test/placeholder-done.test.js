import test from "node:test";
import assert from "node:assert/strict";
import { isPlaceholderSummary, placeholderDoneObjection } from "../src/logic/placeholder-done.js";
import { DONE_GATES } from "../src/done-gates.js";

// TB2 mailman (2026-08-21), on a clean build with zero error signals: ten
// actions in, the run emitted {"a":"done","summary":"placeholder"} and the run
// ENDED — turn 10 of a 200-turn budget, reward 0. empty_done saw a touched tree
// and passed; premature_done needs a failing test verdict and no test had run,
// so it returned null. Every gate was inspecting the work; none read the field
// that said the run was not finished.
test("a stub done summary is refused", () => {
  for (const stub of ["placeholder", "TODO:", "...", "<summary>", "", "   ", "stub", "todo: finish this"]) {
    assert.equal(isPlaceholderSummary(stub), true, `${JSON.stringify(stub)} must read as a stub`);
  }
  const objection = placeholderDoneObjection([{ action: { a: "done", summary: "placeholder" } }], 0);
  assert.ok(objection, "the gate must object");
  assert.match(objection, /placeholder/);
});

test("a real summary — even a terse one — is left alone", () => {
  for (const real of [
    "Implemented the LRU cache in src/cache.js and confirmed with npm test (42 passing).",
    "Fixed the off-by-one in parse_header; ./run_tests.sh now exits 0.",
    "Done.",
  ]) {
    assert.equal(isPlaceholderSummary(real), false, `${JSON.stringify(real)} must not read as a stub`);
  }
  assert.equal(
    placeholderDoneObjection([{ action: { a: "done", summary: "Rewrote the parser; make check is green." } }], 0),
    null,
  );
});

test("the gate is bounded and can never trap a run", () => {
  const turns = [{ action: { a: "done", summary: "placeholder" } }];
  assert.equal(placeholderDoneObjection(turns, 2), null, "must let go at maxRejections");
});

test("it runs before the gates that inspect the work, not after", () => {
  const names = DONE_GATES.map((g) => g.name);
  assert.ok(names.includes("placeholder_done"), "gate must be registered in the chain");
  assert.ok(
    names.indexOf("placeholder_done") < names.indexOf("premature_done"),
    "a one-string check must precede the gates that returned null on this case",
  );
});
