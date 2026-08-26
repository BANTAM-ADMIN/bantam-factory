// The carve-off replay (2026-08-17, chat r0 @ 22:22): turns 6–14 were SEVEN
// consecutive inspect batches with zero fresh sub-ops — reshuffled
// combinations of six already-read files, all start:1 windows. The exact-dupe
// guard can't key them (batch composition wobbles) and the ledger veto rightly
// stands down (the files exceed the panel, so refusing would starve the
// model). The paging steer covers windowing within ONE file; this is its
// cross-file cousin: batches that re-open the same files instead of deciding.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

test("a third mostly-stale inspect batch draws the shuffle steer and masks inspect", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-shuffle-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  // MIXED batches: one fresh sub-op smuggles the rest past the ledger veto
  // ("new/mixed territory falls through and executes") — the real carve-off
  // batches t11/t12 had exactly this shape, and fully-stale batches join them
  // once prompt slimming evicts the ranges from residency. A batch that is
  // two-thirds re-read is a shuffle even though it technically reached
  // something new.
  for (const n of ["a", "b", "c", "d", "e"]) {
    fs.writeFileSync(path.join(workspace, `${n}.js`), Array.from({ length: 1500 }, (_, i) => `export const ${n}${i} = ${i};`).join("\n") + "\n");
  }

  // No single file reaches a 3rd window here — that would rightly hand the
  // turn to the more specific paging steer instead (see
  // one-steer-speaks-at-a-time.test.js for that precedence).
  const batch = (files) => JSON.stringify({ a: "inspect", ops: files.map((p) => ({ a: "read_file", p, limit: 20 })) });
  const model = scriptedModel([
    batch(["a.js", "b.js", "c.js"]),   // all fresh
    batch(["a.js", "b.js", "d.js"]),   // 2/3 covered (stale 1); pages a=2 b=2
    batch(["c.js", "d.js", "e.js"]),   // 2/3 covered (stale 2), max pages 2 → shuffle steers
    JSON.stringify({ a: "respond", text: "a/b/c export numbered constants." }),
  ]);

  const steers = [];
  const result = await runAgent({
    task: "What do these files export?",
    workspace,
    model,
    maxTurns: 8,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (e) => { if (e.type === "inspect_shuffle_steer") steers.push(e); },
  });

  assert.equal(result.responded, true);
  assert.equal(steers.length, 1, "two consecutive stale batches draw the steer");
  assert.equal(steers[0].staleBatches, 2);
});

test("batches that keep reaching new ground never draw the steer", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-shuffle-fresh-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const n of ["a", "b", "c", "d", "e", "f"]) {
    fs.writeFileSync(path.join(workspace, `${n}.js`), `export const ${n} = 1;\n`);
  }
  const batch = (files) => JSON.stringify({ a: "inspect", ops: files.map((p) => ({ a: "read_file", p })) });
  const model = scriptedModel([
    batch(["a.js", "b.js"]),
    batch(["c.js", "d.js"]),
    batch(["e.js", "f.js"]),
    JSON.stringify({ a: "respond", text: "six modules, one export each." }),
  ]);
  const steers = [];
  const result = await runAgent({
    task: "Survey the modules.",
    workspace,
    model,
    maxTurns: 8,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (e) => { if (e.type === "inspect_shuffle_steer") steers.push(e); },
  });
  assert.equal(result.responded, true);
  assert.equal(steers.length, 0);
});
