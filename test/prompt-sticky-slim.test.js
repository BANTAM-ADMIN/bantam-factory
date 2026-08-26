import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPrompt } from "../src/prompt.js";

// The dominant prefix-cache waste in a Codex run, measured on a recorded
// gpt-5.6-terra adapter-migration run (10 turns):
//
//   turn  pointers  event
//     3      4      un-slimmed package.json
//     4      4      un-slimmed enabled.js tags.js headers.js date.js
//     5      4      un-slimmed method.js
//     ...          10 un-slim events in 10 turns
//
// An earlier read is replaced by a pointer while its file sits in the open-files
// panel, and the FULL BODY IS RESTORED when the file drops out of that sliding
// window. History therefore oscillates, and every oscillation invalidates the
// provider prefix cache from that point on: 60,803 characters discarded, ~26% of
// all cache misses on that run.
//
// Slimming must be monotonic. Once a body has been omitted from an emitted
// prompt it stays omitted, and the pointer must read true whether or not the file
// is currently in the panel -- otherwise the text has to change, which is the
// very thing that costs the cache.
//
// This removes no information the model was relying on: the body was ALREADY
// hidden whenever the file was in-panel, and read_file remains available.

const FILE_BODY = "src/a.js (2 lines, showing 1-2):\n1\texport const a = 1;\n2\t\n";

const turns = () => [
  { i: 0, action: { a: "read_file", p: "src/a.js" }, observation: FILE_BODY },
  { i: 1, action: { a: "read_file", p: "src/b.js" }, observation: "src/b.js (1 line):\n1\tb\n" },
];

const build = (readPaths, extra = {}) => buildPrompt({
  task: "t",
  env: "e",
  turns: turns(),
  openPaths: readPaths,
  readPaths,
  openFilesText: readPaths.map((p) => `# ${p} (current)\n`).join(""),
  ...extra,
});

describe("slimming an earlier read is monotonic", () => {
  it("omits the body while the file is in the open-files panel", () => {
    const prompt = build(["src/a.js"]);
    assert.ok(!prompt.includes("export const a = 1;"),
      "an in-panel file's earlier body should be omitted");
  });

  // The defect: the same prompt one turn later, with the file out of the window.
  it("keeps the body omitted after the file leaves the panel", () => {
    const stillSlim = new Set(["src/a.js"]);
    const prompt = build(["src/b.js"], { everSlimmedPaths: stillSlim });
    assert.ok(!prompt.includes("export const a = 1;"),
      "a body once omitted must not be restored when the file leaves the panel");
  });

  // If the pointer claims the file is in <open_files> when it is not, the text has
  // to change as the window slides -- reintroducing the churn by another route.
  it("uses a pointer that stays true once the file leaves the panel", () => {
    const inPanel = build(["src/a.js"], { everSlimmedPaths: new Set(["src/a.js"]) });
    const outOfPanel = build(["src/b.js"], { everSlimmedPaths: new Set(["src/a.js"]) });
    const line = (p) => (p.match(/\[turn 1[^\]]*src\/a\.js[^\]]*\]/) || [""])[0];
    assert.ok(line(inPanel), "expected a pointer for the slimmed read");
    assert.equal(line(inPanel), line(outOfPanel),
      "the pointer text must not change when the file leaves the panel");
  });

  // The property that actually saves the tokens.
  it("does not rewrite earlier prompt bytes as the panel window slides", () => {
    const memo = new Set(["src/a.js"]);
    const before = build(["src/a.js"], { everSlimmedPaths: memo });
    const after = build(["src/b.js"], { everSlimmedPaths: memo });
    const historyEnd = before.indexOf("src/b.js (1 line)");
    assert.ok(historyEnd > 0, "expected the second read in history");
    assert.equal(before.slice(0, historyEnd), after.slice(0, historyEnd),
      "history bytes changed when only the open-files window moved");
  });
});

// The remaining invalidator after un-slim churn was fixed. A pointer had two
// wordings -- "earlier snapshot omitted" while merely redundant, and "snapshot
// superseded by a later accepted edit" once the file was edited -- so every edit
// UPGRADED all of that file's earlier pointers and rewrote history again. On the
// sticky-slim run this was the worst divergence in the whole run (36.1% prefix).
//
// The body is hidden in both states, so one wording serves both and the text
// never has to change.
describe("a pointer's wording does not change when the file is later edited", () => {
  const base = [
    { i: 0, action: { a: "read_file", p: "src/a.js" }, observation: "src/a.js (1 line):\n1\tconst a=1;\n" },
  ];
  const edited = [
    ...base,
    {
      i: 1,
      action: { a: "write_file", p: "src/a.js", content: "const a=2;" },
      observation: "wrote src/a.js",
      editApplied: true,
    },
  ];
  const build = (turns) => buildPrompt({
    task: "t", env: "e", turns,
    openPaths: ["src/a.js"], readPaths: ["src/a.js"],
    openFilesText: "# src/a.js\n",
  });

  it("uses the same pointer before and after the edit", () => {
    const line = (p) => (p.match(/\[turn 1[^\]]*src\/a\.js[^\]]*\]/) || [""])[0];
    const before = line(build(base));
    const after = line(build(edited));
    assert.ok(before, "expected a pointer for the slimmed read");
    assert.equal(before, after,
      "an accepted edit rewrote the earlier pointer instead of leaving it alone");
  });
});

// BANTAM's own telemetry pointed straight at this: on a 9-turn gpt-5.6-terra run,
// promptChurn reported firstChangedSections { actionHistory: 8 } -- every single
// comparable turn first diverged in the replayed ACTION history -- with 21,820
// characters REPLACED rather than appended, and delta delivery saving only 36.7%.
//
// The read-observation slimming was made sticky; slimReplayedAction was not. It
// stayed keyed on the open-files sliding window, so an edited file's body was
// dropped from history when the file entered the panel and RESTORED when it left,
// exactly the churn already fixed on the other half.
describe("replayed edit bodies stay slimmed once the window moves on", () => {
  const turns = [
    {
      i: 0,
      action: { a: "write_file", p: "src/a.js", content: "export const a = 1;\n" },
      observation: "wrote src/a.js",
      editApplied: true,
    },
    { i: 1, action: { a: "read_file", p: "src/b.js" }, observation: "src/b.js:\n1\tb\n" },
  ];
  const build = (openPaths, memo) => buildPrompt({
    task: "t", env: "e", turns,
    openPaths, readPaths: openPaths,
    openFilesText: "# panel\n",
    everSlimmedPaths: memo,
  });

  it("slims the edit body while the file is in the panel", () => {
    const prompt = build(["src/a.js"], new Set());
    assert.ok(!prompt.includes("export const a = 1;"),
      "an in-panel edit body should be replaced by a pointer");
  });

  it("keeps it slimmed after the panel window moves past it", () => {
    const memo = new Set();
    build(["src/a.js"], memo);            // enters the panel, gets slimmed
    const later = build(["src/b.js"], memo); // window moves on
    assert.ok(!later.includes("export const a = 1;"),
      "the edit body came back when the file left the panel");
  });
});

describe("a failed edit proposal remains model-resident", () => {
  it("retains the newest rejected patch body even when its path is live", () => {
    const proposed = "export const repaired = 42;";
    const prompt = buildPrompt({
      task: "repair it",
      env: "e",
      turns: [{
        i: 0,
        action: {
          a: "patch",
          edits: [
            { p: "src/a.js", old: "stale", new: proposed },
            { p: "src/b.js", old: "also stale", new: "export const b = 2;" },
          ],
        },
        observation: 'ERROR: patch edit 1 (src/a.js): "old" text not found; read the file',
        editApplied: false,
      }],
      openPaths: ["src/a.js"],
      readPaths: ["src/a.js"],
      openFilesText: "# src/a.js (current)\n1\texport const repaired = 0;\n",
      everSlimmedPaths: new Set(["src/a.js"]),
    });

    assert.match(prompt, new RegExp(proposed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(prompt, /"p":"src\/a\.js","note":"\[superseded/);
  });
});

describe("controller evidence survives source-read slimming", () => {
  const build = (enabled) => buildPrompt({
    task: "fix it",
    env: "e",
    turns: [{
      i: 0,
      action: { a: "read_file", p: "src/a.js" },
      observation: `${FILE_BODY}\n[auto-verify] stale-turn guard ran the suite — PASS:\n# pass 10\n# fail 0\nThe tests PASS.`,
    }],
    openPaths: ["src/a.js"],
    readPaths: ["src/a.js"],
    openFilesText: "# src/a.js (current)\n",
    preserveSlimmedControlAnnotations: enabled,
  });

  it("retains trusted verification while still removing redundant source", () => {
    const treatment = build(true);
    assert.doesNotMatch(treatment, /export const a = 1/);
    assert.match(treatment, /\[auto-verify\][\s\S]*PASS/);
    assert.match(treatment, /# fail 0/);
  });

  it("keeps the historical control behavior available for a matched A\/B", () => {
    assert.doesNotMatch(build(false), /\[auto-verify\]/);
  });
});
