import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareTeacherTrajectories,
  deriveTrajectoryHypotheses,
  formatTrajectoryHypotheses,
} from "../src/trajectory-comparison.js";

function artifact(runId, modelId, pass, actions, task = "Repair the contract.") {
  return {
    kind: "bantam-run",
    runId,
    modelId,
    task,
    result: { pass, status: pass ? "pass" : "fail" },
    turns: actions.map((parsedAction) => ({ parsedAction })),
  };
}

describe("model-free trajectory candidate reduction", () => {
  it("emits bounded, hash-linked, falsifiable candidates for shared passing behavior", () => {
    const subject = artifact("subject", "local", false, [
      { a: "read_file", p: "src/a.js" },
      { a: "replace", p: "src/a.js" },
      { a: "done" },
    ]);
    const sol = artifact("sol", "gpt-5.6-sol", true, [
      { a: "read_file", p: "test/a.test.js" },
      { a: "replace", p: "src/a.js" },
      { a: "patch", p: "src/b.js" },
      { a: "shell", c: "npm test" },
      { a: "done" },
    ]);
    const terra = artifact("terra", "gpt-5.6-terra", true, [
      { a: "read_file", p: "test/a.test.js" },
      { a: "replace", p: "src/a.js" },
      { a: "patch", p: "src/b.js" },
      { a: "verify" },
      { a: "done" },
    ]);

    const comparison = compareTeacherTrajectories(subject, [sol, terra]);
    const result = deriveTrajectoryHypotheses(comparison);

    assert.equal(result.sourceComparisonSha256, comparison.sha256);
    assert.deepEqual(result.candidates.map((row) => row.id), [
      "verification-before-completion",
      "context-coverage-before-edit",
      "premature-completion-audit",
      "edit-scope-completeness",
    ]);
    assert.deepEqual(result.candidates[0].evidence.actionKinds, ["shell", "verify"]);
    assert.match(result.candidates[0].falsification, /Fresh paired tasks/);
    assert.match(result.candidates[0].thresholds.rollback, /regression/);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(result), true);
    assert.match(formatTrajectoryHypotheses(result), /Observable divergence/);
  });

  it("does not invent candidates without a failing-subject/passing-reference gap", () => {
    const left = artifact("left", "terra", true, [{ a: "done" }]);
    const right = artifact("right", "sol", true, [{ a: "done" }]);
    const result = deriveTrajectoryHypotheses(compareTeacherTrajectories(left, [right]));

    assert.deepEqual(result.candidates, []);
    assert.match(result.boundary, /no candidates emitted/i);
  });

  it("rejects unsafe candidate limits and mismatched tasks", () => {
    const failed = artifact("failed", "local", false, [{ a: "done" }]);
    const passed = artifact("passed", "sol", true, [{ a: "done" }]);
    const comparison = compareTeacherTrajectories(failed, [passed]);

    assert.throws(
      () => deriveTrajectoryHypotheses(comparison, { maxCandidates: 0 }),
      /integer from 1 to 12/,
    );
    assert.throws(
      () => compareTeacherTrajectories(
        failed,
        [artifact("other", "terra", true, [{ a: "done" }], "Other task.")],
      ),
      /exact same task/,
    );
  });
});
