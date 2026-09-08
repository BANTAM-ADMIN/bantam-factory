import assert from "node:assert/strict";
import test from "node:test";

import { buildContextFlightRecorder } from "../src/context-flight-recorder.js";
import { clipKeepingControllerAnnotation } from "../src/prompt.js";

// The recorder reported, for the turn that deleted the requirement checklist:
//   delivered.chars === raw.chars === 8815
//   transform: { changed: false, charsRemoved: 0 }
//   controllerEvidence: { blocks: 2, missing: 0 }
// A 6,969-character deletion registered as a clean delivery, because the
// recorder answers two narrower questions than it appears to. It compares raw
// against delivered, which is the observation BEFORE prompt assembly, and it
// checks only each annotation's first 200 characters — and the clipper always
// preserves heads. So the one instrument built to catch context loss was
// structurally incapable of seeing the loss that mattered.
//
// Guidance blocks that must survive whole are now checked whole.

const CHECKLIST = "[requirement-checklist] This task explicitly names: "
  + "[Invalid inputs throw an Error.] · [Such a code point must not be dropped.] · "
  + "[Display width counts one per code point, except in the ranges U+1100 to U+115F.]. "
  + "Trace each named bound, literal, and rejection through the current code.";

const observation = `$ npm test\nok 1 - a passing line\n\n${CHECKLIST}`;

// The recorder audits each decision against the PREVIOUS turn's outcome, so the
// checklist has to sit on turn 1 and be looked for in turn 2's prompt.
function recorderFor(promptText) {
  return buildContextFlightRecorder({
    turns: [
      { i: 0, parsedAction: { a: "shell", c: "npm test" }, observation: "start", modelCallIndex: 0 },
      { i: 1, parsedAction: { a: "shell", c: "npm test" }, observation, modelCallIndex: 1 },
      { i: 2, parsedAction: { a: "read_file", p: "a.js" }, observation: "read", modelCallIndex: 2 },
    ],
    modelCalls: [
      { index: 0, request: { body: JSON.stringify({ prompt: "first turn prompt" }) } },
      { index: 1, request: { body: JSON.stringify({ prompt: "second turn prompt" }) } },
      { index: 2, request: { body: JSON.stringify({ prompt: promptText }) } },
    ],
  });
}

test("a guidance block clipped out of the prompt is reported", () => {
  const truncated = `<observation>\n$ npm test\nok 1 - a passing line\n\n`
    + `[requirement-checklist] This task explicitly names: [Invalid inputs\n`
    + `… [400 chars of quoted output clipped] …\n</observation>`;
  const recorder = recorderFor(truncated);
  const decision = recorder.decisions.find((d) => d.turn === 2);
  const codes = (decision?.risks ?? []).map((r) => r.code ?? r);
  assert.ok(codes.includes("guidance-block-clipped"),
    `expected a clipped-guidance risk, got ${JSON.stringify(decision?.risks)}`);
  assert.ok(recorder.summary.risks["guidance-block-clipped"] >= 1, "the summary must count it");
});

test("a guidance block that reached the prompt whole is not reported", () => {
  const intact = `<observation>\n${observation}\n</observation>`;
  const recorder = recorderFor(intact);
  const decision = recorder.decisions.find((d) => d.turn === 2);
  const codes = (decision?.risks ?? []).map((r) => r.code ?? r);
  assert.ok(!codes.includes("guidance-block-clipped"),
    `unexpected risk on an intact prompt: ${JSON.stringify(decision?.risks)}`);
});

test("the check runs on a passing turn, not only a failing one", () => {
  // The deletion that hid for weeks happened on a green `npm test`. The old
  // residency check only ran when the outcome bore failure evidence, so the
  // completion audit — which fires precisely on green — was never checked.
  const toolOutput = observation.slice(0, observation.indexOf("[requirement-checklist]"));
  assert.ok(!/fail|error|✗/i.test(toolOutput),
    "the tool output must be a passing one; the quoted requirement may still say Error");
  const truncated = `<observation>\n$ npm test\nok 1 - a passing line\n</observation>`;
  const codes = (recorderFor(truncated).decisions.find((d) => d.turn === 2)?.risks ?? [])
    .map((r) => r.code ?? r);
  assert.ok(codes.includes("guidance-block-clipped"));
});

test("the real clipper output no longer trips the check", () => {
  const clipped = clipKeepingControllerAnnotation(observation, true);
  const codes = (recorderFor(`<observation>\n${clipped}\n</observation>`)
    .decisions.find((d) => d.turn === 2)?.risks ?? []).map((r) => r.code ?? r);
  assert.ok(!codes.includes("guidance-block-clipped"),
    "the clipper preserves this block, so the recorder must agree");
});
