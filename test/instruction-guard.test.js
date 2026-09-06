import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeInstructionGuards } from "../src/instruction-guard.js";
import { createShellScopeGuard, immutableEditReason } from "../src/scope-guard.js";
import { evaluateDoneGates } from "../src/done-gates.js";
import { extractImmutable, immutableViolations } from "../src/logic/self-check.js";
import { editScopeRefusal } from "../src/agent.js";

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

const existingTestsInstruction = "Do not add third-party dependencies or modify `package.json` or existing public tests. You may add tests.";
function testFixture(t) {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "test"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, "test", "base.test.js"), "// supplied assertions\n");
  fs.writeFileSync(path.join(root, "src", "local.spec.js"), "// supplied colocated assertions\n");
  return root;
}

test("public coordinated prohibition names package.json and the existing-tests class", () => {
  const inv = extractImmutable(existingTestsInstruction);
  assert.equal(inv.mode, "forbid");assert.deepEqual(inv.forbidden, ["package.json"]);
  assert.equal(inv.preserveExistingTests, true);
  for (const instruction of ["Do not modify existing tests. You may add new tests.",
    "You must not change the supplied test files.", "Do not add dependencies, alter package.json, or modify provided public tests."]) {
    assert.equal(extractImmutable(instruction).preserveExistingTests, true, instruction);
  }
  for (const instruction of ["Existing public tests should pass. Add tests as needed.",
    "You may modify existing public tests.", "Do not assume existing tests are correct.",
    "Do not add dependencies, but modify existing tests and package.json.",
    "Do not modify package.json. Existing public tests may be expanded."]) {
    assert.notEqual(extractImmutable(instruction).preserveExistingTests, true, instruction);
  }
});

test("purpose mentions do not make tests forbidden objects, and explicit test exceptions stay editable", t => {
  const workspace = testFixture(t);
  const purpose = composeInstructionGuards({ workspace,
    instruction: "Do not modify source.txt to satisfy existing public tests. You may add or edit tests." });
  assert.equal(purpose.editGuard("source.txt"), "instruction-forbidden");
  assert.equal(purpose.editGuard("test/base.test.js"), null);
  for (const named of ["test/base.test.js", "`test/base.test.js`"]) {
    const guards = composeInstructionGuards({ workspace,
      instruction: `Do not modify existing public tests except ${named}. You may add tests.` });
    assert.equal(guards.editGuard("test/base.test.js"), null);
    assert.equal(guards.editGuard("src/local.spec.js"), "instruction-forbidden");
    assert.equal(guards.editGuard("test/new.test.js"), null);
    assert.ok(!guards.protectedExistingTests.includes("test/base.test.js"));
    assert.ok(guards.protectedExistingTests.includes("src/local.spec.js"));
  }
  const guarded = composeInstructionGuards({ workspace,
    instruction: "Do not modify existing public tests except `test/base.test.js`. Do not modify `test/base.test.js`.",
    editGuard: name => name === "src/local.spec.js" ? "caller-protected" : null });
  assert.equal(guarded.editGuard("test/base.test.js"), "instruction-forbidden");
});

test("same-task frozen checkpoints preserve original paths and reject malformed authority", t => {
  const workspace = testFixture(t), instruction = "Do not modify existing public tests. You may add tests.";
  const first = composeInstructionGuards({ workspace, instruction });
  fs.writeFileSync(path.join(workspace, "test/new.test.js"), "// worker test\n");
  const resumed = composeInstructionGuards({ workspace, instruction, frozenTests: JSON.parse(JSON.stringify(first.frozenTestCheckpoint)),
    editGuard: name => name === "test/new.test.js" ? "caller-protected" : null });
  assert.equal(resumed.editGuard("test/new.test.js"), "caller-protected");
  assert.equal(resumed.editGuard("test/base.test.js"), "instruction-forbidden");
  assert.ok(!resumed.protectedExistingTests.includes("test/new.test.js"));
  const changedTask = composeInstructionGuards({ workspace, instruction: instruction + " Continue with a new task.",
    frozenTests: first.frozenTestCheckpoint });
  assert.ok(changedTask.protectedExistingTests.includes("test/new.test.js"));
  for (const bad of ["../outside.test.js", "/tmp/outside.test.js", "test/../base.test.js", "__proto__", "test\\base.test.js"]) {
    assert.throws(() => composeInstructionGuards({ workspace, instruction,
      frozenTests: { ...first.frozenTestCheckpoint, existingTests: [bad], hashes: {} } }), /invalid same-task/);
  }
  assert.throws(() => composeInstructionGuards({ workspace, instruction,
    frozenTests: { ...first.frozenTestCheckpoint, hashes: {} } }), /checkpoint hashes/);
});

test("class-only immutable done authority hashes exact frozen paths and detects changed supplied tests", t => {
  const workspace = testFixture(t);
  const { invariants, frozenTestCheckpoint } = composeInstructionGuards({ workspace,
    instruction: "Do not modify existing public tests. You may add tests." });
  const snap = immutableViolations.snapshot(workspace, invariants);
  assert.deepEqual(Object.keys(snap.hashes).sort(), ["src/local.spec.js", "test/base.test.js"]);
  assert.deepEqual(snap.hashes, frozenTestCheckpoint.hashes);
  fs.writeFileSync(path.join(workspace, "test/new.test.js"), "// allowed\n");
  assert.deepEqual(immutableViolations(workspace, invariants, snap), []);
  fs.writeFileSync(path.join(workspace, "test/base.test.js"), "// changed supplied bytes\n");
  assert.equal(immutableViolations(workspace, invariants, snap).length, 1);
  const ctx = { workspace, task: "Do not modify existing public tests.", immutableInv: invariants, immutableSnap: snap,
    interactive: true, turns: [], count: () => 99, policy: { immutable_file: { interactive: "block", autonomous: "block" } } };
  assert.equal(evaluateDoneGates(ctx)?.gate, "immutable_file");
});

test("frozen immutable hashes cover deep files and symlink aliases without false deletion claims", t => {
  const workspace = testFixture(t), directory = "test/a/b/c/d/e/f/g";
  fs.mkdirSync(path.join(workspace, directory), { recursive: true });
  fs.writeFileSync(path.join(workspace, directory, "deep.test.js"), "// deep\n");
  fs.symlinkSync("test", path.join(workspace, "tests"));
  const instruction = "Do not modify existing public tests. You may add tests.";
  const guards = composeInstructionGuards({ workspace, instruction });
  const snap = immutableViolations.snapshot(workspace, guards.invariants);
  assert.deepEqual(immutableViolations(workspace, guards.invariants, snap), []);
  assert.doesNotThrow(() => composeInstructionGuards({ workspace, instruction,
    frozenTests: JSON.parse(JSON.stringify(guards.frozenTestCheckpoint)) }));
  fs.writeFileSync(path.join(workspace, directory, "deep.test.js"), "// changed\n");
  assert.ok(immutableViolations(workspace, guards.invariants, snap).some(row => row.includes("deep.test.js")));
});

test("existing test paths are frozen once while new test files and same-basename files stay editable", t => {
  const workspace = testFixture(t);
  const { editGuard, invariants, protectedExistingTests } = composeInstructionGuards({ workspace, instruction: existingTestsInstruction });
  assert.deepEqual(invariants.existingTests, ["src/local.spec.js", "test/base.test.js"]);
  assert.deepEqual(protectedExistingTests, ["src/local.spec.js", "test/base.test.js"]);
  for (const file of ["package.json", "test/base.test.js", "src/local.spec.js", "test", "src"]) assert.equal(editGuard(file), "instruction-forbidden", file);
  for (const file of ["test/additional.test.js", "new/base.test.js", "src/impl.js"]) assert.equal(editGuard(file), null, file);
  fs.writeFileSync(path.join(workspace, "test", "additional.test.js"), "// new assertions\n");
  assert.equal(editGuard("test/additional.test.js"), null, "a newly added test does not become immutable later in the same invocation");
  assert.equal(composeInstructionGuards({ workspace, instruction: "You may add or edit tests." }).editGuard, null);
});

test("existing-test policy ignores dependency caches and does not read their test contents", t => {
  const workspace = testFixture(t);
  fs.mkdirSync(path.join(workspace, "node_modules", "dep", "test"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "node_modules", "dep", "test", "vendor.test.js"), "// dependency\n");
  const { editGuard, invariants } = composeInstructionGuards({ workspace, instruction: "Do not modify existing tests. You may add tests." });
  assert.ok(!invariants.existingTests.some(p => p.startsWith("node_modules/")));
  assert.equal(editGuard("node_modules/dep/test/vendor.test.js"), null);
});

test("test protection follows file and directory aliases without freezing new children", t => {
  const workspace = testFixture(t);
  fs.symlinkSync("test/base.test.js", path.join(workspace, "alias.js"));
  fs.writeFileSync(path.join(workspace, "src", "shared-fixture.js"), "// test target\n");
  fs.symlinkSync("../src/shared-fixture.js", path.join(workspace, "test", "linked.test.js"));
  fs.mkdirSync(path.join(workspace, "cases"));
  fs.writeFileSync(path.join(workspace, "cases", "plain.js"), "// supplied through alias\n");
  fs.symlinkSync("cases", path.join(workspace, "tests"));
  const { editGuard, protectedExistingTests } = composeInstructionGuards({ workspace, instruction: existingTestsInstruction });
  for (const file of ["alias.js", "test/linked.test.js", "src/shared-fixture.js", "tests/plain.js", "cases/plain.js"]) assert.equal(editGuard(file), "instruction-forbidden", file);
  assert.equal(editGuard("tests/new.test.js"), null);
  assert.equal(editGuard("cases/new.test.js"), null);
  assert.ok(!protectedExistingTests.includes("tests"), "do not mount an entire test directory read-only");
  assert.ok(protectedExistingTests.includes("cases/plain.js"));
  assert.ok(protectedExistingTests.includes("tests/plain.js"));
  fs.symlinkSync("test/base.test.js", path.join(workspace, "later-alias.js"));
  assert.equal(editGuard("later-alias.js"), "instruction-forbidden");
});

test("a mixed edit batch and moves/deletion cannot modify an existing supplied test", t => {
  const workspace = testFixture(t);
  const { editGuard } = composeInstructionGuards({ workspace, instruction: existingTestsInstruction });
  for (const action of [{ a: "patch", edits: [{ p: "source.txt", content: "ok" }, { p: "test/base.test.js", content: "append" }] },
    { a: "move_file", from: "test/base.test.js", to: "test/new.test.js" },
    { a: "move_file", from: "test/new.test.js", to: "test/base.test.js" },
    { a: "delete_file", p: "test/base.test.js" }]) assert.match(editScopeRefusal(action, editGuard), /immutable/);
  assert.equal(editScopeRefusal({ a: "patch", edits: [{ p: "test/new.test.js", content: "allowed" }, { p: "source.txt", content: "ok" }] }, editGuard), null);
});

test("shell rollback restores only supplied tests and their permissions while retaining new tests", t => {
  const workspace = testFixture(t);
  const { shellScopeGuard } = composeInstructionGuards({ workspace, instruction: existingTestsInstruction });
  const before = shellScopeGuard.capture(), mode = fs.statSync(path.join(workspace, "test/base.test.js")).mode & 0o777;
  fs.appendFileSync(path.join(workspace, "test/base.test.js"), "// forbidden append\n");
  fs.chmodSync(path.join(workspace, "test/base.test.js"), 0o700);
  fs.unlinkSync(path.join(workspace, "src/local.spec.js"));
  fs.writeFileSync(path.join(workspace, "test/new.test.js"), "// legitimate new test\n");
  fs.writeFileSync(path.join(workspace, "source.txt"), "legitimate source");
  const result = shellScopeGuard.rollback(before);
  assert.equal(result.clean, true);
  assert.deepEqual(result.violations.map(v => v.path).sort(), ["src/local.spec.js", "test/base.test.js"]);
  assert.equal(fs.readFileSync(path.join(workspace, "test/base.test.js"), "utf8"), "// supplied assertions\n");
  assert.equal(fs.statSync(path.join(workspace, "test/base.test.js")).mode & 0o777, mode);
  assert.equal(fs.readFileSync(path.join(workspace, "test/new.test.js"), "utf8"), "// legitimate new test\n");
  assert.equal(fs.readFileSync(path.join(workspace, "source.txt"), "utf8"), "legitimate source");
});

test("supplied-test shell restoration does not write through a replaced directory symlink", t => {
  const workspace = testFixture(t), outside = testFixture(t);
  const { shellScopeGuard } = composeInstructionGuards({ workspace, instruction: existingTestsInstruction });
  const before = shellScopeGuard.capture();
  fs.rmSync(path.join(workspace, "test"), { recursive: true });
  fs.symlinkSync(path.join(outside, "test"), path.join(workspace, "test"));
  const result = shellScopeGuard.rollback(before);
  assert.equal(result.clean, true);
  assert.equal(fs.lstatSync(path.join(workspace, "test")).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(outside, "test/base.test.js"), "utf8"), "// supplied assertions\n");
});
