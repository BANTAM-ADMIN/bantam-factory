import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { scopeRollbackEnabled } from "../src/fixture-runner.js";

// The evaluation scope transaction refuses direct edits to files the fixture
// declares immutable, and rolls back shell mutations to the same paths. It was
// opt-in behind BANTAM_EVAL_SCOPE_ROLLBACK, so every run without that variable had
// DETECTION (post-verify integrity) but no PREVENTION -- the harness noticed a
// modified test only after grading against it.
//
// Measured across 53 recorded fixture runs: exactly ONE out-of-scope edit was
// attempted, and it was refused. Prevention therefore costs essentially nothing
// in refusals while providing a guarantee bare `codex exec` cannot: the graded
// tests are provably the ones the fixture shipped.
//
// This is the detection-to-prevention step in the poka-yoke hierarchy, and the
// reason it can be taken now is that the direct-edit gate is paired with the shell
// transaction. Enabling the gate ALONE was measured worse on 2026-07-26: a refused
// test write was rerouted into a truncated shell heredoc, which is why the two are
// armed together or not at all.

const source = fs.readFileSync(new URL("../src/fixture-runner.js", import.meta.url), "utf8");

describe("evaluation scope guarding", () => {
  it("is on when the variable is unset", () => {
    assert.equal(scopeRollbackEnabled(undefined), true);
    assert.equal(scopeRollbackEnabled(""), true);
  });

  it("stays on for any affirmative value", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      assert.equal(scopeRollbackEnabled(value), true, `${value} should keep guarding on`);
    }
  });

  // Escapable on purpose: a fixture that legitimately needs to rewrite its own
  // tests has to be able to say so, and silently unguardable is worse than opt-out.
  it("can be turned off explicitly", () => {
    for (const value of ["0", "false", "no", "off"]) {
      assert.equal(scopeRollbackEnabled(value), false, `${value} should disable guarding`);
    }
  });

  it("never arms the direct-edit gate without the paired shell transaction", () => {
    const editGuard = /editGuard:\s*(\w+)/.exec(source);
    const shellGuard = /shellScopeGuard:\s*(\w+)/.exec(source);
    assert.ok(editGuard && shellGuard, "both guards must be wired");
    assert.equal(editGuard[1], shellGuard[1],
      "both guards must be controlled by the same flag; the edit gate alone reroutes "
      + "a refused write into a shell heredoc");
  });
});
