// Maze film study, backlog rank 1: the losing shape patches one wrong
// function fragment by fragment while the suite stays red; the winners
// re-pour it whole from the contract. The sentinel makes the re-pour the
// lit button on the fourth same-file patch of a red span.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepourSentinel } from "../src/logic/repour.js";

test("four same-file patches after a red verdict draw the steer; green re-arms", () => {
  const s = new RepourSentinel();
  s.note({ ranVerification: true, verificationRed: true });
  for (let i = 0; i < 3; i++) assert.equal(s.note({ replacedPath: "src/f.js" }), null);
  const note = s.note({ replacedPath: "src/f.js" });
  assert.match(note, /\[regenerate-from-formula\] 4 patches have landed on src\/f.js/);
  assert.match(note, /REWRITE the whole function/);
  assert.equal(s.note({ replacedPath: "src/f.js" }), null, "one steer per path per drought");
  s.note({ ranVerification: true, verificationRed: false });  // green: everything re-arms
  s.note({ ranVerification: true, verificationRed: true });
  for (let i = 0; i < 3; i++) assert.equal(s.note({ replacedPath: "src/f.js" }), null);
  assert.ok(s.note({ replacedPath: "src/f.js" }), "re-armed after green then red");
});

test("no red verdict in the span means surgical work, not thrash — silent", () => {
  const s = new RepourSentinel();
  for (let i = 0; i < 8; i++) assert.equal(s.note({ replacedPath: "a.py" }), null);
});

test("counts are per-path; two files at two patches each stay silent", () => {
  const s = new RepourSentinel();
  s.note({ ranVerification: true, verificationRed: true });
  for (const p of ["a.py", "b.py", "a.py", "b.py"]) assert.equal(s.note({ replacedPath: p }), null);
});

test("wired: a patch-thrash spiral hears the steer through the real dispatcher", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-repour-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(ws, "t.test.js"), 'import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; test("v9", () => assert.equal(fs.readFileSync("v.txt","utf8"), "9"));');
  fs.writeFileSync(path.join(ws, "v.txt"), "start-0");
  const outputs = [];
  outputs.push(JSON.stringify({ a: "shell", c: "npm test" }));                       // red verdict
  for (let i = 1; i <= 4; i++) outputs.push(JSON.stringify({ a: "replace", p: "v.txt", old: String(i - 1), new: String(i) }));
  outputs.push(JSON.stringify({ a: "write_file", p: "v.txt", content: "9" }));       // the re-pour
  outputs.push(JSON.stringify({ a: "shell", c: "npm test" }));                       // green
  outputs.push(JSON.stringify({ a: "done", summary: "Re-poured v.txt whole; suite green." }));
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
  assert.doesNotMatch(obs[3], /\[regenerate-from-formula\]/, "third same-file patch: quiet");
  assert.match(obs[4], /\[regenerate-from-formula\] 4 patches/, "fourth same-file patch of a red span draws the steer");
  assert.ok(result.metrics.repourSteers >= 1);
});
