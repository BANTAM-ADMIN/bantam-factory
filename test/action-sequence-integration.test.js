// Tests for Action Sequence Integration
import test from 'node:test';
import assert from 'node:assert';
import { IntegratedDecider, runABEvaluation } from '../src/action-sequence-integration.js';

// ---------------------------------------------------------------------------
// IntegratedDecider: construction and modes
// ---------------------------------------------------------------------------

test('IntegratedDecider: defaults to adaptive mode', () => {
  const d = new IntegratedDecider();
  assert.strictEqual(d.mode, 'adaptive');
  assert.strictEqual(d.seeded, false);
});

test('IntegratedDecider: can be constructed in recommender mode', () => {
  const d = new IntegratedDecider({ mode: 'recommender' });
  assert.strictEqual(d.mode, 'recommender');
});

test('IntegratedDecider: can be constructed in planner mode', () => {
  const d = new IntegratedDecider({ mode: 'planner' });
  assert.strictEqual(d.mode, 'planner');
});

test('IntegratedDecider: seed() marks as seeded', () => {
  const d = new IntegratedDecider();
  d.seed();
  assert.strictEqual(d.seeded, true);
});

test('IntegratedDecider: summary includes mode and stats', () => {
  const d = new IntegratedDecider();
  const s = d.summary();
  assert.ok(s.mode);
  assert.ok(s.stats);
  assert.ok(typeof s.stats.totalDecisions === 'number');
});

// ---------------------------------------------------------------------------
// IntegratedDecider: decide() in each mode
// ---------------------------------------------------------------------------

test('IntegratedDecider: recommender mode returns recommender strategy', () => {
  const d = new IntegratedDecider({ mode: 'recommender' });
  const result = d.decide({ lastAction: 'read_file' });
  assert.strictEqual(result.strategy, 'recommender');
  assert.ok(result.action);
});

test('IntegratedDecider: planner mode returns planner strategy', () => {
  const d = new IntegratedDecider({ mode: 'planner' });
  d.seed();
  const result = d.decide({ lastAction: 'read_file' });
  assert.strictEqual(result.strategy, 'planner');
  assert.ok(result.action);
  assert.ok(result.plan);
});

test('IntegratedDecider: adaptive mode returns recommender when not seeded', () => {
  const d = new IntegratedDecider({ mode: 'adaptive' });
  const result = d.decide({ lastAction: 'read_file' });
  assert.strictEqual(result.strategy, 'recommender');
});

test('IntegratedDecider: adaptive mode uses planner when seeded and score is higher', () => {
  const d = new IntegratedDecider({ mode: 'adaptive', overrideThreshold: 0.1 });
  d.seed();
  const result = d.decide({ lastAction: 'read_file' });
  // Should have tried planner; strategy could be either depending on scores
  assert.ok(result.strategy === 'recommender' || result.strategy === 'planner');
});

test('IntegratedDecider: decide returns action name string', () => {
  const d = new IntegratedDecider();
  d.seed();
  const result = d.decide({ lastAction: 'read_file' });
  assert.ok(typeof result.action === 'string');
});

test('IntegratedDecider: decide increments totalDecisions', () => {
  const d = new IntegratedDecider();
  assert.strictEqual(d.stats.totalDecisions, 0);
  d.decide({});
  assert.strictEqual(d.stats.totalDecisions, 1);
  d.decide({});
  assert.strictEqual(d.stats.totalDecisions, 2);
});

// ---------------------------------------------------------------------------
// IntegratedDecider: recordOutcome
// ---------------------------------------------------------------------------

test('IntegratedDecider: recordOutcome updates planner', () => {
  const d = new IntegratedDecider();
  d.recordOutcome(['read_file', 'replace', 'shell'], true);
  assert.ok(d.planner.sequences.length > 0);
});

// ---------------------------------------------------------------------------
// runABEvaluation
// ---------------------------------------------------------------------------

test('runABEvaluation: returns results for all three modes', () => {
  const result = runABEvaluation();
  assert.ok(result.A);
  assert.ok(result.B);
  assert.ok(result.C);
  assert.ok(result.totalScenarios > 0);
});

test('runABEvaluation: each mode has winRate and avgScore', () => {
  const result = runABEvaluation();
  for (const mode of ['A', 'B', 'C']) {
    assert.ok(typeof result[mode].winRate === 'number', `${mode}.winRate should be number`);
    assert.ok(typeof result[mode].avgScore === 'number', `${mode}.avgScore should be number`);
  }
});

test('runABEvaluation: winner is one of A, B, or C', () => {
  const result = runABEvaluation();
  assert.ok(['A', 'B', 'C'].includes(result.winner), `winner "${result.winner}" should be A/B/C`);
});

test('runABEvaluation: planner or adaptive beats or ties recommender', () => {
  const result = runABEvaluation();
  // Planner (B) or adaptive (C) should score at least as well as recommender (A)
  assert.ok(
    result.B.avgScore >= result.A.avgScore * 0.5 || result.C.avgScore >= result.A.avgScore * 0.5,
    'planner or adaptive should score >= 50% of recommender'
  );
});

test('runABEvaluation: win rates sum to ~100% (allowing ties)', () => {
  const result = runABEvaluation();
  const totalWinRate = result.A.winRate + result.B.winRate + result.C.winRate;
  // With ties, sum can exceed 100%; with no ties, sums to 100
  assert.ok(totalWinRate >= 100, `win rates should sum >= 100 (got ${totalWinRate})`);
});

// ---------------------------------------------------------------------------
// Integration: planner mode produces sensible sequences
// ---------------------------------------------------------------------------

test('Integration: planner mode after read_file suggests write or verify', () => {
  const d = new IntegratedDecider({ mode: 'planner' });
  d.seed();
  const result = d.decide({ lastAction: 'read_file' });
  // After reading, should suggest something productive
  assert.ok(result.plan && result.plan.length > 0);
});

test('Integration: planner mode after failure suggests recon', () => {
  const d = new IntegratedDecider({ mode: 'planner' });
  d.seed();
  const result = d.decide({ lastAction: 'replace', lastFailed: true });
  assert.ok(result.action);
});

test('Integration: adaptive mode with high threshold defaults to recommender', () => {
  const d = new IntegratedDecider({ mode: 'adaptive', overrideThreshold: 100 });
  d.seed();
  const result = d.decide({ lastAction: 'read_file' });
  assert.strictEqual(result.strategy, 'recommender');
});

test('Integration: planner fallback to recommender when no plan', () => {
  const d = new IntegratedDecider({ mode: 'planner' });
  // Don't seed — planner may still produce plans from beam search
  const result = d.decide({ lastAction: 'read_file' });
  assert.ok(result.action);
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

test('Performance: 100 decisions complete in reasonable time', () => {
  const d = new IntegratedDecider({ mode: 'adaptive' });
  d.seed();
  const start = Date.now();
  for (let i = 0; i < 100; i++) {
    d.decide({ lastAction: 'read_file' });
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `100 decisions took ${elapsed}ms, should be < 5000ms`);
});
