import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor, stripPassiveTestStatusSuffix } from "../src/executor.js";
import { verificationEvidence } from "../src/verification-evidence.js";

function fixture(t, code = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-passive-status-")), calls = [];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executor = new Executor(dir, { shellSandbox: "host", processRunner: async (file, args) => {
    calls.push({ file, args });
    return { code, signal: null, stdout: "CHECK_OUTPUT\n", stderr: "", timedOut: false, bufferExceeded: false, aborted: false };
  } });
  return { executor, calls, dir };
}

test("only a passive exit-code echo is removed from a simple direct check", () => {
  for (const [requested, direct] of [
    ['npm test; echo "EXIT=$?"', "npm test"],
    ['node --test test/edge.test.js; echo "FINAL_EXIT=$?"', "node --test test/edge.test.js"],
    ["node check-api.mjs; echo $?", "node check-api.mjs"],
    ["python3 verify_api.py; echo EXIT=$?", "python3 verify_api.py"],
    ['node witness-case.cjs; echo "status: $?"', "node witness-case.cjs"],
    [`npm test -- --test-name-pattern='semi;colon'; echo "EXIT=$?"`, "npm test -- --test-name-pattern='semi;colon'"],
  ]) assert.equal(stripPassiveTestStatusSuffix(requested), direct, requested);
});

test("no setup, cleanup, assignment, redirect, substitution, wrapper, or additional statement is inferred away", () => {
  for (const command of [
    'cd subdir && npm test; echo "EXIT=$?"',
    'MODE=test npm test; echo "EXIT=$?"',
    'export MODE=test; npm test; echo "EXIT=$?"',
    'node prepare.js; npm test; echo "EXIT=$?"',
    'rm verify-api.mjs && npm test; echo "FINAL_EXIT=$?"',
    'npm test > /tmp/out; echo "EXIT=$?"',
    'npm test 2>&1; echo "EXIT=$?"',
    'npm test < fixture; echo "EXIT=$?"',
    'npm test | tail -1; echo "EXIT=$?"',
    'npm test && echo "EXIT=$?"',
    'npm test; echo "EXIT=$?"; node after.js',
    'npm test; echo "EXIT=$?" > /tmp/status',
    'npm test; echo "EXIT=$(node mutate.js)"',
    'npm test; echo "EXIT=$? OTHER=$OTHER"',
    "npm test; echo 'EXIT=$?'",
    'npm test; echo DONE',
    'npm test; printf "EXIT=%s" "$?"',
    'npm test\necho "EXIT=$?"',
    'npm test; echo "EXIT=$?"\nnode after.js',
    'node --test "$(find test)"; echo "EXIT=$?"',
    'node --test "$TEST_FILE"; echo "EXIT=$?"',
    "node --test `find test`; echo EXIT=$?",
    'bash -c "npm test"; echo "EXIT=$?"',
    '! npm test; echo "EXIT=$?"',
    'npm test # not a command separator; echo "EXIT=$?"',
  ]) assert.equal(stripPassiveTestStatusSuffix(command), null, command);
});

test("ordinary CLI expected-error probes and non-executing invocations are not called assertion checks", () => {
  for (const command of [
    'node cli.mjs invalid-input; echo "EXIT=$?"',
    'node snapshot.js verify missing; echo "EXIT=$?"',
    'node check-api.mjs --help; echo "EXIT=$?"',
    'node --check check-api.mjs; echo "EXIT=$?"',
    'node -p check-api.mjs; echo "EXIT=$?"',
    'node --require check-api.mjs; echo "EXIT=$?"',
    'python -c "print(1)"; echo "EXIT=$?"',
    'echo "node --test"; echo "EXIT=$?"',
  ]) assert.equal(stripPassiveTestStatusSuffix(command), null, command);
});

test("eligible checks execute once with transparent requested/actual metadata and real pass/fail status", async t => {
  for (const code of [0, 1]) {
    const { executor, calls } = fixture(t, code);
    const requested = 'node check-api.mjs; echo "EXIT=$?"';
    const result = await executor.execute({ a: "shell", c: requested });
    assert.equal(calls.length, 1, "never run the compound first and then repeat the check");
    assert.equal(calls[0].args.at(-1), "node check-api.mjs");
    assert.equal(result.shellExecution.requestedCommand, requested);
    assert.equal(result.shellExecution.command, "node check-api.mjs");
    assert.equal(result.shellExecution.executedCommand, "node check-api.mjs");
    assert.equal(result.shellExecution.exitCode, code);
    assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, code ? "fail" : "pass");
    assert.match(result.observation, /WITHOUT the passive status-print suffix/);
    assert.match(result.observation, /echo was not executed/);
    assert.match(result.observation, /CHECK_OUTPUT/);
  }
});

test("native test runners retain their selectors and executor timeout while omitting only the status echo", async t => {
  for (const direct of ["npm test", "node --test test/edge.test.js"]) {
    const { executor, calls } = fixture(t);
    const requested = `${direct}; echo "EXIT=$?"`;
    const result = await executor.execute({ a: "shell", c: requested });
    assert.equal(calls.length, 1);
    assert.equal(result.shellExecution.requestedCommand, requested);
    assert.equal(result.shellExecution.command, direct);
    assert.equal(result.shellExecution.executedCommand.includes("echo"), false);
    if (direct.startsWith("node")) assert.match(result.shellExecution.executedCommand, /^node --test --test-timeout=\d+ test\/edge.test.js$/);
    assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, "pass");
  }
});

test("required cleanup and expected-negative CLI commands retain the exact original compound and no invented pass", async t => {
  for (const command of ['rm verify-api.mjs && npm test; echo "FINAL_EXIT=$?"', 'node cli.mjs invalid-input; echo "EXIT=$?"']) {
    const { executor, calls } = fixture(t);
    const result = await executor.execute({ a: "shell", c: command });
    assert.equal(calls.length, 1);
    assert.equal(result.shellExecution.command, command, "existing authorized command is not semantically rewritten");
    assert.equal(result.shellExecution.executedCommand, command);
    assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, "unverified");
    assert.doesNotMatch(result.observation, /\[status-guard\]/);
  }
});

test("a real throwing check cannot become successful by printing its exit code", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-passive-status-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "check-edge.mjs"), 'import assert from "node:assert/strict"; assert.equal(1, 2);\n');
  const result = await new Executor(dir, { shellSandbox: "host" }).execute({ a: "shell", c: 'node check-edge.mjs; echo "EXIT=$?"' });
  assert.equal(result.shellExecution.exitCode, 1);
  assert.match(result.shellExecution.stderr, /AssertionError/);
  assert.equal(result.shellExecution.stdout.includes("EXIT="), false);
  assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, "fail");
});
