import test from "node:test";
import assert from "node:assert/strict";

import { budgetTurns } from "../src/history-budget.js";

// Twelve DISTINCT turns (identical observations would dedup to pointers and
// never exceed a budget), sized so a 6k budget keeps only the newest few.
const turns = Array.from({ length: 12 }, (_, i) => ({
  i,
  action: { a: "shell", c: `cmd${i}` },
  observation: `obs${i} `.repeat(200) + String(i).repeat(50),
}));

test("default eviction drops the OLDEST turns — including turn 0", () => {
  const w = budgetTurns(turns, { charBudget: 6000 });
  assert.ok(w.length < turns.length, "fixture must actually exceed the budget");
  assert.notEqual(w[0].i, 0, "without the pin, turn 0 is the first to go");
});

test("pinHead keeps turn 0 and budgets the window behind it", () => {
  const w = budgetTurns(turns, { charBudget: 6000, pinHead: true });
  assert.equal(w[0].i, 0, "turn 0 survives");
  // the rest of the window is still the NEWEST turns, contiguous
  const rest = w.slice(1).map((t) => t.i);
  assert.deepEqual(rest, rest.slice().sort((a, b) => a - b));
  assert.equal(rest[rest.length - 1], 11);
  // and the pin costs roughly one slot, not the whole budget
  const base = budgetTurns(turns, { charBudget: 6000 });
  assert.ok(w.length >= base.length - 1 && w.length <= base.length + 1);
});

test("pinHead is a no-op when everything fits, and on a single turn", () => {
  assert.equal(budgetTurns(turns, { charBudget: 1e6, pinHead: true }).length, 12);
  const one = budgetTurns(turns.slice(0, 1), { charBudget: 10, pinHead: true });
  assert.equal(one.length, 1);
});

test("typed context updates consume history budget without losing the newest update", () => {
  const small = Array.from({ length: 4 }, (_, i) => ({ i, observation: `unique ${i}` }));
  assert.equal(budgetTurns(small, { charBudget: 5000 }).length, 4);
  const withUpdates = small.map((turn) => ({ ...turn,
    contextUpdates: [{ schema: 1, id: `update-${turn.i}`, kind: "decision", generation: turn.i,
      text: String(turn.i).repeat(2800), paths: [{ path: "source.js" }] }],
  }));
  const kept = budgetTurns(withUpdates, { charBudget: 5000 });
  assert.deepEqual(kept.map((turn) => turn.i), [3]);
  assert.deepEqual(kept[0].contextUpdates, withUpdates[3].contextUpdates);
  assert.deepEqual(withUpdates.map((turn) => turn.contextUpdates[0].text.length), [2800, 2800, 2800, 2800]);
});
