// Card 7: bantam spent 230 s fixing a drawing it never printed, while the
// same weights under hermes looked at the picture once and fixed it. A
// repeatedly-failing multi-line-string test now steers the model to print
// actual vs expected aligned before its next edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeeYourWorkSentinel } from "../src/logic/see-your-work.js";

const GRID_FAIL = `VERDICT: 1 of 8 tests FAILED (7 passed).
Failing tests:
  ✗ test_render_shape (test_maze.py:41)
assert '+───+───+\\n│   │' == '+───+───+───+\\n│       │'`;
const NUM_FAIL = `VERDICT: 1 of 3 tests FAILED (2 passed).
Failing tests:
  ✗ test_total (test_sum.py:9)
assert 41 == 42`;

test("a string-shaped test failing twice draws the print-the-picture steer, once", () => {
  const s = new SeeYourWorkSentinel();
  assert.equal(s.note({ observation: GRID_FAIL }), null, "first failure: let it fix directly");
  const note = s.note({ observation: GRID_FAIL });
  assert.match(note, /\[see-your-work\] "test_render_shape" has now failed 2 times/);
  assert.match(note, /PRINTS your actual output and the expected value aligned/);
  assert.match(note, /re-run the suite/);
  assert.doesNotMatch(note, /Do not re-run/, "the steer must never suppress verification (card 7R: 3 suite runs in 111 turns)");
  assert.equal(s.note({ observation: GRID_FAIL }), null, "single-fire per test");
});

test("a test named in both the digest and the TAP line counts once", () => {
  const both = `VERDICT: 1 of 1 tests FAILED (0 passed).
Failing tests:
  ✗ grid has a bottom border (draw.test.js:4)
not ok 1 - grid has a bottom border
  + '+---+\\n|   |'
  - '+---+\\n|   |\\n+---+'`;
  const s = new SeeYourWorkSentinel();
  assert.equal(s.note({ observation: both }), null, "first failure is ONE failure");
  assert.ok(s.note({ observation: both }), "second observation fires");
});

test("numeric assertion failures never draw it", () => {
  const s = new SeeYourWorkSentinel();
  assert.equal(s.note({ observation: NUM_FAIL }), null);
  assert.equal(s.note({ observation: NUM_FAIL }), null);
});

const EXCEPTION_FAIL = `TAP version 13
# Subtest: malformed CSV rejects invalid quotes
not ok 1 - malformed CSV rejects invalid quotes
  ---
  duration_ms: 1.5
  location: '/tmp/csv/test/csv.test.js:62:1'
  failureType: 'testCodeFailure'
  error: 'Missing expected exception (SyntaxError).'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: [Function: SyntaxError]
  operator: 'throws'
  stack: |-
    TestContext.<anonymous> (/tmp/csv/test/csv.test.js:62:32)
  ...
# tests 1
# pass 0
# fail 1`;

test("TAP YAML terminators and truncation never turn exception failures into text diffs", () => {
  for (const tail of ["", "\nFull output truncated", "\nSkipping 20 identical items", "\n..."]) {
    const s = new SeeYourWorkSentinel();
    const input = { verificationEvidence: { status: "fail", rawOutput: EXCEPTION_FAIL + tail } };
    assert.equal(s.note(input), null);
    assert.equal(s.note(input), null);
    assert.equal(s.note(input), null);
    const historical = new SeeYourWorkSentinel();
    const observation = `VERDICT: 1 of 1 tests FAILED (0 passed).\n${EXCEPTION_FAIL}${tail}`;
    assert.equal(historical.note({ observation }), null);
    assert.equal(historical.note({ observation }), null);
  }
});

test("typed evidence takes precedence over rendered text and an unexecuted check stays quiet", () => {
  for (const verificationEvidence of [null, { status: "unverified", rawOutput: GRID_FAIL },
    { status: "fail", rawOutput: EXCEPTION_FAIL }]) {
    const s = new SeeYourWorkSentinel();
    assert.equal(s.note({ verificationEvidence, observation: GRID_FAIL }), null);
    assert.equal(s.note({ verificationEvidence, observation: GRID_FAIL }), null);
  }
});

test("real multiline string diffs activate only for the matching failure", () => {
  const s = new SeeYourWorkSentinel();
  const rawOutput = `${EXCEPTION_FAIL}\nnot ok 2 - rendered rows\n  ---\n  expected: 'first\\nsecond'\n  actual: 'first\\nwrong'\n  ...`;
  const input = { verificationEvidence: { status: "fail", rawOutput } };
  assert.equal(s.note(input), null);
  const note = s.note(input);
  assert.match(note, /"rendered rows" has now failed 2 times/);
  assert.doesNotMatch(note, /malformed CSV|you are editing a drawing|have not looked/);
});

test("a non-text failure breaks a same-name text-comparison streak", () => {
  const s = new SeeYourWorkSentinel();
  const input = { verificationEvidence: { status: "fail", rawOutput:
    "not ok 1 - test_total\n  expected: 'one\\ntwo'\n  actual: 'one\\nthree'" } };
  assert.equal(s.note(input), null);
  assert.equal(s.note({ observation: NUM_FAIL }), null);
  assert.equal(s.note(input), null);
});

test("a green suite resets the streaks", () => {
  const s = new SeeYourWorkSentinel();
  s.note({ observation: GRID_FAIL });
  s.note({ observation: "VERDICT: all 8 tests passed." });
  assert.equal(s.note({ observation: GRID_FAIL }), null, "streak restarted");
});

test("wired: a real node --test multi-line string failure steers on the second run", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-seework-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(ws, "draw.js"), 'export const grid = () => "+---+\\n|   |";\n');
  fs.writeFileSync(path.join(ws, "draw.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { grid } from "./draw.js";',
    'test("grid has a bottom border", () => assert.equal(grid(), "+---+\\n|   |\\n+---+"));',
  ].join("\n"));
  const outputs = [
    JSON.stringify({ a: "shell", c: "npm test" }),
    JSON.stringify({ a: "shell", c: "npm test # again" }),
    JSON.stringify({ a: "write_file", p: "draw.js", content: 'export const grid = () => "+---+\\n|   |\\n+---+";\n' }),
    JSON.stringify({ a: "shell", c: "npm test # verify" }),
    JSON.stringify({ a: "done", summary: "Printed the two pictures, saw the missing border, fixed and verified green." }),
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
    task: "Fix draw.js so the suite passes.", workspace: ws, model, maxTurns: 8,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.equal(result.reachedDone, true);
  assert.doesNotMatch(String(result.turns[0].observation), /\[see-your-work\]/);
  assert.match(String(result.turns[1].observation), /\[see-your-work\]/);
  assert.equal(result.metrics.seeYourWorkSteers, 1);
});
