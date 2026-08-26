// Card 1 (Quiet Line) A/B protocol: the quiescent arm runs with every rescue
// steer disarmed but LOGGED — the would-fire ledger is the null-control data
// that separates steers that cause fast-EXACT from steers that co-occur with
// slow lanes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("quiescent mode suppresses the cadence steer but records the would-fire", async (t) => {
  process.env.BANTAM_RESCUE_QUIESCENT = "1";
  t.after(() => { delete process.env.BANTAM_RESCUE_QUIESCENT; });
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-quiescent-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(ws, "t.test.js"), 'import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; test("v7", () => assert.equal(fs.readFileSync("v.txt","utf8"), "7"));');
  fs.writeFileSync(path.join(ws, "v.txt"), "0");
  const outputs = [];
  for (let i = 1; i <= 6; i++) outputs.push(JSON.stringify({ a: "write_file", p: "v.txt", content: String(i) }));
  outputs.push(JSON.stringify({ a: "write_file", p: "v.txt", content: "7" }));
  outputs.push(JSON.stringify({ a: "shell", c: "npm test" }));
  outputs.push(JSON.stringify({ a: "done", summary: "Quiescent run complete; suite green." }));
  const model = { assistantPrefill: "", actTemperature: null, prompts: [], requestCursor() { return this.prompts.length; },
    async complete() { return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} }; } };
  const result = await runAgent({ task: "Fix v.txt so the suite passes.", workspace: ws, model, maxTurns: 12,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host" });
  assert.equal(result.reachedDone, true);
  for (const turn of result.turns) assert.doesNotMatch(String(turn.observation ?? ""), /\[verify-cadence\]/, "no steer text reaches the model");
  assert.ok((result.metrics.steerWouldFire?.["verify-cadence"] ?? 0) >= 1, "the would-fire is recorded");
});
