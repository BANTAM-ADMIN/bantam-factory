import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";

// SWE-bench Verified, django__django-15128 (2026-08-17, repaired harness):
// the agent applied EIGHT successful edits to django/db/models/sql/query.py
// across 40 turns — every one observed "replaced 1 occurrence" — then ran
//
//   git checkout django/db/models/sql/query.py
//
// two actions from the end. The instance was graded "empty patch": 474 seconds
// of work, zero bytes delivered. Nothing in the harness objected, because every
// other shell guard is about reading, piping, or leaving the workspace — none
// was about deleting the answer.
//
// A run's product is its working tree, and git offers no undo for a discard.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-git-guard-"));
  fs.writeFileSync(path.join(dir, "a.py"), "x = 1\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const refused = (result) => /discards uncommitted changes/.test(String(result?.observation ?? ""));

test("commands that throw away uncommitted work are refused", async (t) => {
  const executor = new Executor(workspace(t), { shellSandbox: "host" });
  for (const command of [
    "git checkout django/db/models/sql/query.py",
    "git checkout -- src/agent.js",
    "git restore src/a.js",
    "git reset --hard HEAD",
    "git clean -fd",
    "git stash",
  ]) {
    assert.ok(refused(await executor.execute({ a: "shell", c: command })), `${command} must be refused`);
  }
});

test("the refusal names a reversible alternative", async (t) => {
  const executor = new Executor(workspace(t), { shellSandbox: "host" });
  const result = await executor.execute({ a: "shell", c: "git checkout a.py" });
  assert.match(String(result.observation), /edit the text back with `replace`/);
  assert.match(String(result.observation), /`git diff` is fine/);
});

test("read-only and non-destructive git still runs", async (t) => {
  const executor = new Executor(workspace(t), { shellSandbox: "host" });
  for (const command of ["git diff a.py", "git status --short", "git stash list", "git checkout -b feature"]) {
    assert.ok(!refused(await executor.execute({ a: "shell", c: command })), `${command} must be allowed`);
  }
});

test("the guard does not fire on unrelated commands", async (t) => {
  const executor = new Executor(workspace(t), { shellSandbox: "host" });
  for (const command of ["echo git checkout is a thing", "python3 -c \"print(1)\""]) {
    const result = await executor.execute({ a: "shell", c: command });
    assert.ok(!refused(result), `${command} must be allowed`);
  }
});
