// A heartbeat that repeats the same line every five seconds is noise. These pin
// the replacement: a live prompt suffix that changes (elapsed + output volume)
// and a stall explanation that names the real cause when a command is silent —
// most often a `| tail` filter, which cannot emit a line until it exits.
import test from "node:test";
import assert from "node:assert/strict";
import { bufferingFilterIn, formatElapsed, liveStatusSuffix, stallExplanation, STALL_AFTER_MS } from "../src/repl-progress.js";

test("a buffering filter is recognized, a streaming pipeline is not", () => {
  for (const cmd of [
    "node test/smoke.js 2>&1 | tail -40",
    "npm test 2>&1 | tail -20",
    "ls | sort",
    "cat x | wc -l",
    "make 2>&1 | tac",
  ]) {
    assert.equal(bufferingFilterIn(cmd), true, cmd);
  }
  for (const cmd of [
    "node test/smoke.js 2>&1",
    "grep -n TODO src/*.js",
    "npm test 2>&1 | tee out.log",
    "tail -f app.log",
  ]) {
    assert.equal(bufferingFilterIn(cmd), false, cmd);
  }
});

test("elapsed reads in seconds, then minutes", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(9500), "10s");
  assert.equal(formatElapsed(65000), "1m05s");
  assert.equal(formatElapsed(190000), "3m10s");
  assert.equal(formatElapsed(120000), "2m");
});

test("the live suffix shows volume once output flows, and names the silence before that", () => {
  assert.equal(liveStatusSuffix({ elapsedMs: 3000 }), " 3s");
  assert.equal(liveStatusSuffix({ elapsedMs: 30000, sinceOutputMs: 30000 }), " 30s · no output");
  assert.equal(liveStatusSuffix({ elapsedMs: 30000, sinceOutputMs: 30000, buffered: true }), " 30s · output buffered");
  assert.equal(liveStatusSuffix({ elapsedMs: 65000, outputChars: 3277 }), " 1m05s · 3.2kB out");
});

test("a young or producing command gets no stall note", () => {
  assert.equal(stallExplanation({ command: "node x.js | tail -5", sinceOutputMs: 5000, elapsedMs: 5000 }), null);
  assert.equal(stallExplanation({ command: "node x.js | tail -5", sinceOutputMs: 90000, outputChars: 42, elapsedMs: 90000 }), null);
  assert.equal(stallExplanation({ command: "node x.js", sinceOutputMs: null, elapsedMs: 90000 }), null);
});

test("a silent buffered command names the filter, not a hang", () => {
  const note = stallExplanation({
    command: "node test/smoke.js 2>&1 | tail -40",
    sinceOutputMs: STALL_AFTER_MS,
    elapsedMs: 95000,
  });
  assert.match(note, /pipes through a buffering filter/);
  assert.match(note, /nothing appears until it exits/);
});

test("a silent unbuffered command is reported as still running, with an escape hatch when long", () => {
  const early = stallExplanation({ command: "node slow.js", sinceOutputMs: 26000, elapsedMs: 26000 });
  assert.equal(early, "no output for 26s — still running");
  const late = stallExplanation({ command: "node slow.js", sinceOutputMs: 140000, elapsedMs: 140000 });
  assert.match(late, /still running; if it is stuck, Ctrl-C/);
});
