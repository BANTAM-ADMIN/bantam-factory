// The cellui correction replay (2026-08-17, chat r0 artifact, 78 turns before
// the operator pulled it): the model paged the 1,008-line
// writing-theme-manager.js in ~10 windows across the run. The paging steer
// fired exactly once — `pages === 3` — at turn 17, and the paging resumed
// unchallenged thirty turns later. One nudge per file per run is not pressure;
// the steer must re-arm on every third window of the same big file.

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

test("every third window of the same big file draws the steer again", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-paging-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const body = Array.from({ length: 500 }, (_, i) => `export const v${i} = ${i};`).join("\n");
  fs.writeFileSync(path.join(workspace, "big.js"), `${body}\n`);

  const read = (start) => JSON.stringify({ a: "read_file", p: "big.js", start, limit: 60 });
  const model = scriptedModel([
    read(1), read(61), read(121),                       // pages 1-3 → steer, read_file masked next turn
    JSON.stringify({ a: "search", q: "v400", p: "big.js" }),
    read(181), read(241), read(301),                     // pages 4-6 → steer again
    JSON.stringify({ a: "respond", text: "big.js defines v0..v499." }),
  ]);

  const steers = [];
  const result = await runAgent({
    task: "What does big.js define?",
    workspace,
    model,
    maxTurns: 12,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (e) => { if (e.type === "paging_steer") steers.push(e); },
  });

  assert.equal(result.responded, true);
  assert.equal(steers.length, 2, "the steer re-arms on the sixth window instead of firing once per run");
  assert.equal(steers[0].reads, 3);
  assert.equal(steers[1].reads, 6);
});

test("window-creep through inspect batches feeds the same paging counter", async (t) => {
  // The carve-off retry (chat r0 @ 2026-08-17T22:29) read the same five files
  // at limit 80, then 120, 150, 200, 250 — all wrapped in inspect batches, so
  // pagedReads (keyed on bare read_file actions) never saw a single page and
  // the steer stayed dark through nine growing re-reads.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-creep-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const body = Array.from({ length: 500 }, (_, i) => `export const v${i} = ${i};`).join("\n");
  fs.writeFileSync(path.join(workspace, "big.js"), `${body}\n`);
  fs.writeFileSync(path.join(workspace, "side.js"), "export const s = 1;\n");

  const creep = (limit) => JSON.stringify({ a: "inspect", ops: [
    { a: "read_file", p: "big.js", limit },
    { a: "read_file", p: "side.js" },
  ] });
  const model = scriptedModel([
    creep(60), creep(120), creep(180),                  // three windows of big.js → steer
    JSON.stringify({ a: "respond", text: "big.js defines v0..v499." }),
  ]);

  const steers = [];
  const result = await runAgent({
    task: "What does big.js define?",
    workspace,
    model,
    maxTurns: 8,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (e) => { if (e.type === "paging_steer") steers.push(e); },
  });

  assert.equal(result.responded, true);
  assert.equal(steers.length, 1, "the third windowed read of one big file steers, even inside inspect");
  assert.equal(steers[0].path, "big.js");
});
