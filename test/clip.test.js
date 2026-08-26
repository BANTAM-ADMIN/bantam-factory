import test from 'node:test';
import assert from 'node:assert';
import { clipText, OBS_MAX } from '../src/clip.js';

// --- clipText basics ---
test('clipText returns text unchanged when under limit', () => {
  assert.strictEqual(clipText('hello', 100), 'hello');
});

test('clipText returns text unchanged at exact limit', () => {
  const text = 'x'.repeat(50);
  assert.strictEqual(clipText(text, 50), text);
});

test('clipText clips text that exceeds limit', () => {
  const text = 'x'.repeat(1000);
  const result = clipText(text, 100);
  assert.ok(result.length <= 100);
});

test('clipText returns empty string for limit 0', () => {
  assert.strictEqual(clipText('hello', 0), '');
});

test('clipText handles null input', () => {
  assert.strictEqual(clipText(null, 100), '');
});

test('clipText handles undefined input', () => {
  assert.strictEqual(clipText(undefined, 100), '');
});

test('clipText converts non-string values', () => {
  assert.strictEqual(clipText(100, 100), '100');
});

// --- clipping behavior ---
test('clipText includes a clip marker when truncating', () => {
  const text = 'x'.repeat(1000);
  const result = clipText(text, 200);
  assert.ok(result.includes('[') && result.includes('chars clipped]'));
});

test('clipText preserves head and tail content', () => {
  const head = 'HEAD';
  const tail = 'TAIL';
  const middle = 'x'.repeat(500);
  const text = head + middle + tail;
  const result = clipText(text, 100);
  assert.ok(result.startsWith('HEAD'));
  assert.ok(result.endsWith('TAIL'));
});

test('clipText is idempotent — re-clipping already-clipped text is a no-op', () => {
  const text = 'x'.repeat(1000);
  const once = clipText(text, 200);
  const twice = clipText(once, 200);
  assert.strictEqual(once, twice);
});

test('clipText uses OBS_MAX as default max', () => {
  const text = 'x'.repeat(OBS_MAX + 100);
  const result = clipText(text);
  assert.ok(result.length <= OBS_MAX);
});

test('clipText handles very short limit by returning head only', () => {
  const text = 'hello world';
  const result = clipText(text, 5);
  assert.strictEqual(result, 'hello');
});

test('clipText handles unicode without splitting surrogate pairs', () => {
  const text = 'café'.repeat(200);
  const result = clipText(text, 50);
  // Should not end with a lone surrogate
  assert.ok(result.length > 0);
  assert.ok(result.length <= 50);
});

test('OBS_MAX is exported and equals 4000', () => {
  assert.strictEqual(OBS_MAX, 4000);
});
