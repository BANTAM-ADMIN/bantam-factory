import assert from "node:assert/strict";
import test from "node:test";

import { buildContextFlightRecorder } from "../src/context-flight-recorder.js";

// Every residency check in the recorder asks whether bytes ARE present. None
// asked whether the prompt's account of itself is true, so tc1 (2026-08-17)
// finished with an empty risk set while 13 of its 17 panels declared a line
// omitted and rendered it anyway — among them lines 84-85, the signature and
// binding the model had written one turn earlier. It re-read the range it had
// just been shown, the repetition guard refused, and two turns went to
// searching for an edit that had never left the screen. Replaying that
// artifact through this detector now reports 9 decisions at
// panel-self-contradiction; the same ticket on the repaired panel reports none.

function panel(entries) {
  const blocks = entries.map(({ path, total, rows }) => `# ${path} (current, ${total} lines)\n${rows.join("\n")}`);
  return `<|im_start|>user\n<open_files>\n${blocks.join("\n")}\n</open_files>\n<|im_end|>\n`;
}

const source = (start, end) => Array.from(
  { length: end - start + 1 },
  (_, i) => `${start + i}\tconst line${start + i} = ${start + i};`,
);

function recorderFor(entries) {
  return buildContextFlightRecorder({
    turns: [{ i: 0, parsedAction: { a: "read_file", p: "src/agent.js" }, observation: "ok", modelCallIndex: 0 }],
    modelCalls: [{ index: 0, request: { body: JSON.stringify({ prompt: panel(entries) }) } }],
  });
}

const codes = (recorder) => (recorder.decisions[0]?.risks ?? []).map((r) => r.code);
const detail = (recorder) => (recorder.decisions[0]?.risks ?? [])
  .find((r) => r.code === "panel-self-contradiction")?.detail ?? "";

test("a panel that renders the lines it calls omitted is flagged", () => {
  // The tc1 shape: a seam block prints 81-89, the body then declares them gone.
  const recorder = recorderFor([{
    path: "src/logic/test-focus.js",
    total: 646,
    rows: [...source(81, 89), "… (lines 1–55 omitted)", ...source(56, 80), "… (lines 81–89 omitted)", ...source(90, 120)],
  }]);
  assert.ok(codes(recorder).includes("panel-self-contradiction"), "the contradiction must be visible to the instrument");
  assert.match(detail(recorder), /src\/logic\/test-focus\.js declared line\(s\) 81-89 omitted while rendering them/);
});

test("an honestly clipped panel is not flagged", () => {
  const recorder = recorderFor([{
    path: "src/agent.js",
    total: 5667,
    rows: [...source(1, 60), "… (lines 61–5667 omitted)"],
  }]);
  assert.deepEqual(codes(recorder), [], "a panel that only omits is doing its job");
});

test("a pointer at content held elsewhere is not an omission claim", () => {
  // "shown above/below" names bytes the panel DOES hold. Reading those as
  // omission claims would flag every repaired panel as defective.
  const recorder = recorderFor([{
    path: "src/logic/test-focus.js",
    total: 646,
    rows: [
      ...source(81, 89),
      "… (lines 1–55 omitted)",
      ...source(56, 80),
      '… (lines 81–89 shown above under "accepted mutation seams")',
      ...source(90, 120),
    ],
  }]);
  assert.deepEqual(codes(recorder), [], "the repaired panel is honest and must read as clean");
});

test("one file's line numbers cannot contradict another's", () => {
  // Pooling rendered line numbers across the whole panel inflated the first
  // measurement of this defect from 46% of prompts to 77%. The detector scopes
  // per file entry; this pins that.
  const recorder = recorderFor([
    { path: "src/a.js", total: 400, rows: [...source(1, 60), "… (lines 61–400 omitted)"] },
    { path: "src/b.js", total: 400, rows: [...source(61, 120), "… (lines 1–60 omitted)"] },
  ]);
  assert.deepEqual(codes(recorder), [], "b.js rendering line 61 says nothing about a.js omitting it");
});

test("the flagged range is the overlap, not the whole claim", () => {
  const recorder = recorderFor([{
    path: "src/agent.js",
    total: 400,
    rows: [...source(90, 120), "… (lines 100–200 omitted)"],
  }]);
  assert.match(detail(recorder), /100-120/, "only 100-120 is both claimed omitted and rendered");
});
