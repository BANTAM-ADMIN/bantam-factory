import assert from "node:assert/strict";
import test from "node:test";

import { isAffirmation, extractNextStep, buildSessionTask } from "../src/continuation.js";

// Operator, 2026-08-17: "I shouldn't have to say 'keep going' to have all that
// held... I don't want this locked to the literal words." The thread is now
// unconditional; affirmation detection only disambiguates bare consent.

test("a brand-new request STILL carries the full thread", () => {
  const task = buildSessionTask({
    request: "now add a --json flag to the CLI",
    sessionLog: [{ request: "build the calc CLI", summary: "built calc.js",
      fullSummary: "Built calc.js with tokenizer/parser/evaluator. Next: error messages could name the bad token." }],
  });
  assert.match(task, /Your last report, in full/, "the thread is not gated on phrasing");
  assert.match(task, /error messages could name the bad token/);
  assert.match(task, /New request: now add a --json flag/);
  assert.doesNotMatch(task, /consent to CONTINUE/, "a new ask is framed as a new ask");
});

test("bare consent — including an empty Enter — becomes an explicit continue", () => {
  for (const req of ["", "yes", "keep going", "sure, keep going, TDD process", "do it", "sounds good"]) {
    const task = buildSessionTask({
      request: req,
      sessionLog: [{ request: "document the system", summary: "started docs", fullSummary: "Docs for 3 of 7 modules. Next: bindings/." }],
    });
    assert.match(task, /consent to CONTINUE/, JSON.stringify(req));
    assert.match(task, /Next: bindings/);
  }
});

test("real new-instructions are never mistaken for consent", () => {
  for (const t of [
    "ok, open the server up so I can test it here.",
    "continue reading the log file and tell me every error class you find",
    "yes - and also refactor the parser to handle unicode, then add tests",
  ]) assert.ok(!isAffirmation(t), t);
});

test("the agent's own Next: proposal is extractable", () => {
  assert.equal(extractNextStep("Did X.\nNext: wire the flag through main."), "wire the flag through main.");
  assert.equal(extractNextStep("Next steps: profile the hot loop"), "profile the hot loop");
  assert.equal(extractNextStep("All done, nothing obvious remains."), null, "absence is honest");
});

// Operator, same conversation: "build it so it can propose next steps after
// anything we do/finish so it's thinking of ways to go further or improve."
// The prompt half of the loop: interactive sessions instruct the model to end
// every done summary with a Next: line — with an explicit no-make-work escape,
// because a fabricated proposal is worse than an honest stop.
import { buildPrompt } from "../src/prompt.js";

test("interactive sessions ask for a Next proposal after everything", () => {
  const p = buildPrompt({ task: "t", env: "e", turns: [], interactive: true });
  assert.match(p, /end your done summary with a line of the form "Next:/);
  assert.match(p, /nothing pressing/, "the no-make-work escape exists");
});

test("headless runs are not burdened with proposals", () => {
  const p = buildPrompt({ task: "t", env: "e", turns: [], interactive: false });
  assert.doesNotMatch(p, /end your done summary with a line of the form "Next:/);
});

// The status check — "how's it coming" in 100+ real sessions. Mid-run it gets
// an instant harness answer instead of burning a model turn as a steer.
import { isStatusQuestion } from "../src/continuation.js";

test("real status pokes are recognised", () => {
  for (const t of ["how's it coming", "hows it going?", "status", "where are we at?", "you still there?", "still working?"])
    assert.ok(isStatusQuestion(t), t);
});

test("real work requests are not status pokes", () => {
  for (const t of ["how's it coming along with the parser — actually, switch to the tokenizer first",
                   "status should be a json field on every row", "progress bar please"])
    assert.ok(!isStatusQuestion(t), t);
});

test("the honest stop is not a pressable proposal", () => {
  assert.equal(extractNextStep("Fixed it.\nNext: nothing pressing — this is a good stopping point."), null);
});
