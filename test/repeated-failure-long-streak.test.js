import test from "node:test";
import assert from "node:assert/strict";
import { repeatedFailureDiagnostic, failureFingerprint } from "../src/failure-diagnostics.js";

const crash = { action: { a: "shell", c: "cat t.comp | ./decomp; echo exit=$?" }, observation: "$ cat t.comp | ./decomp; echo exit=$?\nexit=139\nSegmentation fault (core dumped)\n" };
const edit = { action: { a: "replace", p: "enc.py", old: "a", new: "b" }, observation: "replaced 1 occurrence in enc.py" };

test("a crash observation with exit=N and 'Segmentation fault' now fingerprints", () => {
  assert.ok(failureFingerprint(crash.observation));
});

test("a long identical streak fires even with only one edit between repeats", () => {
  const turns = [crash, crash, edit, crash, crash, crash, crash];   // 6 crashes, 1 edit
  assert.ok(repeatedFailureDiagnostic(turns, crash.action, crash.observation));
});

test("a short streak with no edits stays quiet (a plain re-run is not a thrash)", () => {
  assert.equal(repeatedFailureDiagnostic([crash, crash], crash.action, crash.observation), null);
});
