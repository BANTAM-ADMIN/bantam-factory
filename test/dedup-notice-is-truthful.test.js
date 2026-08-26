import assert from "node:assert/strict";
import test from "node:test";

import { RepetitionGuard } from "../src/repetition.js";
import { compactHistory } from "../src/history-budget.js";

// Measured on .bantam/runs/2026-08-25T04-38-54-399Z-chat-r0.json ("take a look
// at your codebase", 11 turns). The guard fired once, on turn 7, and the notice
// the model was handed read:
//
//   You already ran this exact action on turn 7 and the workspace has not
//   changed  Its last real run FAILED and the workspace is unchanged, so that
//   failure still stands — FIX the code before re-testing or calling done.since,
//   so it was not executed again. ... or — for a whole-repo overview you have
//   not fetched yet — a `map` query (`brief`/`arch`).
//
// Three defects in one notice: a directory listing cannot FAIL (record() stored
// passed:false for every non-shell action and _message tested === false); the
// failure clause was spliced into the middle of another sentence; and `map` was
// named although no repomap extractor exists in this checkout, so the model's
// next turn (its reasoning: "The reminder suggests using a `map` query") was
// spent on `[query] "map brief" didn't match a tool`.
//
// And the guard fired LATE: src/factory had been listed on turns 2, 3, 4, 5 and
// 6 before the exact-match key finally caught turn 7. Turn 5 had the same three
// ops in a different order.

const LIST = { a: "inspect", ops: [{ a: "list_dir", p: "bin" }, { a: "list_dir", p: "src/factory" }, { a: "list_dir", p: "scripts" }] };
const LISTING = "# 1 {\"a\":\"list_dir\",\"p\":\"bin\"}\nbin:\nbantam.js\n\n# 2 …";
const TEST = { a: "shell", c: "node --test test/ordered-map.test.js" };
const FAILED = "tests 1\npass 0\nfail 1\nexit code: 1";

test("a deduplicated read never claims its last run FAILED", () => {
  const guard = new RepetitionGuard({});
  guard.record(LIST, LISTING, { turn: 6 });
  const { observation } = guard.check(LIST);
  assert.doesNotMatch(observation, /FAILED/);
  assert.match(observation, /already ran this exact action on turn 6 and the workspace has not changed since, so it was not executed again\./);
});

test("a confirmed shell failure is stated after the sentence, not inside it", () => {
  const guard = new RepetitionGuard({ dedupeShell: true });
  for (let turn = 1; turn <= 3; turn++) guard.record(TEST, FAILED, { turn, shellWorkspaceUnchanged: true });
  const { observation } = guard.check(TEST);
  assert.match(observation, /no workspace file has changed since, so it was not executed again\./);
  assert.match(observation, /not executed again\.[^]*last real run FAILED/);
  assert.doesNotMatch(observation, /done\.since/);
});

test("the steer names a `map` query only when the guard is told the tool exists", () => {
  const without = new RepetitionGuard({});
  without.record(LIST, LISTING, { turn: 2 });
  assert.doesNotMatch(without.check(LIST).observation, /`map`/);
  assert.match(without.check(LIST).observation, /do something different/);

  const withMap = new RepetitionGuard({ mapAvailable: true });
  withMap.record(LIST, LISTING, { turn: 2 });
  assert.match(withMap.check(LIST).observation, /`map` query/);
});

test("an inspect is a duplicate when its ops were already run, whatever their order", () => {
  const guard = new RepetitionGuard({});
  guard.record(LIST, LISTING, { turn: 5 });
  const reordered = { a: "inspect", ops: [LIST.ops[1], LIST.ops[0], LIST.ops[2]] };
  const duplicate = guard.check(reordered);
  assert.ok(duplicate, "same three listings in a different order must not execute again");
  assert.equal(duplicate.duplicateOfTurn, 5);
});

test("an inspect is a duplicate when earlier inspects already covered every op", () => {
  const guard = new RepetitionGuard({});
  guard.record({ a: "inspect", ops: [{ a: "list_dir", p: "src/logic" }, { a: "list_dir", p: "src/factory" }] }, LISTING, { turn: 4 });
  guard.record({ a: "inspect", ops: [{ a: "list_dir", p: "bin" }, { a: "list_dir", p: "scripts" }] }, LISTING, { turn: 5 });
  const duplicate = guard.check(LIST);
  assert.ok(duplicate, "every op was run on turn 4 or 5");
  assert.equal(duplicate.duplicateOfTurn, 5, "the newest covering turn is the provenance");
  assert.match(duplicate.observation, /already ran every op in this action on turn 5/);
  // An op nobody has run yet is new information: execute.
  const partlyNew = { a: "inspect", ops: [LIST.ops[0], { a: "list_dir", p: "docs" }] };
  assert.equal(guard.check(partlyNew), null);
  // An edit invalidates the op memory like everything else.
  guard.noteWorkspaceChanged();
  assert.equal(guard.check(LIST), null);
});

test("history compaction keeps the steer on an every-op notice too", () => {
  const guard = new RepetitionGuard({});
  guard.record({ a: "inspect", ops: [LIST.ops[0]] }, LISTING, { turn: 4 });
  guard.record({ a: "inspect", ops: [LIST.ops[1], LIST.ops[2]] }, LISTING, { turn: 5 });
  const notice = guard.check(LIST).observation;
  const out = compactHistory([
    { i: 3, action: { a: "inspect", ops: [LIST.ops[0]] }, observation: LISTING },
    { i: 4, action: { a: "inspect", ops: [LIST.ops[1], LIST.ops[2]] }, observation: LISTING },
    { i: 6, action: LIST, observation: notice },
  ]);
  assert.match(out[2].observation, /do something different/);
});
