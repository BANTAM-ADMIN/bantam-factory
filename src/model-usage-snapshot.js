// Task-scoped snapshots over a reusable ModelClient's cumulative accounting.

export const USAGE_FIELDS = Object.freeze([
  "requests",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheHitTokens",
  "cacheMissTokens",
  "reasoningTokens",
  "costUsd",
  "codexRequests",
]);

export function modelUsageSnapshot(model) {
  try {
    return normalizedUsage(model?.usageSummary?.());
  } catch {
    return normalizedUsage(null);
  }
}

export function modelUsageDelta(before, after) {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [
    field,
    Math.max(0, Number(after?.[field] ?? 0) - Number(before?.[field] ?? 0)),
  ]));
}

export function modelUsageBreakdownSnapshot(model) {
  try {
    const value = model?.usageBreakdownSummary?.();
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([source, usage]) => [
      source,
      normalizedUsage(usage),
    ]));
  } catch {
    return {};
  }
}

export function modelUsageBreakdownDelta(before, after) {
  const sources = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return Object.fromEntries([...sources].sort().map((source) => [
    source,
    modelUsageDelta(before?.[source], after?.[source]),
  ]).filter(([, usage]) => USAGE_FIELDS.some((field) => usage[field] !== 0)));
}

function normalizedUsage(value) {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [
    field,
    Number.isFinite(Number(value?.[field])) ? Number(value[field]) : 0,
  ]));
}
