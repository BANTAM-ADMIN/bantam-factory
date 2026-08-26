// Three films in one sweep (rowquery x2, slugline): fast draws SAMPLE an
// enumerated contract instead of walking it, and their self-suites skip the
// same entries. The note makes the checklist the lit button at turn 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerateContractNote } from "../src/logic/probe-discipline.js";

test("fires on contract-handing tasks", () => {
  const t1 = "The rowquery package ships src/query.js as a stub whose header comment is the full contract for select(rows, spec).";
  assert.match(enumerateContractNote(t1), /\[enumerate-the-contract\]/);
  const t2 = "Implement chart.mjs so output matches the EXACT grammar pinned by SPEC.md";
  assert.ok(enumerateContractNote(t2));
  const t3 = "Honor every clause of the contract, including stable sort and no mutation.";
  assert.ok(enumerateContractNote(t3));
});

test("silent on ordinary build tasks", () => {
  assert.equal(enumerateContractNote("Build wordfreq.py that prints the top 10 words from stdin."), null);
  assert.equal(enumerateContractNote("Fix the failing test in this package."), null);
});

test("wired: the note lands on turn 0 of a contract task", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-enum-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const outputs = [JSON.stringify({ a: "list_dir", p: "." }), JSON.stringify({ a: "done", summary: "noted." })];
  const model = { assistantPrefill: "", actTemperature: null, prompts: [], requestCursor() { return this.prompts.length; },
    async complete() { return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} }; } };
  const result = await runAgent({
    task: "Implement select(); the header comment is the full contract.", workspace: ws, model, maxTurns: 4,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.match(String(result.turns[0].observation), /\[enumerate-the-contract\]/);
  assert.ok(result.metrics.contractEnumNotes >= 1);
});
