import fs from "node:fs";
import path from "node:path";
import {
  codexModelOptions,
  gauntletAliasForCodex,
} from "./codex-models.js";
import { normalizeThinkMode } from "./thinking.js";

export function gauntletModelRegistry(catalog = []) {
  const entries = {
    local: Object.freeze({
    name: "local",
    description: "Default local grammar-constrained model",
    model: { runtime: "local" },
    }),
  };
  for (const entry of codexModelOptions(catalog)) {
    const name = gauntletAliasForCodex(entry);
    entries[name] = Object.freeze({
      name,
      description: `${entry.displayName} · ${entry.role}: ${entry.recommendation}`,
      model: Object.freeze({
        runtime: "codex",
        name: entry.model,
        effort: entry.effort,
      }),
    });
  }
  return Object.freeze(entries);
}

export const GAUNTLET_MODELS = gauntletModelRegistry();

export const GAUNTLET_FIXTURES = Object.freeze([
  "ordered-map",
  "ttl-cache",
  "safe-config-merge",
  "range-parser",
  "retry-policy",
  "keyed-task-pool",
  "adapter-migration",
]);

export function createGauntletSpec({
  root,
  models = ["local", "sol", "terra"],
  fixtures = GAUNTLET_FIXTURES,
  rounds = 1,
  effort = null,
  quick = false,
  // The two-call think rail is tuned for models that reason in short bursts.
  // A long-CoT model (Gemma 4 with `<|think|>`) can spend the entire per-phase
  // budget on one turn, so the arm needs to be selectable rather than fixed.
  thinkMode = "auto",
  modelRegistry = GAUNTLET_MODELS,
} = {}) {
  if (typeof root !== "string" || !root.trim()) throw new Error("gauntlet root is required");
  const selectedModels = normalizeSelection(models, Object.keys(modelRegistry), "model");
  const selectedFixtures = normalizeSelection(
    quick ? [fixtures[0]] : fixtures,
    GAUNTLET_FIXTURES,
    "fixture",
  );
  const fixtureRoot = path.resolve(root, "gauntlet", "fixtures");
  const fixturePaths = selectedFixtures.map((name) => path.join(fixtureRoot, name));
  for (const fixturePath of fixturePaths) {
    if (!fs.existsSync(path.join(fixturePath, "task.json"))) {
      throw new Error(`gauntlet fixture is missing: ${fixturePath}`);
    }
  }
  const arms = selectedModels.map((name) => {
    const entry = modelRegistry[name];
    const model = { ...entry.model };
    if (model.runtime === "codex" && effort) model.effort = normalizeEffort(effort);
    return { name: entry.name, description: entry.description, model };
  });
  return {
    schema: 1,
    name: quick ? "BANTAM model gauntlet quick" : "BANTAM model gauntlet",
    description: "Same-task isolated coding comparison with hidden contracts and full model accounting.",
    fixtures: fixturePaths,
    rounds: boundedRounds(rounds),
    passAtK: [1],
    arms,
    thinkMode: normalizeThinkMode(thinkMode),
    preGate: true,
    planMode: false,
    stopOnFailure: false,
  };
}

export function modelOptionsForGauntletArm(model = {}, base = {}) {
  const runtime = model.runtime ?? "local";
  const sampling = {
    temperature: model.temperature,
    actTemperature: model.actTemperature,
    topP: model.topP,
    topK: model.topK,
    timeoutMs: model.timeoutMs,
  };
  if (runtime === "codex") {
    return compact({
      ...base,
      ...sampling,
      endpoint: undefined,
      apiUrl: null,
      apiKey: null,
      deepseek: false,
      codex: true,
      model: model.name,
      codexEffort: model.effort ?? "high",
      codexThreadMode: model.threadMode ?? base.codexThreadMode,
    });
  }
  if (runtime === "api") {
    return compact({
      ...base,
      ...sampling,
      endpoint: undefined,
      codex: false,
      apiUrl: model.endpoint,
      model: model.name,
    });
  }
  return compact({
    ...base,
    ...sampling,
    apiUrl: null,
    apiKey: null,
    deepseek: false,
    codex: false,
    endpoint: model.endpoint ?? base.endpoint,
    profile: model.profile ?? base.profile,
  });
}

export function parseGauntletList(value, fallback) {
  if (value === undefined || value === null || value === true) return [...fallback];
  if (typeof value !== "string") throw new Error("gauntlet selection must be a comma-separated string");
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function normalizeSelection(values, allowed, label) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`gauntlet ${label}s cannot be empty`);
  const selected = [...new Set(values.map((value) => String(value).trim().toLowerCase()))];
  const invalid = selected.filter((value) => !allowed.includes(value));
  if (invalid.length) throw new Error(`unknown gauntlet ${label}(s): ${invalid.join(", ")}`);
  return selected;
}

function normalizeEffort(value) {
  const effort = String(value).trim().toLowerCase();
  if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
    throw new Error(`invalid gauntlet Codex effort: ${value}`);
  }
  return effort;
}

function boundedRounds(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 50) {
    throw new Error("gauntlet rounds must be an integer from 1 to 50");
  }
  return number;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
