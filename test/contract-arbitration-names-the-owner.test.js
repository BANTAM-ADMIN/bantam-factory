// Falsefriend (card 27): every winning corner ARBITRATED the contract
// before touching the lying test. The pin makes the silent alternative —
// weakening a red assertion with no ruling — audible.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContractArbitrationPin, isTestPath } from "../src/logic/contract-arbitration.js";

test("isTestPath knows the shapes", () => {
  for (const p of ["test/visible.test.mjs", "tests/x.js", "test_round.py", "src/round_test.py"]) assert.ok(isTestPath(p), p);
  for (const p of ["src/round.js", "protest.py", "contest/x.js"]) assert.ok(!isTestPath(p), p);
});

test("a red-span assertion rewrite draws the pin once per file; green clears", () => {
  const s = new ContractArbitrationPin();
  s.note({ ranVerification: true, verificationRed: true });
  const edit = { a: "replace", p: "test/visible.test.mjs", old: "assert.equal(round(2.5), 3)", new: "assert.equal(round(2.5), 2)" };
  const note = s.note({ action: edit });
  assert.match(note, /\[contract-arbitration\]/);
  assert.match(note, /name the.*owner|owns the contract/i);
  assert.equal(s.note({ action: edit }), null, "single-fire per path per span");
  s.note({ ranVerification: true, verificationRed: false });
  s.note({ ranVerification: true, verificationRed: true });
  assert.ok(s.note({ action: edit }), "a new red span re-arms");
});

test("green-span test edits and non-assertion edits stay silent", () => {
  const s = new ContractArbitrationPin();
  const edit = { a: "replace", p: "test/x.test.js", old: "assert.equal(a, 1)", new: "assert.equal(a, 2)" };
  assert.equal(s.note({ action: edit }), null, "no verification yet: silent");
  s.note({ ranVerification: true, verificationRed: true });
  assert.equal(s.note({ action: { a: "replace", p: "test/x.test.js", old: "const n = 4", new: "const n = 5" } }), null, "not an assertion");
  assert.equal(s.note({ action: { a: "replace", p: "src/impl.js", old: "assert(x)", new: "check(x)" } }), null, "not a test file");
});

test("a declared ruling passes the pin", () => {
  const s = new ContractArbitrationPin();
  s.note({ ranVerification: true, verificationRed: true });
  const edit = { a: "replace", p: "test_round.py", old: "assert round2(2.5) == 3", new: "assert round2(2.5) == 2" };
  assert.equal(s.note({ action: edit, declared: true }), null, "arbitration on record: no steer");
});

test("wired: weakening a red assertion through the real dispatcher hears the pin", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-arb-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(ws, "impl.js"), "export const round2 = (x) => 3;");
  fs.mkdirSync(path.join(ws, "test"));
  fs.writeFileSync(path.join(ws, "test", "t.test.js"),
    'import test from "node:test"; import assert from "node:assert/strict"; import { round2 } from "../impl.js"; test("half", () => assert.equal(round2(2.5), 2));');
  const outputs = [];
  outputs.push(JSON.stringify({ a: "shell", c: "npm test" }));   // red
  outputs.push(JSON.stringify({ a: "replace", p: "test/t.test.js", old: "assert.equal(round2(2.5), 2)", new: "assert.equal(round2(2.5), 3)" }));
  outputs.push(JSON.stringify({ a: "shell", c: "npm test" }));   // green (weakened)
  outputs.push(JSON.stringify({ a: "done", summary: "Pin heard; ruling would be recorded before landing." }));
  const model = {
    assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete() { return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} }; },
  };
  const result = await runAgent({
    task: "Make the suite pass.", workspace: ws, model, maxTurns: 8,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.equal(result.reachedDone, true);
  const obs = result.turns.map((t2) => String(t2.observation ?? ""));
  assert.match(obs[1], /\[contract-arbitration\]/, "the assertion rewrite in the red span hears the pin");
  assert.ok(result.metrics.contractArbitrations >= 1);
});
