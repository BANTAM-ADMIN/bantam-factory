// The startup picker is the first station, and its lit button was wrong.
//
// `recommended` was hardcoded to gpt-5.6-terra, so on a machine with six
// certified local profiles the cloud model was [1] and the local daily driver
// was an unmarked [4]. Worse, the ordering contradicted what was measured: the
// unified-KV `crew` profile (11x slower on alternating work, strictly dominated
// by crewsplit) sat above both of them, with nothing to say so.
//
// The registry already carried a `priority` field that nothing read. It reads it
// now: the machine's own registry decides what is recommended, and a fresh
// machine with no local models still falls back to the cloud default, because
// there that IS the right first move.
import assert from "node:assert/strict";
import test from "node:test";

import { startupModelChoices, resolveStartupModelChoice } from "../src/startup-model-choice.js";

const locals = [
  { name: "bantam-q4-crew", endpoint: "http://x:1", slots: 4, priority: 10,
    warn: "unified KV: a worker returning after a sibling ran loses its whole cache" },
  { name: "bantam-q4", endpoint: "http://x:1", slots: 1, priority: 100 },
  { name: "bantam-q4-crewsplit", endpoint: "http://x:1", slots: 4, priority: 80 },
];

test("the highest-priority local is recommended and comes first", () => {
  const c = startupModelChoices({ locals, catalog: [], preference: null });
  assert.equal(c[0].name, "bantam-q4", "the certified daily driver is the lit button");
  assert.equal(c[0].recommended, true);
  assert.equal(c.filter((x) => x.recommended).length, 1, "exactly one lit button");
});

test("locals are ordered by priority, so the measured hierarchy is the menu order", () => {
  const c = startupModelChoices({ locals, catalog: [], preference: null });
  assert.deepEqual(
    c.filter((x) => x.kind === "local").map((x) => x.name),
    ["bantam-q4", "bantam-q4-crewsplit", "bantam-q4-crew"],
    "crew is measurably the worst for concurrent work and must not sit above crewsplit",
  );
});

test("locals precede the cloud entries on a machine that has them", () => {
  const c = startupModelChoices({ locals, catalog: [], preference: null });
  const firstCloud = c.findIndex((x) => x.kind !== "local");
  const lastLocal = c.map((x) => x.kind).lastIndexOf("local");
  assert.ok(lastLocal < firstCloud, "a local-first factory should read as one");
});

test("a fresh machine with no local models still recommends the cloud default", () => {
  const c = startupModelChoices({ locals: [], catalog: [], preference: null });
  assert.equal(c[0].name, "codex-terra");
  assert.equal(c[0].recommended, true, "with nothing registered, this IS the right first move");
});

test("a warning rides with the entry that earned it", () => {
  const c = startupModelChoices({ locals, catalog: [], preference: null });
  const crew = c.find((x) => x.name === "bantam-q4-crew");
  assert.match(crew.detail, /unified KV/, "the reason not to pick it must be visible at the moment of picking");
  const solo = c.find((x) => x.name === "bantam-q4");
  assert.doesNotMatch(solo.detail ?? "", /unified KV/);
});

test("unprioritised locals still appear, after the ranked ones", () => {
  const c = startupModelChoices({ locals: [...locals, { name: "unranked", endpoint: "http://x:1" }], catalog: [], preference: null });
  const names = c.filter((x) => x.kind === "local").map((x) => x.name);
  assert.equal(names.at(-1), "unranked");
  assert.equal(names[0], "bantam-q4");
});

test("Enter selects the recommended entry rather than cancelling", () => {
  const c = startupModelChoices({ locals, catalog: [], preference: null });
  assert.equal(resolveStartupModelChoice(c, "", { enterSelectsRecommended: true })?.name, "bantam-q4");
  // Without the opt-in the old meaning holds, so nothing else that calls this changes.
  assert.equal(resolveStartupModelChoice(c, ""), null);
  // An explicit cancel is still possible.
  assert.equal(resolveStartupModelChoice(c, "q", { enterSelectsRecommended: true }), null);
  assert.equal(resolveStartupModelChoice(c, "2", { enterSelectsRecommended: true }).name, "bantam-q4-crewsplit");
});
