// `bantam models add` — the registration path. Before it, the only way to add a
// llama.cpp model was to hand-edit .bantam/models.json, and every hand-edit
// mistake failed silently: listModels() drops entries whose script is missing,
// so a typo'd path made the model simply not appear in the startup picker.
// Validation happens here, at write time, where it can still be reported.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { addModel, readRegistryFile, removeModel } from "../src/model-registry.js";

const madeDirs = [];
after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-registry-edit-"));
  madeDirs.push(root);
  const script = path.join(root, "launch-q4.sh");
  fs.writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
  return { root, script, file: path.join(root, "models.json") };
}

test("adding a model creates the registry and records the launch script", () => {
  const { script, file } = workspace();
  const result = addModel({ name: "qwen38uc", script, endpoint: "http://127.0.0.1:8085", slots: 2, vision: true }, { file });
  assert.equal(result.ok, true, result.error);
  const [entry] = readRegistryFile(file);
  assert.equal(entry.name, "qwen38uc");
  assert.equal(entry.script, script);
  assert.equal(entry.endpoint, "http://127.0.0.1:8085");
  assert.equal(entry.slots, 2);
  assert.equal(entry.vision, true);
});

test("a launch script that does not exist is refused, not silently dropped", () => {
  const { root, file } = workspace();
  const result = addModel({ name: "ghost", script: path.join(root, "nope.sh") }, { file });
  assert.equal(result.ok, false);
  assert.match(result.error, /no launch script/i);
  assert.equal(fs.existsSync(file), false, "a refused add must not create a registry");
});

test("a directory instead of a script is refused and the candidates are named", () => {
  const { root, file } = workspace();
  const result = addModel({ name: "dir", script: root }, { file });
  assert.equal(result.ok, false);
  assert.match(result.error, /directory/i);
  assert.match(result.error, /launch-q4\.sh/, "point the operator at the scripts that are there");
});

test("a duplicate name is refused unless the caller asks to replace it", () => {
  const { script, file } = workspace();
  addModel({ name: "qwen38uc", script }, { file });
  const clash = addModel({ name: "qwen38uc", script }, { file });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already registered/i);
  const replaced = addModel({ name: "qwen38uc", script, slots: 4 }, { file, replace: true });
  assert.equal(replaced.ok, true, replaced.error);
  const entries = readRegistryFile(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slots, 4);
});

test("the endpoint defaults to the local llama.cpp port and must be a real URL", () => {
  const { script, file } = workspace();
  assert.equal(addModel({ name: "a", script }, { file }).entry.endpoint, "http://127.0.0.1:8085");
  assert.match(addModel({ name: "b", script, endpoint: "port 8085" }, { file }).error, /endpoint/i);
});

test("a nameless entry is refused", () => {
  const { script, file } = workspace();
  assert.match(addModel({ name: "  ", script }, { file }).error, /name/i);
});

test("removing a model takes it out of the registry", () => {
  const { script, file } = workspace();
  addModel({ name: "keep", script }, { file });
  addModel({ name: "drop", script }, { file });
  const result = removeModel("drop", { file });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(readRegistryFile(file).map((entry) => entry.name), ["keep"]);
  assert.match(removeModel("drop", { file }).error, /not registered/i);
});

test("a corrupt registry is reported, never silently replaced", () => {
  const { script, file } = workspace();
  fs.writeFileSync(file, "{ this is not json");
  const result = addModel({ name: "x", script }, { file });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not read/i);
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json", "never overwrite what we cannot parse");
});
