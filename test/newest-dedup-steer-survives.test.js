import assert from "node:assert/strict";
import test from "node:test";

import { budgetTurns, compactHistory } from "../src/history-budget.js";
import { buildPrompt } from "../src/prompt.js";

// Measured on the ticket-B rerun (.bantam/runs/2026-08-16T14-11-45-620Z.json):
// turn 14 re-read src/agent.js:5140 and RepetitionGuard answered with
//
//   [repetition] Deduplicated — not stale. You already ran this exact action on
//   turn 4 ... Reading it again cannot reveal anything new. If you already have
//   enough to answer the task, respond now ... Otherwise do something
//   different: request a different file or line range, run a different search,
//   or — for a whole-repo overview you have not fetched yet — a `map` query.
//
// The context flight recorder then flagged turn 15 (and 10 others)
// "prior-controller-evidence-missing": compactHistory had replaced it with
// "[turn 15: duplicate action not executed; unchanged result remains at turn 4]".
// The FACT survived; the instruction for what to do instead did not — and this
// pass runs on every prompt build, not only under budget pressure. The run made
// 27 read_file actions.
//
// Contract: the newest duplicate notice keeps its steer. Older ones compact.

const STEER = "[repetition] Deduplicated — not stale. You already ran this exact action on turn 4 "
  + "and the workspace has not changed since, so it was not executed again.\n\n"
  + "Reading it again cannot reveal anything new. Otherwise do something different: "
  + "request a different file or line range, run a different search, or a `map` query.";

const turnAt = (i, observation) => ({ i, action: { a: "read_file", p: "src/agent.js" }, observation });

test("the newest duplicate notice keeps its actionable steer", () => {
  const out = compactHistory([
    turnAt(3, "src/agent.js (5527 lines, showing 5140-5219):\n5140\tconst x = 1;"),
    turnAt(14, STEER),
  ]);
  assert.match(out[1].observation, /do something different/,
    "the correction must reach the turn that just tripped the guard");
});

test("older duplicate notices still compact to a pointer", () => {
  const out = compactHistory([
    turnAt(3, "src/agent.js (5527 lines, showing 5140-5219):\n5140\tconst x = 1;"),
    turnAt(14, STEER),
    turnAt(20, STEER),
  ]);
  assert.doesNotMatch(out[1].observation, /do something different/, "the older one compacts");
  assert.match(out[1].observation, /duplicate action not executed/);
  assert.match(out[2].observation, /do something different/, "the newest one survives");
});

test("a steer whose origin turn left the window is corrected, not preserved", () => {
  // "Its unchanged result remains at turn 4" is false once turn 4 is evicted;
  // the corrected pointer must win over preservation.
  const out = compactHistory([turnAt(14, STEER)]);
  assert.doesNotMatch(out[0].observation, /remains at turn 4/);
  assert.match(out[0].observation, /has since left this window|Re-run the action/);
});

test("the steer survives the WHOLE path, not just compaction", () => {
  // Preserving it in compactHistory is worthless if buildPrompt's collapse then
  // replaces it. The read turn is panel-substitutable here, so the collapse
  // fires and the annotation must ride through as the controller suffix.
  // (Prior incident: a residency fix landed in the resume-replay loop and never
  // executed on a live turn. Layer-local checks do not prove delivery.)
  const turns = budgetTurns([
    turnAt(3, "src/agent.js (5527 lines, showing 5140-5219):\n5140\tconst x = 1;"),
    turnAt(14, STEER),
  ], { charBudget: 36000 });

  const prompt = buildPrompt({
    task: "t",
    env: "node 20",
    openPaths: ["src/agent.js"],
    readPaths: ["src/agent.js"],
    openFilesText: "# src/agent.js (current, 1 lines)\n1\tconst x = 1;",
    turns,
    everSlimmedPaths: new Set(["src/agent.js"]),
    preserveSlimmedControlAnnotations: true,   // the agent's own default
  });

  assert.match(prompt, /earlier snapshot omitted/, "the stale body is still collapsed");
  assert.match(prompt, /do something different/, "the steer must reach the literal prompt");
  assert.match(prompt, /already ran this exact action on turn 4/, "provenance rides with it");
});

test("ordinary observations are untouched by the rule", () => {
  const body = "src/agent.js (5527 lines, showing 1-10):\n1\tconst a = 1;";
  const out = compactHistory([turnAt(1, body)]);
  assert.equal(out[0].observation, body);
});
