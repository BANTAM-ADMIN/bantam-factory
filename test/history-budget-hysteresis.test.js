import test from "node:test";
import assert from "node:assert/strict";
import { budgetTurns, createHistoryWindow, sourcePointerOrigins } from "../src/history-budget.js";

const turns = count => Array.from({ length: count }, (_, i) => ({ i,
  parsedAction: { a: "read_file", p: `source-${i}.js` },
  observation: `distinct turn ${i}: ` + String.fromCharCode(65 + i % 26).repeat(1000) }));
const ids = window => window.map(turn => turn.i);

test('capacity updates preserve the retained prefix and never resurrect evicted history', () => {
  const history=turns(15),events=[];
  const window=createHistoryWindow({charBudget:6000,onRebase:e=>events.push(e)});
  const initial=ids(window(history.slice(0,12)));
  assert.ok(initial[1]>1);
  window.setBudget(20000);
  assert.deepEqual(ids(window(history.slice(0,12))),initial);
  assert.deepEqual(ids(window(history)),[...initial,12,13,14]);
  window.setBudget(4000);
  const reduced=ids(window(history));
  assert.ok(reduced.every(id=>[...initial,12,13,14].includes(id)));
  assert.equal(events.at(-1).hardCharBudget,4000);
  for(const invalid of [0,-1,NaN,Infinity,1.5])assert.throws(()=>window.setBudget(invalid),/positive integer/);
});

test("extension keeps its cutoff across repeated builds and rebases in chunks without raising the hard cap", () => {
  const history = turns(24), events = [];
  const window = createHistoryWindow({ charBudget: 6500, onRebase: event => events.push(event) });
  let previousCutoff = 1, shifted = 0;
  for (let n = 1; n <= history.length; n++) {
    const kept = window(history.slice(0, n));
    assert.equal(kept[0].i, 0);
    assert.equal(kept.at(-1).i, n - 1);
    if (kept.length > 1) {
      const cutoff = kept[1].i;
      assert.ok(cutoff >= previousCutoff, "an evicted turn does not reappear");
      if (cutoff !== previousCutoff) shifted++;
      previousCutoff = cutoff;
    }
    const count = events.length;
    assert.deepEqual(window(history.slice(0, n)), kept, "a second reasoning/action build is stable");
    assert.equal(events.length, count, "identical builds do not emit another rebase");
    assert.equal(budgetTurns(kept, { charBudget: 6500, pinHead: true }).length, kept.length);
  }
  assert.ok(shifted > 1 && shifted < 10, `chunked, not every-turn eviction: ${shifted}`);
  assert.ok(events.every(event => event.reason === "overflow" && event.hardCharBudget === 6500
    && event.targetCharBudget === 4333 && event.afterChars <= event.targetCharBudget));
});

test("shortened current observations do not resurrect dropped evidence; input objects remain untouched", () => {
  const history = turns(12), original = JSON.stringify(history);
  const window = createHistoryWindow({ charBudget: 6000 });
  const initial = ids(window(history));
  const shortened = history.map(turn => ({ ...turn, observation: `short ${turn.i}` }));
  // Preserve the pinned origin so this is the same transcript, not a new run.
  shortened[0] = history[0];
  assert.deepEqual(ids(window(shortened)), initial);
  assert.equal(JSON.stringify(history), original);
});

test("newest synthetic tail and oversized required turns survive with truthful bounded diagnostics", () => {
  const history = turns(5), events = [];
  const window = createHistoryWindow({ charBudget: 2000, onRebase: event => events.push(event) });
  const synthetic = { i: 5, observation: "newest causal evidence ".repeat(2000) };
  const kept = window([...history, synthetic]);
  assert.deepEqual(ids(kept), [0, 5]);
  assert.ok(events.at(-1).oversizedRequiredTurns);
  assert.ok(events.at(-1).afterChars > events.at(-1).hardCharBudget);
  const count = events.length;
  assert.deepEqual(ids(window([...history, synthetic])), [0, 5]);
  assert.equal(events.length, count);
});

test("actual unnumbered repair/wrap-up tail neither resets the boundary nor resurrects history when removed", () => {
  const history = turns(12), events = [];
  const window = createHistoryWindow({ charBudget: 6000, onRebase: event => events.push(event) });
  const initial = ids(window(history));
  const synthetic = { observation: "WRAP_UP_NOTE current repair instruction ".repeat(90) };
  const withTail = window([...history, synthetic]);
  const retainedReal = ids(withTail.filter(turn => Number.isInteger(turn.i)));
  assert.ok(retainedReal.every(id => initial.includes(id)));
  assert.ok(retainedReal.includes(11), "the latest real causal action survives alongside its steer");
  assert.equal(withTail.at(-1).observation, synthetic.observation);
  assert.ok(events.every(event => event.reason === "overflow" && event.keyKind === "turn-id"));
  assert.deepEqual(ids(window(history)), retainedReal, "tail removal is not a rewind");
  const extended = turns(13);
  const after = ids(window(extended));
  assert.deepEqual(after, [...retainedReal, 12]);
  assert.ok(events.every(event => event.reason === "overflow"));
});

test("rewind, changed origin and empty restart reset retained boundaries explicitly", () => {
  const events = [], window = createHistoryWindow({ charBudget: 6000, onRebase: event => events.push(event) });
  const history = turns(12);
  assert.ok(window(history)[1].i > 1);
  assert.deepEqual(ids(window(history.slice(0, 3))), [0, 1, 2]);
  assert.equal(events.at(-1).reason, "rewind");
  window(history);
  const next = turns(3); next[0] = { ...next[0], observation: "a different initial grounding" };
  assert.deepEqual(ids(window(next)), [0, 1, 2]);
  assert.equal(events.at(-1).reason, "origin-changed");
  assert.deepEqual(window([]), []);
  assert.deepEqual(ids(window(history.slice(0, 2))), [0, 1]);
});

test("external history cap is honored and source pointers name only retained earlier origins", () => {
  const window = createHistoryWindow({ charBudget: 6000 });
  const history = turns(12).map(turn => ({ ...turn,
    observation: `shared.js (1 lines, showing 1-1):\n1\tconst same = 1;\nunique ${turn.i} ` + "x".repeat(1000) }));
  window(history);
  const capped = history.slice(-3), kept = window(capped);
  assert.deepEqual(ids(kept), [9, 10, 11]);
  const retained = new Set(kept.map(turn => turn.i + 1));
  for (const turn of kept) for (const origin of sourcePointerOrigins(turn.observation)) {
    assert.ok(retained.has(origin)); assert.ok(origin < turn.i + 1);
  }
});

test("unpinned or unnumbered histories remain bounded and invalid retention ratios are rejected", () => {
  const window = createHistoryWindow({ charBudget: 3000, pinHead: false });
  const history = turns(10).map(({ i, ...turn }) => turn);
  const kept = window(history);
  assert.ok(kept.length < history.length);
  assert.equal(kept.at(-1).observation, history.at(-1).observation);
  assert.deepEqual(window(history), kept);
  for (const retainRatio of [0, 1, -1, NaN, Infinity]) assert.throws(() => createHistoryWindow({ retainRatio }), /retainRatio/);
});
