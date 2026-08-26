import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureFixtureProvenance,
  fixtureEvaluatorRoot,
} from "../src/fixture-provenance.js";

test("fixture provenance changes with task, starting repository, or grader bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fixture-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureDir = path.join(root, "fixture");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(fixtureDir, "grader"), { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "source.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(fixtureDir, "grader", "contract.test.js"), "assert(value === 1);\n");
  const taskSpecBytes = Buffer.from('{"task":"Implement value one."}\n');

  const initial = captureFixtureProvenance({ fixtureDir, workspace, taskSpecBytes });
  assert.equal(fixtureEvaluatorRoot(initial), initial.evaluatorSha256);
  assert.equal(initial.repoFiles, 1);
  assert.equal(initial.graderFiles, 1);

  fs.writeFileSync(path.join(fixtureDir, "grader", "contract.test.js"), "assert(value >= 1);\n");
  const graderChanged = captureFixtureProvenance({ fixtureDir, workspace, taskSpecBytes });
  assert.notEqual(graderChanged.graderTreeSha256, initial.graderTreeSha256);
  assert.notEqual(graderChanged.evaluatorSha256, initial.evaluatorSha256);

  fs.writeFileSync(path.join(workspace, "source.js"), "export const value = 2;\n");
  const repoChanged = captureFixtureProvenance({ fixtureDir, workspace, taskSpecBytes });
  assert.notEqual(repoChanged.repoTreeSha256, graderChanged.repoTreeSha256);
  assert.notEqual(repoChanged.evaluatorSha256, graderChanged.evaluatorSha256);

  const taskChanged = captureFixtureProvenance({
    fixtureDir,
    workspace,
    taskSpecBytes: Buffer.from('{"task":"Implement value two."}\n'),
  });
  assert.notEqual(taskChanged.taskSpecSha256, repoChanged.taskSpecSha256);
  assert.notEqual(taskChanged.evaluatorSha256, repoChanged.evaluatorSha256);
});
