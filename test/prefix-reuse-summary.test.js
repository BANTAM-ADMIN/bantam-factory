// The run summary reported turns, tokens and wall-clock but never said how much
// of the prompt was REUSED. That number is the difference between a turn that
// resumes from a checkpoint and one that reprocesses the whole context, and on
// this stack it is set by --ubatch-size vs how far back the prompt changes.
// Measured 2026-08-22: a profile whose window was too small ran every turn at
// 0% reuse, 3813 ms instead of 1513 ms, and nothing in the output said so.
// The throughput andon catches the catastrophic case (3 turns under 50%); this
// is the everyday gauge that makes chronic waste visible without an alarm.
import assert from "node:assert/strict";
import test from "node:test";

import { formatPrefixReuse } from "../src/model-usage.js";

test("reuse is reported as a share of the prompt actually sent", () => {
  const line = formatPrefixReuse({ inputTokens: 10000, cacheHitTokens: 8800 });
  assert.match(line, /88%/);
  assert.match(line, /8,800/);
  assert.match(line, /10,000/);
});

test("a healthy run gets no advice attached", () => {
  assert.doesNotMatch(formatPrefixReuse({ inputTokens: 10000, cacheHitTokens: 9500 }), /ubatch/);
});

test("chronic low reuse names the knob that controls it", () => {
  const line = formatPrefixReuse({ inputTokens: 40000, cacheHitTokens: 4000 });
  assert.match(line, /10%/);
  assert.match(line, /ubatch/, "the operator should not have to already know the mechanism");
});

test("small runs stay quiet — there is no prefix worth reusing", () => {
  // Advice keyed off a 300-token run would fire on every trivial task.
  assert.doesNotMatch(formatPrefixReuse({ inputTokens: 300, cacheHitTokens: 0 }), /ubatch/);
});

test("no usage at all reports nothing rather than 0% or NaN", () => {
  assert.equal(formatPrefixReuse({ inputTokens: 0, cacheHitTokens: 0 }), null);
  assert.equal(formatPrefixReuse(null), null);
  assert.equal(formatPrefixReuse(undefined), null);
});

test("a hit count above the prompt total cannot produce over 100%", () => {
  const line = formatPrefixReuse({ inputTokens: 100, cacheHitTokens: 999 });
  assert.match(line, /100%/);
  assert.doesNotMatch(line, /999%/);
});
