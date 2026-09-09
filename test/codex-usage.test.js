import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexUsageAccumulator} from '../src/codex-usage.js';

const raw = (inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens = 0) =>
  ({inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens: inputTokens + outputTokens});
const first = {last: raw(100, 40, 10, 2), total: raw(100, 40, 10, 2)};
const second = {last: raw(150, 100, 20, 5), total: raw(250, 140, 30, 7)};

test('all native requests count once, including identical replies with distinct cumulative totals', () => {
  const meter = new CodexUsageAccumulator();
  meter.add(first); meter.add(first); meter.add(second); meter.add(second);
  meter.add({last: second.last, total: raw(400, 240, 50, 12)});
  const result = meter.snapshot();
  assert.deepEqual(result.raw, raw(400, 240, 50, 12));
  assert.equal(result.requests, 3); assert.equal(result.complete, true);
  assert.equal(result.evidence.receipts.length, 3);
});

test('a subsequent native turn pays only the difference from its acknowledged thread total', () => {
  const meter = new CodexUsageAccumulator(second.total);
  meter.add(second); // delayed duplicate from the preceding turn
  meter.add({last: raw(300, 200, 8), total: raw(550, 340, 38, 7)});
  assert.deepEqual(meter.snapshot().raw, raw(300, 200, 8));
  assert.equal(meter.snapshot().requests, 1);
  assert.equal(meter.snapshot().complete, true);
});

test('missing intermediate receipts retain the full token delta with an explicit accounting gap', () => {
  const meter = new CodexUsageAccumulator();
  meter.add(second);
  assert.deepEqual(meter.snapshot().raw, second.total);
  assert.equal(meter.snapshot().complete, false);
  assert.deepEqual(meter.snapshot().evidence.gaps, ['unobserved-response-usage']);
});

test('out-of-order cumulative usage cannot roll the baseline backward or count it twice', () => {
  const meter = new CodexUsageAccumulator();
  meter.add(first); meter.add(second); meter.add(first);
  assert.deepEqual(meter.snapshot().raw, second.total);
  assert.deepEqual(meter.snapshot().cursor, second.total);
  assert.equal(meter.snapshot().requests, 2);
  assert.equal(meter.snapshot().complete, false);
});

test('legacy single receipts remain usable, while ambiguous duplicates and unknown baselines stay partial', () => {
  const meter = new CodexUsageAccumulator();
  meter.add({last:first.last});
  assert.equal(meter.snapshot().complete, true);
  assert.equal(meter.snapshot().cursor, null);
  meter.add({last:first.last});
  assert.deepEqual(meter.snapshot().raw, first.last);
  assert.equal(meter.snapshot().requests, 1);
  assert.equal(meter.snapshot().complete, false);
  const next = new CodexUsageAccumulator(null); next.add(second);
  assert.deepEqual(next.snapshot().raw, second.last);
  assert.equal(next.snapshot().complete, false);
});

test('missing counters are never invented as zero, and inputs cannot be negative or cache exceed input', () => {
  assert.equal(new CodexUsageAccumulator().snapshot().raw, null);
  for (const last of [{inputTokens:10,outputTokens:4}, raw(-1,0,4), raw(10,11,4), raw('10',0,4)]) {
    const meter = new CodexUsageAccumulator();meter.add({last});
    assert.equal(meter.snapshot().complete, false);
  }
  const meter = new CodexUsageAccumulator(); meter.add({last:{inputTokens:10,outputTokens:4}});
  assert.equal(meter.snapshot().raw.cachedInputTokens, null);
  const corrupt = new CodexUsageAccumulator();corrupt.add({last:first.last,total:raw(-1,0,10)});
  assert.equal(corrupt.snapshot().complete,false,'invalid totals are not a legacy server');
});
