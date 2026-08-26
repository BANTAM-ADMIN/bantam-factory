import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

// Across 39 stored runs that ran a counted suite, the first measurement came
// AFTER the model's first edit in 39 of 39 — and it was RED in 29 of them. So a
// red first suite is systematically ambiguous: the model cannot tell its own
// breakage from what it inherited, and nothing in the prompt distinguishes them.
//
// It matters twice over, because the regression guard seeds `bestPassed` from
// that same first comparable measurement. When the model has already broken
// something, the guard adopts the damaged state as the standard to protect and
// under-protects for the rest of the run.
//
// tb29 (2026-08-17) is the case that surfaced it: 189 failing tests from a
// missing `acorn` package — a broken workspace of my own making — first measured
// at turn 35 with four edits already applied. The model saw the module error and
// still spent its remaining turns treating the failures as work to do.
//
// The harness cannot say whose failures they are without a pre-run measurement
// it does not take. It CAN say, with certainty, that nobody measured the suite
// before the edits, which is the fact the model is missing.

const script = (...actions) => actions.map((a) => JSON.stringify(a));
const model = (lines) => ({
  assistantPrefill: "",
  actTemperature: null,
  async complete() {
    return { content: lines.shift() ?? JSON.stringify({ a: "done", summary: "d" }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  },
});

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-baseline-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.writeFileSync(path.join(dir, "impl.js"), "export const value = 1;\n");
  // A suite that reports TAP counts with one failure, whatever the model does.
  fs.writeFileSync(path.join(dir, "suite.js"), [
    "console.log('TAP version 13');",
    "console.log('ok 1 - a');",
    "console.log('not ok 2 - b');",
    "console.log('1..2');",
    "console.log('# tests 2');",
    "console.log('# pass 1');",
    "console.log('# fail 1');",
    "process.exit(1);",
  ].join("\n"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const noticeIn = (r) => r.turns
  .map((t) => String(t.observation ?? ""))
  .find((o) => /nothing measured this suite before/i.test(o));

const run = (dir, lines) => runAgent({
  task: "Make the suite pass.",
  workspace: dir,
  model: model(lines),
  maxTurns: lines.length + 2,
  useGrammar: false,
  shellSandbox: "host",
});

test("an edit-then-measure red suite is named as unattributable", async (t) => {
  const dir = workspace(t);
  const r = await run(dir, script(
    { a: "replace", p: "impl.js", old: "value = 1", new: "value = 2" },
    { a: "shell", c: "node suite.js" },
  ));
  const notice = noticeIn(r);
  assert.ok(notice, `expected the notice; observations: ${r.turns.map((t2) => String(t2.observation ?? "").slice(0, 80)).join(" | ")}`);
  assert.match(notice, /1 edit/, `it should name how many edits came first; got: ${notice}`);
});

test("measuring before any edit is a real baseline and says nothing", async (t) => {
  const dir = workspace(t);
  const r = await run(dir, script({ a: "shell", c: "node suite.js" }));
  assert.equal(noticeIn(r), undefined, "a pre-edit measurement attributes cleanly");
});

test("it is said once, not at every later run of the suite", async (t) => {
  const dir = workspace(t);
  const r = await run(dir, script(
    { a: "replace", p: "impl.js", old: "value = 1", new: "value = 2" },
    { a: "shell", c: "node suite.js" },
    { a: "shell", c: "node suite.js" },
  ));
  const seen = r.turns.filter((t2) => /nothing measured this suite before/i.test(String(t2.observation ?? "")));
  assert.equal(seen.length, 1, "one notice per run");
});
