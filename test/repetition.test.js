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

const DRIFT = { a: "shell", c: 'TMP=$(mktemp -d) && node snapshot.js verify "$TMP" "$TMP/m.json"; echo "VERIFY_EXIT=$?"' };
const DRIFT_OBSERVATION = `$ ${DRIFT.c}\nexit 0\n{"ok":false,"changed":[{"path":"f.txt","reasons":["mode"]}]}\nVERIFY_EXIT=1\n\n[verification uncertainty] outer shell success may mask an inner runner failure`;
function typedResult(action, status, exitCode = status === "fail" ? 1 : 0) {
  return {
    shellExecution: { command: action.c, exitCode, generation: 1 },
    verificationEvidence: { command: action.c, status, exitCode, generation: 1 },
  };
}

test("echoed expected-drift status stays unverified through duplicate escalation", () => {
  const guard = new RepetitionGuard({ dedupeShell: true });
  for (let turn = 1; turn <= 3; turn++) {
    guard.record(DRIFT, DRIFT_OBSERVATION, { turn, shellWorkspaceUnchanged: true,
      result: typedResult(DRIFT, "unverified") });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const duplicate = guard.check(DRIFT);
    assert.ok(duplicate);
    assert.match(duplicate.observation, /UNVERIFIED, not failed/);
    assert.doesNotMatch(duplicate.observation, /last real run FAILED|never passed|actual defect|FIX the code|WILL be identical/);
  }
});

test("legacy unknown is not collapsed into a confirmed failure", () => {
  const guard = new RepetitionGuard({ dedupeShell: true });
  for (let turn = 1; turn <= 3; turn++) guard.record(DRIFT, DRIFT_OBSERVATION, { turn, shellWorkspaceUnchanged: true });
  assert.match(guard.check(DRIFT).observation, /UNVERIFIED, not failed/);
});

test("typed pass and true failure retain their distinct duplicate behavior despite prose", () => {
  const green = new RepetitionGuard({ dedupeShell: true });
  green.record(TEST, "expected exception includes FAILED\n[verification uncertainty] unrelated annotation", {
    shellWorkspaceUnchanged: true, result: typedResult(TEST, "pass"),
  });
  assert.ok(green.check(TEST));
  assert.doesNotMatch(green.check(TEST).observation, /last real run FAILED|UNVERIFIED/);
  assert.match(green.check(TEST).observation, /last check passed/);

  const red = new RepetitionGuard({ dedupeShell: true });
  for (let turn = 1; turn <= 3; turn++) {
    red.record(TEST, "exit 1\nAssertionError: mismatch\n[verification uncertainty] unrelated annotation", {
      turn, shellWorkspaceUnchanged: true, result: typedResult(TEST, "fail"),
    });
    if (turn < 3) assert.equal(red.check(TEST), null);
  }
  assert.match(red.check(TEST).observation, /last real run FAILED/);
});

test("blocked, deduplicated, spawn-failed and mismatched receipts do not accumulate runs", () => {
  const guard = new RepetitionGuard({ dedupeShell: true });
  for (const result of [
    { shellExecution: null },
    { shellExecution: { command: TEST.c, blocked: true } },
    { shellExecution: { command: TEST.c, error: "spawn denied" } },
    { shellExecution: { command: "different command", exitCode: 0 } },
  ]) {
    for (let i = 0; i < 8; i++) guard.record(TEST, "exit 1\nFAILED", { shellWorkspaceUnchanged: true, result });
  }
  assert.equal(guard.check(TEST), null);
  assert.equal(guard.noProgressSteers, 0);
  assert.equal(guard.brokenRecordSteers, 0);
});

test("same-result streak language distinguishes pass, failure and unknown", () => {
  for (const status of ["pass", "fail", "unverified"]) {
    const guard = new RepetitionGuard();
    const action = status === "unverified" ? DRIFT : TEST;
    for (let i = 0; i < 6; i++) {
      guard.record(action, DRIFT_OBSERVATION, { result: typedResult(action, status) });
      guard.noteWorkspaceChanged();
    }
    const steer = guard.check(action);
    assert.match(steer.observation, /\[no-progress\]/);
    assert.doesNotMatch(steer.observation, /never passed|failed identically|editing between runs/);
    assert.match(steer.observation, status === "pass" ? /checks passed/ : status === "fail" ? /checks failed/ : /UNVERIFIED, not failed/);
  }
});

test("an unrelated landing PASS cannot qualify the masked shell that preceded it", () => {
  const guard = new RepetitionGuard({ dedupeShell: true });
  const result = typedResult(DRIFT, "unverified");
  result.verificationEvidence = { command: "npm test", executedCommand: "npm test", status: "pass",
    source: "landing", workspaceReadOnly: true, exitCode: 0 };
  for (let turn = 1; turn <= 3; turn++) {
    guard.record(DRIFT, DRIFT_OBSERVATION + "\nLanding npm test: PASS", { turn, shellWorkspaceUnchanged: true, result });
    if (turn < 3) assert.equal(guard.check(DRIFT), null, "unrelated pass must not suppress the first retry");
  }
  assert.match(guard.check(DRIFT).observation, /UNVERIFIED, not failed/);
});

test("normalized commands bind via requestedCommand and use actual execution status", () => {
  const action = { a: "shell", c: 'node verify.mjs; echo "EXIT=$?"' };
  const result = { shellExecution: { requestedCommand: action.c, command: "node verify.mjs",
    executedCommand: "node verify.mjs", exitCode: 0, stdout: "verified\n", stderr: "", pipefail: true },
  verificationEvidence: { command: action.c, status: "unverified" } };
  const guard = new RepetitionGuard({ dedupeShell: true });
  guard.record(action, "stale unverified narrative", { shellWorkspaceUnchanged: true, result });
  const duplicate = guard.check(action);
  assert.ok(duplicate, "real normalized pass is reusable immediately");
  assert.doesNotMatch(duplicate.observation, /FAILED|UNVERIFIED/);
});
