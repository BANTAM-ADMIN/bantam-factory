import assert from "node:assert/strict";
import test from "node:test";

import { buildContextFlightRecorder } from "../src/context-flight-recorder.js";

// The partial-edit risks fired 121 times across 66 stored runs, and the number
// was read as a defect count — until the acorn write probe (2026-08-17) showed
// both of its flagged edits LANDING: a model editing from fresh search results
// does not need the seam in the panel. The harmful case is specifically the
// failed edit (40 of the 121). The codes stay unchanged for corpus
// comparability; each risk now carries the outcome, so the split is a field
// filter instead of a re-derivation.

const call = (prompt) => ({ request: { body: JSON.stringify({ prompt }) } });
const body = Array.from({ length: 41 }, (_, i) => `${100 + i}\tconst a${100 + i} = 1;`).join("\n");
const PANEL = `<|im_start|>user\n<open_files>\n# src/big.js (current, 6000 lines)\n${body}\n… (lines 141–6000 omitted)\n</open_files>\n<|im_end|>\n`;

function runWith(observation) {
  const turns = [{
    i: 0, modelCallIndex: 0,
    parsedAction: { a: "replace", p: "src/big.js", old: "const zz = 9;", new: "const zz = 10;", line: 5200 },
    observation,
  }];
  return buildContextFlightRecorder({ turns, modelCalls: [call(PANEL)] });
}

test("a landed edit's partial-target risk says so", () => {
  const r = runWith("replaced 1 occurrence in src/big.js at line 5200");
  const d = (r.decisions ?? [])[0];
  const partial = (d?.risks ?? []).find((x) => x.code === "edit-target-partial");
  assert.ok(partial, `risk should fire: ${JSON.stringify(d?.risks)}`);
  assert.equal(partial.outcome, "landed");
});

test("a failed edit's risk says that instead", () => {
  const r = runWith('ERROR: "old" text not found starting on line 5200 in src/big.js.');
  const partial = ((r.decisions ?? [])[0]?.risks ?? []).find((x) => x.code === "edit-target-partial");
  assert.ok(partial);
  assert.equal(partial.outcome, "failed");
});
