import assert from "node:assert/strict";
import test from "node:test";

import { clipVerificationOutput } from "../src/agent.js";

// The run artifact's `verifyDetail` is the only record of WHY a run failed once
// the workspace is gone. It clipped head + tail at 2,000 characters, on the
// reasoning that "test runners put the useful failure summary at the end" —
// true of the COUNTS, and false of the failing test's name and diagnostic, which
// node's TAP writes where the failure occurred.
//
// 2026-08-17T12-06-25 is the case: a ticket-B run that ended `# pass 2162 /
// # fail 1`. The artifact kept 1,161 `ok` lines and the summary, and dropped the
// one `not ok`. Which test failed was unrecoverable without re-running the run.
//
// digestTestOutput already solved this for what the MODEL sees mid-run
// (2026-08-17, tb24). The artifact was still clipping blind.

const tapWith = (failAt, total, name) => {
  const lines = ["TAP version 13"];
  for (let i = 1; i <= total; i += 1) {
    lines.push(`# Subtest: case ${i}`);
    if (i === failAt) {
      lines.push(`not ok ${i} - ${name}`);
      lines.push("  ---");
      lines.push("  error: 'Expected values to be strictly equal: 3 !== 4'");
      lines.push("  code: 'ERR_ASSERTION'");
      lines.push("  ...");
    } else {
      lines.push(`ok ${i} - case ${i} passes`);
      lines.push("  ---");
      lines.push("  duration_ms: 1.5");
      lines.push("  ...");
    }
  }
  lines.push(`1..${total}`, `# tests ${total}`, `# pass ${total - 1}`, `# fail 1`);
  return lines.join("\n");
};

test("a failure in the middle survives the clip", () => {
  const out = clipVerificationOutput(tapWith(500, 1000, "impossible scope ends the run early"));
  assert.match(out, /not ok 500/, `the failing case must survive; got ${out.length} chars`);
  assert.match(out, /impossible scope ends the run early/, "and its name");
  assert.match(out, /ERR_ASSERTION|strictly equal/, "and enough of the diagnostic to act on");
});

test("the summary counts still survive", () => {
  const out = clipVerificationOutput(tapWith(500, 1000, "some case"));
  assert.match(out, /# fail 1/, "the tail is what makes a run gradable");
  assert.match(out, /# pass 999/);
});

test("output that fits is returned untouched", () => {
  const small = "TAP version 13\nok 1 - fine\n1..1\n# pass 1\n# fail 0";
  assert.equal(clipVerificationOutput(small), small);
});

test("an all-passing run still clips to a bounded size", () => {
  const green = tapWith(-1, 1000, "");
  const out = clipVerificationOutput(green);
  assert.ok(out.length < green.length, "still clipped");
  assert.match(out, /# fail 1|# pass 1000/, "the summary survives either way");
});

// Preserving the failure REGION keeps the first failure. A run that ends four
// tests short still records only one of them, because the other three sit
// thousands of characters further down in the TAP. tb30 is exactly that: four
// failing tests, one recoverable from its artifact.
//
// The digest already solves this for the model — renderFailingTests names every
// failure in a few hundred characters, with its assertion. The artifact should
// lead with the same thing, and keep the raw slice after it for context.
import { renderFailingTests } from "../src/logic/test-focus.js";

test("a four-failure run names all four in the record", () => {
  const lines = ["TAP version 13"];
  for (let i = 1; i <= 400; i += 1) {
    lines.push(`# Subtest: case ${i}`);
    if (i % 100 === 0) {
      lines.push(`not ok ${i} - requirement ${i} is met`);
      lines.push("  ---", `  location: 'test/req.test.js:${i}:1'`,
        `  error: 'requirement ${i} was not applied'`, "  code: 'ERR_ASSERTION'", "  ...");
    } else {
      lines.push(`ok ${i} - case ${i}`, "  ---", "  duration_ms: 1", "  ...");
    }
  }
  lines.push("1..400", "# tests 400", "# pass 396", "# fail 4");
  const raw = lines.join("\n");

  const digest = renderFailingTests(raw, { max: 8 });
  for (const n of [100, 200, 300, 400]) {
    assert.match(digest, new RegExp(`requirement ${n} is met`), `failure ${n} must be named`);
    assert.match(digest, new RegExp(`requirement ${n} was not applied`), `and explained`);
  }
  assert.ok(digest.length < 900, `and it must stay small: ${digest.length} chars`);
});
