import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

function scriptedPromptModel(outputs) {
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

function systemBlock(prompt) {
  const close = prompt.indexOf("<|im_end|>");
  assert.ok(close > 0, "prompt must open with a system turn");
  return prompt.slice(0, close);
}

test("the system head stays byte-identical across a mid-run feature escalation", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-head-stability-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "lib.js"), "export const value = 1;\n");

  const model = scriptedPromptModel([
    JSON.stringify({ a: "read_file", p: "lib.js" }),
    JSON.stringify({ a: "replace", p: "lib.js", old: "text that is not present", new: "x" }),
    JSON.stringify({ a: "respond", text: "Recovered." }),
  ]);

  const result = await runAgent({
    task: "Adjust lib.js.",
    workspace,
    model,
    maxTurns: 4,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
  });

  assert.equal(result.responded, true);
  assert.match(result.turns[1].observation, /^ERROR:/);

  const heads = model.prompts.map(systemBlock);
  for (let i = 1; i < heads.length; i += 1) {
    assert.equal(
      heads[i],
      heads[0],
      `prompt ${i + 1}'s system head must be byte-identical to prompt 1's — `
      + "a churning head invalidates every cached token below it",
    );
  }

  // The recovery turn still has to teach the line-edit shape somewhere.
  const recoveryPrompt = model.prompts[2];
  assert.match(recoveryPrompt, /"a":"edit_lines"/);
});
