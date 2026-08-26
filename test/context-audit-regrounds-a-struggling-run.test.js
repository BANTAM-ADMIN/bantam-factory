// "Context is always the problem" as a station: when a run thrashes (failed
// edits to the same file) or grinds (an outlier turn wall), audit the CONTEXT
// — re-read bytes and evidence — instead of trying harder. Card 7's maze
// thrash and card 17's 45.8s outlier turn are the measured shapes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextAuditSentinel } from "../src/logic/context-audit.js";

const FAIL = 'ERROR: "old" text not found in src/render.js.';
const OK = "replaced 1 occurrence in src/render.js";
const R = { a: "replace", p: "src/render.js" };

test("two consecutive failed edits to one file draw the re-grounding audit, once", () => {
  const s = new ContextAuditSentinel();
  assert.equal(s.note({ action: R, observation: FAIL, now: 1000 }), null);
  const note = s.note({ action: R, observation: FAIL, now: 2000 });
  assert.match(note, /\[context-audit\] 2 consecutive edits to src\/render\.js/);
  assert.match(note, /read_file the exact/);
  assert.equal(s.note({ action: R, observation: FAIL, now: 3000 }), null, "capped per episode");
});

test("a NO_CHANGE edit is divergence evidence, not a landed edit (7R: seven no-ops in a row, streak reset each time)", () => {
  const s = new ContextAuditSentinel();
  const NOOP = "NO_CHANGE: maze.py already has the requested content; this action did not edit the workspace.";
  assert.equal(s.note({ action: { a: "write_file", p: "maze.py" }, observation: NOOP, now: 1000 }), null);
  const note = s.note({ action: { a: "replace", p: "maze.py" }, observation: NOOP, now: 2000 });
  assert.match(note, /\[context-audit\]/);
  assert.match(note, /without landing|already holds/);
});

test("a successful edit resets the episode; divergence can be caught again", () => {
  const s = new ContextAuditSentinel();
  s.note({ action: R, observation: FAIL, now: 1000 });
  s.note({ action: R, observation: OK, now: 2000 });
  assert.equal(s.note({ action: R, observation: FAIL, now: 3000 }), null, "streak restarted at 1");
  assert.ok(s.note({ action: R, observation: FAIL, now: 4000 }), "fires again at 2");
});

test("an outlier turn wall draws the audit only after a baseline, capped at two", () => {
  const s = new ContextAuditSentinel({ wallFloorMs: 20000 });
  let t = 0;
  const tick = (ms, obs = "listing") => s.note({ action: { a: "inspect" }, observation: obs, now: (t += ms) });
  for (let i = 0; i < 6; i++) assert.equal(tick(3000), null, "steady turns are quiet");
  const note = tick(45000);
  assert.match(note, /\[context-audit\] That turn took 45s against a 3s median/);
  assert.match(note, /grinding is a context signal/);
  assert.ok(tick(50000), "second audit allowed");
  assert.equal(tick(60000), null, "third is capped");
});

test("steady fast turns under the floor never fire even at 3x median", () => {
  const s = new ContextAuditSentinel();
  let t = 0;
  const tick = (ms) => s.note({ action: { a: "inspect" }, observation: "x", now: (t += ms) });
  for (let i = 0; i < 6; i++) tick(2000);
  assert.equal(tick(9000), null, "9s is 4.5x median but under the 20s floor");
});

test("wired: a run that thrashes on replace gets the audit in its observation", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-context-audit-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(ws, "target.js"), 'export const value = "initial";\n');
  fs.writeFileSync(path.join(ws, "target.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { value } from "./target.js";',
    'test("value fixed", () => assert.equal(value, "fixed"));',
  ].join("\n"));
  const outputs = [
    JSON.stringify({ a: "replace", p: "target.js", old: "not in the file", new: "x" }),
    JSON.stringify({ a: "replace", p: "target.js", old: "also not in the file", new: "x" }),
    JSON.stringify({ a: "write_file", p: "target.js", content: 'export const value = "fixed";\n' }),
    JSON.stringify({ a: "shell", c: "npm test" }),
    JSON.stringify({ a: "done", summary: "Re-grounded on the real bytes and fixed target.js; suite green." }),
  ];
  const model = {
    assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
  const result = await runAgent({
    task: "Fix target.js so the suite passes.", workspace: ws, model, maxTurns: 8,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
    verificationScript: "npm test",
  });
  assert.equal(result.reachedDone, true);
  assert.doesNotMatch(String(result.turns[0].observation), /\[context-audit\]/);
  assert.match(String(result.turns[1].observation), /\[context-audit\] 2 consecutive edits to target\.js/);
  assert.equal(result.metrics.contextAudits, 1);
});
