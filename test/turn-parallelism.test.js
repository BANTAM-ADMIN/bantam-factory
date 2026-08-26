import test from 'node:test';
import assert from 'node:assert';
import { actionKind, actionsConflict, buildBatches, estimateSavings, analyzeTurns, smartBatch, estimateCost, optimizeTurns } from '../src/turn-parallelism.js';

// --- actionKind ---
test('actionKind returns "read" for read_file', () => {
  assert.strictEqual(actionKind({ a: 'read_file', p: 'x.js' }), 'read');
});

test('actionKind returns "read" for list_dir', () => {
  assert.strictEqual(actionKind({ a: 'list_dir', p: '.' }), 'read');
});

test('actionKind returns "read" for search', () => {
  assert.strictEqual(actionKind({ a: 'search', q: 'foo' }), 'read');
});

test('actionKind returns "read" for query', () => {
  assert.strictEqual(actionKind({ a: 'query', q: 'x' }), 'read');
});

test('actionKind returns "read" for inspect', () => {
  assert.strictEqual(actionKind({ a: 'inspect', ops: [] }), 'read');
});

test('actionKind returns "write" for replace', () => {
  assert.strictEqual(actionKind({ a: 'replace', p: 'x.js' }), 'write');
});

test('actionKind returns "write" for write_file', () => {
  assert.strictEqual(actionKind({ a: 'write_file', p: 'x.js' }), 'write');
});

test('actionKind returns "write" for shell', () => {
  assert.strictEqual(actionKind({ a: 'shell', c: 'ls' }), 'write');
});

test('actionKind returns "unknown" for null', () => {
  assert.strictEqual(actionKind(null), 'unknown');
});

test('actionKind returns "unknown" for empty object', () => {
  assert.strictEqual(actionKind({}), 'unknown');
});

// --- actionsConflict ---
test('actionsConflict returns false for two reads', () => {
  assert.strictEqual(actionsConflict({ a: 'read_file' }, { a: 'list_dir' }), false);
});

test('actionsConflict returns true for two writes', () => {
  assert.strictEqual(actionsConflict({ a: 'replace' }, { a: 'write_file' }), true);
});

test('actionsConflict returns true for read + write', () => {
  assert.strictEqual(actionsConflict({ a: 'read_file' }, { a: 'shell' }), true);
});

// --- buildBatches ---
test('buildBatches groups reads into inspect batches', () => {
  const actions = [
    { a: 'read_file', p: 'a.js' },
    { a: 'read_file', p: 'b.js' },
    { a: 'list_dir', p: '.' },
  ];
  const batches = buildBatches(actions);
  assert.strictEqual(batches.length, 1);
  assert.strictEqual(batches[0].type, 'inspect');
  assert.strictEqual(batches[0].ops.length, 3);
});

test('buildBatches keeps writes sequential', () => {
  const actions = [
    { a: 'read_file', p: 'a.js' },
    { a: 'replace', p: 'a.js' },
  ];
  const batches = buildBatches(actions);
  assert.strictEqual(batches.length, 2);
  assert.strictEqual(batches[1].type, 'sequential');
});

test('buildBatches respects maxBatch limit', () => {
  const actions = Array.from({ length: 10 }, (_, i) => ({ a: 'read_file', p: `${i}.js` }));
  const batches = buildBatches(actions, 3);
  assert.strictEqual(batches.length, 4); // 3+3+3+1
  assert.strictEqual(batches[0].ops.length, 3);
  assert.strictEqual(batches[3].ops.length, 1);
});

// --- estimateSavings ---
test('estimateSavings returns positive savings for many reads', () => {
  const actions = Array.from({ length: 20 }, () => ({ a: 'read_file' }));
  const savings = estimateSavings(actions);
  assert.ok(savings.turnsSaved > 0);
  assert.ok(savings.pctSaved > 0);
});

test('estimateSavings returns zero savings for single action', () => {
  const savings = estimateSavings([{ a: 'read_file' }]);
  assert.strictEqual(savings.turnsSaved, 0);
});

// --- analyzeTurns ---
test('analyzeTurns returns phases with discovery and write', () => {
  const turns = [
    [{ a: 'read_file' }, { a: 'list_dir' }],
    [{ a: 'replace' }],
  ];
  const analysis = analyzeTurns(turns);
  assert.ok(analysis.phases.some(p => p.name === 'discovery'));
  assert.ok(analysis.phases.some(p => p.name === 'write'));
});

test('analyzeTurns returns recommendations', () => {
  const turns = [
    [{ a: 'read_file' }, { a: 'list_dir' }, { a: 'search' }],
    [{ a: 'replace' }],
  ];
  const analysis = analyzeTurns(turns);
  assert.ok(Array.isArray(analysis.recommendations));
});

// --- smartBatch ---
test('smartBatch returns batches for mixed actions', () => {
  const actions = [
    { a: 'read_file', p: 'a.js' },
    { a: 'read_file', p: 'b.js' },
    { a: 'replace', p: 'a.js' },
  ];
  const batches = smartBatch(actions);
  assert.ok(batches.length > 0);
});

// --- estimateCost ---
test('estimateCost returns positive cost', () => {
  const actions = [
    { a: 'read_file', p: 'a.js' },
    { a: 'replace', p: 'a.js' },
  ];
  const cost = estimateCost(actions);
  assert.ok(cost.totalCost > 0);
});

test('estimateCost tracks breakdown by type', () => {
  const actions = [{ a: 'read_file', p: 'a.js' }];
  const cost = estimateCost(actions);
  assert.ok('read_file' in cost.breakdown);
});

// --- optimizeTurns ---
test('optimizeTurns reduces action count', () => {
  const actions = [
    { a: 'read_file', p: 'a.js' },
    { a: 'read_file', p: 'b.js' },
    { a: 'read_file', p: 'c.js' },
    { a: 'replace', p: 'a.js' },
  ];
  const optimized = optimizeTurns(actions);
  assert.ok(optimized.length < actions.length);
});

test('optimizeTurns preserves write actions', () => {
  const actions = [
    { a: 'read_file', p: 'a.js' },
    { a: 'replace', p: 'a.js' },
  ];
  const optimized = optimizeTurns(actions);
  const writes = optimized.filter(o => o.type === 'sequential');
  assert.strictEqual(writes.length, 1);
});
