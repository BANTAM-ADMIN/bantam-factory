import assert from "node:assert/strict";
import test from "node:test";

import { buildPrompt } from "../src/prompt.js";

// Measured 2026-08-15, trio ticket A (`.bantam/trios/2026-08-15T20-52-10-048Z-09959fff`):
// the local arm spent 25 of 30 turns re-reading files it had already read, and
// never finished the ticket. Forensics: 9 read observations in the final prompt
// were collapsed to "[earlier snapshot omitted; read_file for current
// contents]" and ZERO live reads survived, while every panel entry was
// byte-truncated ("panel truncated at 1477 bytes — use read_file").
//
// Cause: prompt.js treats a path as panel-substitutable forever once it has
// been slimmed once (the sticky rule). When the panel is truncated the
// substitution is false, and the collapse message instructs the model to do
// the exact thing whose result is then destroyed — a closed loop.
//
// Contract: the NEWEST read of a file the panel cannot fully render survives
// in history. Older reads of that file stay collapsed (cache stability), and
// a read older than the file's latest edit stays collapsed (it is genuinely
// stale).

const FILE = "src/thing.js";
const BODY_ONE = `${FILE} (3 lines, showing 1-3):\n1\texport const a = 1;\n2\texport const b = 2;\n3\texport const c = 3;`;
const BODY_TWO = `${FILE} (3 lines, showing 1-3):\n1\texport const a = 9;\n2\texport const b = 2;\n3\texport const c = 3;`;

const base = {
  task: "Adjust thing.js.",
  env: "node 20",
  openPaths: [FILE],           // the panel lists it…
  readPaths: [],               // …but does NOT render it completely
  openFilesText: `# ${FILE} (current, 3 lines)\n1\texport const a = 9;\n… (panel truncated at 256 bytes — use read_file)`,
};

test("the newest read of a truncated-panel file survives, even after prior slimming", () => {
  const everSlimmedPaths = new Set([FILE]);   // it was collapsed on an earlier turn
  const turns = [
    { i: 0, action: { a: "read_file", p: FILE }, observation: BODY_ONE },
    { i: 1, action: { a: "replace", p: FILE, old: "1", new: "9" }, observation: `replaced 1 occurrence in ${FILE}`, editApplied: true },
    { i: 2, action: { a: "read_file", p: FILE }, observation: BODY_TWO },
  ];
  const prompt = buildPrompt({ ...base, turns, everSlimmedPaths });

  assert.ok(prompt.includes("export const a = 9;\n2\texport const b = 2;"),
    "the newest read must remain readable in history");
  assert.equal((prompt.match(/earlier snapshot omitted/g) ?? []).length, 1,
    "the pre-edit read stays collapsed — exactly one omission");
});

test("a fully rendered panel still supersedes every read (unchanged behavior)", () => {
  const turns = [
    { i: 0, action: { a: "read_file", p: FILE }, observation: BODY_ONE },
    { i: 1, action: { a: "read_file", p: FILE }, observation: BODY_ONE },
  ];
  const prompt = buildPrompt({
    ...base,
    readPaths: [FILE],           // panel renders it completely
    openFilesText: `# ${FILE} (current, 3 lines)\n1\texport const a = 1;\n2\texport const b = 2;\n3\texport const c = 3;`,
    turns,
    everSlimmedPaths: new Set([FILE]),
  });
  assert.ok(!prompt.includes("export const b = 2;\n3\texport const c = 3;\n<|im_end|>"),
    "a complete panel keeps superseding reads");
  assert.equal((prompt.match(/earlier snapshot omitted/g) ?? []).length, 2);
});

test("a read older than the file's latest edit stays collapsed", () => {
  const turns = [
    { i: 0, action: { a: "read_file", p: FILE }, observation: BODY_ONE },
    { i: 1, action: { a: "read_file", p: FILE }, observation: BODY_ONE },
    { i: 2, action: { a: "replace", p: FILE, old: "1", new: "9" }, observation: `replaced 1 occurrence in ${FILE}`, editApplied: true },
  ];
  const prompt = buildPrompt({ ...base, turns, everSlimmedPaths: new Set([FILE]) });
  assert.equal((prompt.match(/earlier snapshot omitted/g) ?? []).length, 2,
    "both pre-edit reads are stale and stay collapsed");
});

test("both refusal markers keep their file resident, not just the ledger one", async () => {
  // parity8 (2026-08-15): done-gates.js and gate-policy.js were refused with
  // "[open_files] Not re-read … already shown in <open_files>", never refreshed
  // in the open list, aged out, and left the panel — so the run wrote its gate
  // report unable to see the gate table and omitted type_contract. A refusal's
  // promise of residency must outlive the turn that makes it.
  const { refusedResidentReadPathsForTest } = await import("../src/agent.js");
  if (typeof refusedResidentReadPathsForTest !== "function") return; // exported for test only
  const ledgerTurn = { action: { a: "read_file", p: "a.js" }, observation: "[ledger] Not re-read: every range …" };
  const panelTurn = { action: { a: "read_file", p: "b.js" }, observation: "[open_files] Not re-read: b.js — the CURRENT, complete contents …" };
  const plain = { action: { a: "read_file", p: "c.js" }, observation: "c.js (10 lines, showing 1-10):" };
  assert.deepEqual(refusedResidentReadPathsForTest(ledgerTurn), ["a.js"]);
  assert.deepEqual(refusedResidentReadPathsForTest(panelTurn), ["b.js"]);
  assert.deepEqual(refusedResidentReadPathsForTest(plain), []);
});
