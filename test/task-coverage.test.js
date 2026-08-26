import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  taskCoverageScope,
  taskCoverageObjection,
} from "../src/logic/task-coverage.js";
import { runAgent } from "../src/agent.js";

function scriptedPromptModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    requestCursor() {
      return this.prompts.length;
    },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return {
        content: outputs.shift(),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}

function widgetWorkspace(t, files = ["alpha.js", "beta.js", "gamma.js", "delta.js"]) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-coverage-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src", "widgets"), { recursive: true });
  for (const name of files) {
    fs.writeFileSync(path.join(workspace, "src", "widgets", name), `export const x = "${name}";\n`);
  }
  return workspace;
}

test("taskCoverageScope derives the module set from a universally quantified directory", (t) => {
  const workspace = widgetWorkspace(t);
  const scope = taskCoverageScope(
    "Complete the normalization migration across every module in src/widgets.",
    workspace,
  );
  assert.ok(scope, "quantifier + existing directory must yield a scope");
  assert.equal(scope.dir, "src/widgets");
  assert.deepEqual(scope.files, [
    "src/widgets/alpha.js",
    "src/widgets/beta.js",
    "src/widgets/delta.js",
    "src/widgets/gamma.js",
  ].sort());
});

test("taskCoverageScope stays out of tasks that never quantify a directory", (t) => {
  const workspace = widgetWorkspace(t);
  assert.equal(taskCoverageScope("Fix the bug in src/widgets/alpha.js.", workspace), null);
  assert.equal(taskCoverageScope("Improve error handling everywhere.", workspace), null);
  // Too few files to be a breadth task.
  const tiny = widgetWorkspace(t, ["only.js", "pair.js"]);
  assert.equal(
    taskCoverageScope("Update every module in src/widgets.", tiny),
    null,
  );
});

test("the coverage gate bounces an early done once, then lets the run finish", async (t) => {
  const workspace = widgetWorkspace(t);
  const prior = process.env.BANTAM_TASK_COVERAGE;
  process.env.BANTAM_TASK_COVERAGE = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.BANTAM_TASK_COVERAGE;
    else process.env.BANTAM_TASK_COVERAGE = prior;
  });

  const model = scriptedPromptModel([
    JSON.stringify({ a: "write_file", p: "src/widgets/alpha.js", content: "export const x = 1;\n" }),
    JSON.stringify({ a: "read_file", p: "src/widgets/beta.js" }),
    JSON.stringify({ a: "done", summary: "Updated the widgets." }),
    JSON.stringify({ a: "done", summary: "Updated the widgets." }),
  ]);

  const events = [];
  const result = await runAgent({
    task: "Normalize the exports of every module in src/widgets.",
    workspace,
    model,
    maxTurns: 6,
    interactive: false,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (event) => events.push(event),
  });

  const rejection = events.find((event) => event.type === "done_rejected" && event.gate === "task_coverage");
  assert.ok(rejection, "the first done must bounce on unexamined in-scope modules");
  assert.match(rejection.reason, /gamma\.js/);
  assert.match(rejection.reason, /delta\.js/);
  assert.equal(result.done, true, "the single-bounce bound must let the second done finish");
  assert.equal(result.metrics.taskCoverageRejections, 1);
});

test("taskCoverageObjection names exactly the unexamined modules, once", (t) => {
  const workspace = widgetWorkspace(t);
  const scope = taskCoverageScope("Update every module in src/widgets.", workspace);
  const turns = [
    { action: { a: "read_file", p: "src/widgets/alpha.js" }, observation: "…" },
    {
      action: { a: "replace", p: "src/widgets/beta.js", old: "x", new: "y" },
      observation: "replaced",
      editApplied: true,
    },
  ];

  const objection = taskCoverageObjection(scope, turns, 0, {});
  assert.ok(objection, "two unexamined modules must object");
  assert.match(objection, /gamma\.js/);
  assert.match(objection, /delta\.js/);
  assert.doesNotMatch(objection, /alpha\.js.*never/);

  // Panel-resident files count as examined.
  const withPanel = taskCoverageObjection(scope, turns, 0, {
    panelComplete: new Set(["src/widgets/gamma.js", "src/widgets/delta.js"]),
  });
  assert.equal(withPanel, null);

  // One bounce per run: a second done proceeds.
  assert.equal(taskCoverageObjection(scope, turns, 1, {}), null);

  // Full coverage: no objection.
  const covered = [
    ...turns,
    { action: { a: "inspect", ops: [
      { a: "read_file", p: "src/widgets/gamma.js" },
      { a: "read_file", p: "src/widgets/delta.js" },
    ] }, observation: "…" },
  ];
  assert.equal(taskCoverageObjection(scope, covered, 0, {}), null);
});
