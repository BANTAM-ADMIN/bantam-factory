// The registry has two producers with different shapes: `bantam doctor --launch`
// scaffolds { label, script, endpoint }, while hand-written and `bantam models
// add` entries carry { name, ... } because that is what swap/aliases resolve on.
// Every display path read `.label`, so a name-keyed registry rendered five
// "Start undefined" rows in the startup picker and `:model <name>` threw on
// undefined.toLowerCase(). Identity is normalized once, at the load boundary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { listModels, resolveModelTarget } from "../src/model-launcher.js";
import { startupModelChoices, resolveStartupModelChoice } from "../src/startup-model-choice.js";

const madeDirs = [];
const priorEnv = process.env.BANTAM_MODELS;
after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
  if (priorEnv === undefined) delete process.env.BANTAM_MODELS;
  else process.env.BANTAM_MODELS = priorEnv;
});

/** A temp registry driven through the real loader (BANTAM_MODELS), scripts on disk. */
function registryOf(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-registry-"));
  madeDirs.push(root);
  const written = entries.map((entry, index) => {
    const script = path.join(root, `start-${index}.sh`);
    fs.writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
    return { ...entry, script };
  });
  const file = path.join(root, "models.json");
  fs.writeFileSync(file, JSON.stringify(written, null, 2));
  process.env.BANTAM_MODELS = file;
  return file;
}

test("a name-keyed registry entry carries a display label", () => {
  registryOf([{ name: "bantam-q4", endpoint: "http://127.0.0.1:8085", slots: 1 }]);
  const [entry] = listModels();
  assert.equal(entry.name, "bantam-q4");
  assert.equal(entry.label, "bantam-q4");
});

test("a label-keyed registry entry (doctor scaffold) carries a resolvable name", () => {
  registryOf([{ label: "Local llama.cpp model", endpoint: "http://localhost:8085", match: "" }]);
  const [entry] = listModels();
  assert.equal(entry.label, "Local llama.cpp model");
  assert.equal(entry.name, "Local llama.cpp model");
  assert.ok(resolveModelTarget("local llama.cpp model"), "doctor-scaffolded models must be swappable");
});

test("startup picker names local models instead of printing Start undefined", () => {
  registryOf([
    { name: "bantam-q4", endpoint: "http://127.0.0.1:8085", slots: 1, vision: true },
    { name: "bantam-q4-duo", endpoint: "http://127.0.0.1:8085", slots: 2 },
  ]);
  const choices = startupModelChoices({ locals: listModels(), catalog: [], preference: null });
  const locals = choices.filter((choice) => choice.kind === "local");
  assert.deepEqual(locals.map((choice) => choice.label), [
    "Start bantam-q4", "Start bantam-q4-duo",
  ]);
  for (const choice of locals) assert.doesNotMatch(choice.label, /undefined/);
  // The picker must distinguish the profiles the operator actually chooses
  // between -- one slot versus two on the same endpoint.
  assert.match(locals[0].detail, /1 slot/);
  assert.match(locals[1].detail, /2 slots/);
  assert.equal(resolveStartupModelChoice(choices, "bantam-q4-duo")?.name, "bantam-q4-duo");
});

test("a remembered local model is flagged as last used", () => {
  registryOf([{ name: "bantam-q4-duo", endpoint: "http://127.0.0.1:8085", slots: 2 }]);
  const choices = startupModelChoices({
    locals: listModels(),
    catalog: [],
    preference: { kind: "local", name: "bantam-q4-duo" },
  });
  assert.equal(choices.find((choice) => choice.kind === "local").lastUsed, true);
});
