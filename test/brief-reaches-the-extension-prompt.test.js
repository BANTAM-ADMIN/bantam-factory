import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

// 2026-08-24 auto-mode tour run (.bantam/runs/2026-08-25T05-19-09-299Z-chat-r0.json):
// the repository_context event fired, every one of the 9 prompts carried the
// nudge "A live `map brief` is already supplied in the repository context
// below", and none of them carried the brief. Under the extension trajectory
// the <open_files> packet — the brief's only vehicle — is never rendered
// (prompt.js), so the harness promised context it did not give. The head is
// frozen under extension, so the brief rides in the head, once.

function scriptedPromptModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

test("under the extension trajectory the promised brief is in every prompt, once, in the frozen head", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-brief-extension-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "entry.js"), "export const entry = true;\n");
  const map = { name: "map", description: "fixture repository map", verbs: ["brief", "arch"], answer: () => "FIXTURE LIVE BRIEF: entry.js exports entry" };
  const model = scriptedPromptModel([
    JSON.stringify({ a: "read_file", p: "src/entry.js" }),
    JSON.stringify({ a: "respond", text: "It exports entry." }),
  ]);
  const result = await runAgent({
    task: "Take a look at your codebase.",
    workspace, model, maxTurns: 2, interactive: true, useGrammar: false, grounding: true,
    extraTools: [map], shellSandbox: "host", promptTrajectory: "extension",
  });
  assert.equal(result.responded, true);
  assert.equal(model.prompts.length, 2);
  for (const prompt of model.prompts) {
    assert.match(prompt, /already supplied in the repository context/, "the nudge is made");
    assert.equal(prompt.match(/FIXTURE LIVE BRIEF/g)?.length, 1, "…so the brief must be there, exactly once");
    const head = prompt.indexOf("FIXTURE LIVE BRIEF");
    const firstObservation = prompt.indexOf("<observation>");
    assert.ok(firstObservation === -1 || head < firstObservation, "in the frozen head, before any observation");
  }
  // Byte-extension holds: prompt 2 starts with prompt 1's bytes up to the prefill.
  const p1 = model.prompts[0].replace(/<\|im_start\|>assistant\n?$/, "");
  assert.ok(model.prompts[1].startsWith(p1.slice(0, Math.min(p1.length, model.prompts[1].length) - 40)), "the head did not churn");
});
