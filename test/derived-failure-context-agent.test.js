import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import { DERIVED_CONTEXT_MARKER } from "../src/logic/derived-failure-context.js";

test("runAgent injects Datalog-derived context once when an edit preserves a failure", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-derived-context-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "cache.js"), "export const version = 0;\n");

  const actions = [
    { a: "replace", p: "src/cache.js", old: "version = 0", new: "version = 1" },
    { a: "shell", c: "npm test" },
    { a: "replace", p: "src/cache.js", old: "version = 1", new: "version = 2" },
    { a: "shell", c: "npm test" },
  ];
  let call = 0;
  const model = {
    assistantPrefill: "",
    async complete() {
      return {
        content: JSON.stringify(actions[call++]),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
  const shellProcessRunner = async () => ({
    code: 1,
    signal: null,
    stdout: "TAP version 13\nnot ok 1 - evicts failed loads\n  error: 'boom'\n# fail 1\n",
    stderr: "",
    timedOut: false,
    bufferExceeded: false,
    aborted: false,
  });

  const result = await runAgent({
    task: "Implement a keyed cache. get always returns a Promise. Validate key and loader. Loader throws reject asynchronously. Concurrent misses for the same key return the exact same Promise. TTL begins when loader resolves. invalidate fences an older in-flight stale completion.",
    workspace,
    model,
    maxTurns: actions.length,
    thinkMode: "off",
    useGrammar: false,
    preGate: false,
    grounding: false,
    completionAudit: false,
    progressAwareness: false,
    testFocus: false,
    regressionGuard: false,
    diagnoseStuckTests: false,
    autoVerifyBlindEdits: 0,
    autoVerifyProbes: 0,
    autoVerifyStaleTurns: 0,
    shellSandbox: "host",
    shellProcessRunner,
  });

  assert.equal(result.metrics.outcomeCycleEvents, 1);
  assert.equal(result.metrics.derivedFailureContextHints, 1);
  assert.ok(result.turns[3].observation.includes(DERIVED_CONTEXT_MARKER));
  assert.match(result.turns[3].observation, /Promise\.resolve\(\)\.then/);
  assert.match(result.turns[3].observation, /entries\.get\(key\) === entry/);
  assert.equal(result.turns.filter((turn) => turn.observation.includes(DERIVED_CONTEXT_MARKER)).length, 1);
});

test("runAgent treats a failure after a verified repair as a new episode", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-outcome-repair-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "cache.js"), "export const version = 0;\n");
  const actions = [
    { a: "shell", c: "npm test" },
    { a: "replace", p: "cache.js", old: "version = 0", new: "version = 1" },
    { a: "shell", c: "npm test" },
    { a: "replace", p: "cache.js", old: "version = 1", new: "version = 2" },
    { a: "shell", c: "npm test" },
  ];
  let call = 0, executions = 0;
  const result = await runAgent({
    task: "Repair cache.js and run npm test.", workspace,
    model: { assistantPrefill: "", async complete() {
      return { content: JSON.stringify(actions[call++]), tokens: 1,
        stoppedEos: true, stoppedLimit: false, timings: {} };
    } },
    maxTurns: actions.length, thinkMode: "off", useGrammar: false,
    preGate: false, grounding: false, completionAudit: false,
    progressAwareness: false, testFocus: false, regressionGuard: false,
    diagnoseStuckTests: false, autoVerifyBlindEdits: 0,
    autoVerifyProbes: 0, autoVerifyStaleTurns: 0, shellSandbox: "host",
    shellProcessRunner: async () => {
      const pass = ++executions === 2;
      return { code: pass ? 0 : 1, signal: null,
        stdout: `TAP version 13\n${pass ? "ok" : "not ok"} 1 - cache preserves identity\n1..1\n# tests 1\n# pass ${pass ? 1 : 0}\n# fail ${pass ? 0 : 1}\n`,
        stderr: "", timedOut: false, bufferExceeded: false, aborted: false };
    },
  });
  assert.equal(executions, 3);
  assert.equal(result.turns[2].verificationEvidence.status, "pass");
  assert.equal(result.metrics.outcomeCycleEvents, 0);
  assert.equal(result.metrics.derivedFailureContextHints, 0);
  assert.doesNotMatch(result.turns[4].observation, /\[outcome-cycle\]|intervening work did not change/);
});
