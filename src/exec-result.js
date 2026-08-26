/** Build the stable machine-readable result emitted by `bantam exec --json`. */
export function buildExecResult({ pass, status, turns = 0, durationMs = 0, error = null, usage = null }) {
  const result = { type: "result", pass, status, turns, durationMs };
  if (error) result.error = error;
  if (usage) {
    result.tokens = {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      total: usage.totalTokens ?? 0,
      cacheHit: usage.cacheHitTokens ?? 0,
      cacheMiss: usage.cacheMissTokens ?? 0,
      reasoning: usage.reasoningTokens ?? 0,
    };
    result.requests = usage.requests ?? 0;
    if (usage.costUsd > 0) result.costUsd = usage.costUsd;
  }
  return result;
}
