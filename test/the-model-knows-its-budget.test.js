import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { systemPrompt } from "../src/prompt.js";
import { runAgent } from "../src/agent.js";

// Every run of the workday refactor request — three harness eras — landed
// within four turns of its cap (41/45, 44/45, 45/45), and the audit showed why:
// the FIRST budget signal arrives inside the landing window, max(3, 10% of
// maxTurns) turns from the end. Before that nothing in any prompt says a
// boundary exists, so the model plans as if unbounded and then gets a six-turn
// countdown. A model cannot pace work it cannot see the edge of.
//
// Two additions, both context: the system prompt states the budget up front,
// and a single midpoint notice marks half spent. The landing window is
// unchanged.

test("the system prompt states the budget when one exists", () => {
  const p = systemPrompt({ maxTurns: 45 });
  assert.match(p, /45 turns/, "the number, not a vague mention");
  assert.match(p, /finish (well |comfortably )?(inside|before|within)/i, "and the instruction to pace");
});

test("no budget line when the caller sets none", () => {
  assert.doesNotMatch(systemPrompt({}), /turn budget|turns for this task/i);
});

const model = (lines) => ({
  assistantPrefill: "",
  actTemperature: null,
  async complete() {
    return { content: lines.shift() ?? JSON.stringify({ a: "done", summary: "d" }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  },
});

test("one midpoint notice, halfway, non-interactive only", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-budget-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reads = Array.from({ length: 11 }, () => JSON.stringify({ a: "read_file", p: "a.js" }));
  const r = await runAgent({
    task: "Look around.",
    workspace: dir,
    model: model(reads),
    maxTurns: 12,
    useGrammar: false,
    shellSandbox: "host",
  });
  const marks = r.turns.filter((x) => /\[budget\] halfway/i.test(String(x.observation ?? "")));
  assert.equal(marks.length, 1, `once, not a drumbeat: ${marks.map((x) => x.i).join(",")}`);
  assert.ok(marks[0].i >= 4 && marks[0].i <= 7, `at the midpoint of 12, got turn ${marks[0].i}`);
});

// tb33 went green at turn 48 and made nine more edits to the cap. The context
// DID contain "emit done — do not keep editing a green tree"… at char 2,436 of
// 2,469, after a wall of ok-lines, twice. The red path has led with its verdict
// all day ("Lead a test run with its verdict"); the green path led with noise
// and trailed the one actionable sentence. Order is context too.
test("a green auto-verify puts the land instruction before the TAP wall", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-green-close-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true,"type":"module"}');
  fs.writeFileSync(path.join(dir, "impl.js"), "export const v = 1;\n");
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test/v.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { v } from '../impl.js';\ntest('v', () => assert.equal(v, 2));\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const edits = [
    JSON.stringify({ a: "replace", p: "impl.js", old: "v = 1", new: "v = 2" }),
    ...Array.from({ length: 9 }, (_, i) => JSON.stringify({ a: "read_file", p: "impl.js" })),
  ];
  const r = await runAgent({
    task: "Make the test pass.",
    workspace: dir,
    model: model(edits),
    maxTurns: 12,
    useGrammar: false,
    shellSandbox: "host",
    verificationScript: "node --test test/v.test.js",
  });
  const green = r.turns.map((x) => String(x.observation ?? "")).find((o) => /\[auto-verify\][^]*PASS/.test(o));
  assert.ok(green, "an auto-verify green must occur");
  const block = green.slice(green.indexOf("[auto-verify]"));
  const close = block.indexOf("do not keep editing a green tree");
  assert.ok(close >= 0 && close < 300,
    `the land instruction must lead, not trail: found at ${close}`);
});
