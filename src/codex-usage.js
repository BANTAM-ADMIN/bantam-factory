// App-server usage is cumulative per thread, with `last` describing one model
// response. A native tool loop can produce several responses in one BANTAM
// completion. Keep the receipts, deduplicate cumulative snapshots, and subtract
// the previous completion instead of charging its tokens a second time.
const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const REQUIRED = ['inputTokens', 'cachedInputTokens', 'outputTokens'];
export const emptyCodexUsage = () => Object.fromEntries(FIELDS.map(k => [k, 0]));
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const copy = raw => raw && typeof raw === 'object'
  ? Object.fromEntries(FIELDS.map(k => [k, counter(raw[k])])) : null;
const valid = raw => raw && REQUIRED.every(k => raw[k] !== null)
  && raw.cachedInputTokens <= raw.inputTokens;
const equal = (a, b) => a && b && FIELDS.every(k => a[k] === b[k]);
const difference = (a, b) => Object.fromEntries(FIELDS.map(k => [k,
  a?.[k] !== null && b?.[k] !== null && Number.isSafeInteger(a?.[k]) && Number.isSafeInteger(b?.[k])
    && a[k] >= b[k] ? a[k] - b[k] : null]));

export class CodexUsageAccumulator {
  constructor(previousTotal = emptyCodexUsage()) {
    this.base = copy(previousTotal);
    this.cursor = copy(previousTotal);
    this.raw = null;
    this.receipts = [];
    this.gaps = new Set();
    this.legacy = false;
  }

  add(notification) {
    const total = copy(notification?.total), last = copy(notification?.last);
    if (notification?.total != null && !valid(total)) this.gaps.add('invalid-cumulative-usage');
    if (valid(total)) {
      if (equal(total, this.cursor)) return false;
      const delta = difference(total, this.cursor);
      if (this.cursor && !valid(delta)) {
        this.gaps.add('cumulative-usage-decreased');
        return false; // A stale receipt must not move the next turn's baseline.
      }
      if (!valid(last)) this.gaps.add('missing-response-usage');
      else if (this.cursor && !REQUIRED.every(k => delta[k] === last[k])) {
        this.gaps.add('unobserved-response-usage');
      }
      if (!this.base) this.gaps.add('unknown-thread-baseline');
      if (this.legacy) this.gaps.add('missing-cumulative-usage');
      this.cursor = total;
      this.raw = this.base ? difference(total, this.base) : last;
      this.receipts.push({total, last});
    } else if (last) {
      // Older app-servers can report only `last`. One report is usable; without
      // cumulative totals multiple notifications cannot be safely deduplicated.
      if (this.receipts.length) this.gaps.add('missing-cumulative-usage');
      this.legacy = true;
      this.cursor = null;
      this.raw ??= last;
      this.receipts.push({total: null, last});
      if (!valid(last)) this.gaps.add('missing-response-usage');
    } else {
      this.gaps.add('missing-response-usage');
    }
    return true;
  }

  snapshot() {
    const complete = this.receipts.length > 0 && valid(this.raw) && this.gaps.size === 0;
    return {raw: this.raw, cursor: this.cursor, complete,
      requests: this.legacy ? Math.min(1, this.receipts.length) : this.receipts.length,
      evidence: {schema: 'bantam.codex-usage.v1', complete,
        source: this.legacy ? 'last-response' : 'thread-total-delta',
        baseline: this.base, receipts: this.receipts,
        gaps: this.receipts.length ? [...this.gaps] : ['missing-response-usage']}};
  }
}
