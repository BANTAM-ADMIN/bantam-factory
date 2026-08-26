import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareTeacherTrajectories,
  formatTrajectoryComparison,
} from "../src/trajectory-comparison.js";

function artifact(runId, modelId, {
  task = "Repair the parser.",
  pass = false,
  actions = [],
} = {}) {
  return {
    kind: "bantam-run",
    runId,
    modelId,
    task,
    result: { pass, status: pass ? "pass" : "fail" },
    turns: actions.map((action, i) => ({ i, parsedAction: action })),
  };
}

describe("deterministic teacher trajectory comparison", () => {
  it("records exact action, path, outcome, and completion divergence without causal claims", () => {
    const local = artifact("local-run", "qwen", {
      actions: [
        { a: "read_file", p: "src/parser.js" },
        { a: "replace", p: "src/parser.js" },
        { a: "done" },
      ],
    });
    const sol = artifact("sol-run", "gpt-5.6-sol", {
      pass: true,
      actions: [
        {
          a: "inspect",
          ops: [
            { a: "read_file", p: "src/parser.js" },
            { a: "read_file", p: "docs/spec.md" },
            { a: "read_file", p: "tmp/sk-secretsecretsecret12345.txt" },
          ],
        },
        { a: "read_file", p: "test/parser.test.js" },
        { a: "replace", p: "src/parser.js" },
        { a: "shell", c: "npm test" },
        { a: "done" },
      ],
    });
    const terra = artifact("terra-run", "gpt-5.6-terra", {
      pass: true,
      actions: [
        { a: "read_file", p: "src/parser.js" },
        { a: "read_file", p: "test/parser.test.js" },
        { a: "patch", p: "src/parser.js" },
        { a: "shell", c: "npm test" },
        { a: "done" },
      ],
    });

    const compared = compareTeacherTrajectories(local, [sol, terra]);

    assert.equal(compared.consensus.allReferencesPassedWhileLocalFailed, true);
    assert.deepEqual(compared.consensus.referenceOnlyReadPaths, ["test/parser.test.js"]);
    assert.deepEqual(compared.references[0].referenceOnly.readPaths, [
      "docs/spec.md",
      "test/parser.test.js",
      "tmp/[REDACTED].txt",
    ]);
    assert.deepEqual(compared.consensus.referenceOnlyActionKinds, ["shell"]);
    assert.equal(compared.references[0].firstActionDivergence.turn, 1);
    assert.match(compared.references[0].firstActionDivergence.reference, /^inspect\[/);
    assert.equal(compared.references[0].doneTurnDelta, 2);
    assert.equal(compared.references[0].verificationAttemptDelta, 1);
    assert.equal(Object.isFrozen(compared), true);
    assert.match(formatTrajectoryComparison(compared), /shared reference-only reads/);
    assert.match(compared.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(compared), /caused|cause/i);
    assert.doesNotMatch(JSON.stringify(compared), /secretsecret/);
  });

  it("rejects task-mismatched artifacts before producing evidence", () => {
    assert.throws(
      () => compareTeacherTrajectories(
        artifact("local", "qwen"),
        [artifact("sol", "gpt-5.6-sol", { task: "Different." })],
      ),
      /exact same task/,
    );
  });
});
