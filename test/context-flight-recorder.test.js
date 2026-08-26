import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextFlightRecorder,
  inspectDecisionContext,
} from "../src/context-flight-recorder.js";

function prompt({ observation = "", openFiles = "", guidance = "" } = {}) {
  return "<|im_start|>system\nrules\n<|im_end|>\n"
    + "<|im_start|>user\nTask: fix it\n<|im_end|>\n"
    + (observation ? `<|im_start|>user\n<observation>\n${observation}\n</observation>\n<|im_end|>\n` : "")
    + (guidance ? `<|im_start|>user\n${guidance}\n<|im_end|>\n` : "")
    + (openFiles ? `<|im_start|>user\n<open_files>\n${openFiles}\n</open_files>\n<|im_end|>\n` : "")
    + "<|im_start|>assistant\n";
}

function calls(prompts) {
  return prompts.map((value, index) => ({
    index,
    request: { body: JSON.stringify({ prompt: value }) },
  }));
}

test("decision context inventories complete and partial source plus harness guidance", () => {
  const context = inspectDecisionContext(prompt({
    guidance: "[state-audit] prove publication ordering\n[edit-recovery] use current bytes\n[root] is a task label",
    openFiles: "# src/a.js (current, 2 lines)\n1\tone\n2\ttwo\n\n"
      + "# src/b.js (current, 90 lines)\n1\tone\n… (89 more lines omitted — read_file a specific range)",
  }));

  assert.equal(context.available, true);
  assert.deepEqual(context.guidanceTags, ["edit-recovery", "state-audit"]);
  // omittedRanges records what each entry CLAIMED it lacks, which is what makes
  // a panel-self-contradiction risk auditable from the artifact afterwards.
  // Neither entry here uses the "… (lines X–Y omitted)" range form: a.js is
  // complete and b.js carries only the trailing "N more lines" summary.
  assert.deepEqual(context.openFiles, [
    { path: "src/a.js", totalLines: 2, status: "complete", partialMarkers: [], shownRanges: [[1, 2]], omittedRanges: [] },
    { path: "src/b.js", totalLines: 90, status: "partial", partialMarkers: ["more-lines-omitted"], shownRanges: [[1, 1]], omittedRanges: [] },
  ]);
});

test("flight recorder catches missing failure evidence and absent failed-edit recovery source", () => {
  const first = prompt();
  const second = prompt({
    observation: "ERROR: old text did not match",
    guidance: "[edit-recovery] copy current source",
  });
  const recorder = buildContextFlightRecorder({
    turns: [
      {
        i: 0,
        modelCallIndex: 0,
        parsedAction: { a: "replace", p: "src/a.js", old: "x", new: "y" },
        editApplied: false,
        observation: "ERROR: old text did not match\nAssertionError: expected 2 actual 1",
      },
      {
        i: 1,
        modelCallIndex: 1,
        parsedAction: { a: "read_file", p: "src/a.js" },
        observation: "source",
      },
    ],
    modelCalls: calls([first, second]),
  });

  assert.equal(recorder.status, "findings");
  assert.equal(recorder.decisions[1].priorOutcome.decisiveEvidence.lines, 2);
  assert.equal(recorder.decisions[1].priorOutcome.decisiveEvidence.missingLines, 1);
  assert.deepEqual(recorder.decisions[1].risks.map((item) => item.code), [
    "prior-decisive-evidence-missing",
    "failed-edit-target-absent",
  ]);
  assert.equal(recorder.summary.risks["failed-edit-target-absent"], 1);
});

test("flight recorder links raw transforms and edit residency to exact call indices", () => {
  const second = prompt({
    observation: "exit 1\nnot ok 1 - broke\nAssertionError: expected 2 actual 1",
    openFiles: "# src/a.js (current, 50 lines)\n1\tbroken\n… (49 more lines omitted — read_file a specific range)",
  });
  const recorder = buildContextFlightRecorder({
    turns: [
      {
        i: 4,
        modelCallIndex: 7,
        parsedAction: { a: "shell", c: "npm test" },
        rawObservation: "exit 1\nnot ok 1 - broke\nAssertionError: expected 2 actual 1\nERROR: raw-only detail",
        observation: "exit 1\nnot ok 1 - broke\nAssertionError: expected 2 actual 1",
      },
      {
        i: 5,
        modelCallIndex: 9,
        parsedAction: { a: "edit_lines", p: "src/a.js", start: 20, end: 20, content: "fixed" },
        observation: "updated",
      },
    ],
    modelCalls: [
      { index: 7, request: { prompt: prompt() } },
      { index: 8, request: { prompt: "auxiliary" } },
      { index: 9, request: { prompt: second } },
    ],
  });

  const decision = recorder.decisions[1];
  assert.equal(decision.modelCallIndex, 9);
  assert.equal(decision.targets[0].status, "partial");
  assert.equal(decision.priorOutcome.transform.changed, true);
  assert.equal(decision.priorOutcome.transform.decisiveLinesDropped, 1);
  assert.deepEqual(decision.risks.map((item) => item.code), [
    "edit-target-partial",
    "observation-transform-dropped-evidence",
  ]);
});

test("passing test names and assertion source are not misclassified as lost failure evidence", () => {
  const green = "ok 19 - a task's synchronous throw surfaces as a rejected promise\n"
    + "343\t  assert.doesNotThrow(() => new Pool());\n# fail 0\nexit 0";
  const recorder = buildContextFlightRecorder({
    turns: [
      { i: 0, modelCallIndex: 0, parsedAction: { a: "shell", c: "npm test" }, observation: green },
      { i: 1, modelCallIndex: 1, parsedAction: { a: "done" }, observation: "done" },
    ],
    modelCalls: calls([prompt(), prompt({ observation: "green summary" })]),
  });

  assert.equal(recorder.decisions[1].priorOutcome.decisiveEvidence.lines, 0);
  assert.equal(recorder.decisions[1].risks.length, 0);
});

test("workspace path redaction is recorded as a transform without claiming evidence loss", () => {
  const raw = "exit 1\n✗ skips dependents (/tmp/bantam-eval-Ab12/test/public.test.js:58)";
  const delivered = "exit 1\n✗ skips dependents (<workspace>/test/public.test.js:58)";
  const recorder = buildContextFlightRecorder({
    turns: [
      { i: 0, modelCallIndex: 0, parsedAction: { a: "shell", c: "npm test" }, rawObservation: raw, observation: delivered },
      { i: 1, modelCallIndex: 1, parsedAction: { a: "read_file", p: "src/a.js" }, observation: "source" },
    ],
    modelCalls: calls([prompt(), prompt({ observation: delivered })]),
  });

  assert.equal(recorder.decisions[1].priorOutcome.transform.changed, true);
  assert.equal(recorder.decisions[1].priorOutcome.transform.decisiveLinesDropped, 0);
  assert.equal(recorder.decisions[1].risks.length, 0);
});

test("flight recorder catches trusted verification lost at final prompt assembly", () => {
  const verification = "[auto-verify] controller ran the suite — PASS:\n# pass 10\n# fail 0";
  const recorder = buildContextFlightRecorder({
    turns: [
      {
        i: 0,
        modelCallIndex: 0,
        parsedAction: { a: "read_file", p: "src/a.js" },
        observation: `src/a.js (1 line):\n1\tcode\n${verification}`,
      },
      { i: 1, modelCallIndex: 1, parsedAction: { a: "done" }, observation: "done" },
    ],
    modelCalls: calls([prompt(), prompt({ observation: "[turn 1: src/a.js — earlier snapshot omitted]" })]),
  });

  assert.equal(recorder.decisions[1].priorOutcome.controllerEvidence.present, true);
  assert.equal(recorder.decisions[1].priorOutcome.controllerEvidence.missing, 1);
  assert.deepEqual(recorder.decisions[1].risks.map((item) => item.code), [
    "prior-controller-evidence-missing",
  ]);
  assert.equal(recorder.summary.priorControllerAnnotationsMissing, 1);
});
