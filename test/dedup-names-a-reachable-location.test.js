import assert from "node:assert/strict";
import test from "node:test";

import { RepetitionGuard } from "../src/repetition.js";

// The refusal used to end "Its unchanged result remains at turn N; it is not
// copied here." A turn number is only a usable address while that turn's
// observation is still in the prompt, and across 34 stored runs it usually was
// not: 697 of 1,183 such claims named a turn whose observation had already been
// replaced by a stub. Both halves reached the model in the SAME prompt —
//
//   [repetition] … Its unchanged result remains at turn 8; it is not copied here.
//   [turn 8, inspect #1: src/agent.js — earlier snapshot omitted; read_file for current contents]
//
// — so the refusal sent the model to a turn that told it to re-read, and the
// re-read was refused. 31% of all dedup refusals in that corpus are the model
// immediately retrying the identical action.
//
// history-budget.js already rewrites the claim when the origin turn has been
// EVICTED from the window. This is the other case: the turn is still there, its
// content is not.
//
// agent.js consults this guard only after readReplayIsContextSafe confirms
// <open_files> holds the file's current bytes, so naming the panel is true by
// construction — which a turn number never was.

const READ = { a: "read_file", p: "src/agent.js", start: 295, limit: 120 };

function refusalFor(action) {
  const guard = new RepetitionGuard({});
  guard.record(action, "src/agent.js (5756 lines, showing 295-414): …", { turn: 38 });
  return guard.check(action).observation;
}

test("a refused read is pointed at the panel, not at a turn number", () => {
  const observation = refusalFor(READ);
  assert.match(observation, /current contents of src\/agent\.js are in <open_files> above/);
  assert.doesNotMatch(observation, /remains at turn/);
});

test("the provenance turn is still stated as history", () => {
  // Knowing WHEN it ran is useful; it just cannot be the address of the bytes.
  assert.match(refusalFor(READ), /already ran this exact action on turn 38/);
});

test("an inspect names every path it would have read", () => {
  const inspect = {
    a: "inspect",
    ops: [
      { a: "read_file", p: "src/agent.js" },
      { a: "read_file", p: "src/scope-guard.js" },
      { a: "search", q: "editable", p: "src/agent.js" },
    ],
  };
  const observation = refusalFor(inspect);
  assert.match(observation, /src\/agent\.js, src\/scope-guard\.js are in <open_files> above/);
  assert.doesNotMatch(observation, /remains at turn/);
});

test("a shell replay claims no location, having no panel guarantee", () => {
  // readReplayIsContextSafe covers reads only. Promising a shell result is in
  // <open_files> would substitute one false address for another.
  const shell = { a: "shell", c: "node --test test/ordered-map.test.js" };
  const guard = new RepetitionGuard({ dedupeShell: true });
  guard.record(shell, "tests 1\npass 1\nfail 0\nexit code: 0", { turn: 3, shellWorkspaceUnchanged: true });
  const observation = guard.check(shell).observation;
  assert.match(observation, /Its result is not repeated here\./);
  assert.doesNotMatch(observation, /<open_files>/);
  assert.doesNotMatch(observation, /remains at turn/);
});

test("the escalated message keeps the same honest location", () => {
  const guard = new RepetitionGuard({});
  guard.record(READ, "…", { turn: 38 });
  guard.check(READ);
  const second = guard.check(READ).observation;
  assert.match(second, /attempted this identical action 2 times/);
  assert.match(second, /current contents of src\/agent\.js are in <open_files> above/);
  assert.doesNotMatch(second, /remains at turn/);
});
