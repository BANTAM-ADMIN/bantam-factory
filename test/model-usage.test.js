import assert from "node:assert/strict";
import test from "node:test";

import {
  addModelUsage,
  emptyModelUsage,
  formatUsage,
  usageFromResponse,
} from "../src/model-usage.js";

test("prices DeepSeek V4 Pro cache hits, misses, and output independently", () => {
  const usage = usageFromResponse({
    model: "deepseek-v4-pro",
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
      completion_tokens: 100,
      total_tokens: 1100,
      completion_tokens_details: { reasoning_tokens: 50 },
    },
  }, { provider: "deepseek", model: "deepseek-v4-pro" });

  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.cacheHitTokens, 800);
  assert.equal(usage.cacheMissTokens, 200);
  assert.equal(usage.outputTokens, 100);
  assert.equal(usage.reasoningTokens, 50);
  assert.ok(Math.abs(usage.costUsd - 0.0001769) < 1e-12);
});

test("treats uncategorized DeepSeek prompt tokens as cache misses", () => {
  const usage = usageFromResponse({
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  }, { provider: "deepseek", model: "deepseek-v4-flash" });

  assert.equal(usage.cacheHitTokens, 0);
  assert.equal(usage.cacheMissTokens, 1000);
  assert.equal(usage.costUsd, 0.000168);
});

test("reports local llama token and prefix-cache counts at zero cost", () => {
  const usage = usageFromResponse({
    tokens_evaluated: 1200,
    tokens_predicted: 80,
    tokens_cached: 900,
  }, { provider: "local", model: "qwen.gguf" });

  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.outputTokens, 80);
  assert.equal(usage.cacheHitTokens, 900);
  assert.equal(usage.costUsd, 0);
  assert.match(formatUsage(usage), /\$0 local/);
});

test("prefers llama reused-prefix timing and never reports more cache hits than input", () => {
  const timed = usageFromResponse({
    tokens_evaluated: 11657,
    tokens_predicted: 71,
    tokens_cached: 11730,
    timings: { cache_n: 1722 },
  }, { provider: "local", model: "qwen.gguf" });
  assert.equal(timed.cacheHitTokens, 1722);

  const legacy = usageFromResponse({
    tokens_evaluated: 100,
    tokens_cached: 120,
  }, { provider: "local", model: "qwen.gguf" });
  assert.equal(legacy.cacheHitTokens, 100);
});

test("accumulates a detached session total and formats model-call count", () => {
  const first = usageFromResponse({
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }, { provider: "deepseek", model: "deepseek-v4-flash" });
  const second = usageFromResponse({
    tokens_evaluated: 20,
    tokens_predicted: 3,
  }, { provider: "local", model: "local" });
  const total = addModelUsage(addModelUsage(emptyModelUsage(), first), second);

  assert.equal(total.requests, 2);
  assert.equal(total.inputTokens, 30);
  assert.equal(total.outputTokens, 5);
  assert.equal(total.costUsd, first.costUsd);
  assert.match(formatUsage(total, { cumulative: true }), /session \(2 model calls\)/);
});

test("labels Codex plan usage as subscription rather than local cost", () => {
  const usage = {
    ...emptyModelUsage(),
    provider: "codex",
    model: "gpt-5.6-sol",
    requests: 1,
    codexRequests: 1,
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
  };

  assert.match(formatUsage(usage), /\$0 subscription/);
  assert.doesNotMatch(formatUsage(usage), /\$0 local/);
});
