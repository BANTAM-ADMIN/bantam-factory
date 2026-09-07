import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runAgent } from "../src/agent.js";
import { contextUpdatePromptText } from "../src/prompt.js";

function setup(t, actions, snapshot = false) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-delivery-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({ BANTAM_DECISION_SNAPSHOT: snapshot ? "1" : "0", BANTAM_EXTENSION_WORKING_SET: "0" })) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  }
  const model = { assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      assert.ok(actions.length, "unexpected extra model call");
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
  return { workspace, model };
}

function options(workspace, model) {
  return { task: "Update flag.js as requested.", workspace, model, maxTurns: 8,
    interactive: true, useGrammar: false, grounding: false, promptTrajectory: "extension",
    verificationPolicy: "after_edit", shellSandbox: "host",
    shellProcessRunner: async () => ({ code: 0, signal: null, stdout: "TAP version 13\nok 1 - flag\n1..1\n# tests 1\n# pass 1\n# fail 0\n", stderr: "", timedOut: false, bufferExceeded: false, aborted: false }),
  };
}

test("the actual model callback receives complete decision context despite an oversized annotated observation", async (t) => {
  const source = Array.from({ length: 30 }, (_, i) => `// harmless source line ${i}`).join("\n")
    + '\nexport const strict = true;\nexport const marker = "LATE_CURRENT_SOURCE";\n';
  const { workspace, model } = setup(t, [
    { a: "write_file", p: "flag.js", content: source },
    { a: "shell", c: "node --test" },
    { a: "respond", text: "Finished." },
  ], true);
  fs.writeFileSync(path.join(workspace, "flag.js"), "export const strict = false;\n");
  const result = await runAgent({ ...options(workspace, model),
    observationTransform: (observation) => observation.includes("VERDICT:")
      ? `${observation}\n[completion-audit] Compare each written requirement.\n${"quoted tool output\n".repeat(350)}`
      : observation,
  });
  const turn = result.turns.find((entry) => entry.contextUpdates?.some((update) => update.kind === "decision"));
  assert.ok(turn.observation.length > 4000, "regression must exceed the real observation budget");
  const update = turn.contextUpdates.find((entry) => entry.kind === "decision");
  assert.match(update.text, /LATE_CURRENT_SOURCE/);
  const block = contextUpdatePromptText(update);
  assert.ok(model.prompts.at(-1).includes(block), "the whole current-source record, not just its heading, reaches the model");
  assert.equal(result.metrics.contextUpdatesIncluded, 1);
  assert.equal(result.metrics.contextUpdatesOmitted, 0);
  const receipt = result.metrics.contextUpdatePromptReceipts.find((entry) => entry.id === update.id);
  assert.equal(receipt.boundary, "prepared-prompt");
  assert.equal(receipt.status, "included");
  assert.equal(receipt.promptSha256, crypto.createHash("sha256").update(model.prompts[receipt.modelCallIndex]).digest("hex"));
  for (let i = 1; i < model.prompts.length; i++) assert.ok(model.prompts[i].startsWith(model.prompts[i - 1]));
});

test("plain extension supplies fresh recovery bytes once, not a nonexistent-panel promise", async (t) => {
  const original = 'export const flag = "old";\n';
  const current = '// an added line shifts the source\nexport const flag = "CURRENT_RECOVERY_MARKER";\n';
  const { workspace, model } = setup(t, [
    { a: "read_file", p: "flag.js" },
    { a: "write_file", p: "flag.js", content: current },
    { a: "replace", p: "flag.js", old: original, new: 'export const flag = "incorrect";\n' },
    { a: "read_file", p: "flag.js" },
    { a: "respond", text: "The failed edit left the current file intact." },
  ]);
  fs.writeFileSync(path.join(workspace, "flag.js"), original);
  const result = await runAgent(options(workspace, model));
  const updates = result.turns.flatMap((turn) => turn.contextUpdates ?? []);
  const recoveryUpdates = updates.filter((update) => update.kind === "edit-recovery");
  assert.equal(recoveryUpdates.length, 1);
  assert.equal(updates.filter((update) => update.kind === "decision").length, 0, "optional review remains off");
  assert.match(recoveryUpdates[0].text, /2\texport const flag = "CURRENT_RECOVERY_MARKER"/);
  assert.ok(model.prompts[3].includes(contextUpdatePromptText(recoveryUpdates[0])));
  assert.doesNotMatch(model.prompts[3], /line numbers from the current file panel/);
  assert.equal(fs.readFileSync(path.join(workspace, "flag.js"), "utf8"), current);
  assert.equal(result.metrics.editRecoverySnapshots, 1);
  for (let i = 1; i < model.prompts.length; i++) assert.ok(model.prompts[i].startsWith(model.prompts[i - 1]));
});
