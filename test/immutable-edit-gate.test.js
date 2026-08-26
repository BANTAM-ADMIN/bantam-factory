// The in-loop scope gate — built, measured, and deliberately NOT wired in.
//
// `detectScopeViolations` grades the tree after a run, which catches a grader
// edit but cannot stop one. Front-running it looked obviously right, and gating
// the EDIT actions alone turned out to be worse than gating nothing: on the
// 2026-07-26 Gemma 4 QAT gauntlet it refused two complete, valid write_file
// calls and pushed the model onto `shell` (not an edit action, so ungated),
// where a heredoc hit the token ceiling, lost its terminator, and corrupted the
// grader the gate existed to protect — then blocked the clean repair.
//
// These tests therefore pin the pure decision functions, which are correct and
// ready for a version that also covers shell writes. They also pin that the gate
// is inert unless a caller passes one, which is what keeps it out of the loop
// today. See the note at the postVerifyIntegrity call in fixture-runner.js.

import assert from "node:assert/strict";
import test from "node:test";

import { immutableEditReason, detectScopeViolations } from "../src/scope-guard.js";
import { editScopeRefusal } from "../src/agent.js";

const SPEC = { editable: ["src"] };

test("grader, runner-config and out-of-scope paths are refused; source is not", () => {
  assert.equal(immutableEditReason("test/retry.test.js", SPEC), "grader");
  assert.equal(immutableEditReason("src/retry.test.js", SPEC), "grader"); // suffix, not just test/
  assert.equal(immutableEditReason("jest.config.js", SPEC), "runner-config");
  assert.equal(immutableEditReason(".npmrc", SPEC), "runner-config");
  assert.equal(immutableEditReason("docs/notes.md", SPEC), "out-of-scope");
  assert.equal(immutableEditReason("src/retry.js", SPEC), null);
  // With no `editable` declared, only grader/runner-config paths are immutable.
  assert.equal(immutableEditReason("docs/notes.md", {}), null);
  assert.equal(immutableEditReason("test/a.test.js", {}), "grader");
});

test("the gate agrees with the post-hoc grader on the same path", () => {
  // Whatever the pre-write gate refuses, the after-the-fact check would also
  // have flagged — the gate must not invent a boundary the scorer doesn't hold.
  const before = new Map([["src/retry.js", "a"], ["test/retry.test.js", "t"]]);
  for (const path of ["test/retry.test.js", "docs/notes.md"]) {
    const after = new Map(before);
    after.set(path, "changed");
    const violations = detectScopeViolations(before, after, SPEC);
    assert.equal(violations.length, 1, `${path} should be one violation`);
    assert.ok(immutableEditReason(path, SPEC), `${path} should also be refused up front`);
  }
});

test("an edit action touching an immutable path is refused with a redirect", () => {
  const guard = (rel) => immutableEditReason(rel, SPEC);
  const refusal = editScopeRefusal({ a: "write_file", p: "test/retry.test.js", content: "x" }, guard);
  assert.match(refusal, /^\[scope\] test\/retry\.test\.js is immutable/);
  assert.match(refusal, /part of the grader/);
  // It must say the edit did not land, or the model will assume the file changed.
  assert.match(refusal, /NOT applied/);
  // and point at the legitimate route, since this most often intercepts a model
  // trying to check its own work more thoroughly.
  assert.match(refusal, /`shell`/);
});

test("a patch spanning several files is refused if ANY target is immutable", () => {
  const guard = (rel) => immutableEditReason(rel, SPEC);
  const action = { a: "patch", edits: [{ p: "src/retry.js", line: 1 }, { p: "test/retry.test.js", line: 2 }] };
  assert.match(editScopeRefusal(action, guard), /test\/retry\.test\.js is immutable/);
  assert.equal(editScopeRefusal({ a: "patch", edits: [{ p: "src/retry.js", line: 1 }] }, guard), null);
});

test("non-edit actions and the default (no gate) are never refused", () => {
  const guard = (rel) => immutableEditReason(rel, SPEC);
  // Reading or testing a grader stays allowed — only writes are gated.
  assert.equal(editScopeRefusal({ a: "read_file", p: "test/retry.test.js" }, guard), null);
  assert.equal(editScopeRefusal({ a: "shell", c: "npm test" }, guard), null);
  // No guard supplied: every existing caller behaves exactly as before.
  assert.equal(editScopeRefusal({ a: "write_file", p: "test/retry.test.js", content: "x" }, null), null);
  assert.equal(editScopeRefusal({ a: "write_file", p: "test/retry.test.js", content: "x" }, undefined), null);
});

test("deleting or moving a grader is refused too", () => {
  const guard = (rel) => immutableEditReason(rel, SPEC);
  assert.match(editScopeRefusal({ a: "delete_file", p: "test/retry.test.js" }, guard), /immutable/);
  // move_file names its endpoints `from`/`to`; moving a grader OUT of test/ would
  // remove it from discovery just as surely as deleting it.
  assert.match(editScopeRefusal({ a: "move_file", from: "test/retry.test.js", to: "src/x.js" }, guard), /immutable/);
  // and moving an allowed source file INTO the grader directory is refused too.
  assert.match(editScopeRefusal({ a: "move_file", from: "src/x.js", to: "test/x.test.js" }, guard), /immutable/);
});

test("an out-of-scope refusal NAMES the editable paths when the guard exposes them", () => {
  // The polyglot-js false start (2026-08-15): 11 runs x 24 turns of
  // "[scope] X is immutable ... editable paths" with the model never told
  // WHICH paths were editable. The guard knows; the bounce must deliver it.
  const guard = (rel) => immutableEditReason(rel, { editable: ["affine-cipher.js"] });
  guard.editable = ["affine-cipher.js"];
  const refusal = editScopeRefusal({ a: "write_file", p: "docs/notes.md", content: "x" }, guard);
  assert.match(refusal, /editable paths for this task: affine-cipher\.js/);

  // Without the property the message keeps its old shape.
  const bare = (rel) => immutableEditReason(rel, { editable: ["affine-cipher.js"] });
  const plain = editScopeRefusal({ a: "write_file", p: "docs/notes.md", content: "x" }, bare);
  assert.match(plain, /Make the change inside the editable paths instead\./);
});

test("a refusal flags an editable list that matches no existing file", () => {
  const guard = (rel) => immutableEditReason(rel, { editable: ["src-typo"] });
  guard.editable = ["src-typo"];
  guard.editableMatchesNothing = true;
  const refusal = editScopeRefusal({ a: "write_file", p: "lib.js", content: "x" }, guard);
  assert.match(refusal, /no existing file is under these paths/i);
});
