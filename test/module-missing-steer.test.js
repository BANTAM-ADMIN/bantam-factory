import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Executor } from "../src/executor.js";

// TB2 sweep 2026-08-21. raman-fitting reached for scipy to fit two Raman peaks,
// got `ModuleNotFoundError: No module named 'scipy'`, never tried to install it,
// and hand-rolled a grid search — producing a well-formed results.json with
// WRONG values. That is the worst failure shape there is: a numeric grader fails
// it while every surface signal says success. largest-eigenval reached for scipy
// too, and it is one of the standing reds.
//
// The pre-existing tool-missing steer covers a missing INTERPRETER and tells the
// model to use what it has. For a missing LIBRARY that advice is exactly
// inverted: the substitute you write yourself IS the defect.

function mkExec(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-mod-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return new Executor(ws);
}

// Drive the real observation path with the interpreter's own error text, so the
// test does not depend on which packages happen to be installed on this host.
async function shell(t, stderrLine) {
  const { observation } = await mkExec(t).execute({ a: "shell", c: `echo "${stderrLine}"` });
  return observation;
}

test("a missing module earns the install command", async (t) => {
  const out = await shell(t, "ModuleNotFoundError: No module named 'scipy'");
  assert.match(out, /\[module-missing\]/, out.slice(0, 300));
  assert.match(out, /pip install scipy/);
});

test("it warns against the hand-rolled substitute, which is the real defect", async (t) => {
  const out = await shell(t, "ModuleNotFoundError: No module named 'scipy'");
  assert.match(out, /Do NOT hand-roll/i);
  assert.match(out, /plausible, well-formed output/i, "name the failure shape, not just the rule");
});

test("import name and package name are reconciled when they differ", async (t) => {
  const out = await shell(t, "ModuleNotFoundError: No module named 'cv2'");
  assert.match(out, /pip install opencv-python-headless/);
  assert.match(out, /the import is/, "say why the two names differ");
});

test("a submodule import reports its top-level package", async (t) => {
  const out = await shell(t, "ModuleNotFoundError: No module named 'scipy.optimize'");
  assert.match(out, /pip install scipy/, "scipy.optimize -> scipy");
});

test("no steer when imports succeed", async (t) => {
  const out = await shell(t, "fine");
  assert.doesNotMatch(out, /\[module-missing\]/);
});

test("an unrelated failure does not trip it", async (t) => {
  const out = await shell(t, "ValueError: nope");
  assert.doesNotMatch(out, /\[module-missing\]/);
});
