import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import { Executor } from "../src/executor.js";

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

test("a panel-covered broad re-read never reaches the executor", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-panel-veto-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const lines = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n");
  fs.writeFileSync(path.join(workspace, "lib.js"), `${lines}\n`);
  fs.writeFileSync(path.join(workspace, "aux.js"), "export const aux = 1;\n");

  const execute = t.mock.method(Executor.prototype, "execute");
  const model = scriptedPromptModel([
    JSON.stringify({ a: "read_file", p: "lib.js" }),
    JSON.stringify({ a: "read_file", p: "aux.js" }),
    // Not byte-identical to turn 1 (evades the duplicate guard) but still a
    // broad fetch of panel-resident bytes: the panel veto's exact territory.
    JSON.stringify({ a: "read_file", p: "lib.js", limit: 200 }),
    JSON.stringify({ a: "respond", text: "Used the panel contents." }),
  ]);

  const result = await runAgent({
    task: "Inspect these files and report what lib.js contains.",
    workspace,
    model,
    maxTurns: 6,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
  });

  assert.equal(result.responded, true);
  assert.match(result.turns[2].observation, /^\[open_files\] Not re-read/);
  assert.equal(result.metrics.panelRedirects, 1);

  const executedReads = execute.mock.calls
    .map((call) => call.arguments[0])
    .filter((action) => action?.a === "read_file");
  assert.equal(
    executedReads.length,
    2,
    "the redirected third read must be vetoed before execution, not executed and overwritten",
  );
});
