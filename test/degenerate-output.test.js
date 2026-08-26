import assert from "node:assert/strict";
import test from "node:test";

import { degenerateRepairMessage, degenerateTail } from "../src/logic/degenerate-output.js";

// Across all stored TB2 runs, 27 of 29 rejected outputs were unterminated JSON.
// Two different faults wear that one label:
//   dna-insert turn 20  13,087 chars ending ...ctgctgctgctgctg   (sampling loop)
//   dna-insert turn 38  26,747 chars, coherent, cut mid-comment  (genuinely big)
// They need opposite advice, and the server runs with repeat-penalty and
// presence-penalty both disabled, so nothing damps the loop.

test("catches the DNA-base loop that actually happened", () => {
  const raw = '{"a":"shell","c":"python3 -c \\"seq=\'' + "ctg".repeat(2000);
  const d = degenerateTail(raw);
  assert.ok(d, "expected degeneration");
  assert.ok("ctg".includes(d.unit) || d.unit.includes("ctg") || d.unit === "ctg" || d.repeats >= 12);
});

test("catches the whitespace loop", () => {
  const d = degenerateTail("some real output here" + "\n\n ".repeat(900));
  assert.ok(d, "expected degeneration");
  assert.ok(d.repeats >= 12);
});

test("a long but LEGITIMATE action is not degeneration", () => {
  const code = Array.from({ length: 400 }, (_, i) => `    print(compute_row(${i}), header[${i}], scale)`).join("\n");
  assert.equal(degenerateTail(`{"a":"write_file","p":"x.py","content":"${code}`), null,
    "distinct lines are not a repeating fragment");
});

test("short outputs are never flagged", () => {
  assert.equal(degenerateTail("abcabcabcabc"), null);
  assert.equal(degenerateTail(""), null);
  assert.equal(degenerateTail(null), null);
});

test("the repair tells it to STOP PASTING, not to shrink", () => {
  const msg = degenerateRepairMessage({ unit: "ctg", repeats: 900 }, "solve.py");
  assert.match(msg, /REPETITION LOOP/);
  assert.match(msg, /did not run out of room/);
  assert.match(msg, /read it at runtime/);
  assert.doesNotMatch(msg, /emit a smaller/i, "that is the OTHER fault's advice");
});
