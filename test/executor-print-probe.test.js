import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Executor } from "../src/executor.js";

function fixture(t, mocked = true) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-print-probe-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return new Executor(workspace, { shellSandbox: "host", ...(mocked ? {
    processRunner: async () => ({ code: 0, stdout: "observed value\n", stderr: "", timedOut: false, aborted: false, bufferExceeded: false }),
  } : {}) });
}

test("explicit conditional failure paths are not mislabeled print-only without an assert substring", async t => {
  for (const command of [
    `node -e 'if (actual !== expected) throw new Error("mismatch"); console.log(actual)'`,
    `node -e 'if (!valid) process.exit(1); console.log(actual)'`,
    `node -e 'if (!valid) process.exitCode = 1; console.log(actual)'`,
    `node -e 'if (!valid) fail("mismatch"); console.log(actual)'`,
    `node -e 'if (!valid) Promise.reject(Error("mismatch")); console.log(actual)'`,
    `python3 -c 'if not valid: raise ValueError("mismatch"); print(actual)'`,
    `python3 -c 'if not valid: sys.exit(1); print(actual)'`,
  ]) {
    const result = await fixture(t).execute({ a: "shell", c: command });
    assert.doesNotMatch(result.observation, /\[gauge\]|only prints|wrong value cannot fail/, command);
    assert.equal(result.shellExecution.executedCommand, command);
  }
});

test("printed diagnostics receive conditional advice, not an unsupported claim of no failure path", async t => {
  const executor = fixture(t);
  for (let i = 0; i < 3; i++) {
    const result = await executor.execute({ a: "shell", c: `node -e 'console.log(checkResult(${i}))'` });
    if (i < 2) assert.match(result.observation, /\[gauge\].*If these values are diagnostics rather than checked results/);
    else assert.doesNotMatch(result.observation, /\[gauge\]/);
    assert.doesNotMatch(result.observation, /only prints|wrong value cannot fail/);
  }
});

test("a real conditional throw fails incorrect values and retains the actual process outcome", async t => {
  const executor = fixture(t, false);
  for (const actual of [42, 41]) {
    const command = `node -e 'const actual=${actual}; if(actual!==42) throw new Error("WRONG_VALUE"); console.log("CHECKED",actual)'`;
    const result = await executor.execute({ a: "shell", c: command });
    assert.equal(result.shellExecution.exitCode, actual === 42 ? 0 : 1);
    assert.equal(result.shellExecution.executedCommand, command);
    assert.doesNotMatch(result.observation, /\[gauge\]|only prints|wrong value cannot fail/);
    assert.match(result.observation, actual === 42 ? /CHECKED 42/ : /WRONG_VALUE/);
  }
});
