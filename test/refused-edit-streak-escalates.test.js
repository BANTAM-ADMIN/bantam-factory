import assert from "node:assert/strict";
import test from "node:test";

import { repeatedEditFailureDiagnostic, repeatedRefusedEditDiagnostic } from "../src/failure-diagnostics.js";

// repeatedEditFailureDiagnostic escalates a streak of failed edits at threshold
// 3. isFailedEdit matches only ANCHOR errors — "old" not found, ambiguous, out
// of range — so a run refused for SYNTAX never accumulates a count.
//
// Every long edit-failure streak in the stored corpus is dominated by refusals.
// Run 2026-08-16T14-11 emitted nine consecutive refused edit_lines on
// src/agent.js (t46-t54); 2026-08-16T02-22 fourteen on src/gate-report.js; tb23
// and tb24 three each. The escalation exists, its threshold is 3, and it fired
// 0 times in 40 runs. Replaying the corpus through the new one: 32 firings.

const REFUSAL = 'ERROR: refused — valid JavaScript would become invalid. The complete staged result for src/a.js:91:5 failed to parse: Unexpected token.';
const ANCHOR = 'ERROR: "old" text not found starting on line 12 in src/a.js.';
const edit = (p, observation) => ({ parsedAction: { a: "edit_lines", p }, observation });

test("three refusals on the same file escalate", () => {
  const turns = [edit("src/a.js", REFUSAL), edit("src/a.js", REFUSAL)];
  const out = repeatedRefusedEditDiagnostic(turns, { a: "edit_lines", p: "src/a.js" }, REFUSAL);
  assert.match(String(out), /\[edit-recovery\] 3 of your recent edits to src\/a\.js were REFUSED/);
  assert.match(String(out), /the imbalance is inside the text you are inserting/);
});

test("two do not", () => {
  const turns = [edit("src/a.js", REFUSAL)];
  assert.equal(repeatedRefusedEditDiagnostic(turns, { a: "edit_lines", p: "src/a.js" }, REFUSAL), null);
});

test("a landed edit resets the streak", () => {
  const turns = [
    edit("src/a.js", REFUSAL),
    { parsedAction: { a: "replace", p: "src/a.js" }, observation: "replaced 1 occurrence in src/a.js", editApplied: true },
    edit("src/a.js", REFUSAL),
  ];
  assert.equal(repeatedRefusedEditDiagnostic(turns, { a: "edit_lines", p: "src/a.js" }, REFUSAL), null);
});

test("a streak on a different file does not count", () => {
  const turns = [edit("src/b.js", REFUSAL), edit("src/b.js", REFUSAL)];
  assert.equal(repeatedRefusedEditDiagnostic(turns, { a: "edit_lines", p: "src/a.js" }, REFUSAL), null);
});

test("it escalates once per streak, not every turn", () => {
  // The first firing puts the tag in that turn's observation; later turns see it.
  const escalated = `${REFUSAL}\n[edit-recovery] 3 of your recent edits to src/a.js were REFUSED`;
  const turns = [edit("src/a.js", REFUSAL), edit("src/a.js", REFUSAL), edit("src/a.js", escalated)];
  assert.equal(repeatedRefusedEditDiagnostic(turns, { a: "edit_lines", p: "src/a.js" }, REFUSAL), null);
});

test("the anchor advice is not given for a refusal", () => {
  // "Copy `old` verbatim" is right for an anchor miss and useless here: the
  // anchor matched. The two diagnostics stay disjoint.
  const turns = [edit("src/a.js", REFUSAL), edit("src/a.js", REFUSAL)];
  assert.equal(repeatedEditFailureDiagnostic(turns, { a: "edit_lines", p: "src/a.js" }, REFUSAL), null);
  const anchorTurns = [edit("src/a.js", ANCHOR), edit("src/a.js", ANCHOR)];
  assert.equal(repeatedRefusedEditDiagnostic(anchorTurns, { a: "replace", p: "src/a.js" }, ANCHOR), null);
  assert.match(String(repeatedEditFailureDiagnostic(anchorTurns, { a: "replace", p: "src/a.js" }, ANCHOR)), /did not match the file/);
});
