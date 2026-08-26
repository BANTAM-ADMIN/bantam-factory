import assert from "node:assert/strict";
import test from "node:test";

import {
  extractGoldenSpecimens,
  summarizeGoldenReplay,
  formatGoldenReplay,
} from "../src/logic/golden-replay.js";

// Every gauge check built before this one asked "does the oracle catch a defect?"
// -- red/green against a constructed broken specimen. None asked the mirror
// question: "does the oracle REJECT something that is actually correct?"
//
// On 2026-07-31 it did. The public suite for keyed-task-pool-strong asserted that
// `new KeyedTaskPool({ concurrency: null })` throws RangeError. The hidden grader
// never checks null, and a reference implementation using `?? 2` passes the hidden
// contract 4/4 while failing that public test. One recorded run identified it as
// "the only failing test", rewrote the guard three times, and was killed by the
// wall clock without producing a verdict.
//
// A run the hidden grader PASSED is a known-good specimen, free and already
// recorded. Replaying those against the current public suite detects invented
// requirements with no hand-authored fixtures at all.

const passRecord = (id, text) => ({
  runId: id,
  result: { status: "pass" },
  finalDiff: { status: "captured", truncated: false, text },
});

test("extracts only hidden-PASS runs that carry a usable diff", () => {
  const out = extractGoldenSpecimens([
    passRecord("a", "diff --git a/src/x.js b/src/x.js\n"),
    { runId: "b", result: { status: "contract-fail" }, finalDiff: { text: "diff" } },
    passRecord("c", "diff --git a/src/y.js b/src/y.js\n"),
  ]);
  assert.deepEqual(out.specimens.map((s) => s.runId), ["a", "c"]);
  assert.equal(out.rejected.failedContract, 1);
});

// A pass whose diff was truncated cannot be replayed faithfully. Counting it as a
// specimen would replay a partial tree and blame the oracle for the truncation.
test("excludes a passing run whose diff is truncated or missing", () => {
  const out = extractGoldenSpecimens([
    { runId: "t", result: { status: "pass" }, finalDiff: { status: "captured", truncated: true, text: "diff" } },
    { runId: "m", result: { status: "pass" } },
  ]);
  assert.equal(out.specimens.length, 0);
  assert.equal(out.rejected.unusableDiff, 2);
});

test("a specimen the public suite rejects is an invented requirement", () => {
  const s = summarizeGoldenReplay([
    { runId: "a", applied: true, publicFail: 1, failures: ["rejects invalid concurrency with RangeError"] },
    { runId: "b", applied: true, publicFail: 0, failures: [] },
  ]);
  assert.equal(s.verdict, "invented-requirement");
  assert.deepEqual(s.inventedAssertions, ["rejects invalid concurrency with RangeError"]);
  assert.equal(s.rejectedGood, 1);
  assert.match(formatGoldenReplay(s), /invalid concurrency/);
});

test("all specimens accepted is a clean gauge", () => {
  const s = summarizeGoldenReplay([
    { runId: "a", applied: true, publicFail: 0, failures: [] },
    { runId: "b", applied: true, publicFail: 0, failures: [] },
  ]);
  assert.equal(s.verdict, "clean");
  assert.equal(s.rejectedGood, 0);
});

// The gate-engagement lesson, again: absent evidence is not evidence of absence.
// With no known-good specimens the check has not run, and reporting that as
// "clean" would license exactly the assumption it exists to test.
test("no specimens is not a clean result", () => {
  const s = summarizeGoldenReplay([]);
  assert.equal(s.verdict, "no-specimens");
  assert.match(formatGoldenReplay(s), /no known-good|cannot|not been checked/i);
});

// A diff that will not apply is a harness problem, not an oracle problem, and
// must not be silently counted as either a pass or a rejection.
test("a specimen whose diff does not apply is reported separately", () => {
  const s = summarizeGoldenReplay([
    { runId: "a", applied: false, publicFail: 0, failures: [] },
    { runId: "b", applied: true, publicFail: 0, failures: [] },
  ]);
  assert.equal(s.verdict, "clean");
  assert.equal(s.notApplied, 1);
  assert.equal(s.replayed, 1);
  assert.match(formatGoldenReplay(s), /1 .*did not apply|could not be replayed/i);
});

// The same assertion failing on several known-good implementations is the
// strongest possible signal: it is the assertion, not the implementation.
test("counts how many good specimens each assertion rejects", () => {
  const s = summarizeGoldenReplay([
    { runId: "a", applied: true, publicFail: 1, failures: ["bad assertion"] },
    { runId: "b", applied: true, publicFail: 1, failures: ["bad assertion"] },
    { runId: "c", applied: true, publicFail: 1, failures: ["other"] },
  ]);
  assert.equal(s.byAssertion["bad assertion"], 2);
  assert.equal(s.byAssertion.other, 1);
  assert.match(formatGoldenReplay(s), /bad assertion/);
});
