import assert from "node:assert/strict";
import test from "node:test";

import { buildPrompt } from "../src/prompt.js";

// Two passes write addresses into history and they run in this order:
// compactHistory (history-budget.js) collapses a repeated observation to
// "[history compacted at turn N: exact observation remains at turn M]", and
// THEN prompt.js may replace turn M's own observation with
// "[turn M: <path> — earlier snapshot omitted; read_file for current contents]".
//
// The first address was true when written and false by the time the model reads
// it: following it lands on another address. Measured across 34 stored runs,
// 208 of 1,499 "exact observation remains at turn M" claims pointed at a turn
// that was itself only a pointer. (None pointed outside the window — the
// eviction guard in history-budget.js already covers that case.)
//
// Pointers only ever refer backwards, so the target's fate is always known by
// the time the pointer is rendered.

const FILE = "src/thing.js";
const BODY = `${FILE} (3 lines, showing 1-3):\n1\texport const a = 1;\n2\texport const b = 2;\n3\texport const c = 3;`;

const base = {
  task: "Adjust thing.js.",
  env: "node 20",
  openPaths: [FILE],
  readPaths: [FILE],   // the panel renders it completely, so reads of it collapse
  openFilesText: `# ${FILE} (current, 3 lines)\n1\texport const a = 1;\n2\texport const b = 2;\n3\texport const c = 3;`,
};

// turn 1 reads the file (prompt.js will stub it — the panel has the bytes);
// turn 3 carries a compaction pointer aimed at turn 1. Its own action is a
// search, so nothing else rewrites it: a read of a panel-covered path would be
// replaced by the stub before the pointer was ever rendered.
const turns = [
  { i: 0, action: { a: "read_file", p: FILE }, observation: BODY },
  { i: 1, action: { a: "search", q: "b", p: FILE }, observation: `${FILE}:2: export const b = 2;` },
  { i: 2, action: { a: "search", q: "a", p: FILE }, observation: "[history compacted at turn 3: exact observation remains at turn 1]" },
];

test("a pointer whose target was hollowed out says so", () => {
  const prompt = buildPrompt({ ...base, turns });
  assert.match(prompt, /\[turn 1: src\/thing\.js — earlier snapshot omitted/, "the target is in fact stubbed");
  assert.doesNotMatch(
    prompt,
    /exact observation remains at turn 1\]/,
    "an address pointing at a stub must not survive as if it resolved",
  );
  assert.match(prompt, /identical to turn 1, whose snapshot has since been omitted; read_file for current contents/);
});

test("a pointer at an intact turn is left alone", () => {
  // turn 2's observation is a search result, which nothing stubs.
  const intact = [
    turns[0],
    turns[1],
    { i: 2, action: { a: "search", q: "b", p: FILE }, observation: "[history compacted at turn 3: exact observation remains at turn 2]" },
  ];
  const prompt = buildPrompt({ ...base, turns: intact });
  assert.match(prompt, /exact observation remains at turn 2\]/, "a resolvable address is still the most useful form");
});

test("the rewrite does not fire when nothing was stubbed", () => {
  // No panel coverage -> no superseded reads -> every address still resolves.
  const prompt = buildPrompt({
    ...base,
    readPaths: [],
    openFilesText: `# ${FILE} (current, 3 lines)\n1\texport const a = 1;\n… (panel truncated at 64 bytes — use read_file)`,
    turns,
  });
  assert.match(prompt, /exact observation remains at turn 1\]/);
});
