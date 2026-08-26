// 7R round 2: sixty post-verdict turns, zero suite runs, all escalation
// asleep. The cadence sentinel makes "keep verifying" the lit button.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VerifyCadenceSentinel } from "../src/logic/verify-cadence.js";

test("six landed edits with no verification draws the steer, once, and a verification re-arms it", () => {
  const s = new VerifyCadenceSentinel();
  for (let i = 0; i < 5; i++) assert.equal(s.note({ editApplied: true }), null);
  const note = s.note({ editApplied: true });
  assert.match(note, /\[verify-cadence\] 6 edits have landed/);
  assert.match(note, /Run the test suite/);
  assert.equal(s.note({ editApplied: true }), null, "single-fire per drought");
  s.note({ ranVerification: true });
  for (let i = 0; i < 5; i++) assert.equal(s.note({ editApplied: true }), null);
  assert.ok(s.note({ editApplied: true }), "re-armed after the suite ran");
});

test("probes and reads never advance the count", () => {
  const s = new VerifyCadenceSentinel({ threshold: 2 });
  for (let i = 0; i < 6; i++) assert.equal(s.note({}), null);
  s.note({ editApplied: true });
  assert.ok(s.note({ editApplied: true }));
});

test("wired: a probe-edit spiral hears the steer; a healthy loop never does", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-cadence-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(ws, "t.test.js"), 'import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; test("v7", () => assert.equal(fs.readFileSync("v.txt","utf8"), "7"));');
  fs.writeFileSync(path.join(ws, "v.txt"), "0");
  const outputs = [];
  for (let i = 1; i <= 6; i++) outputs.push(JSON.stringify({ a: "write_file", p: "v.txt", content: String(i) }));
  outputs.push(JSON.stringify({ a: "write_file", p: "v.txt", content: "7" }));
  outputs.push(JSON.stringify({ a: "shell", c: "npm test" }));
  outputs.push(JSON.stringify({ a: "done", summary: "Cadence steer heard; suite run and green." }));
  const model = {
    assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete() { return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} }; },
  };
  const result = await runAgent({
    task: "Fix v.txt so the suite passes.", workspace: ws, model, maxTurns: 12,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.equal(result.reachedDone, true);
  const obs = result.turns.map((t2) => String(t2.observation ?? ""));
  assert.doesNotMatch(obs[4], /\[verify-cadence\]/, "five edits: quiet");
  assert.match(obs[5], /\[verify-cadence\] 6 edits/, "sixth landed edit draws the steer");
  assert.ok(result.metrics.verifyCadenceSteers >= 1);
});
