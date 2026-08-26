import assert from "node:assert/strict";
import test from "node:test";

import { stripTestOutputFilter } from "../src/executor.js";

// tb7 (2026-08-16, .bantam/runs/2026-08-16T18-00-31-834Z.json) is the first run
// where the model ran the configured verification at all — turn 42, copied
// verbatim from the new prompt line:
//
//   node --test $(ls test/*.test.js | grep -vE "genre.test.js|factory-claim-ledger.test.js")
//
// The pipe guard refused it. Its detector was a regex over the raw string,
// `/\|\s*(head|tail|grep|…)/`, which matched the `| grep -vE` INSIDE the
// command substitution — a pipe that builds an argument list, not one that
// filters the runner's output. So the one command the prompt had just told the
// model to run was un-runnable, and would have stayed so on every retry.
//
// Only a TOP-LEVEL stage can filter output. Stage splitting now respects
// $( … ) and backticks as well as quotes.

test("a pipe inside command substitution is not an output filter", () => {
  const command = 'node --test $(ls test/*.test.js | grep -vE "genre.test.js|factory-claim-ledger.test.js")';
  assert.equal(stripTestOutputFilter(command), null,
    "nothing to peel — the pipe builds the file list");
});

test("a backtick substitution is treated the same way", () => {
  assert.equal(stripTestOutputFilter("node --test `ls test/*.test.js | grep -v skip`"), null);
});

test("a real trailing filter is still peeled", () => {
  assert.equal(stripTestOutputFilter("node --test | tail -20"), "node --test");
});

test("a trailing filter is peeled without disturbing an inner substitution", () => {
  const command = 'node --test $(ls test/*.test.js | grep -vE "a") 2>&1 | tail -20';
  assert.equal(stripTestOutputFilter(command), 'node --test $(ls test/*.test.js | grep -vE "a") 2>&1');
});

test("a chain of trailing filters is peeled whole", () => {
  assert.equal(stripTestOutputFilter("npm test | grep -E 'not ok' | tail -5"), "npm test");
});

test("a quoted pipe inside a pattern is still not a boundary", () => {
  // The original reason stage splitting respects quotes; it must survive.
  assert.equal(stripTestOutputFilter("npm test | grep -E '^(not ok|ok)'"), "npm test");
});

test("an unpiped command yields nothing to strip", () => {
  assert.equal(stripTestOutputFilter("npm test"), null);
});

// tb10 (2026-08-16, .bantam/runs/2026-08-16T18-57-06-972Z.json) reached its
// FIRST verification at turn 57 of 60, appended `2>&1 | tail -20`, was refused
// — correctly, that is a real output filter — and had no budget left to retry.
// The harness had already computed the command it wanted; stating the rule
// without the command costs a turn the run may not have.

test("the refusal names the exact command to send instead", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Executor } = await import("../src/executor.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-pipe-msg-"));
  try {
    const executor = new Executor(dir, { shellSandbox: "host" });
    const result = await executor.shell({
      c: 'node --test $(ls test/*.test.js | grep -vE "a.test.js") 2>&1 | tail -20',
    });
    const text = String(result?.observation ?? result);
    assert.match(text, /Send exactly this instead:/);
    assert.match(text, /node --test \$\(ls test\/\*\.test\.js \| grep -vE "a\.test\.js"\) 2>&1/,
      "the substitution must survive into the suggested command");
    assert.doesNotMatch(text.split("Send exactly this instead:")[1], /\| tail/,
      "and the filter must not");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
