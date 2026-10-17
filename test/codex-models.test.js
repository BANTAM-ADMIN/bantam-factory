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
    "codex-astra",
    "codex-6-sol",
    "codex-luna",
    "codex-5.6-sol",
    "codex-terra",
    "codex-5.6-luna",
  ]);
  assert.deepEqual(options[0].supportedReasoningEfforts, [
    "low", "medium", "high", "xhigh", "max", "ultra",
  ]);
  assert.deepEqual(options[3].supportedReasoningEfforts, [
    "low", "medium", "high", "xhigh", "max",
  ]);
});

test("Codex reasoning selection accepts names, menu numbers, and the model default", () => {
  const entry = codexModelOptions([]).find((candidate) => candidate.name === "codex-terra");
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
    "codex-sol",
    "codex-terra",
    "codex-luna",
  ]);
  assert.deepEqual(options.map((entry) => entry.role), [
    "Default",
    "Everyday",
    "Fast",
  ]);
  assert.equal(codexModelOptions([]).find((entry) => entry.name === "codex-5.6-luna").automatic, false);
  assert.equal(codexModelOptions([]).find((entry) => entry.name === "codex-6-sol").role, "Previous");
});

test("Codex CLI aliases resolve roles while preserving exact live model IDs", () => {
  assert.equal(resolveCodexModelAlias(), "gpt-6.1-sol");
  assert.equal(resolveCodexModelAlias("terra"), "gpt-5.6-terra");
  assert.equal(resolveCodexModelAlias("codex-sol"), "gpt-6.1-sol");
  assert.equal(resolveCodexModelAlias("luna"), "gpt-6-luna");
  assert.equal(resolveCodexModelAlias("codex-5.6-luna"), "gpt-5.6-luna");
  assert.equal(resolveCodexModelAlias("gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(resolveCodexModelAlias("future-catalog-model"), "future-catalog-model");
});

test("Astra is an exact manual option with supported native reasoning levels", () => {
  const entry = codexModelOptions([]).find(entry => entry.name === "codex-astra");
  assert.equal(entry.model, "gpt-6-astra");
  assert.equal(entry.effort, "medium");
  assert.equal(entry.automatic, false);
  for (const alias of ["astra", "codex-astra", "gpt-6-astra"]) {
    assert.equal(resolveCodexModelAlias(alias), "gpt-6-astra");
  }
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.deepEqual(resolveCodexReasoningEffort(entry, effort), { ok: true, effort });
  }
  assert.equal(resolveCodexReasoningEffort(entry, "none").ok, false);
  assert.equal(resolveCodexReasoningEffort(entry, "minimal").ok, false);
  assert.deepEqual(recommendedCodexModels([]).map(entry => entry.name), ["codex-sol", "codex-terra", "codex-luna"]);
});

test("Astra selection respects the live account catalog without changing its default effort", () => {
  const [entry] = codexModelOptions([{
    model: "gpt-6-astra", displayName: "GPT-6-Astra", defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
  }]);
  assert.equal(entry.name, "codex-astra");
  assert.equal(entry.effort, "low");
  assert.deepEqual(entry.supportedReasoningEfforts, ["low", "medium"]);
  assert.equal(entry.automatic, false);
  assert.equal(codexModelOptions([{ model: "gpt-5.6-terra" }]).some(entry => entry.model === "gpt-6-astra"), false);
});

test("the newest version of each family takes its role and alias from the live catalog", () => {
  const live = (ids) => ids.map((id) => ({ model: id, supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }));
  const options = codexModelOptions(live(["gpt-5.6-luna", "gpt-7-luna", "gpt-6.10-sol", "gpt-6.9-sol"]));
  const by = Object.fromEntries(options.map((entry) => [entry.model, entry]));
  assert.equal(by["gpt-7-luna"].name, "codex-luna");
  assert.equal(by["gpt-7-luna"].role, "Fast");
  assert.equal(by["gpt-5.6-luna"].name, "codex-5.6-luna");
  assert.equal(by["gpt-5.6-luna"].automatic, false);
  assert.equal(by["gpt-6.10-sol"].name, "codex-sol", "6.10 is newer than 6.9");
  assert.equal(by["gpt-6.10-sol"].effort, "high");
  assert.equal(resolveCodexModelAlias("luna", { catalog: live(["gpt-5.6-luna", "gpt-7-luna"]) }), "gpt-7-luna");
});
