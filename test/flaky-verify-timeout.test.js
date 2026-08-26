import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    requestCursor() {
      return this.prompts.length;
    },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return {
        content: outputs.shift(),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}

test("the flaky-verify recheck runs the same bounded command as the first verify", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-flaky-verify-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const verifyCommands = [];
  const shellProcessRunner = async (file, args) => {
    const command = args[args.length - 1];
    if (command.includes("node --test")) verifyCommands.push(command);
    return {
      code: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      bufferExceeded: false,
      aborted: false,
    };
  };

  const model = scriptedModel([
    JSON.stringify({ a: "done", summary: "finished" }),
  ]);

  const result = await runAgent({
    task: "Finish the task.",
    workspace,
    model,
    maxTurns: 1,
    interactive: true,
    useGrammar: false,
    grounding: null,
    shellSandbox: "host",
    verificationScript: "node --test",
    flakyVerify: true,
    shellProcessRunner,
  });

  assert.equal(result.verification.status, "pass");
  assert.equal(verifyCommands.length, 2, "a flaky-verify pass runs the verifier twice");
  for (const command of verifyCommands) {
    assert.match(
      command,
      /--test-timeout=/,
      "both runs must carry the per-test timeout so a hang cannot outlive the first run's bound",
    );
  }
});
