import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareExecutionEvidence, formatExecutionComparison } from "../src/delegate-comparison.js";

// A source that measured NOTHING used to win every award.
//
// Every field in this file defaulted to `?? 0` -- turns, tokens, durationMs -- and
// the awards are computed by `minimum()`. So an artifact with no usage block and no
// execution block rendered as 0 turns, 0 tokens, 0.0s, and was crowned Fastest,
// Lowest input, Lowest cache miss and Lowest output simultaneously, next to a real
// run that had honestly recorded 50,000 input tokens and 90 seconds.
//
// It does not read as missing data. It reads as a flawless, instantaneous, free
// run, and it beats every arm that actually reported its costs. This is the same
// rule the compare arms and the eval statuses already follow: absent is not zero.

let dir;
const write = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

const complete = {
  kind: "bantam-codex-delegate",
  model: "gpt-5.6-terra",
  effort: "medium",
  result: { pass: true },
  usage: {
    turns: 7, inputTokens: 50_000, cachedInputTokens: 40_000,
    cacheMissTokens: 10_000, outputTokens: 3_000, reasoningOutputTokens: 1_200,
  },
  execution: { durationMs: 90_000 },
};

// Same shape, no usage and no execution -- the artifact of a run whose accounting
// never got written.
const silent = {
  kind: "bantam-codex-delegate",
  model: "gpt-5.6-sol",
  effort: "medium",
  result: { pass: true },
};

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-dc-")); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("a source that measured nothing", () => {
  it("does not win Fastest against a run that reported a real duration", () => {
    const c = compareExecutionEvidence([write("a.json", complete), write("b.json", silent)]);
    assert.notEqual(c.fastest, "native-sol-medium",
      "an unrecorded duration must not beat a measured 90s");
    assert.equal(c.fastest, "native-terra-medium");
  });

  it("does not win any of the token awards", () => {
    const c = compareExecutionEvidence([write("a.json", complete), write("b.json", silent)]);
    for (const award of ["lowestInput", "lowestCacheMiss", "lowestOutput"]) {
      assert.notEqual(c[award], "native-sol-medium", `unmeasured row won ${award}`);
    }
  });

  it("renders its missing numbers as unmeasured, not as zero", () => {
    const text = formatExecutionComparison(
      compareExecutionEvidence([write("a.json", complete), write("b.json", silent)]),
    );
    const row = text.split("\n").find((l) => l.includes("native-sol-medium"));
    assert.doesNotMatch(row, /\b0\.0s\b/, "a missing duration must not render as 0.0s");
    assert.match(row, /n\/a/, "missing measurements should read as n/a");
  });

  // Zero is a legitimate measurement. Only ABSENT is the problem, and the fix must
  // not conflate them.
  it("still lets a genuinely-zero measurement compete", () => {
    const zero = {
      ...complete, model: "gpt-5.6-sol",
      usage: { ...complete.usage, outputTokens: 0 },
      execution: { durationMs: 1_000 },
    };
    const c = compareExecutionEvidence([write("a.json", complete), write("b.json", zero)]);
    assert.equal(c.lowestOutput, "native-sol-medium",
      "a recorded 0 is a real value and must be allowed to win");
  });
});

// The same tiebreak defect that crowned BANTAM on a draw in `bantam compare`:
// `minimum()` sorts and takes [0], so equal values report the first row as a
// strict winner.
describe("awards on a tie", () => {
  it("does not name a single winner when two rows are equal", () => {
    const other = { ...complete, model: "gpt-5.6-sol" };
    const c = compareExecutionEvidence([write("a.json", complete), write("b.json", other)]);
    assert.equal(c.fastest, null, "identical durations are a tie, not a win");
    const text = formatExecutionComparison(c);
    assert.match(text, /Fastest: tie/i);
  });
});

// One measured row is not a comparison.
describe("when only one row measured a metric", () => {
  it("reports the award as unmeasured rather than crowning the only entrant", () => {
    const c = compareExecutionEvidence([write("a.json", complete), write("b.json", silent)]);
    assert.equal(c.lowestCacheMiss, "native-terra-medium");
    // and it must say so, rather than implying two arms were weighed
    assert.match(formatExecutionComparison(c), /only 1 (?:row|source) measured/i);
  });
});
