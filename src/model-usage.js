// Per-completion token and estimated-cost accounting.
//
// DeepSeek prices are USD per 1M tokens, published 2026-07-25:
// https://api-docs.deepseek.com/quick_start/pricing/

export const DEEPSEEK_PRICING = Object.freeze({
  "deepseek-v4-flash": Object.freeze({ cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 }),
  "deepseek-v4-pro": Object.freeze({ cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 }),
});

export function emptyModelUsage() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    codexRequests: 0,
  };
}

export function usageFromResponse(data, { provider = "local", model = "local" } = {}) {
  const raw = data?.usage && typeof data.usage === "object" ? data.usage : {};
  const inputTokens = nonnegativeInt(
    raw.prompt_tokens
      ?? data?.tokens_evaluated
      ?? data?.timings?.prompt_n
      ?? 0,
  );
  const outputTokens = nonnegativeInt(
    raw.completion_tokens
      ?? data?.tokens_predicted
      ?? data?.timings?.predicted_n
      ?? 0,
  );
  const reportedHit = raw.prompt_cache_hit_tokens
    ?? raw.prompt_tokens_details?.cached_tokens
    // llama.cpp's top-level tokens_cached is the current KV-cache/context
    // population and can exceed this request's evaluated prompt. cache_n is
    // the reused prompt prefix for this completion and is the comparable hit
    // count. Retain tokens_cached only as a fallback for older servers.
    ?? data?.timings?.cache_n
    ?? data?.tokens_cached;
  const cacheHitTokens = Math.min(inputTokens, nonnegativeInt(reportedHit ?? 0));
  const reportedMiss = raw.prompt_cache_miss_tokens;
  const cacheMissTokens = nonnegativeInt(
    reportedMiss ?? (provider === "deepseek" ? Math.max(0, inputTokens - cacheHitTokens) : 0),
  );
  const reasoningTokens = nonnegativeInt(raw.completion_tokens_details?.reasoning_tokens ?? 0);
  const totalTokens = nonnegativeInt(raw.total_tokens ?? (inputTokens + outputTokens));
  const pricing = provider === "deepseek" ? DEEPSEEK_PRICING[model] : null;
  const costUsd = pricing
    ? (
        cacheHitTokens * pricing.cacheHit
        + cacheMissTokens * pricing.cacheMiss
        + outputTokens * pricing.output
      ) / 1_000_000
    : 0;

  return {
    provider,
    model,
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    reasoningTokens,
    costUsd,
    codexRequests: provider === "codex" ? 1 : 0,
  };
}

export function addModelUsage(total, entry) {
  const next = emptyModelUsage();
  for (const key of Object.keys(next)) {
    next[key] = Number(total?.[key] ?? 0) + Number(entry?.[key] ?? 0);
  }
  return next;
}

export function formatUsage(entry, { cumulative = false } = {}) {
  const label = cumulative ? `session (${formatInteger(entry.requests)} model calls)` : entry.model;
  const cache = entry.cacheHitTokens || entry.cacheMissTokens
    ? ` · cache ${formatInteger(entry.cacheHitTokens)} hit/${formatInteger(entry.cacheMissTokens)} miss`
    : "";
  const reasoning = entry.reasoningTokens
    ? ` · reasoning ${formatInteger(entry.reasoningTokens)}`
    : "";
  const cost = entry.costUsd > 0
    ? ` · est ${formatUsd(entry.costUsd)}`
    : entry.provider === "codex" || entry.codexRequests > 0
      ? ` · $0 subscription`
      : ` · $0 local`;
  return `${label}: in ${formatInteger(entry.inputTokens)}${cache} · out ${formatInteger(entry.outputTokens)}${reasoning}${cost}`;
}

/**
 * How much of the prompt was reused rather than reprocessed, for the run
 * summary. Returns null when there is nothing to report.
 *
 * On a local llama.cpp slot this number is governed by --ubatch-size: reuse is
 * checkpoint-or-nothing on a hybrid model, and the only checkpoint /completion
 * gets sits n_ubatch+4 tokens before the end. A prompt edit further back than
 * that reprocesses everything. Measured 2026-08-22: the same turn ran 0% reuse
 * / 3813 ms at ubatch 512 and 76% / 1513 ms at 2048. The advice line names that
 * knob, because an operator seeing "11%" should not have to already know the
 * mechanism to act on it.
 */
export function formatPrefixReuse(totals, { remote = false } = {}) {
  const inputTokens = nonnegativeInt(totals?.inputTokens);
  if (!inputTokens) return null;
  const hit = Math.min(inputTokens, nonnegativeInt(totals?.cacheHitTokens));
  const pct = Math.round((100 * hit) / inputTokens);
  const line = `prefix reuse: ${pct}% (${formatInteger(hit)} of ${formatInteger(inputTokens)} prompt tokens reused)`;
  // Quiet on small runs: with barely a prefix there is nothing to reuse, and
  // advice that fires on every trivial task stops being read.
  if (pct >= 60 || inputTokens < 8000) return line;
  // Advice speaks the transport it measured (card-20 sol: --ubatch advice on a
  // bridge lane sent the operator hunting a knob that does not exist there).
  if (remote) {
    // A cold session's first turns SHOULD reuse little; only sustained runs
    // deserve the warning at all.
    if (nonnegativeInt(totals?.requests) > 0 && nonnegativeInt(totals?.requests) <= 3) return line;
    return `${line}\n  ⚠ most of the prompt is being reprocessed every turn. On a remote provider check that cache_prompt/sessions are honored and that the prompt prefix is not rewritten between turns.`;
  }
  return `${line}\n  ⚠ most of the prompt is being reprocessed every turn. On a local server this is usually --ubatch-size: the reuse window is n_ubatch+4 tokens from the end of the prompt, and edits further back than that lose the whole cache.`;
}

function nonnegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function formatInteger(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("en-US");
}

function formatUsd(value) {
  const amount = Math.max(0, Number(value) || 0);
  if (amount === 0) return "$0.000000";
  return `$${amount.toFixed(amount < 0.01 ? 6 : 4)}`;
}
