import assert from "node:assert/strict";
import test from "node:test";
import { budgetTurns, compactHistory, recordDeliveredSourceLines } from "../src/history-budget.js";
import { buildPrompt } from "../src/prompt.js";
import { clipText, OBS_MAX } from "../src/clip.js";

const sourceLine = number => `const value${number} = "SOURCE_VALUE_${String(number).padStart(3, "0")}"; // source context detail`;
function source(path, start, end, total = end) {
  return `${path} (${total} lines, showing ${start}-${end}):\n`
    + Array.from({ length: end - start + 1 }, (_, offset) => {
      const number = start + offset;
      return `${number}\t${sourceLine(number)}\n`;
    }).join("");
}
const read = (i, start, end, suffix = "", name = "module.js") => ({
  i, action: { a: "read_file", p: name, start, limit: end - start + 1 },
  observation: source(name, start, end, 117) + suffix,
});
function render(turns, options = {}) {
  const delivered = new Map();
  const prompt = buildPrompt({
    task: "Inspect the module and verify its behavior.", env: "local workspace",
    turns: budgetTurns(turns, { charBudget: 100000 }), extensionTrajectory: true,
    onRenderedObservation: (turn, text) => delivered.set(turn.i, text), ...options,
  });
  return { prompt, delivered };
}

test("a fresh narrow reread restores source hidden by clipping appended guidance", () => {
  // Recorded shape: read 40–117; an appended working note occupies the kept
  // tail, so source near the end disappears despite remaining in raw evidence.
  const original = read(6, 40, 117, "\n[guidance]\n" + "audit hypothesis ".repeat(650));
  const repeat = read(7, 86, 117);
  const rawBefore = JSON.stringify([original, repeat]);
  const { delivered, prompt } = render([original, repeat]);
  assert.ok(delivered.get(6).length <= OBS_MAX);
  assert.doesNotMatch(delivered.get(6), /108\tconst value108/);
  assert.match(delivered.get(7), /108\tconst value108/);
  assert.doesNotMatch(delivered.get(7), /L86-L117 unchanged from turn 7/);
  assert.ok(delivered.get(7).length <= OBS_MAX);
  assert.match(prompt, /108\tconst value108/);
  assert.equal(JSON.stringify([original, repeat]), rawBefore, "raw evidence is not rewritten");
  assert.doesNotMatch(JSON.stringify(compactHistory([original, repeat])), /rawSourceObservation/);
});

test("plain 4K clipping does not grant source-pointer credit to clipped middle lines", () => {
  const original = read(0, 1, 117), repeatedMiddle = read(1, 70, 75);
  const { delivered } = render([original, repeatedMiddle]);
  assert.doesNotMatch(delivered.get(0), /70\tconst value70/);
  assert.match(delivered.get(1), /70\tconst value70/);
  assert.match(delivered.get(1), /75\tconst value75/);
  assert.doesNotMatch(delivered.get(1), /source range/);
});

test("final controller-annotation clipping, not the budget estimate, owns source visibility", () => {
  const annotations = ["auto-verify", "completion-audit", "progress-awareness"]
    .map(tag => `\n[${tag}] important controller fact ${"quoted diagnostics ".repeat(90)}`).join("");
  const original = read(0, 1, 60, annotations), repeat = read(1, 40, 45);
  const budgetView = compactHistory([original, repeat]);
  assert.match(budgetView[1].observation, /source range/, "the ordinary 4K estimate sees some of these lines");
  const { delivered } = render([original, repeat], { preserveSlimmedControlAnnotations: true });
  assert.doesNotMatch(delivered.get(0), /40\tconst value40/);
  assert.match(delivered.get(1), /40\tconst value40/);
  assert.match(delivered.get(0), /important controller fact/);
  assert.ok(delivered.get(0).length <= OBS_MAX);
});

test("fully delivered equivalent ranges still compact, without pointer-to-pointer origins", () => {
  const { delivered } = render([read(0, 10, 15), read(1, 10, 15), read(2, 10, 15)]);
  assert.match(delivered.get(0), /10\tconst value10/);
  assert.match(delivered.get(1), /L10-L15 unchanged from turn 1/);
  assert.match(delivered.get(2), /L10-L15 unchanged from turn 1/);
  assert.doesNotMatch(delivered.get(2), /unchanged from turn 2/);
  assert.ok(delivered.get(1).length < delivered.get(0).length);
});

test("a clipping gap cannot assign another file's orphaned tail to the preceding header", () => {
  const observation = source("first.js", 1, 2, 117) + "unrelated output ".repeat(300)
    + "\n" + source("second.js", 1, 117, 117);
  const delivered = clipText(observation), known = new Map();
  assert.match(delivered, /117\tconst value117/);
  assert.doesNotMatch(delivered, /second\.js \(117 lines/);
  recordDeliveredSourceLines(delivered, known, 1);
  assert.equal(known.get("first.js")?.has(117), false);
  assert.equal(known.has("second.js"), false);
  const result = render([
    { i: 0, action: { a: "inspect", ops: [] }, observation },
    read(1, 117, 117, "", "second.js"),
  ]);
  assert.match(result.delivered.get(1), /117\tconst value117/);
  assert.doesNotMatch(result.delivered.get(1), /source range/);
});

test("visible file headers retain separate source identities", () => {
  const observation = source("first.js", 1, 2) + source("second.js", 1, 2);
  const { delivered } = render([
    { i: 0, action: { a: "inspect", ops: [] }, observation },
    { i: 1, action: { a: "read_file", p: "third.js" }, observation: source("third.js", 1, 2) },
    { i: 2, action: { a: "read_file", p: "second.js" }, observation: source("second.js", 1, 2) },
  ]);
  assert.match(delivered.get(1), /1\tconst value1/);
  assert.match(delivered.get(2), /second\.js:L1-L2 unchanged from turn 1/);
});

test("a partially delivered numbered line cannot become a complete source origin", () => {
  const known = new Map();
  recordDeliveredSourceLines("module.js (2 lines, showing 1-2):\n1\tconst value1 =\n... [80 chars clipped] ...\n2\tend\n", known, 1);
  assert.equal(known.get("module.js").size, 0);
});

test("frozen-prefix replay uses frozen delivery, even when raw history is later recomputed", () => {
  const cache = new Map();
  const original = read(0, 40, 117, "\n[guidance]\n" + "old working note ".repeat(650));
  const middle = { i: 1, action: { a: "shell", c: "check" }, observation: "check remains pending" };
  const first = render([original, middle], { renderCache: cache });
  const frozenFragment = cache.get(0);
  assert.doesNotMatch(frozenFragment, /108\tconst value108/);
  // A recomputed raw observation now fits more source, but that cannot change
  // either the old fragment or what new pointers claim the old fragment holds.
  const second = render([read(0, 40, 117), middle, read(2, 86, 117)], { renderCache: cache });
  assert.equal(cache.get(0), frozenFragment);
  assert.ok(second.prompt.startsWith(first.prompt), "the previous emitted prompt is an exact prefix");
  assert.match(second.delivered.get(2), /108\tconst value108/);
  const third = render([read(0, 40, 117), middle, read(2, 86, 117), read(3, 108, 112)], { renderCache: cache });
  assert.ok(third.prompt.startsWith(second.prompt));
  assert.match(third.delivered.get(3), /L108-L112 unchanged from turn 3/);
});

test("evicted cached origins cannot supply source knowledge to a smaller current window", () => {
  const cache = new Map(), origin = read(0, 10, 15);
  render([origin, { i: 1, action: { a: "shell", c: "check" }, observation: "pending" }], { renderCache: cache });
  const turns = [origin, { i: 1, action: { a: "write_file", p: "large.txt", content: "x".repeat(5000) }, observation: "wrote" }, read(2, 10, 15)];
  const window = budgetTurns(turns, { charBudget: 700 });
  assert.deepEqual(window.map(turn => turn.i), [2]);
  const { delivered } = render(window, { renderCache: cache });
  assert.match(delivered.get(2), /10\tconst value10/);
  assert.doesNotMatch(delivered.get(2), /source range/);
});

test("budget eviction rebases frozen public-test pointers and preserves unrelated frozen bytes", () => {
  // repair3 shape: pinned grounding turn 1; public-test read at turn 2;
  // repeated public-test reads survive after their original read is evicted.
  const cache = new Map();
  const head = { i: 0, action: { a: "list_dir", p: "." }, observation: "snapshot.js\ntest/" };
  const origin = read(1, 1, 32, "", "test/snapshot.test.js");
  const barrier = { i: 2, action: { a: "write_file", p: "large.txt", content: "x".repeat(20000) }, observation: "wrote" };
  const unchanged = { i: 3, action: { a: "shell", c: "check" }, observation: "unchanged control result" };
  const first = read(4, 1, 32, "", "test/snapshot.test.js");
  const second = read(5, 1, 32, "", "test/snapshot.test.js");
  const tail = { i: 6, action: { a: "list_dir", p: "." }, observation: "current tree" };
  const turns = [head, origin, barrier, unchanged, first, second, tail];
  const rawBefore = JSON.stringify(turns);
  render(turns, { renderCache: cache });
  const stableFragment = cache.get(3);
  assert.match(cache.get(4), /L1-L32 unchanged from turn 2/);
  assert.match(cache.get(5), /L1-L32 unchanged from turn 2/);
  const window = budgetTurns(turns, { charBudget: 4500, pinHead: true });
  assert.deepEqual(window.map(turn => turn.i), [0, 3, 4, 5, 6]);
  const repaired = render(window, { renderCache: cache });
  assert.equal(cache.get(3), stableFragment, "unrelated cached bytes stay frozen");
  assert.match(cache.get(4), /32\tconst value32/);
  assert.doesNotMatch(repaired.prompt, /unchanged from turn 2/);
  assert.match(cache.get(5), /L1-L32 unchanged from turn 5/);
  assert.doesNotMatch(cache.get(5), /32\tconst value32/);
  const appended = render([...window, read(7, 1, 32, "", "test/snapshot.test.js")], { renderCache: cache });
  assert.ok(appended.prompt.startsWith(repaired.prompt), "ordinary append is byte-stable after rebase");
  assert.match(appended.delivered.get(7), /L1-L32 unchanged from turn 5/);
  assert.equal(JSON.stringify(turns), rawBefore, "canonical evidence is untouched");
});

test("rebasing an origin that clips more source also repairs its surviving frozen dependents", () => {
  const cache = new Map();
  const origin = read(0, 1, 35);
  const expanded = read(1, 1, 50, "\n[guidance]\n" + "long working note ".repeat(650));
  const dependent = read(2, 45, 50);
  const tail = { i: 3, action: { a: "shell", c: "check" }, observation: "pending" };
  render([origin, expanded, dependent, tail], { renderCache: cache });
  assert.match(cache.get(1), /50\tconst value50/);
  assert.match(cache.get(2), /L45-L50 unchanged from turn 2/);
  // Turn 2 survives, but expanding its pointer to the now-evicted turn 1
  // consumes the same 4K cap and clips bytes that turn 3 used to point at.
  const repaired = render([expanded, dependent, tail], { renderCache: cache });
  assert.doesNotMatch(repaired.delivered.get(1), /50\tconst value50/);
  assert.match(repaired.delivered.get(2), /50\tconst value50/);
  assert.doesNotMatch(repaired.delivered.get(2), /L45-L50 unchanged from turn 2/);
  assert.ok(repaired.delivered.get(1).length <= OBS_MAX);
  assert.ok(repaired.delivered.get(2).length <= OBS_MAX);
  assert.doesNotMatch(repaired.prompt, /unchanged from turn 1/);
});

test("an eviction rebase preserves the originally frozen action and observation evidence", () => {
  const cache = new Map(), origin = read(0, 10, 15);
  const duplicate = read(1, 10, 15, "\noriginal controller note");
  const tail = { i: 2, action: { a: "shell", c: "check" }, observation: "pending" };
  render([origin, duplicate, tail], { renderCache: cache });
  assert.match(cache.get(1), /L10-L15 unchanged from turn 1/);
  const recomputed = { ...duplicate, action: { a: "read_file", p: "wrong.js", start: 999 },
    observation: "retroactively recomputed observation" };
  render([recomputed, tail], { renderCache: cache });
  assert.match(cache.get(1), /10\tconst value10/);
  assert.match(cache.get(1), /original controller note/);
  assert.match(cache.get(1), /"p":"module.js","start":10/);
  assert.doesNotMatch(cache.get(1), /wrong\.js|retroactively recomputed|unchanged from turn 1/);
});
