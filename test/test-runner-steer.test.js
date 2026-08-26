import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectRepoRunner, runnerMismatchSteer } from "../src/logic/test-runner-steer.js";

// SWE-bench v1 forensics (2026-08-15): agents told (or guessing) `pytest` on
// django went 0/3 with blind patches — the repo's real runner is
// tests/runtests.py and nothing in the harness said so. The steer detects the
// mismatch from the repo's own layout plus the failure's signature and
// delivers the fact, pipe-guard style.

function ws(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-steer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  return dir;
}

test("detects django-style, sympy-style, and pytest-style repos", (t) => {
  assert.equal(detectRepoRunner(ws(t, { "tests/runtests.py": "#!" })).kind, "django-runtests");
  assert.equal(detectRepoRunner(ws(t, { "bin/test": "#!" })).kind, "sympy-bintest");
  assert.equal(detectRepoRunner(ws(t, { "pytest.ini": "[pytest]" })).kind, "pytest");
  assert.equal(detectRepoRunner(ws(t, { "README.md": "x" })).kind, "unknown");
});

test("steers a failing pytest invocation on a runtests.py repo", (t) => {
  const dir = ws(t, { "tests/runtests.py": "#!" });
  const msg = runnerMismatchSteer({
    command: "python -m pytest tests/auth_tests -x -q",
    observation: "E   django.core.exceptions.ImproperlyConfigured: Requested setting INSTALLED_APPS...",
    exitCode: 1,
    workspace: dir,
    priorSteers: 0,
  });
  assert.ok(msg, "must steer");
  assert.match(msg, /\[test-runner\]/);
  assert.match(msg, /tests\/runtests\.py/);
});

test("silent when the runner matches, the run passed, or the cap is reached", (t) => {
  const django = ws(t, { "tests/runtests.py": "#!" });
  const pytestRepo = ws(t, { "pytest.ini": "[pytest]" });
  assert.equal(runnerMismatchSteer({
    command: "python tests/runtests.py auth_tests", observation: "ERROR: something else",
    exitCode: 1, workspace: django, priorSteers: 0 }), null, "right runner already");
  assert.equal(runnerMismatchSteer({
    command: "python -m pytest tests/x.py", observation: "no tests ran",
    exitCode: 1, workspace: pytestRepo, priorSteers: 0 }), null, "pytest repo keeps pytest");
  assert.equal(runnerMismatchSteer({
    command: "python -m pytest tests/x.py", observation: "1 passed",
    exitCode: 0, workspace: django, priorSteers: 0 }), null, "success is never steered");
  assert.equal(runnerMismatchSteer({
    command: "python -m pytest t", observation: "ImproperlyConfigured",
    exitCode: 1, workspace: django, priorSteers: 2 }), null, "capped at 2");
});

test("kill switch disables the steer", (t) => {
  const dir = ws(t, { "tests/runtests.py": "#!" });
  assert.equal(runnerMismatchSteer({
    command: "python -m pytest tests", observation: "ImproperlyConfigured", exitCode: 1,
    workspace: dir, priorSteers: 0, env: { BANTAM_RUNNER_STEER: "0" } }), null);
});
