import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

// The joblog refactor (2026-08-17, .bantam/runs/2026-08-17T16-43-41-374Z.json)
// declared done with one of its own 21 new tests red — after a GOOD process:
// baseline captured, before/after diffed, its suite green at turn 31, then five
// more edits and only CLI re-checks before done at 41.
//
// I first built a new done-gate for this and found the guard already existed:
// prematureDoneObjection bounces edit-after-last-test-run. It had been
// WHITEWASHED — verificationVerdict treats any shell output as a verdict, so
// `node joblog.js > /tmp/x; echo "exit: $?"` at turn 39 read as a green
// verification and outranked the real suite (the tool's own FAILED rows even
// read as a red one at 37). The fix is verdict tiering in done-guard.js: once a
// REAL test command has produced a verdict, only real test commands may update
// it; deliverable-run verdicts remain the only tier for projects with no tests.
//
// These tests drive the whole agent loop, so they hold whichever layer enforces
// it. The guard allows up to two bounces, then lets a run end.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-selftest-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true,"type":"module"}');
  fs.writeFileSync(path.join(dir, "impl.js"), "export const value = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const model = (lines) => ({
  assistantPrefill: "",
  actTemperature: null,
  async complete() {
    return { content: lines.shift() ?? JSON.stringify({ a: "done", summary: "d" }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  },
});

const TEST_FILE = JSON.stringify({
  a: "write_file", p: "test/value.test.js",
  content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../impl.js';\ntest('value is one', () => assert.equal(value, 1));\n",
});

test("done bounces once when edits followed the last self-test run", async (t) => {
  const dir = workspace(t);
  const r = await runAgent({
    task: "Refactor impl.js and add tests.",
    workspace: dir,
    model: model([
      TEST_FILE,
      JSON.stringify({ a: "shell", c: "node --test test/" }),
      JSON.stringify({ a: "replace", p: "impl.js", old: "value = 1", new: "value = 1; // tidied" }),
      JSON.stringify({ a: "done", summary: "refactored" }),
      JSON.stringify({ a: "done", summary: "refactored" }),
      JSON.stringify({ a: "done", summary: "refactored" }),
    ]),
    maxTurns: 9,
    useGrammar: false,
    shellSandbox: "host",
  });
  const bounce = r.turns.find((x) => x.parsedAction?.a === "done" && !x.done
    && /test/.test(String(x.observation ?? "")));
  assert.ok(bounce, `the first done should bounce with a message: ${
    r.turns.map((x) => `${x.i}:${x.parsedAction?.a}`).join(" ")}`);
  assert.match(String(bounce.observation ?? ""), /node --test/,
    "and it names the command the run itself used");
  assert.ok(r.result?.reachedDone ?? r.reachedDone ?? r.turns.some((x) => x.parsedAction?.a === "done" && String(x.observation ?? "") === ""),
    "a later done still ends the run — bounded bounces, not a loop");
});

test("no bounce when the tests ran after the last edit", async (t) => {
  const dir = workspace(t);
  const r = await runAgent({
    task: "Refactor impl.js and add tests.",
    workspace: dir,
    model: model([
      TEST_FILE,
      JSON.stringify({ a: "replace", p: "impl.js", old: "value = 1", new: "value = 1; // tidied" }),
      JSON.stringify({ a: "shell", c: "node --test test/" }),
      JSON.stringify({ a: "done", summary: "refactored and tested" }),
    ]),
    maxTurns: 6,
    useGrammar: false,
    shellSandbox: "host",
  });
  const firstDone = r.turns.find((x) => x.parsedAction?.a === "done");
  assert.ok(firstDone && firstDone.done !== false,
    `a verified done should be accepted: ${String(firstDone?.observation ?? "").slice(0, 120)}`);
});

test("silent when the run wrote no tests", async (t) => {
  const dir = workspace(t);
  const r = await runAgent({
    task: "Tidy impl.js.",
    workspace: dir,
    model: model([
      JSON.stringify({ a: "replace", p: "impl.js", old: "value = 1", new: "value = 2" }),
      JSON.stringify({ a: "done", summary: "tidied" }),
    ]),
    maxTurns: 5,
    useGrammar: false,
    shellSandbox: "host",
  });
  const firstDone = r.turns.find((x) => x.parsedAction?.a === "done");
  assert.ok(firstDone && firstDone.done !== false, "an ordinary no-test run is unaffected");
});

// The tiering's first live outing produced the OPPOSITE failure: a false
// bounce. The re-run of the same refactor request piped its suite through grep
// for the counts — `bash -c 'node --test test/ 2>&1 | grep -E "^# …"'` — which
// isTestCommand rejects (the pipe inside the quoted payload defeats its
// segment splitter). So the green runs at turns 41 and 43 fell out of the test
// tier, the guard saw "edit at 40, no test since", and bounced BOTH dones of a
// run whose suite was green — it hit the turn cap unfinished with a healthy
// workspace (18/18 passing on disk).
//
// Wrapping a test run in bash -c and piping it through grep is good practice,
// not evasion. The guard now unwraps launcher payloads before asking.
import { prematureDoneObjection } from "../src/done-guard.js";

const shellTurn = (c, observation) => ({ action: { a: "shell", c }, observation });
const editTurn = (p) => ({ action: { a: "replace", p, old: "x", new: "y" }, observation: `replaced 1 occurrence in ${p} at line 4` });

const GREEN = "$ cmd\nexit 0\n# tests 18\n# pass 18\n# fail 0\n";
const WRAPPED = `bash -c 'node --test test/ 2>&1 | grep -E "^# (tests|pass|fail)"'`;

test("a piped, bash-wrapped green suite counts as a test verdict", () => {
  const turns = [
    shellTurn("node --test test/", "# tests 18\n# pass 17\n# fail 1\n"),  // real tests exist
    editTurn("src/progress.js"),
    shellTurn(WRAPPED, GREEN),                                            // green, wrapped
  ];
  assert.equal(prematureDoneObjection(turns, 0), null,
    "tested-after-edit must be accepted however the tests were invoked");
});

test("a deliverable echo still does not outrank the suite", () => {
  const turns = [
    shellTurn("node --test test/", "# tests 18\n# pass 17\n# fail 1\n"),  // red suite
    shellTurn(`node joblog.js > /tmp/x 2>&1; echo "exit: $?"`, "exit: 0\n"), // echo looks green
  ];
  assert.match(String(prematureDoneObjection(turns, 0) ?? ""), /failing tests/,
    "the red suite is still the verdict that counts");
});
