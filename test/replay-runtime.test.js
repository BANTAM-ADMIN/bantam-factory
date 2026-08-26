import assert from "node:assert/strict";
import test from "node:test";

import { ModelClient } from "../src/model.js";
import { replayRuntimeOptions } from "../src/replay.js";

const codexArtifact = {
  modelId: "gpt-5.6-terra",
  model: {
    metadata: {
      runtime: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    },
  },
  modelCalls: [{ request: { url: "codex-app-server://local/gpt-5.6-terra" } }],
};

test("replay reconstructs the recorded Codex runtime", () => {
  const options = replayRuntimeOptions(codexArtifact);
  assert.deepEqual(options, {
    codex: true,
    apiUrl: null,
    model: "gpt-5.6-terra",
    codexEffort: "medium",
    codexThreadMode: "run",
    codexPromptMode: "delta",
  });
  const client = new ModelClient(options);
  assert.equal(client.codex, true);
  assert.equal(client.apiMode, false);
  assert.equal(client.modelName, "gpt-5.6-terra");
});

test("explicit cross-transport replay disables Codex dispatch", () => {
  assert.deepEqual(
    replayRuntimeOptions(codexArtifact, { transportOverride: true }),
    { codex: false, apiUrl: null },
  );
});

test("captured Codex request URLs recover runtime for older artifacts", () => {
  const options = replayRuntimeOptions({
    modelId: "gpt-5.6-sol",
    modelCalls: [{ request: { url: "codex-app-server://local/gpt-5.6-sol" } }],
  });
  assert.equal(options.codex, true);
  assert.equal(options.model, "gpt-5.6-sol");
});

test("ordinary local artifacts retain the local transport", () => {
  assert.deepEqual(replayRuntimeOptions({
    modelId: "local",
    modelCalls: [{ request: { url: "http://localhost:8085/completion" } }],
  }), { codex: false });
});
