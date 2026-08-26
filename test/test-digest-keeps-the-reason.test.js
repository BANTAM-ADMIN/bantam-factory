import assert from "node:assert/strict";
import test from "node:test";

import { digestTestOutput } from "../src/executor.js";

// The digest keeps a head, an optional focus region around the first failure
// marker, and a tail. The focus region was guarded by `markerIdx > headChars`,
// which treats a failure marker INSIDE the head as already covered. It is the
// opposite: under node's TAP the preamble plus the first subtests reach 900
// characters right around the first "not ok", so the head ends partway through
// the test NAME and the diagnostic that follows — the error, the
// expected/actual pair — falls into the clipped middle.
//
// tb24 (2026-08-17) wrote one new test file three times across turns 43-59 and
// ran it twice. Both runs named the three failing tests and, for two of them,
// gave no reason at all: the head stopped at "not ok 1 - impossible editable
// scope ends the run early wit" and the next thing the model saw was a tail of
// absolute-path stack frames. The implementation was already green at turn 34;
// the run still ended at the cap.

const FAILURE = "not ok 99 - impossible editable scope ends the run early with the diagnosis\n"
  + "  ---\n  error: 'Cannot read properties of undefined'\n  expected: true\n  actual: false\n";
const STACK = Array.from({ length: 30 }, (_, i) => `    at frame${i} (file:///tmp/very/long/workspace/path/src/fixture-runner.js:${i}:11)\n`).join("");

// Place the marker at an exact offset. The interesting case is a marker just
// inside the 900-char head, so the diagnostic AFTER it spills past the boundary
// — which is where node's TAP puts it on a real suite.
function tapWithMarkerAt(offset) {
  const preamble = "TAP version 13\n# Subtest: setup\n";
  const filler = "ok 1 - setup\n".repeat(Math.max(0, Math.ceil((offset - preamble.length) / 13)));
  const pad = " ".repeat(Math.max(0, offset - preamble.length - filler.length - 1));
  return `${preamble}${filler}${pad}\n${FAILURE}${STACK}`;
}

test("a failure inside the head keeps its diagnostic", () => {
  const raw = tapWithMarkerAt(870);          // just inside the head; its diagnostic is not
  const at = raw.indexOf("\nnot ok") + 1;
  assert.ok(at > 800 && at <= 900, `the marker must sit just inside the head, got ${at}`);
  const out = digestTestOutput(raw);
  assert.match(out, /Cannot read properties of undefined/, "the error must survive");
  assert.match(out, /expected: true/, "so must the expected/actual pair");
  assert.match(out, /actual: false/);
});

test("a failure past the head still gets its focus region", () => {
  const raw = tapWithMarkerAt(1600);         // well past the head
  assert.ok(raw.indexOf("\nnot ok") + 1 > 900);
  const out = digestTestOutput(raw);
  assert.match(out, /Cannot read properties of undefined/);
  assert.match(out, /expected: true/);
});

test("the tail is still preserved", () => {
  // The tail carries the run summary in most runners; keeping the failure
  // region must not cost it.
  const out = digestTestOutput(tapWithMarkerAt(870));
  assert.match(out, /at frame29/, "the end of the output must still arrive");
  assert.match(out, /preserved tail/);
});

test("output with no failure marker is unchanged in shape", () => {
  const passing = "TAP version 13\n" + Array.from({ length: 60 }, (_, i) => `ok ${i + 1} - fine\n  ---\n  duration_ms: 0.5\n  ...\n`).join("");
  const out = digestTestOutput(passing);
  assert.match(out, /^TAP version 13/);
  assert.match(out, /preserved tail/);
  assert.doesNotMatch(out, /before failure region/);
});
