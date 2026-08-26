import assert from "node:assert/strict";
import test from "node:test";

import { buildPrompt } from "../src/prompt.js";

// History retained the newest read of each PATH. A model working two distant
// areas of one big file therefore oscillates: each read evicts the other, so
// neither is ever resident and both are re-fetched forever.
//
// django-11211 (2026-08-17, benches/swebench/runs/) read
// django/db/models/fields/__init__.py — 2,356 lines — sixteen times across four
// distinct ranges, twelve of them repeats, alternating 2309+50 with 771+10. The
// panel renders 66-148 lines of that file and covered the requested start line
// in one of thirteen reads. The run hit its 40-turn cap having never verified.

const FILE = "src/big.js";
const body = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\tconst v${from + i} = ${from + i};`).join("\n");
const readObs = (from, to) => `${FILE} (2356 lines, showing ${from}-${to}):\n${body(from, to)}`;

const base = {
  task: "Work across two regions of a big file.",
  env: "node 20",
  openPaths: [FILE],
  readPaths: [],                       // the panel lists it but cannot render it whole
  openFilesText: `# ${FILE} (current, 2356 lines)\n1\tconst v1 = 1;\n… (2355 more lines omitted — use read_file to page the rest)`,
  // The file was slimmed once, so it stays slimmed (the sticky rule) while the
  // panel can no longer render it whole. That is the state where retention
  // decides what the model still has.
  everSlimmedPaths: new Set([FILE]),
};

const turns = [
  { i: 0, action: { a: "read_file", p: FILE, start: 771, limit: 10 }, observation: readObs(771, 780) },
  { i: 1, action: { a: "search", q: "v2309", p: FILE }, observation: `${FILE}:2309: const v2309 = 2309;` },
  { i: 2, action: { a: "read_file", p: FILE, start: 2309, limit: 50 }, observation: readObs(2309, 2358) },
];

test("both regions survive when the panel cannot hold the file", () => {
  const prompt = buildPrompt({ ...base, turns });
  assert.match(prompt, /showing 2309-2358/, "the newest read is retained");
  assert.match(prompt, /showing 771-780/, "and so is the other region the model is working");
});

test("an older read of the SAME region still collapses", () => {
  // Retaining every read of one area would be churn, not memory.
  const repeated = [
    { i: 0, action: { a: "read_file", p: FILE, start: 2309, limit: 50 }, observation: readObs(2309, 2358) },
    { i: 1, action: { a: "search", q: "v1", p: FILE }, observation: `${FILE}:1: const v1 = 1;` },
    { i: 2, action: { a: "read_file", p: FILE, start: 2309, limit: 50 }, observation: readObs(2309, 2358) },
  ];
  const prompt = buildPrompt({ ...base, turns: repeated });
  const shown = [...prompt.matchAll(/showing 2309-2358/g)].length;
  assert.equal(shown, 1, "one copy of a region, not one per read");
});

test("retention is bounded", () => {
  // Four distinct regions, three kept: a working set, not a transcript.
  const many = [
    { i: 0, action: { a: "read_file", p: FILE, start: 100, limit: 10 }, observation: readObs(100, 109) },
    { i: 1, action: { a: "read_file", p: FILE, start: 700, limit: 10 }, observation: readObs(700, 709) },
    { i: 2, action: { a: "read_file", p: FILE, start: 1400, limit: 10 }, observation: readObs(1400, 1409) },
    { i: 3, action: { a: "read_file", p: FILE, start: 2300, limit: 10 }, observation: readObs(2300, 2309) },
  ];
  const prompt = buildPrompt({ ...base, turns: many });
  const kept = ["showing 100-109", "showing 700-709", "showing 1400-1409", "showing 2300-2309"]
    .filter((probe) => prompt.includes(probe));
  assert.equal(kept.length, 3, `three newest distinct regions, got ${JSON.stringify(kept)}`);
  assert.ok(!kept.includes("showing 100-109"), "the oldest region is the one dropped");
});

test("a read older than an edit to that file stays collapsed", () => {
  // Staleness still wins over regionality: those bytes are no longer true.
  const stale = [
    { i: 0, action: { a: "read_file", p: FILE, start: 771, limit: 10 }, observation: readObs(771, 780) },
    { i: 1, action: { a: "replace", p: FILE, old: "a", new: "b" }, observation: `replaced 1 occurrence in ${FILE}`, editApplied: true },
    { i: 2, action: { a: "read_file", p: FILE, start: 2309, limit: 50 }, observation: readObs(2309, 2358) },
  ];
  const prompt = buildPrompt({ ...base, turns: stale });
  assert.match(prompt, /showing 2309-2358/);
  assert.doesNotMatch(prompt, /showing 771-780/, "pre-edit bytes must not be presented as current");
});

// PINS, not fixes — these passed when written, and that is the finding.
//
// The region rule above reads `turns[i].action`, so it only ever sees a
// TOP-LEVEL read_file, while 72% of the reads in the stored corpus (1,412 of
// 1,972) are read ops inside an `inspect` batch. That looked like a coverage
// hole of the same shape as the search steer's. It is not: the slimming pass the
// rule protects against only ever stubs read_file turns, so an inspect batch's
// regions were never at risk from it. The rule is narrow and so is the threat.
//
// What the budget does NOT do is bound an inspect batch, and that is left alone
// deliberately: applying it there would REMOVE retention that exists today, to
// enforce a limit nothing has shown a need for.
//
// These pin the behaviour so a later edit to either pass cannot quietly drop it.
// django-11211, which motivated the region rule, read entirely at top level (17
// reads, 0 sub-ops), so the rule did cover the run it was built for.
const inspectRead = (i, regions) => ({
  i,
  action: { a: "inspect", ops: regions.map(([from, to]) => ({ a: "read_file", p: FILE, start: from, limit: to - from + 1 })) },
  observation: regions.map(([from, to]) => readObs(from, to)).join("\n\n"),
});

test("regions read inside an inspect batch are retained too", () => {
  const turns = [
    inspectRead(0, [[771, 780]]),
    { i: 1, action: { a: "search", q: "v2309", p: FILE }, observation: `${FILE}:2309: const v2309 = 2309;` },
    inspectRead(2, [[2309, 2358]]),
  ];
  const prompt = buildPrompt({ ...base, turns });
  assert.match(prompt, /showing 2309-2358/, "the newest read is retained");
  assert.match(prompt, /showing 771-780/, "and so is the other region, read the same way");
});

test("a batch reading two regions at once keeps both", () => {
  const turns = [
    inspectRead(0, [[100, 109], [2300, 2309]]),
    { i: 1, action: { a: "shell", c: "npm test" }, observation: "ok" },
    inspectRead(2, [[700, 709]]),
  ];
  const prompt = buildPrompt({ ...base, turns });
  for (const probe of ["showing 100-109", "showing 2300-2309", "showing 700-709"]) {
    assert.ok(prompt.includes(probe), `${probe} should survive`);
  }
});

