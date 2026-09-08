import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { clipKeepingControllerAnnotation } from "../src/prompt.js";
import { OBS_MAX } from "../src/clip.js";
import { completionAuditHint } from "../src/completion-audit.js";
import { requirementChecklistSuffix } from "../src/requirement-checklist.js";

// ansi-wrap, 2026-09-08, four recorded attempts. The requirement checklist
// fired correctly on every run of every card and reached the model on none of
// them. It is appended to the completion audit, which is one annotation block
// of 7,669 characters; the clipper keeps a block's first 700 and replaces the
// rest, and the checklist begins 2,139 characters in. So the countermeasure
// built to quote a task's own requirements back at the model was computed,
// measured, extended twice, and deleted before it was ever read.
//
// The clipper's premise is stated in its own comment: a controller block's
// decisive content is at its HEAD and its tail is quoted tool output. That is
// true of a verification verdict. It is false of the completion audit, which
// is authored guidance throughout and puts the task-specific quotes last.

const TASK = fs.readFileSync(
  path.join(import.meta.dirname, "..", "examples", "fights",
    "factory-formats-2026-09-08", "ansi-wrap", "task.md"), "utf8");

/** The audit as the agent emits it: tool output, then the appended hint. */
function auditObservation(task = TASK) {
  const body = ["$ npm test", ...Array.from({ length: 40 },
    (_, i) => `ok ${i} - a passing tap line that is not worth keeping`)].join("\n");
  const hint = completionAuditHint({
    enabled: true,
    workspaceChanged: true,
    emitted: false,
    turn: {
      action: { a: "shell", c: "npm test" },
      observation: body,
      scopedVerify: { command: "npm test", status: "pass" },
      verificationEvidence: { status: "pass", exitCode: 0, counts: { failed: 0, total: 12 } },
      shellExecution: { command: "npm test", exitCode: 0 },
    },
    task,
    requirementChecklist: true,
  });
  assert.ok(hint, "the audit hint must fire for this fixture to mean anything");
  assert.match(hint, /explicitly names/, "the fixture must actually carry a checklist");
  return `${body}\n${hint}`;
}

test("the requirement checklist survives clipping", () => {
  const clipped = clipKeepingControllerAnnotation(auditObservation(), true);
  assert.match(clipped, /explicitly names/,
    "the checklist was deleted before the model could read it");
});

test("the quoted requirements themselves survive, not just the preamble", () => {
  const clipped = clipKeepingControllerAnnotation(auditObservation(), true);
  for (const quote of ["Invalid inputs throw an Error", "must not be dropped", "U+1100"]) {
    assert.ok(clipped.includes(quote), `lost the quote ${JSON.stringify(quote)}`);
  }
});

test("the largest checklist any published work order produces survives", () => {
  const kits = path.join(import.meta.dirname, "..", "examples", "fights");
  let worst = { chars: 0, task: TASK, card: "none" };
  for (const kit of fs.readdirSync(kits)) {
    const dir = path.join(kits, kit);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const card of fs.readdirSync(dir)) {
      const file = path.join(dir, card, "task.md");
      if (!fs.existsSync(file)) continue;
      const task = fs.readFileSync(file, "utf8");
      const chars = requirementChecklistSuffix(task).length;
      if (chars > worst.chars) worst = { chars, task, card };
    }
  }
  assert.ok(worst.chars > 0, "expected at least one work order to produce a checklist");
  const clipped = clipKeepingControllerAnnotation(auditObservation(worst.task), true);
  assert.match(clipped, /explicitly names/, `the largest checklist (${worst.card}) was clipped`);
});

test("clipping still respects the observation budget", () => {
  assert.ok(clipKeepingControllerAnnotation(auditObservation(), true).length <= OBS_MAX);
});

test("an ordinary annotation whose tail is quoted output is still head-clipped", () => {
  const verdict = "[auto-verify] I ran the tests for you — FAIL: 81 of 1500 failed.";
  const noise = Array.from({ length: 400 }, (_, i) => `ok ${i} - noisy passing tap line`).join("\n");
  const clipped = clipKeepingControllerAnnotation(`edited src/agent.js\n${verdict}\n${noise}`, true);
  assert.ok(clipped.includes("81 of 1500 failed"), "the verdict at the head must survive");
  assert.ok(!clipped.includes("ok 399 - noisy passing tap line"), "the quoted tail must still go");
  assert.ok(clipped.length <= OBS_MAX);
});

test("a checklist far larger than any real one cannot blow the budget", () => {
  const monstrous = `${"x".repeat(200)}\n\n[requirement-checklist] ${"q".repeat(50000)}`;
  const clipped = clipKeepingControllerAnnotation(monstrous, true);
  assert.ok(clipped.length <= OBS_MAX, `budget blown: ${clipped.length} > ${OBS_MAX}`);
});
