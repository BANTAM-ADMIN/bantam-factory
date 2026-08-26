import assert from "node:assert/strict";
import test from "node:test";

import { runIsAttended } from "../src/attendance.js";

// Measured on the ticket-B rerun (.bantam/runs/2026-08-16T14-55-11-002Z.json):
// `bantam run --task … > tb3.log` was classified interactive (the CLI inferred
// it from the absence of --autonomous), which disables the disguised-done guard
// in src/agent.js. At turn 16 the model emitted
//
//   respond: "… Before I write the edit I need to confirm two things …
//             Reading those two files now."
//
// and the run ended: reachedDone true, 17 turns, ZERO applied edits, both of
// its replace attempts syntax-refused. It intended to continue, and no person
// was reading its question anyway. Attendance is observable — observe it.

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("a run with both streams on a terminal is attended", () => {
  assert.equal(runIsAttended({ stdout: tty, stdin: tty }), true);
});

test("a run redirected to a file is NOT attended", () => {
  assert.equal(runIsAttended({ stdout: pipe, stdin: tty }), false);
});

test("a terminal stdout with a closed stdin is NOT attended", () => {
  // The half-attached case: text lands on a screen but nothing can answer.
  assert.equal(runIsAttended({ stdout: tty, stdin: pipe }), false);
});

test("missing streams are not attended", () => {
  assert.equal(runIsAttended({}), false);
  assert.equal(runIsAttended(), false);
});

test("BANTAM_ASSUME_ATTENDED forces attendance for a relaying wrapper", () => {
  assert.equal(runIsAttended({ stdout: pipe, stdin: pipe, env: { BANTAM_ASSUME_ATTENDED: "1" } }), true);
});

test("BANTAM_ASSUME_UNATTENDED wins over a real terminal", () => {
  assert.equal(runIsAttended({ stdout: tty, stdin: tty, env: { BANTAM_ASSUME_UNATTENDED: "1" } }), false);
});

test("falsy env values do not force anything", () => {
  for (const value of ["0", "false", "no", ""]) {
    assert.equal(runIsAttended({ stdout: pipe, stdin: pipe, env: { BANTAM_ASSUME_ATTENDED: value } }), false,
      `BANTAM_ASSUME_ATTENDED=${JSON.stringify(value)} must not claim a person is present`);
  }
});
