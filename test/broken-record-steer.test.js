// Arm-B (2026-08-18) re-ran the same failing self-test seven times, varying
// only the output filename to defeat exact-match dedup, then called done.
// The broken-record track keys on the FAILURE SIGNATURE (last meaningful
// line, volatile paths masked), not the command bytes: three consecutive
// same-failure shell runs with no intervening edit earn a steer that says
// change the code or the theory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RepetitionGuard } from "../src/repetition.js";

const FAIL = (n) => `$ python3 gguf-scope f.gguf > /tmp/${n}.txt 2>&1; echo "exit=$?"\nexit=1\nTraceback (most recent call last):\nTypeError: sequence item 0: expected str instance, tuple found`;

test("three same-signature failures with varied commands earn the steer", () => {
  const g = new RepetitionGuard({ enabled: true });
  for (const n of ["a1", "b1", "c1"]) {
    assert.equal(g.check({ a: "shell", c: `python3 gguf-scope f.gguf > /tmp/${n}.txt` }), null);
    g.record({ a: "shell", c: `python3 gguf-scope f.gguf > /tmp/${n}.txt` }, FAIL(n), { turn: 1 });
  }
  const steer = g.check({ a: "shell", c: "python3 gguf-scope f.gguf > /tmp/d1.txt" });
  assert.ok(steer, "steer fires at three");
  assert.match(steer.observation, /broken-record/);
  assert.match(steer.observation, /Change the CODE or your THEORY/);
});

test("an edit resets the streak", () => {
  const g = new RepetitionGuard({ enabled: true });
  for (const n of ["a", "b", "c"]) g.record({ a: "shell", c: `run ${n}` }, FAIL(n), { turn: 1 });
  g.noteWorkspaceChanged();
  assert.equal(g.check({ a: "shell", c: "run d" }), null);
});

test("a pass resets the streak; different failures do not accumulate", () => {
  const g = new RepetitionGuard({ enabled: true });
  g.record({ a: "shell", c: "run a" }, FAIL("a"), { turn: 1 });
  g.record({ a: "shell", c: "run b" }, "$ run b\nall good", { turn: 2 });
  g.record({ a: "shell", c: "run c" }, FAIL("c"), { turn: 3 });
  g.record({ a: "shell", c: "run d" }, "exit=1\nValueError: different beast", { turn: 4 });
  assert.equal(g.check({ a: "shell", c: "run e" }), null);
});
