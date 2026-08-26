import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import { QWEN_ASSISTANT_PREFILL } from "../src/profiles.js";

// The extension trajectory's immutable history replays an empty closed
// <think></think> block on every historical assistant turn. Measured on
// Qwen 3.8 (2026-08-14 characterization): that in-context pattern collapses
// the auto think rail to the turn-0 opener — 12 of 13 phase-1 completions
// returned empty in the failing dependency-scheduler run. The bare-history
// flag renders extension-mode assistant turns without the empty block, the
// same shape the gemma profile already uses for prior turns (measured there:
// bare 7/10 vs empty-block 0/10). Preregistration:
// docs/superpowers/reports/2026-08-14-extension-bare-history-preregistration.md

const EMPTY_THINK_BLOCK = "<think>\n</think>";

function scriptedPromptModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    stop: [],
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

function makeWorkspace(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-bare-history-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "lib.js"), "export const value = 1;\n");
  return workspace;
}

const SCRIPT = [
  JSON.stringify({ a: "read_file", p: "lib.js" }),
  JSON.stringify({ a: "list_dir", p: "." }),
  JSON.stringify({ a: "respond", text: "Done." }),
];

const RUN_OPTS = {
  task: "Inspect lib.js.",
  maxTurns: 4,
  interactive: true,
  useGrammar: false,
  grounding: false,
  verificationPolicy: "after_edit",
  shellSandbox: "host",
  promptTrajectory: "extension",
};

test("bare history: extension prompts carry no empty think blocks and keep the byte-extension invariant", async (t) => {
  const workspace = makeWorkspace(t);
  const model = scriptedPromptModel([...SCRIPT]);
  await runAgent({ ...RUN_OPTS, workspace, model, extensionBareHistory: true });

  assert.ok(model.prompts.length >= 3, "run should take several turns");
  for (const p of model.prompts) {
    assert.ok(!p.includes(EMPTY_THINK_BLOCK),
      "no prompt may replay an empty closed think block in bare-history mode");
  }
  for (let i = 1; i < model.prompts.length; i += 1) {
    assert.ok(model.prompts[i].startsWith(model.prompts[i - 1]),
      `prompt ${i + 1} must still begin with prompt ${i} byte-for-byte`);
  }
  const last = model.prompts[model.prompts.length - 1];
  assert.ok(last.includes(`<|im_start|>assistant\n{"a":"read_file"`),
    "historical assistant turns render bare: role header directly followed by the action");
});

test("bare history is the extension-mode default; the closed-think form is one env var away", async (t) => {
  // Adopted by the preregistered rule on 2026-08-14: bare 6/9 vs control 4/9
  // with 9/9 mechanism engagement and zero empty think completions (control: 29).
  // docs/superpowers/reports/2026-08-14-extension-bare-history-results.md
  const workspace = makeWorkspace(t);
  const model = scriptedPromptModel([...SCRIPT]);
  await runAgent({ ...RUN_OPTS, workspace, model });

  const last = model.prompts[model.prompts.length - 1];
  assert.ok(!last.includes(EMPTY_THINK_BLOCK),
    "extension defaults to bare history — no empty closed think blocks replay");

  const optedOut = scriptedPromptModel([...SCRIPT]);
  await runAgent({ ...RUN_OPTS, workspace, model: optedOut, extensionBareHistory: false });
  const lastOptOut = optedOut.prompts[optedOut.prompts.length - 1];
  assert.ok(lastOptOut.includes(EMPTY_THINK_BLOCK),
    "extensionBareHistory: false restores the profile's closed-think history form");
});

test("bare history: the think rail still derives and seals real reasoning", async (t) => {
  const workspace = makeWorkspace(t);
  // thinkMode always: phase-1 (free reasoning) then phase-2 action, repeated.
  const model = scriptedPromptModel([
    "I should read the file first.",
    JSON.stringify({ a: "read_file", p: "lib.js" }),
    "Now I can answer.",
    JSON.stringify({ a: "respond", text: "Done." }),
  ]);
  // A think-capable profile prefill: the rail derives its open/close forms
  // from this even though bare-history mode strips it from action turns.
  model.assistantPrefill = QWEN_ASSISTANT_PREFILL;
  await runAgent({
    ...RUN_OPTS,
    workspace,
    model,
    extensionBareHistory: true,
    thinkMode: "always",
  });

  const openThinkPrompts = model.prompts.filter((p) => p.endsWith("<think>\n"));
  assert.ok(openThinkPrompts.length >= 2,
    "phase-1 prompts still end with an open think block (rail capability intact)");
  const sealed = model.prompts.find((p) => p.includes("I should read the file first.\n</think>"));
  assert.ok(sealed, "phase-2 seals the real reasoning into the acting prompt");
  for (const p of model.prompts) {
    assert.ok(!p.includes(EMPTY_THINK_BLOCK),
      "even with the rail active, no EMPTY closed block is replayed");
  }
});
