import assert from "node:assert/strict";
import test from "node:test";

import { RepetitionGuard } from "../src/repetition.js";

const TEST = { a: "shell", c: "node --test test/ordered-map.test.js" };

test("a green verification is reused until the workspace changes", () => {
  const guard = new RepetitionGuard({ dedupeShell: true });
  guard.record(TEST, "tests 1\npass 1\nfail 0\nexit code: 0", { turn: 3, shellWorkspaceUnchanged: true });
  const duplicate = guard.check(TEST);
  assert.equal(duplicate.duplicateOfTurn, 3);
  assert.match(duplicate.observation, /not executed again/);
  guard.noteWorkspaceChanged();
  assert.equal(guard.check(TEST), null);
});

test("a failing verification remains retryable until the same failure is confirmed", () => {
  const guard = new RepetitionGuard({ dedupeShell: true });
  const failed = "tests 1\npass 0\nfail 1\nexit code: 1";
  guard.record(TEST, failed, { turn: 1, shellWorkspaceUnchanged: true });
  assert.equal(guard.check(TEST), null);
  guard.record(TEST, failed, { turn: 2, shellWorkspaceUnchanged: true });
  assert.equal(guard.check(TEST), null);
  guard.record(TEST, failed, { turn: 3, shellWorkspaceUnchanged: true });
  assert.equal(guard.check(TEST).duplicateOfTurn, 3);
});

test("a runaway identical test-loop escalates to a hard circuit-breaker (TB2 audit)", () => {
  // write-compressor: the model re-ran an identical build+size-check 13 times
  // and burned its whole turn budget. By the 3rd dedup the steer must stop
  // being polite and forbid the loop, pointing at correctness over size.
  const guard = new RepetitionGuard({ dedupeShell: true });
  const BUILD = { a: "shell", c: "cd /app && ./gen && wc -c data.comp" };
  const green = "output size: 4000\nexit code: 0";
  let msg = "";
  for (let turn = 1; turn <= 5; turn++) {
    guard.record(BUILD, green, { turn, shellWorkspaceUnchanged: true });
    const dup = guard.check(BUILD);
    if (dup) msg = dup.observation;
  }
  assert.match(msg, /LOOP DETECTED/);
  assert.match(msg, /EDIT/);
  assert.match(msg, /CORRECTNESS|correctness/);
  assert.match(msg, /Do not run this exact command again/);
});
