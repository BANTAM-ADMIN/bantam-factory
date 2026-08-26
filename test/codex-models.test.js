import assert from "node:assert/strict";
import test from "node:test";

import {
  codexModelOptions,
  recommendedCodexModels,
  resolveCodexModelAlias,
  resolveCodexReasoningEffort,
} from "../src/codex-models.js";

test("Codex model options map the live catalog to stable BANTAM aliases", () => {
  const options = codexModelOptions([
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "Frontier",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
      ],
      hidden: false,
    },
    {
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      description: "Balanced",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      hidden: false,
    },
    {
      id: "gpt-5.4",
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      upgrade: "gpt-5.6-terra",
      hidden: false,
    },
    { id: "hidden-model", model: "hidden-model", hidden: true },
  ]);

  assert.deepEqual(
    options.map(({ name, model, effort, upgrade }) => ({ name, model, effort, upgrade })),
    [
      {
        name: "codex-sol",
        model: "gpt-5.6-sol",
        effort: "high",
        upgrade: null,
      },
      {
        name: "codex-terra",
        model: "gpt-5.6-terra",
        effort: "medium",
        upgrade: null,
      },
      {
        name: "codex-5.4",
        model: "gpt-5.4",
        effort: "medium",
        upgrade: "gpt-5.6-terra",
      },
    ],
  );
});

test("Codex model options provide a complete offline fallback catalog", () => {
  const options = codexModelOptions([]);
  assert.deepEqual(options.map((entry) => entry.name), [
    "codex-sol",
    "codex-terra",
    "codex-luna",
    "codex-5.5",
    "codex-5.4",
    "codex-5.4-mini",
    "codex-spark",
  ]);
  assert.deepEqual(options[0].supportedReasoningEfforts, [
    "low", "medium", "high", "xhigh", "max", "ultra",
  ]);
  assert.deepEqual(options[2].supportedReasoningEfforts, [
    "low", "medium", "high", "xhigh", "max",
  ]);
});

test("Codex reasoning selection accepts names, menu numbers, and the model default", () => {
  const entry = codexModelOptions([])[1];
  assert.deepEqual(resolveCodexReasoningEffort(entry), {
    ok: true,
    effort: "medium",
  });
  assert.deepEqual(resolveCodexReasoningEffort(entry, "4"), {
    ok: true,
    effort: "xhigh",
  });
  assert.deepEqual(resolveCodexReasoningEffort(entry, "MAX"), {
    ok: true,
    effort: "max",
  });
  assert.equal(resolveCodexReasoningEffort(entry, "extreme").ok, false);
});

test("Codex policy presents measured automatic roles in recommended order", () => {
  const options = recommendedCodexModels([]);
  assert.deepEqual(options.map((entry) => entry.name), [
    "codex-terra",
    "codex-luna",
    "codex-sol",
  ]);
  assert.deepEqual(options.map((entry) => entry.role), [
    "Everyday",
    "Fast",
    "Hard",
  ]);
  assert.equal(codexModelOptions([]).find((entry) => entry.name === "codex-5.5").automatic, false);
  assert.equal(codexModelOptions([]).find((entry) => entry.name === "codex-spark").automatic, false);
});

test("Codex CLI aliases resolve roles while preserving exact live model IDs", () => {
  assert.equal(resolveCodexModelAlias(), "gpt-5.6-terra");
  assert.equal(resolveCodexModelAlias("terra"), "gpt-5.6-terra");
  assert.equal(resolveCodexModelAlias("codex-sol"), "gpt-5.6-sol");
  assert.equal(resolveCodexModelAlias("gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(resolveCodexModelAlias("future-catalog-model"), "future-catalog-model");
});
