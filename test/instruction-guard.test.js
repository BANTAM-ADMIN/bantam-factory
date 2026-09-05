import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeInstructionGuards } from "../src/instruction-guard.js";
import { createShellScopeGuard, immutableEditReason } from "../src/scope-guard.js";
import { evaluateDoneGates } from "../src/done-gates.js";
import { extractImmutable, immutableViolations } from "../src/logic/self-check.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-instruction-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "keep.txt"), "original");
  fs.writeFileSync(path.join(root, "source.txt"), "old source");
  return root;
}

test("explicit prohibition blocks direct writes forever and composes supplied policy", (t) => {
  const workspace = fixture(t);
  const prior = (p) => p === "runner.json" ? "runner-config" : null;
  const guards = composeInstructionGuards({ workspace, instruction: "Change source.txt. Do not modify keep.txt.", editGuard: prior });
  for (let retry = 0; retry < 10; retry++) {
    assert.equal(guards.editGuard("keep.txt"), "instruction-forbidden");
    assert.equal(guards.editGuard("./keep.txt"), "instruction-forbidden");
  }
  assert.equal(guards.editGuard("source.txt"), null);
  assert.equal(guards.editGuard("runner.json"), "runner-config");
});

test("prohibitions follow canonical paths, absolute names, and symlink aliases", (t) => {
  const workspace = fixture(t);
  fs.symlinkSync("keep.txt", path.join(workspace, "alias.txt"));
  const { editGuard } = composeInstructionGuards({ workspace, instruction: `Do not modify '${workspace}/keep.txt'.` });
  assert.equal(editGuard("a/../keep.txt"), "instruction-forbidden");
  assert.equal(editGuard("alias.txt"), "instruction-forbidden");
  assert.equal(editGuard("source.txt"), null);
});

test("shell rollback restores forbidden bytes and modes while keeping legitimate edits", (t) => {
  const workspace = fixture(t);
  const { shellScopeGuard } = composeInstructionGuards({ workspace, instruction: "Change source.txt. Do not modify keep.txt." });
  const before = shellScopeGuard.capture();
  const mode = fs.statSync(path.join(workspace, "keep.txt")).mode & 0o777;
  fs.writeFileSync(path.join(workspace, "keep.txt"), "forbidden");
  fs.chmodSync(path.join(workspace, "keep.txt"), 0o700);
  fs.writeFileSync(path.join(workspace, "source.txt"), "legitimate");
  const result = shellScopeGuard.rollback(before);
  assert.equal(result.clean, true);
  assert.deepEqual(result.violations.map((v) => v.path), ["keep.txt"]);
  assert.equal(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8"), "original");
  assert.equal(fs.statSync(path.join(workspace, "keep.txt")).mode & 0o777, mode);
  assert.equal(fs.readFileSync(path.join(workspace, "source.txt"), "utf8"), "legitimate");
});

test("exclusive edit scope rejects and restores newly created out-of-scope files", (t) => {
  const workspace = fixture(t);
  const { editGuard, shellScopeGuard } = composeInstructionGuards({ workspace, instruction: "Only edit source.txt." });
  assert.equal(editGuard("new.txt"), "instruction-forbidden");
  assert.equal(editGuard("source.txt"), null);
  const before = shellScopeGuard.capture();
  fs.writeFileSync(path.join(workspace, "new.txt"), "forbidden");
  fs.writeFileSync(path.join(workspace, "source.txt"), "legitimate");
  assert.equal(shellScopeGuard.rollback(before).clean, true);
  assert.equal(fs.existsSync(path.join(workspace, "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "source.txt"), "utf8"), "legitimate");
});

test("instruction shell policy preserves existing fixture protections", (t) => {
  const workspace = fixture(t);
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "test", "a.test.js"), "original test");
  const spec = {};
  const { editGuard, shellScopeGuard } = composeInstructionGuards({
    workspace, instruction: "Do not modify keep.txt.",
    editGuard: (p) => immutableEditReason(p, spec), shellScopeGuard: createShellScopeGuard(workspace, spec),
  });
  assert.equal(editGuard("test/a.test.js"), "grader");
  const before = shellScopeGuard.capture();
  fs.writeFileSync(path.join(workspace, "keep.txt"), "forbidden");
  fs.writeFileSync(path.join(workspace, "test", "a.test.js"), "changed test");
  const result = shellScopeGuard.rollback(before);
  assert.equal(result.clean, true);
  assert.deepEqual(result.violations.map((v) => v.path).sort(), ["keep.txt", "test/a.test.js"]);
  assert.equal(fs.readFileSync(path.join(workspace, "test", "a.test.js"), "utf8"), "original test");
});

test("immutable done gate cannot be exhausted by repeating done", (t) => {
  const workspace = fixture(t), task = "Do not modify keep.txt.";
  const immutableInv = extractImmutable(task);
  const immutableSnap = immutableViolations.snapshot(workspace, immutableInv);
  fs.writeFileSync(path.join(workspace, "keep.txt"), "changed");
  const ctx = { workspace, task, immutableInv, immutableSnap, interactive: true, turns: [], count: () => 99, policy: { immutable_file: { interactive: "block", autonomous: "block" } } };
  assert.equal(evaluateDoneGates(ctx)?.gate, "immutable_file");
});

test("restoring a protected file cannot write through a replaced parent symlink", (t) => {
  const workspace = fixture(t), outside = fixture(t);
  fs.mkdirSync(path.join(workspace, "protected"));
  fs.writeFileSync(path.join(workspace, "protected", "keep.txt"), "protected original");
  const { shellScopeGuard } = composeInstructionGuards({ workspace, instruction: "Do not modify protected/keep.txt." });
  const before = shellScopeGuard.capture();
  fs.rmSync(path.join(workspace, "protected"), { recursive: true });
  fs.symlinkSync(outside, path.join(workspace, "protected"));
  const result = shellScopeGuard.rollback(before);
  assert.equal(result.clean, true);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(workspace, "protected", "keep.txt"), "utf8"), "protected original");
});
