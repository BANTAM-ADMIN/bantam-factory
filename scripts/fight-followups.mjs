// Public receipts for contenders recorded after a card's original run window.
// Only fixed identities, hashes, dates and numeric conditions can cross here.
const ARMS = new Set(['deepseek-local-27b', 'hermes', 'opencode']);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const positive = value => Number.isSafeInteger(value) && value > 0;

export function publicFollowups(value) {
  if (!Array.isArray(value) || value.length > 3) return [];
  const seen = new Set(), receipts = [];
  for (const item of value) {
    if (!item || item.schema !== 'bantam.fight-followup.v1'
        || !['previousSourceSha256', 'baselineManifestSha256', 'manifestSha256', 'materialsSha256', 'modelSha256'].every(key => hash(item[key]))
        || !date(item.startedAt) || !date(item.finishedAt) || item.finishedAt < item.startedAt
        || !Array.isArray(item.arms) || !item.arms.length || item.arms.length > 3
        || item.arms.some(arm => !ARMS.has(arm) || seen.has(arm)) || new Set(item.arms).size !== item.arms.length
        || !positive(item.wallMs) || item.wallMs > 3600000
        || !positive(item.contextTokens) || item.contextTokens > 16777216
        || !positive(item.peerOutputTokens) || item.peerOutputTokens > item.contextTokens) return [];
    for (const arm of item.arms) seen.add(arm);
    receipts.push({schema: item.schema, previousSourceSha256: item.previousSourceSha256,
      baselineManifestSha256: item.baselineManifestSha256, manifestSha256: item.manifestSha256,
      materialsSha256: item.materialsSha256, modelSha256: item.modelSha256,
      startedAt: item.startedAt, finishedAt: item.finishedAt, arms: [...item.arms],
      wallMs: item.wallMs, contextTokens: item.contextTokens, peerOutputTokens: item.peerOutputTokens});
  }
  return receipts;
}

export function followupFields(series) {
  const followups = publicFollowups(series.followups);
  return followups.length ? {followups} : {};
}
