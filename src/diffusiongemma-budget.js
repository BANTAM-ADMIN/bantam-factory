// Small-context primary mode. These are deployment budgets, not model limits.
export function diffusionGemmaBudget(contextTokens = 16384) {
  const context = Number(contextTokens);
  if (!Number.isSafeInteger(context) || context < 4096) throw Error('DiffusionGemma primary mode needs a context window of at least 4096 tokens');
  const marginTokens = Math.max(512, Math.min(1024, Math.floor(context / 16)));
  const generationTokens = Math.min(4096, Math.floor(context / 4));
  const hardInputTokens = Math.min(11264, context - generationTokens - marginTokens);
  const compactAtTokens = Math.min(8192, Math.floor(hardInputTokens * .75));
  return { contextTokens: context, compactAtTokens, compactToTokens: Math.min(6144, Math.floor(compactAtTokens * .75)),
    hardInputTokens, generationTokens, defaultGenerationTokens: Math.min(2048, generationTokens), marginTokens,
    historyChars: Math.min(12000, Math.floor(compactAtTokens / 3) * 4) };
}

export function diffusionGemmaOutputTokens(requested, budget) {
  const n = requested == null ? budget.defaultGenerationTokens : Number(requested);
  if (!Number.isFinite(n) || n <= 0) throw Error('DiffusionGemma generation budget must be positive');
  return Math.min(Math.floor(n), budget.generationTokens);
}
