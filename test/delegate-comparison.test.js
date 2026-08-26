import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareExecutionEvidence,
  formatExecutionComparison,
} from "../src/delegate-comparison.js";

test("execution comparison normalizes native delegates and BANTAM experiment arms", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-delegate-compare-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const delegate = path.join(root, "delegate.json");
  const experiment = path.join(root, "manifest.json");
  fs.writeFileSync(delegate, JSON.stringify({
    schema: 1, kind: "bantam-codex-delegate", id: "d", model: "gpt-5.6-sol", effort: "high",
    result: { pass: true }, execution: { durationMs: 100 },
    usage: { turns: 1, inputTokens: 1000, cachedInputTokens: 800, cacheMissTokens: 200, outputTokens: 50, reasoningOutputTokens: 10 },
  }));
  fs.writeFileSync(experiment, JSON.stringify({
    kind: "bantam-experiment",
    spec: { arms: [{ name: "sol", model: { effort: "high" } }, { name: "local", model: {} }] },
    totals: { arms: {
      sol: { tasks: 1, passed: 1, strict: 1, turns: 3, requests: 3, inputTok: 600, cacheHitTok: 500, cacheMissTok: 100, outputTok: 40, reasoningTok: 5, taskMs: 80 },
      local: { tasks: 1, passed: 1, strict: 1, turns: 4, requests: 4, inputTok: 300, cacheHitTok: 20, cacheMissTok: 0, outputTok: 60, reasoningTok: 0, taskMs: 70 },
    } },
  }));
  const comparison = compareExecutionEvidence([delegate, experiment]);
  assert.equal(comparison.rows.length, 3);
  assert.equal(comparison.fastest, "bantam-local");
  assert.equal(comparison.lowestCacheMiss, "bantam-sol");
  assert.match(formatExecutionComparison(comparison), /native-sol-high/);
  assert.match(formatExecutionComparison(comparison), /different contracts/);
});

test("execution comparison accepts Claude delegates without claiming cache equivalence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-claude-delegate-compare-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claude = path.join(root, "claude.json");
  const codex = path.join(root, "codex.json");
  fs.writeFileSync(claude, JSON.stringify({
    schema: 1, kind: "bantam-claude-delegate", id: "c", model: "claude-opus-5", effort: "high",
    result: { pass: true }, execution: { durationMs: 1200 },
    usage: { turns: 2, inputTokens: 200, cachedInputTokens: 160, cacheMissTokens: 40, outputTokens: 30 },
  }));
  fs.writeFileSync(codex, JSON.stringify({
    schema: 1, kind: "bantam-codex-delegate", id: "d", model: "gpt-5.6-terra", effort: "medium",
    result: { pass: true }, execution: { durationMs: 1000 },
    usage: { turns: 2, inputTokens: 220, cachedInputTokens: 180, cacheMissTokens: 40, outputTokens: 25 },
  }));
  const comparison = compareExecutionEvidence([claude, codex]);
  const row = comparison.rows.find((entry) => entry.model === "claude-opus-5");
  assert.equal(row.label, "native-claude-opus-high");
  assert.equal(row.cacheMissComparable, false);
  assert.equal(comparison.lowestCacheMiss, "native-terra-medium");
});

test("execution comparison reads authoritative usage aggregates from current BANTAM runs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-current-run-compare-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first.json");
  const second = path.join(root, "second.json");
  const run = (model, runtime, usage, durationMs) => ({
    kind: "bantam-run", modelId: model, model: { metadata: { runtime } },
    modelCalls: [{ response: { body: "transport evidence, not a shallow usage block" } }],
    result: { pass: true }, metrics: { turns: 4, modelRequests: usage.requests, usage, durationMs },
  });
  fs.writeFileSync(first, JSON.stringify(run("qwen-27b", "local", {
    requests: 6, inputTokens: 14_237, cacheHitTokens: 14_000,
    cacheMissTokens: 237, outputTokens: 236, reasoningTokens: 0,
  }, 6_700)));
  fs.writeFileSync(second, JSON.stringify(run("gpt-5.6-terra", "codex", {
    requests: 4, inputTokens: 56_720, cacheHitTokens: 38_144,
    cacheMissTokens: 18_576, outputTokens: 399, reasoningTokens: 34,
  }, 16_300)));
  const comparison = compareExecutionEvidence([first, second]);
  assert.deepEqual(comparison.rows.map((row) => ({
    input: row.inputTokens, cache: row.cacheHitTokens, miss: row.cacheMissTokens,
    output: row.outputTokens, reasoning: row.reasoningTokens,
  })), [
    { input: 14_237, cache: 14_000, miss: 237, output: 236, reasoning: 0 },
    { input: 56_720, cache: 38_144, miss: 18_576, output: 399, reasoning: 34 },
  ]);
});
