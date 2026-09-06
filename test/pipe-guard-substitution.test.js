import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Executor, stripTestOutputFilter } from "../src/executor.js";
import { verificationEvidence, verificationShellStatusRisk } from "../src/verification-evidence.js";

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

function fixture(t, code = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-pipe-msg-")), calls = [];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executor = new Executor(dir, { shellSandbox: "host", processRunner: async (file, args) => {
    calls.push({ file, args });
    return { code, signal: null, stdout: `TAP version 13\n1..1\n# tests 1\n# pass ${code ? 0 : 1}\n# fail ${code ? 1 : 0}\n`,
      stderr: code ? "test failed\n" : "", timedOut: false, bufferExceeded: false, aborted: false };
  } });
  return { executor, calls };
}

test("opaque argument selection is not offered as an established direct verifier", async (t) => {
  const { executor, calls } = fixture(t);
  const result = await executor.execute({ a: "shell",
    c: 'node --test $(ls test/*.test.js | grep -vE "a.test.js") 2>&1 | tail -20' });
  assert.equal(calls.length, 0);
  assert.equal(result.shellExecution, null);
  assert.match(result.observation, /Nothing was executed.*No safe standalone test invocation/);
  assert.match(result.observation, /Preserve required setup, environment, cwd and argument selection/);
  assert.doesNotMatch(result.observation, /Send exactly this|run it directly:\n/);
});

test("simple test pipelines autocorrect with exact invocation and truthful pass or failure evidence", async (t) => {
  for (const code of [0, 1]) {
    const { executor, calls } = fixture(t, code);
    const requested = "npm test 2>&1 | grep -E '^(not ok|ok)' | tail -20";
    const result = await executor.execute({ a: "shell", c: requested });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.at(-1), "npm test");
    assert.equal(result.shellExecution.requestedCommand, requested);
    assert.equal(result.shellExecution.command, "npm test");
    assert.equal(result.shellExecution.exitCode, code);
    assert.equal(result.shellExecution.pipefail, true);
    assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, code ? "fail" : "pass");
    assert.match(result.observation, /Command executed: npm test/);
    assert.match(result.observation, /stdout and stderr are captured separately/);
  }
});

test("observed capture/echo/cat recipes refuse without execution and suggest only a direct test", async (t) => {
  for (const direct of ["node --test test/cli.test.js", "npm test"]) {
    const { executor, calls } = fixture(t);
    const command = `${direct} > /tmp/full.txt 2>&1; echo DONE; cat /tmp/full.txt | grep -E '^(ok|not ok|# (tests|pass|fail))'`;
    const refused = await executor.execute({ a: "shell", c: command });
    assert.equal(calls.length, 0);
    assert.equal(refused.shellExecution, null);
    assert.match(refused.observation, /Nothing was executed/);
    assert.match(refused.observation, /not an equivalent rewrite/);
    assert.match(refused.observation, /Preserve any required setup, environment, cwd and argument selection/);
    const suggested = /run it directly:\n  ([^\n]+)/.exec(refused.observation)?.[1];
    assert.equal(suggested, direct);
    assert.doesNotMatch(suggested, /[><;|&]|echo|cat/);
    assert.equal(verificationShellStatusRisk(suggested), null);
    const retried = await executor.execute({ a: "shell", c: suggested });
    assert.equal(calls.length, 1);
    assert.equal(retried.shellExecution.command, direct);
    assert.equal(verificationEvidence({ execution: retried.shellExecution, generation: 0 }).status, "pass");
  }
});

test("required prior setup, input redirects, opaque substitutions and interleaved args are never silently dropped", async (t) => {
  for (const command of [
    "cd subdir && npm test | tail -20",
    "export MODE=integration; npm test | tail -20",
    "node prepare.js; npm test | tail -20",
    "node --test < fixture.txt | tail -20",
    "npm test > /tmp/out.txt -- --required-selector | tail -20",
    'node --test "$(printf selected.test.js)" | tail -20',
    "node --test `printf selected.test.js` | tail -20",
    "! npm test | tail -20",
    "npm test 3> /tmp/extra-fd | tail -20",
  ]) {
    const { executor, calls } = fixture(t);
    const result = await executor.execute({ a: "shell", c: command });
    assert.equal(calls.length, 0, command);
    assert.equal(result.shellExecution, null, command);
    assert.match(result.observation, /No safe standalone test invocation/, command);
    assert.doesNotMatch(result.observation, /Send exactly this|run it directly:\n/, command);
  }
});

test("compound or executable filter programs are not automatically discarded", async (t) => {
  for (const command of [
    "npm test | tail -20; echo DONE",
    "npm test | grep failed && node followup.js",
    "npm test || tail -20 /tmp/out.txt",
    "npm test | sed -i /pattern/d output.txt",
    "npm test | awk '{system(\"node followup.js\")}'",
    "npm test | rg --pre ./prepare failed",
    "npm test | sort -o /tmp/output.txt",
    "npm test > /tmp/output.txt | tail -20",
  ]) {
    const { executor, calls } = fixture(t);
    const result = await executor.execute({ a: "shell", c: command });
    assert.equal(calls.length, 0, command);
    assert.equal(result.shellExecution, null);
    assert.match(result.observation, /Nothing was executed/);
    assert.match(result.observation, /not an equivalent rewrite/);
  }
});

test("autocorrection preserves simple environment, paths and literal quoted patterns", async (t) => {
  const direct = String.raw`MODE=integration npm --prefix 'sub project' test -- --pattern="quote\"|pipe"`;
  const { executor, calls } = fixture(t);
  const result = await executor.execute({ a: "shell", c: `${direct} | tail -20` });
  assert.equal(calls.length, 1);
  assert.equal(result.shellExecution.command, direct);
  assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, "pass");
});

test("a real failing Node test remains failed after automatic filter removal", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-pipe-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "failure.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; test("boundary", () => assert.equal(1, 2));\n');
  const executor = new Executor(dir, { shellSandbox: "host" });
  const result = await executor.execute({ a: "shell", c: "node --test failure.test.mjs 2>&1 | tail -1" });
  assert.equal(result.shellExecution.command, "node --test failure.test.mjs");
  assert.equal(result.shellExecution.exitCode, 1);
  assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, "fail");
  assert.match(result.observation, /not ok 1 - boundary/);
  assert.match(result.observation, /AssertionError/);
});
