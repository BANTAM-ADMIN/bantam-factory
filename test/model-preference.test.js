import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  loadModelPreference,
  modelPreferencePath,
  saveModelPreference,
} from "../src/model-preference.js";
import {
  resolveStartupModelChoice,
  startupModelChoices,
} from "../src/startup-model-choice.js";

// Removed when this file finishes -- see the note in open-files-stable-order.test.js.
const madeDirs = [];
after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("model preference round-trips without storing credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-model-pref-"));
  madeDirs.push(root);
  saveModelPreference({
    kind: "codex",
    name: "codex-terra",
    model: "gpt-5.6-terra",
    effort: "medium",
  }, root);
  const loaded = loadModelPreference(root);
  assert.deepEqual(
    { kind: loaded.kind, name: loaded.name, model: loaded.model, effort: loaded.effort },
    {
      kind: "codex",
      name: "codex-terra",
      model: "gpt-5.6-terra",
      effort: "medium",
    },
  );
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(modelPreferencePath(root))), "apiKey"), false);
});

test("Codex choices expose role, recommendation, and last-used state", () => {
  // No locals registered: this is the fresh-machine case, where the cloud
  // default is genuinely the right first move and stays [1]. On a machine WITH
  // local models the registry decides instead — see startup-picker-order.test.js.
  const choices = startupModelChoices({
    locals: [],
    preference: {
      kind: "codex",
      model: "gpt-5.6-terra",
      effort: "medium",
    },
  });
  assert.deepEqual(choices.slice(0, 3).map((choice) => choice.name), [
    "codex-terra", "codex-luna", "codex-sol",
  ]);
  assert.equal(choices[0].recommended, true);
  assert.equal(choices[0].lastUsed, true);
  assert.match(choices[0].detail, /Everyday/);
  assert.equal(resolveStartupModelChoice(choices, "1"), choices[0]);
  assert.equal(resolveStartupModelChoice(choices, "codex-sol").name, "codex-sol");
  assert.equal(resolveStartupModelChoice(choices, ""), null);
});

test("a registered local model displaces the cloud default as the lit button", () => {
  const choices = startupModelChoices({
    locals: [{ name: "bantam-q4", endpoint: "http://127.0.0.1:8085", slots: 1, priority: 100 }],
    preference: { kind: "codex", model: "gpt-5.6-terra", effort: "medium" },
  });
  assert.equal(choices[0].name, "bantam-q4");
  assert.equal(choices[0].recommended, true);
  // The stale codex preference is still TRUE and still shown — it just no
  // longer masquerades as the recommendation.
  const terra = choices.find((c) => c.name === "codex-terra");
  assert.equal(terra.lastUsed, true);
  assert.equal(terra.recommended, false);
});
