import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPrompt } from "../src/prompt.js";
import { runAgent } from "../src/agent.js";

const TASK = "Implement the thing.";
const ENV = "node 20";
const FILE_BODY = "1\texport function alpha() {\n2\t  return 1;\n3\t}\n";

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

test("extension trajectory: every prompt begins with the previous prompt byte-for-byte", () => {
  const turnsOne = [
    { i: 0, action: { a: "read_file", p: "src/a.js" }, observation: FILE_BODY },
  ];
  const turnsTwo = [
    ...turnsOne,
    {
      i: 1,
      action: { a: "write_file", p: "src/a.js", content: "export function alpha() { return 2; }" },
      observation: "wrote src/a.js",
      editApplied: true,
    },
  ];
  const build = (turns, extras = {}) => buildPrompt({
    task: TASK,
    env: ENV,
    turns,
    extensionTrajectory: true,
    openPaths: ["src/a.js"],
    readPaths: ["src/a.js"],
    openFilesText: "# src/a.js (current)\n1\texport function alpha() { return 2; }\n",
    reanchorText: "Reminder — your objective: implement the thing.",
    ...extras,
  });

  const first = build(turnsOne);
  const second = build(turnsTwo, {
    openFilesText: "# src/a.js (current)\n1\tcompletely different panel bytes\n",
    reanchorText: "A different reminder that must not rewrite the shared prefix.",
  });

  assert.ok(second.startsWith(first), "the next prompt must extend the previous one");
  assert.ok(!first.includes("# src/a.js (current)"), "the live panel must not render mid-prompt");
  assert.ok(!second.includes("completely different panel bytes"), "panel refreshes must not reach the prompt");
  assert.ok(!first.includes("Reminder — your objective"), "volatile tail blocks must not render");
  assert.ok(second.includes(FILE_BODY.trim()), "history stays immutable — no superseded-read rewrite");
  assert.ok(!second.includes("earlier snapshot omitted"), "no pointer substitution in extension mode");
});

test("every transport defaults to rebuild; extension remains an explicit choice", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-trajectory-default-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "lib.js"), "export const value = 1;\n");

  const script = () => [
    JSON.stringify({ a: "read_file", p: "lib.js" }),
    JSON.stringify({ a: "respond", text: "Done." }),
  ];
  const run = (model, extra = {}) => runAgent({
    task: "Inspect lib.js.",
    workspace,
    model,
    maxTurns: 3,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    ...extra,
  });

  // Local endpoint model: rebuild is the default again per the 2026-08-12
  // strictness routing decision (10/10 vs 7/10 at n=10 on the flagged family).
  const local = Object.assign(scriptedPromptModel(script()), { endpoint: "http://127.0.0.1:9" });
  await run(local);
  assert.ok(local.prompts.some((p) => p.includes("(current, ")),
    "a local endpoint model defaults to the rebuild panel");

  // Extension stays one explicit option away, with its invariant intact.
  const opted = Object.assign(scriptedPromptModel(script()), { endpoint: "http://127.0.0.1:9" });
  await run(opted, { promptTrajectory: "extension" });
  assert.ok(
    opted.prompts[1].startsWith(opted.prompts[0]),
    "an explicit extension request still produces byte-extension prompts",
  );
  assert.ok(!opted.prompts.some((p) => p.includes("(current, ")),
    "explicit extension renders no panel");
});

test("extension trajectory: an agent run keeps the invariant and still delivers recovery guidance", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-extension-run-"));
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
    promptTrajectory: "extension",
  });

  assert.equal(result.responded, true);
  for (let i = 1; i < model.prompts.length; i += 1) {
    assert.ok(
      model.prompts[i].startsWith(model.prompts[i - 1]),
      `prompt ${i + 1} must begin with prompt ${i} byte-for-byte`,
    );
  }
  assert.match(model.prompts[2], /EDIT RECOVERY ACTIVE/);
  assert.ok(!model.prompts.some((p) => p.includes("(current, ")),
    "extension mode never renders the live panel");
});
