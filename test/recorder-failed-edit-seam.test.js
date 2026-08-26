import assert from "node:assert/strict";
import test from "node:test";

import { buildContextFlightRecorder } from "../src/context-flight-recorder.js";

// "Partial" is the permanent condition of any file too large to render whole,
// so flagging a retry merely because its target is partial marks every
// giant-file recovery as risky and says nothing. tb14 turn 28
// (.bantam/runs/2026-08-16T21-20-33-402Z.json) retried edit_lines at line 176
// with the panel showing [[88,264],[673,693]] — the seam was plainly visible —
// and was flagged anyway. What matters is whether the failed SEAM is visible on
// the recovery turn, which is what the sibling edit-target check already asks.

function panelPrompt(ranges) {
  const body = ranges
    .map(([start, end], i) => {
      const rows = [];
      if (i > 0) rows.push(`… (lines ${ranges[i - 1][1] + 1}–${start - 1} omitted)`);
      for (let n = start; n <= end; n += 1) rows.push(`${n}\tconst line${n} = ${n};`);
      return rows.join("\n");
    })
    .join("\n");
  const panel = `<open_files>\n# src/agent.js (current, 5667 lines)\n${body}\n… (lines ${ranges.at(-1)[1] + 1}–5667 omitted)\n</open_files>`;
  return `<|im_start|>user\n${panel}\n<|im_end|>\n`;
}

function recorderFor({ failedLine, ranges }) {
  return buildContextFlightRecorder({
    turns: [
      {
        i: 0,
        parsedAction: { a: "edit_lines", p: "src/agent.js", start: failedLine, end: failedLine },
        observation: "ERROR: refused — valid JavaScript would become invalid.",
        modelCallIndex: 0,
      },
      { i: 1, parsedAction: { a: "read_file", p: "src/agent.js" }, observation: "ok", modelCallIndex: 1 },
    ],
    modelCalls: [
      { index: 0, request: { body: JSON.stringify({ prompt: "<|im_start|>user\nfirst\n<|im_end|>\n" }) } },
      { index: 1, request: { body: JSON.stringify({ prompt: panelPrompt(ranges) }) } },
    ],
  });
}

const codes = (recorder, turn) =>
  (recorder.decisions.find((d) => d.turn === turn)?.risks ?? []).map((r) => r.code);

test("a retry whose failed seam is visible is not flagged", () => {
  const recorder = recorderFor({ failedLine: 176, ranges: [[88, 264], [673, 693]] });
  assert.ok(!codes(recorder, 1).includes("failed-edit-target-partial"),
    "line 176 sits inside 88-264; the recovery turn can see it");
});

test("a retry whose failed seam is NOT visible is still flagged", () => {
  const recorder = recorderFor({ failedLine: 1500, ranges: [[88, 264], [673, 693]] });
  assert.ok(codes(recorder, 1).includes("failed-edit-target-partial"),
    "line 1500 is in neither window — the real defect this check exists for");
});
