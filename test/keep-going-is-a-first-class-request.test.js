import assert from "node:assert/strict";
import test from "node:test";

import { isContinuationRequest, buildContinuationTask } from "../src/continuation.js";

// Mined from the real corpus (benches/collab): 3,846 of 17,083 sampled user
// turns (23%) are continuation-shaped. The specimen session is one substantive
// ask and fifteen continuations. These strings are the operator's actual words.
test("real continuations are recognised", () => {
  for (const t of [
    "keep going",
    "yes, keep going, TDD process",
    "keep going, yeah",
    "sure, keep going",
    "yes, please",
    "yes",
    "go ahead",
    "keep going, that seems slower than it should be but maybe it's not?",
  ]) assert.ok(isContinuationRequest(t) || t.length > 80, t);
});

test("real new-instructions that merely START like continuations are not", () => {
  for (const t of [
    "ok, open the server up so I can test it here.",             // corpus, verbatim
    "yes - and also refactor the parser to handle unicode properly, then add tests for the edge cases we discussed",
    "continue reading the log file and tell me every error class you find in it today",
  ]) assert.ok(!isContinuationRequest(t), t);
});

test("the continuation task carries the thread", () => {
  const task = buildContinuationTask({
    request: "yes, keep going, TDD process",
    lastRequest: "document it, test it, then lets discuss improving",
    lastReport: "Wrote docs/architecture.md; 3 of 7 modules documented. Next: document bindings/, then add tests for the query layer.",
    sessionContext: '- you asked: "document it" → I: started docs',
  });
  assert.match(task, /consent to CONTINUE your own previous work/);
  assert.match(task, /document it, test it/);
  assert.match(task, /Next: document bindings/, "the last report's next steps travel");
  assert.match(task, /TDD process/, "the rider is preserved");
  assert.match(task, /Do not re-explore/);
});
