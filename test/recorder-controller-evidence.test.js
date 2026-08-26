import assert from "node:assert/strict";
import test from "node:test";

import { buildContextFlightRecorder } from "../src/context-flight-recorder.js";

// The recorder's controller-evidence check required the ENTIRE annotation
// suffix — every byte from the first `[tag]` to the end of the observation — to
// appear verbatim in the next prompt. Once prompt.js began keeping each
// annotation's HEAD and dropping its quoted tool output, that could never pass
// on a clipped observation.
//
// tb11 (2026-08-16, .bantam/runs/2026-08-16T19-21-23-939Z.json) logged
// prior-controller-evidence-missing on 11 turns. Checked against the real
// prompts, all five annotation blocks of the flagged observation — [impact],
// [peer], [impact], [auto-verify], [fix-tests] — were present. The metric was
// reporting "this observation was clipped", not "the decisive content is gone",
// and a metric that cries loss on every long turn cannot be used to find one.

function runWith({ observation, prompt }) {
  return buildContextFlightRecorder({
    turns: [
      { i: 0, parsedAction: { a: "replace", p: "src/a.js" }, observation, modelCallIndex: 0 },
      { i: 1, parsedAction: { a: "read_file", p: "src/a.js" }, observation: "src/a.js (1 lines):", modelCallIndex: 1 },
    ],
    modelCalls: [
      { index: 0, request: { body: JSON.stringify({ prompt: "first" }) } },
      { index: 1, request: { body: JSON.stringify({ prompt }) } },
    ],
  });
}

const OBSERVATION = [
  "replaced 1 occurrence in src/a.js",
  "[auto-verify] ran the tests for you — FAIL:",
  "VERDICT: 3 of 100 tests FAILED (97 passed).",
  ...Array.from({ length: 200 }, (_, i) => `ok ${i} - quoted tap noise`),
  "[fix-tests] fix them one at a time",
  "  quoted test source",
].join("\n");

test("a clipped observation whose block heads survive is not reported as a loss", () => {
  // The prompt keeps each head and drops the quoted tails — what prompt.js does.
  const prompt = [
    "[auto-verify] ran the tests for you — FAIL:",
    "VERDICT: 3 of 100 tests FAILED (97 passed).",
    "[fix-tests] fix them one at a time",
  ].join("\n");
  const recorder = runWith({ observation: OBSERVATION, prompt });
  const decision = recorder.decisions[1];
  assert.equal(decision.priorOutcome.controllerEvidence.blocks, 2);
  assert.equal(decision.priorOutcome.controllerEvidence.missing, 0,
    "both heads are present; nothing decisive was lost");
});

test("a genuinely dropped block is still reported, with a sample", () => {
  const prompt = "[auto-verify] ran the tests for you — FAIL:\nVERDICT: 3 of 100 tests FAILED (97 passed).";
  const recorder = runWith({ observation: OBSERVATION, prompt });
  const evidence = recorder.decisions[1].priorOutcome.controllerEvidence;
  assert.equal(evidence.missing, 1);
  assert.match(evidence.missingSamples[0], /\[fix-tests\]/);
});

test("an observation with no annotation reports nothing present", () => {
  const recorder = runWith({ observation: "replaced 1 occurrence in src/a.js", prompt: "anything" });
  const evidence = recorder.decisions[1].priorOutcome.controllerEvidence;
  assert.equal(evidence.present, false);
  assert.equal(evidence.missing, 0);
});

// Only the NEWEST duplicate notice keeps its full steer; older ones are
// deliberately replaced with "[turn N: duplicate action not executed; unchanged
// result remains at turn M]". That is a designed substitution carrying the same
// fact, not a loss — but the recorder counted it as one, reporting five phantom
// losses in tb14 (.bantam/runs/2026-08-16T21-20-33-402Z.json, turns 67-78).

const REPETITION_OBS = [
  "[repetition] Deduplicated — not stale. You already ran this exact action on turn 46 and the workspace has not changed.",
  "Reading it again cannot reveal anything new. Do something different.",
  ...Array.from({ length: 300 }, (_, i) => `filler line ${i}`),
].join("\n");

test("a duplicate notice replaced by its pointer is not counted as missing", () => {
  const prompt = "[turn 67: duplicate action not executed; unchanged result remains at turn 46]";
  const recorder = runWith({ observation: REPETITION_OBS, prompt });
  const evidence = recorder.decisions[1].priorOutcome.controllerEvidence;
  assert.equal(evidence.missing, 0, "the fact survived in substituted form");
  assert.equal(evidence.substituted, 1);
});

test("a duplicate notice that simply vanished is still a loss", () => {
  const prompt = "nothing here about duplicates at all";
  const recorder = runWith({ observation: REPETITION_OBS, prompt });
  const evidence = recorder.decisions[1].priorOutcome.controllerEvidence;
  assert.equal(evidence.missing, 1);
  assert.match(evidence.missingSamples[0], /\[repetition\]/);
});

test("the substitution excuse applies only to duplicate notices", () => {
  // An [auto-verify] block has no such designed replacement; its absence is
  // always a loss.
  const observation = [
    "[auto-verify] ran the tests for you — FAIL:",
    ...Array.from({ length: 300 }, (_, i) => `filler ${i}`),
  ].join("\n");
  const prompt = "[turn 9: duplicate action not executed; unchanged result remains at turn 4]";
  const recorder = runWith({ observation, prompt });
  assert.equal(recorder.decisions[1].priorOutcome.controllerEvidence.missing, 1);
});

// The harness deliberately RESHAPES test output before the model sees it: a raw
// "not ok 1 - some test" is delivered as "✗ some test (file:line) — expected X,
// got Y", and "exit 1" as "VERDICT: N of M tests FAILED". Byte matching counts
// every one of those as a loss.
//
// ta1 (2026-08-17, .bantam/runs/2026-08-17T01-05-02-149Z.json) reported five
// decisive-evidence losses on a run that PASSED, and every failing test name
// was present in the prompt via the digest. Recomputed with reformatting
// awareness the run reports none, while tb15 — which genuinely broke 85 tests —
// still reports five.

const TAP_FAILURE = [
  "not ok 1 - every gate in DONE_GATES appears in the report",
  "  ---",
  "  error: |-",
  "  Expected values to be strictly equal:",
  "  code: 'ERR_ASSERTION'",
  "  expected: 21",
  "  actual: 20",
  "  ...",
  "exit 1",
  ...Array.from({ length: 200 }, (_, i) => `filler ${i}`),
].join("\n");

const DIGEST_PROMPT = "VERDICT: 1 of 5 tests FAILED (4 passed).\nFailing tests:\n"
  + "  ✗ every gate in DONE_GATES appears in the report (test/gates-report.test.js:17) — expected 21, got 20";

test("a failure delivered as a digest row is not counted as lost", () => {
  const recorder = runWith({ observation: TAP_FAILURE, prompt: DIGEST_PROMPT });
  assert.equal(recorder.decisions[1].priorOutcome.decisiveEvidence.missingLines, 0,
    "the name, the expected and the actual all reached the model");
});

test("a failure that reached the prompt in no form at all is still lost", () => {
  const recorder = runWith({ observation: TAP_FAILURE, prompt: "nothing about tests here" });
  assert.ok(recorder.decisions[1].priorOutcome.decisiveEvidence.missingLines > 0);
});

test("TAP scaffolding is not counted as evidence", () => {
  // "code: 'ERR_ASSERTION'" and "Expected values to be strictly equal:" match
  // the failure vocabulary while carrying no fact; the fact is expected/actual.
  const observation = [
    "not ok 1 - a test",
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    "  Expected values to be strictly equal:",
    ...Array.from({ length: 200 }, (_, i) => `filler ${i}`),
  ].join("\n");
  const recorder = runWith({ observation, prompt: "✗ a test (x.test.js:1)" });
  assert.equal(recorder.decisions[1].priorOutcome.decisiveEvidence.missingLines, 0);
});

test("the harness's own clipping marker is not evidence", () => {
  const observation = [
    "... (test output digest: skipped 62 chars before failure region)",
    ...Array.from({ length: 200 }, (_, i) => `filler ${i}`),
  ].join("\n");
  const recorder = runWith({ observation, prompt: "anything" });
  assert.equal(recorder.decisions[1].priorOutcome.decisiveEvidence.lines, 0,
    "text this code emitted about its own clipping is not model-facing evidence");
});

// prompt.js keeps each annotation's first ANNOTATION_HEAD_CHARS (700) and clips
// the rest, so a controller line LONGER than that never appears verbatim in the
// prompt and a whole-line `includes` reports it absent. ta3 turn 17
// (2026-08-17) flagged a missing [completion-audit] whose line was 962
// characters; the prompt carried exactly its first 700, prefix identical. The
// steer was delivered.
//
// This is the same correction the block-level check already carries one level
// up — measure whether the decisive content survived, not whether it was
// clipped.
test("a head-clipped annotation line counts as delivered", () => {
  const long = `[completion-audit] Tests are green. Before done, compare the current implementation with every explicit task requirement. ${"detail ".repeat(140)}`;
  assert.ok(long.length > 700, "the fixture must exceed the head budget");
  const recorder = buildContextFlightRecorder({
    turns: [
      { i: 0, modelCallIndex: 0, parsedAction: { a: "shell", c: "node --test" }, observation: `ok\n${long}` },
      { i: 1, modelCallIndex: 1, parsedAction: { a: "done", summary: "d" }, observation: "" },
    ],
    modelCalls: [
      { index: 0, request: { body: JSON.stringify({ prompt: "<|im_start|>user\nfirst\n<|im_end|>\n" }) } },
      // exactly what prompt.js emits: the head, then a clip marker
      { index: 1, request: { body: JSON.stringify({ prompt: `<|im_start|>user\n<observation>\n${long.slice(0, 700)}\n… [262 chars of quoted output clipped] …\n</observation>\n<|im_end|>\n` }) } },
    ],
  });
  const codes = (recorder.decisions.find((d) => d.turn === 1)?.risks ?? []).map((r) => r.code);
  assert.ok(!codes.includes("prior-controller-evidence-missing"),
    "a delivered-but-clipped steer must not read as missing");
});

test("an annotation that never arrived is still reported", () => {
  // The converse: softening this into always-passing would retire the check.
  const long = `[completion-audit] Tests are green. ${"detail ".repeat(140)}`;
  const recorder = buildContextFlightRecorder({
    turns: [
      { i: 0, modelCallIndex: 0, parsedAction: { a: "shell", c: "node --test" }, observation: `ok\n${long}` },
      { i: 1, modelCallIndex: 1, parsedAction: { a: "done", summary: "d" }, observation: "" },
    ],
    modelCalls: [
      { index: 0, request: { body: JSON.stringify({ prompt: "<|im_start|>user\nfirst\n<|im_end|>\n" }) } },
      { index: 1, request: { body: JSON.stringify({ prompt: "<|im_start|>user\n<observation>\nok\n</observation>\n<|im_end|>\n" }) } },
    ],
  });
  const codes = (recorder.decisions.find((d) => d.turn === 1)?.risks ?? []).map((r) => r.code);
  assert.ok(codes.includes("prior-controller-evidence-missing"));
});

// decisiveLines screens for failure vocabulary, and harness prose is full of it.
// It already skips a line starting with `[tag]`, but not the prose UNDER it.
// ta3 turn 25 (2026-08-17) reported a lost decisive line reading "see the
// assertion in the test output" — a fixed string the harness itself writes in
// src/logic/test-focus.js when a failure carries no expected/actual pair.
//
// Harness annotations are checked separately as controller evidence, so their
// bodies are not tool output. The exception is the blocks that QUOTE a tool
// stream: a loss inside [auto-verify] is the defect this recorder exists for.
function recorderFor(observation, nextPrompt) {
  return buildContextFlightRecorder({
    turns: [
      { i: 0, modelCallIndex: 0, parsedAction: { a: "shell", c: "node --test" }, observation },
      { i: 1, modelCallIndex: 1, parsedAction: { a: "done", summary: "d" }, observation: "" },
    ],
    modelCalls: [
      { index: 0, request: { body: JSON.stringify({ prompt: "<|im_start|>user\nfirst\n<|im_end|>\n" }) } },
      { index: 1, request: { body: JSON.stringify({ prompt: `<|im_start|>user\n<observation>\n${nextPrompt}\n</observation>\n<|im_end|>\n` }) } },
    ],
  });
}
const riskCodes = (recorder) => (recorder.decisions.find((d) => d.turn === 1)?.risks ?? []).map((r) => r.code);

test("harness prose in an instruction block is not decisive evidence", () => {
  const observation = "VERDICT: 1 of 3 tests FAILED (2 passed).\nnot ok 2 - the widget resizes\n"
    + "[completion-audit] Tests are red. ✗ the widget resizes — see the assertion in the test output";
  // The tool lines survive; only the annotation prose is gone.
  const next = "VERDICT: 1 of 3 tests FAILED (2 passed).\nnot ok 2 - the widget resizes";
  assert.ok(!riskCodes(recorderFor(observation, next)).includes("prior-decisive-evidence-missing"));
});

test("a failure quoted inside auto-verify is still decisive", () => {
  // [auto-verify] carries a real tool stream. Losing its named failure is the
  // defect this recorder was built to catch, so its body keeps counting.
  const observation = "[auto-verify] I ran them for you — FAIL:\nnot ok 7 - the ledger clamps its window\n  expected: 5\n  actual: 9";
  const next = "[auto-verify] I ran them for you — FAIL:";
  assert.ok(riskCodes(recorderFor(observation, next)).includes("prior-decisive-evidence-missing"));
});
