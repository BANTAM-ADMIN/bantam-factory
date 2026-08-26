import assert from "node:assert/strict";
import test from "node:test";

import {
  modelUsageBreakdownDelta,
  modelUsageBreakdownSnapshot,
  modelUsageDelta,
  modelUsageSnapshot,
} from "../src/model-usage-snapshot.js";

test("task-scoped usage snapshots isolate aggregate and source deltas", () => {
  let total = {
    requests: 3,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheHitTokens: 50,
    cacheMissTokens: 50,
    reasoningTokens: 5,
    costUsd: 0,
    codexRequests: 3,
  };
  let sources = {
    action_generation: { ...total },
  };
  const model = {
    usageSummary: () => structuredClone(total),
    usageBreakdownSummary: () => structuredClone(sources),
  };
  const before = modelUsageSnapshot(model);
  const sourcesBefore = modelUsageBreakdownSnapshot(model);

  total = {
    requests: 5,
    inputTokens: 180,
    outputTokens: 35,
    totalTokens: 215,
    cacheHitTokens: 80,
    cacheMissTokens: 100,
    reasoningTokens: 9,
    costUsd: 0,
    codexRequests: 5,
  };
  sources = {
    action_generation: {
      requests: 4,
      inputTokens: 160,
      outputTokens: 30,
      totalTokens: 190,
      cacheHitTokens: 80,
      cacheMissTokens: 80,
      reasoningTokens: 8,
      costUsd: 0,
      codexRequests: 4,
    },
    supplied_image_vision: {
      requests: 1,
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      cacheHitTokens: 0,
      cacheMissTokens: 20,
      reasoningTokens: 1,
      costUsd: 0,
      codexRequests: 1,
    },
  };

  assert.deepEqual(modelUsageDelta(before, modelUsageSnapshot(model)), {
    requests: 2,
    inputTokens: 80,
    outputTokens: 15,
    totalTokens: 95,
    cacheHitTokens: 30,
    cacheMissTokens: 50,
    reasoningTokens: 4,
    costUsd: 0,
    codexRequests: 2,
  });
  assert.deepEqual(
    modelUsageBreakdownDelta(sourcesBefore, modelUsageBreakdownSnapshot(model)),
    {
      action_generation: {
        requests: 1,
        inputTokens: 60,
        outputTokens: 10,
        totalTokens: 70,
        cacheHitTokens: 30,
        cacheMissTokens: 30,
        reasoningTokens: 3,
        costUsd: 0,
        codexRequests: 1,
      },
      supplied_image_vision: {
        requests: 1,
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        cacheHitTokens: 0,
        cacheMissTokens: 20,
        reasoningTokens: 1,
        costUsd: 0,
        codexRequests: 1,
      },
    },
  );
});

test("usage snapshots fail closed to zero-shaped evidence", () => {
  const throwing = {
    usageSummary() { throw new Error("unavailable"); },
    usageBreakdownSummary() { throw new Error("unavailable"); },
  };
  assert.equal(modelUsageSnapshot(throwing).requests, 0);
  assert.deepEqual(modelUsageBreakdownSnapshot(throwing), {});
});
