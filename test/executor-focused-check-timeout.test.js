import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Executor } from "../src/executor.js";
import { verificationEvidence } from "../src/verification-evidence.js";

function fixture(t, response = {}, options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-focused-timeout-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const executor = new Executor(workspace, {
    shellSandbox: "host", shellTimeoutMs: 12000, testTimeoutMs: 2500,
    processRunner: async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { code: 0, signal: null, stdout: "", stderr: "",
        timedOut: false, aborted: false, bufferExceeded: false, ...response };
    }, ...options,
  });
  return { workspace, executor, calls };
}

test("direct focused checks share the tighter verification deadline without changing their program", async t => {
  for (const command of [
    "node check_contract.mjs", "node witness-case.cjs", "node test/edge.test.js",
    "python3 verify_api.py", "ruby check_api.rb",
    "node --input-type=module -e \"import assert from 'node:assert/strict'; assert.equal(1, 1);\"",
    "python3 -c 'assert 1 == 1'",
  ]) {
    const { executor, calls } = fixture(t);
    const result = await executor.execute({ a: "shell", c: command });
    assert.equal(calls.length, 1, command);
    assert.equal(calls[0].opts.timeoutMs, 2500, command);
    assert.equal(calls[0].args.at(-1), command, "deadline selection never rewrites the program");
    assert.equal(result.shellExecution.requestedCommand, command);
    assert.equal(result.shellExecution.executedCommand, command);
    assert.equal(result.shellExecution.pipefail, true);
  }
});

test("ordinary programs, informational calls and ambiguous setup compounds retain the general clock", async t => {
  for (const command of [
    "node build.mjs", "python3 train.py", "node cli.mjs invalid-input",
    "node check-api.mjs --help", "node --check check-api.mjs",
    "node -e 'console.log(1)'",
    "node prepare.mjs && node check-api.mjs",
    "node check-api.mjs && node cleanup.mjs",
  ]) {
    const { executor, calls } = fixture(t);
    const result = await executor.execute({ a: "shell", c: command });
    assert.equal(calls.length, 1, command);
    assert.equal(calls[0].opts.timeoutMs, 12000, command);
    assert.equal(result.shellExecution.executedCommand, command);
  }
});

test("an already shorter shell deadline still wins and passive echoes retain transparent normalization", async t => {
  const { executor, calls } = fixture(t, {}, { shellTimeoutMs: 800 });
  const command = 'node check_contract.mjs 2>&1; echo "TEST_EXIT=$?"';
  const result = await executor.execute({ a: "shell", c: command });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.timeoutMs, 800);
  assert.equal(result.shellExecution.requestedCommand, command);
  assert.equal(result.shellExecution.executedCommand, "node check_contract.mjs");
  assert.match(result.observation, /echo was not executed/);
});

test("a focused timeout is uncertainty, never a green receipt or advice to background the check", async t => {
  const { executor, calls } = fixture(t, { timedOut: true, stdout: "# tests 1\n# pass 1\n# fail 0\n" });
  const result = await executor.execute({ a: "shell", c: "node check_contract.mjs" });
  assert.equal(calls[0].opts.timeoutMs, 2500);
  assert.equal(result.shellExecution.timedOut, true);
  assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, "unverified");
  assert.match(result.observation, /\[timeout\] Verification was killed after 3s/);
  assert.match(result.observation, /runaway recursion/);
  assert.match(result.observation, /last unmatched marker/);
  assert.match(result.observation, /do not assume a later finalizer ran/);
  assert.doesNotMatch(result.observation, /nohup|background and poll|VERDICT: all/);
});

test("a real hanging ad-hoc check is stopped by the verification deadline", async t => {
  const { workspace } = fixture(t);
  fs.writeFileSync(path.join(workspace, "check-loop.mjs"), "console.log('check started'); setInterval(() => {}, 1000);\n");
  const executor = new Executor(workspace, { shellSandbox: "host", shellTimeoutMs: 10000, testTimeoutMs: 250 });
  const result = await executor.execute({ a: "shell", c: "node check-loop.mjs" });
  assert.equal(result.shellExecution.timedOut, true);
  assert.match(result.shellExecution.stdout, /check started/);
  assert.notEqual(verificationEvidence({ execution: result.shellExecution, generation: 0 })?.status, "pass");
  assert.match(result.observation, /Verification was killed/);
  assert.doesNotMatch(result.observation, /nohup/);
});
