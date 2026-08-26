import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildExperimentSchedule,
  createExperimentManifest,
  normalizeExperimentSpec,
  summarizeExperiment,
} from "../src/experiment.js";
import {
  createGauntletSpec,
  GAUNTLET_FIXTURES,
  gauntletModelRegistry,
  modelOptionsForGauntletArm,
  parseGauntletList,
} from "../src/gauntlet.js";
import { runContractGrader } from "../src/contract-grader.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("gauntlet creates a normalized same-task local/Sol/Terra experiment", () => {
  const spec = createGauntletSpec({ root });
  const normalized = normalizeExperimentSpec(spec);
  assert.equal(normalized.fixtures.length, 7);
  assert.deepEqual(normalized.arms.map((arm) => arm.name), ["local", "sol", "terra"]);
  assert.deepEqual(normalized.arms[1].model, {
    runtime: "codex",
    name: "gpt-5.6-sol",
    effort: "high",
  });
  assert.ok(normalized.fixtures.every((fixture) => path.isAbsolute(fixture)));
  assert.equal(buildExperimentSchedule(normalized).length, 3);
  assert.equal(createExperimentManifest({ spec: normalized }).schedule.length, 3);
});

test("gauntlet registry exposes every non-hidden live Codex model as an alias", () => {
  const registry = gauntletModelRegistry([
    {
      model: "gpt-5.6-sol",
      displayName: "Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
    {
      model: "gpt-future",
      displayName: "Future",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    },
    { model: "gpt-hidden", hidden: true },
  ]);
  assert.deepEqual(Object.keys(registry), ["local", "sol", "future"]);
  const spec = createGauntletSpec({
    root,
    models: ["future"],
    quick: true,
    modelRegistry: registry,
  });
  assert.equal(spec.arms[0].model.name, "gpt-future");
  assert.equal(spec.arms[0].model.effort, "low");
});

test("quick selection and per-arm routing remain explicit and credential-free", () => {
  const spec = createGauntletSpec({
    root,
    models: ["local", "sol"],
    fixtures: ["ttl-cache", "ordered-map"],
    quick: true,
    effort: "xhigh",
  });
  assert.match(spec.fixtures[0], /ttl-cache$/);
  assert.equal(spec.arms[1].model.effort, "xhigh");
  assert.deepEqual(modelOptionsForGauntletArm(spec.arms[0].model, {
    endpoint: "http://127.0.0.1:8085",
    apiKey: "must-be-removed",
  }), {
    endpoint: "http://127.0.0.1:8085",
    apiUrl: null,
    apiKey: null,
    deepseek: false,
    codex: false,
  });
  assert.deepEqual(modelOptionsForGauntletArm(spec.arms[1].model, {
    endpoint: "http://127.0.0.1:8085",
    apiKey: "must-be-removed",
  }), {
    apiUrl: null,
    apiKey: null,
    deepseek: false,
    codex: true,
    model: "gpt-5.6-sol",
    codexEffort: "xhigh",
  });
  assert.deepEqual(parseGauntletList("local, SOL,local", ["terra"]), ["local", "sol", "local"]);
});

test("a one-arm gauntlet is valid for focused transport measurements", () => {
  const spec = createGauntletSpec({
    root,
    models: ["sol"],
    quick: true,
  });
  const normalized = normalizeExperimentSpec(spec);
  assert.deepEqual(normalized.arms.map((arm) => arm.name), ["sol"]);
  assert.equal(createExperimentManifest({ spec: normalized }).schedule.length, 1);
});

test("checked-in Codex thread experiments remain valid and explicitly paired", () => {
  for (const file of [
    "codex-thread-mode.json",
    "codex-thread-mode-breadth.json",
    "codex-prompt-delta.json",
    "codex-prompt-delta-breadth.json",
    "codex-delta-rebase-breadth.json",
    "codex-delta-adaptive-long-horizon.json",
    "codex-hard-tournament-2026-07-25.json",
  ]) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "examples", "experiments", file), "utf8"));
    const spec = normalizeExperimentSpec(raw);
    const expectedNames = file === "codex-hard-tournament-2026-07-25.json"
      ? ["sol-high", "terra-medium", "luna-medium", "gpt-5-5-medium"]
      : file === "codex-delta-rebase-breadth.json"
      ? ["sol-delta-continuous", "sol-delta-rebase-3"]
      : file === "codex-delta-adaptive-long-horizon.json"
        ? ["sol-delta-continuous", "sol-delta-adaptive-20"]
      : file.startsWith("codex-prompt-delta")
        ? ["sol-ephemeral-full", "sol-run-full", "sol-run-delta"]
        : ["sol-ephemeral", "sol-run-thread"];
    assert.deepEqual(spec.arms.map((arm) => arm.name), expectedNames);
    if (file === "codex-hard-tournament-2026-07-25.json") {
      assert.equal(spec.fixtures.length, 2);
      assert.equal(spec.rounds, 2);
    } else if (file === "codex-delta-rebase-breadth.json") {
      assert.equal(spec.arms[0].env.BANTAM_CODEX_THREAD_MODE, "run");
      assert.equal(spec.arms[1].env.BANTAM_CODEX_THREAD_MODE, "run");
      assert.equal(spec.arms[0].env.BANTAM_CODEX_REBASE_EVERY, "0");
      assert.equal(spec.arms[1].env.BANTAM_CODEX_REBASE_EVERY, "3");
    } else if (file === "codex-delta-adaptive-long-horizon.json") {
      assert.equal(spec.fixtures[0], "gauntlet/fixtures/adapter-migration");
      assert.equal(spec.arms[0].env.BANTAM_CODEX_REBASE_MIN_SAVINGS, "0");
      assert.equal(spec.arms[1].env.BANTAM_CODEX_REBASE_MIN_SAVINGS, "0.2");
    } else {
      assert.equal(spec.arms[0].env.BANTAM_CODEX_THREAD_MODE, "ephemeral");
      assert.equal(spec.arms[1].env.BANTAM_CODEX_THREAD_MODE, "run");
    }
    if (file.startsWith("codex-prompt-delta")) {
      assert.equal(spec.arms[2].env.BANTAM_CODEX_THREAD_MODE, "run");
      assert.equal(spec.arms[2].env.BANTAM_CODEX_PROMPT_MODE, "delta");
    }
  }
});

test("adaptive long-horizon replication keeps independent seeds and paired arms", () => {
  const source = JSON.parse(fs.readFileSync(
    path.join(root, "examples", "experiments", "codex-delta-adaptive-long-horizon-replication.json"),
    "utf8",
  ));
  const spec = normalizeExperimentSpec(source);
  assert.deepEqual(spec.seeds, [77003, 77004]);
  assert.deepEqual(spec.arms.map((arm) => arm.name), [
    "sol-delta-continuous",
    "sol-delta-adaptive-20",
  ]);
  assert.equal(spec.arms[0].env.BANTAM_CODEX_REBASE_MIN_SAVINGS, "0");
  assert.equal(spec.arms[1].env.BANTAM_CODEX_REBASE_MIN_SAVINGS, "0.2");
});

test("experiment summaries aggregate full provider accounting", () => {
  const spec = createGauntletSpec({ root, models: ["local", "sol"], quick: true });
  const manifest = {
    spec,
    schedule: [
      { arm: "local", status: "complete", durationMs: 10, priorDurationMs: 0, runs: [{
        name: "ordered-map", status: "pass", turns: 2, requests: 2,
        inputTok: 100, outputTok: 20, cacheHitTok: 80, cacheMissTok: 0,
        reasoningTok: 0, costUsd: 0, durationMs: 9,
        promptCalls: 2, promptChars: 1000, promptComparableChars: 600,
        promptCommonPrefixChars: 480, promptAddedSuffixChars: 120,
        promptReplacedSuffixChars: 20, promptFirstChangedSections: { observations: 1 },
      }] },
      { arm: "sol", status: "complete", durationMs: 12, priorDurationMs: 0, runs: [{
        name: "ordered-map", status: "pass", turns: 3, requests: 3,
        inputTok: 200, outputTok: 30, cacheHitTok: 120, cacheMissTok: 80,
        reasoningTok: 7, costUsd: 0, durationMs: 11,
        promptCalls: 3, promptChars: 1800, promptComparableChars: 1200,
        promptCommonPrefixChars: 900, promptAddedSuffixChars: 300,
        promptReplacedSuffixChars: 100, promptFirstChangedSections: { actionHistory: 2 },
        codexThreadCalls: 3, codexUniqueThreads: 2, codexReusedCalls: 1,
        codexRebasedCalls: 1,
        codexCanonicalPromptChars: 1800, codexDeliveredPromptChars: 900,
        codexPromptSavedChars: 900, codexPromptDeltaCalls: 2,
        codexPromptFallbackCalls: 0,
        codexPromptRebaseCalls: 1,
        codexTerminalRebasedCalls: 1,
        codexPostRebaseCalls: 2,
        codexPromptMinDeltaSavedRatio: 0.18,
        codexPromptLowSavingsDeltaCalls: 1,
        codexPromptIntegrityStatus: "pass",
        codexPromptIntegrityAuditedCalls: 3,
        codexPromptIntegrityExactCalls: 3,
        codexPromptIntegrityFailures: 0,
        externalWorkspaceMutationEvents: 2,
        externalWorkspaceMutationPaths: 3,
        externalWorkspaceMutationBlockedActions: 1,
      }] },
    ],
  };
  const totals = summarizeExperiment(manifest);
  assert.equal(totals.arms.sol.inputTok, 200);
  assert.equal(totals.arms.sol.reasoningTok, 7);
  assert.equal(totals.comparisons[0].delta.inputTok, 100);
  assert.equal(totals.comparisons[0].delta.requests, 1);
  assert.equal(totals.arms.sol.promptCommonPrefixRatio, 0.75);
  assert.equal(totals.arms.sol.fixtures["ordered-map"].promptCommonPrefixRatio, 0.75);
  assert.deepEqual(totals.arms.sol.promptFirstChangedSections, { actionHistory: 2 });
  assert.equal(totals.arms.sol.codexThreadCalls, 3);
  assert.equal(totals.arms.sol.codexUniqueThreads, 2);
  assert.equal(totals.arms.sol.codexReusedCalls, 1);
  assert.equal(totals.arms.sol.codexRebasedCalls, 1);
  assert.equal(totals.arms.sol.codexDeliveredPromptChars, 900);
  assert.equal(totals.arms.sol.codexPromptSavedRatio, 0.5);
  assert.equal(totals.arms.sol.codexPromptDeltaCalls, 2);
  assert.equal(totals.arms.sol.codexTerminalRebasedCalls, 1);
  assert.equal(totals.arms.sol.codexPostRebaseCalls, 2);
  assert.equal(totals.arms.sol.codexPromptMinDeltaSavedRatio, 0.18);
  assert.equal(totals.arms.sol.codexPromptLowSavingsDeltaCalls, 1);
  assert.equal(totals.arms.sol.codexPromptIntegrityAuditedCalls, 3);
  assert.equal(totals.arms.sol.codexPromptIntegrityExactCalls, 3);
  assert.equal(totals.arms.sol.codexPromptIntegrityFailures, 0);
  assert.equal(totals.arms.sol.externalWorkspaceMutationEvents, 2);
  assert.equal(totals.arms.sol.externalWorkspaceMutationPaths, 3);
  assert.equal(totals.arms.sol.externalWorkspaceMutationBlockedActions, 1);
  assert.equal(totals.arms.sol.fixtures["ordered-map"].externalWorkspaceMutationEvents, 2);
  assert.equal(totals.comparisons[0].delta.externalWorkspaceMutationBlockedActions, 1);
  assert.equal(totals.comparisons[0].delta.codexReusedCalls, 1);
  assert.equal(totals.comparisons[0].delta.codexRebasedCalls, 1);
  assert.equal(totals.comparisons[0].delta.promptChars, 800);
  assert.ok(Math.abs(totals.comparisons[0].delta.promptCommonPrefixRatio + 0.05) < 1e-12);
});

test("all benchmark fixtures start public-green but hidden-contract-red", async (t) => {
  for (const name of GAUNTLET_FIXTURES) {
    await t.test(name, async () => {
      const fixture = path.join(root, "gauntlet", "fixtures", name);
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-gauntlet-${name}-`));
      try {
        fs.cpSync(path.join(fixture, "repo"), workspace, { recursive: true });
        execFileSync(process.execPath, ["--test"], {
          cwd: workspace,
          env: { ...process.env, BANTAM_NO_FACTS: "1" },
          stdio: "pipe",
        });
        const contract = await runContractGrader({ fixtureDir: fixture, workspace });
        assert.equal(contract.status, "fail");
        assert.ok(contract.tests >= 2);
        const task = JSON.parse(fs.readFileSync(path.join(fixture, "task.json"), "utf8"));
        assert.deepEqual(task.editable, ["src"]);
        assert.equal(task.verify, "npm test");
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
});
