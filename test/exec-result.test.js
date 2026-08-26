import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildExecResult } from "../src/exec-result.js";

describe("headless exec result", () => {
  it("preserves the compact legacy envelope when no usage was recorded", () => {
    assert.deepEqual(buildExecResult({ pass: true, status: "done", turns: 2, durationMs: 40 }), {
      type: "result",
      pass: true,
      status: "done",
      turns: 2,
      durationMs: 40,
    });
  });

  it("includes measured token and request usage for benchmark consumers", () => {
    assert.deepEqual(buildExecResult({
      pass: false,
      status: "max-turns",
      turns: 8,
      durationMs: 1200,
      usage: {
        requests: 3,
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cacheHitTokens: 60,
        cacheMissTokens: 40,
        reasoningTokens: 7,
        costUsd: 0.012,
      },
    }), {
      type: "result",
      pass: false,
      status: "max-turns",
      turns: 8,
      durationMs: 1200,
      tokens: { input: 100, output: 25, total: 125, cacheHit: 60, cacheMiss: 40, reasoning: 7 },
      requests: 3,
      costUsd: 0.012,
    });
  });

  it("normalizes partial usage and omits a zero cost", () => {
    assert.deepEqual(buildExecResult({ pass: false, status: "error", error: "offline", usage: {} }), {
      type: "result",
      pass: false,
      status: "error",
      turns: 0,
      durationMs: 0,
      error: "offline",
      tokens: { input: 0, output: 0, total: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0 },
      requests: 0,
    });
  });
});
