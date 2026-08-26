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

const TAP_PASS = "TAP version 13\nok 1 - holds\n1..1\n# tests 1\n# pass 1\n# fail 0\n";

test("extension mode folds the edited bytes back into view at verify-green", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-decision-snapshot-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "flag.js"), "export const strict = false;\n");
  const prior = process.env.BANTAM_DECISION_SNAPSHOT;
  process.env.BANTAM_DECISION_SNAPSHOT = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.BANTAM_DECISION_SNAPSHOT;
    else process.env.BANTAM_DECISION_SNAPSHOT = prior;
  });

  const edited = 'export const strict = true;\nexport const extra = "visible-in-snapshot";\n';
  const shellProcessRunner = async () => ({
    code: 0, signal: null, stdout: TAP_PASS, stderr: "",
    timedOut: false, bufferExceeded: false, aborted: false,
  });

  const model = scriptedPromptModel([
    JSON.stringify({ a: "write_file", p: "flag.js", content: edited }),
    JSON.stringify({ a: "shell", c: "node --test" }),
    JSON.stringify({ a: "respond", text: "All green." }),
  ]);

  await runAgent({
    task: "Make flag.js strict.",
    workspace,
    model,
    maxTurns: 5,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    promptTrajectory: "extension",
    shellProcessRunner,
  });

  const finalPrompt = model.prompts[model.prompts.length - 1];
  assert.match(finalPrompt, /\[review\]/, "verify-green must trigger a review snapshot");
  assert.ok(
    finalPrompt.includes("visible-in-snapshot"),
    "the snapshot must show the CURRENT bytes of the edited file at the decision point",
  );
  const reviewAt = finalPrompt.lastIndexOf("[review]");
  assert.ok(
    finalPrompt.length - reviewAt < 2000,
    "the snapshot must sit near the decision point, not buried mid-history",
  );
  for (let i = 1; i < model.prompts.length; i += 1) {
    assert.ok(
      model.prompts[i].startsWith(model.prompts[i - 1]),
      `prompt ${i + 1} must still extend prompt ${i} — the snapshot may not break the invariant`,
    );
  }
});

test("the snapshot appends once per converged state, not on every green", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-decision-snapshot-once-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "flag.js"), "export const strict = false;\n");
  const prior = process.env.BANTAM_DECISION_SNAPSHOT;
  process.env.BANTAM_DECISION_SNAPSHOT = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.BANTAM_DECISION_SNAPSHOT;
    else process.env.BANTAM_DECISION_SNAPSHOT = prior;
  });

  const shellProcessRunner = async () => ({
    code: 0, signal: null, stdout: TAP_PASS, stderr: "",
    timedOut: false, bufferExceeded: false, aborted: false,
  });
  const model = scriptedPromptModel([
    JSON.stringify({ a: "write_file", p: "flag.js", content: "export const strict = true;\n" }),
    JSON.stringify({ a: "shell", c: "node --test" }),
    JSON.stringify({ a: "shell", c: "node --test" }),
    JSON.stringify({ a: "respond", text: "Still green." }),
  ]);

  await runAgent({
    task: "Make flag.js strict.",
    workspace,
    model,
    maxTurns: 6,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    promptTrajectory: "extension",
    shellProcessRunner,
  });

  const finalPrompt = model.prompts[model.prompts.length - 1];
  const count = finalPrompt.split("[review]").length - 1;
  assert.equal(count, 1, "an unchanged workspace must not earn a second snapshot");
});
