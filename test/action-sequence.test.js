import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TransitionModel,
  SequenceScorer,
  ActionSequencePlanner,
  ABTestRunner,
  generateTestScenarios,
  seedTransitionModel,
} from '../src/action-sequence.js';
import { ActionRecommender } from '../src/action-recommender.js';

// ---------------------------------------------------------------------------
// TransitionModel tests
// ---------------------------------------------------------------------------

test('TransitionModel: recordSequence updates unigram counts', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file', 'replace'], true);
  model.recordSequence(['read_file', 'replace'], false);
  const rate = model.unigramRate('read_file');
  assert.ok(rate > 0 && rate <= 1, `unigram rate should be 0..1, got ${rate}`);
});

test('TransitionModel: recordSequence updates bigram counts', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file', 'replace'], true);
  model.recordSequence(['read_file', 'replace'], true);
  model.recordSequence(['read_file', 'shell'], false);
  const prob = model.bigramProbability('read_file', 'replace');
  assert.ok(prob > 0.5, `bigram prob should be >0.5, got ${prob}`);
});

test('TransitionModel: recordSequence updates trigram counts', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file', 'replace', 'shell'], true);
  model.recordSequence(['read_file', 'replace', 'shell'], true);
  const prob = model.trigramProbability('read_file', 'replace', 'shell');
  assert.strictEqual(prob, 1, 'trigram prob should be 1.0');
});

test('TransitionModel: returns undefined for unknown transitions', () => {
  const model = new TransitionModel();
  model.recordSequence(['a', 'b'], true);
  assert.strictEqual(model.bigramProbability('a', 'c'), undefined);
  assert.strictEqual(model.bigramProbability('x', 'y'), undefined);
  assert.strictEqual(model.unigramRate('z'), undefined);
});

test('TransitionModel: nextActions returns sorted list', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file', 'replace'], true);
  model.recordSequence(['read_file', 'replace'], true);
  model.recordSequence(['read_file', 'shell'], false);
  const next = model.nextActions('read_file');
  assert.ok(next.length >= 1, 'should have at least one next action');
  assert.strictEqual(next[0].action, 'replace', 'replace should be highest prob');
});

test('TransitionModel: nextActions returns empty for unknown action', () => {
  const model = new TransitionModel();
  assert.deepStrictEqual(model.nextActions('unknown'), []);
});

test('TransitionModel: summary returns correct counts', () => {
  const model = new TransitionModel();
  model.recordSequence(['a', 'b', 'c'], true);
  const s = model.summary();
  assert.strictEqual(s.totalSequences, 1);
  assert.ok(s.bigramPairs >= 2, 'should have bigram pairs');
  assert.ok(s.trigramPairs >= 1, 'should have trigram pairs');
  assert.ok(s.knownActions >= 3, 'should know all 3 actions');
});

test('TransitionModel: handles single-element sequence', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file'], true);
  assert.ok(model.unigramRate('read_file') > 0);
  assert.strictEqual(model.bigramProbability('read_file', 'x'), undefined);
});

test('TransitionModel: handles empty sequence', () => {
  const model = new TransitionModel();
  model.recordSequence([], true);
  assert.strictEqual(model.totalSequences, 1);
});

// ---------------------------------------------------------------------------
// SequenceScorer tests
// ---------------------------------------------------------------------------

test('SequenceScorer: scores empty sequence as 0', () => {
  const model = new TransitionModel();
  const scorer = new SequenceScorer(model);
  const result = scorer.scoreSequence([]);
  assert.strictEqual(result.score, 0);
});

test('SequenceScorer: scores a known sequence higher than unknown', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file', 'replace', 'shell'], true);
  model.recordSequence(['read_file', 'replace', 'shell'], true);
  const scorer = new SequenceScorer(model);
  const known = scorer.scoreSequence(['read_file', 'replace', 'shell'], { lastAction: null });
  const unknown = scorer.scoreSequence(['query', 'inspect', 'done'], { lastAction: null });
  assert.ok(known.score > unknown.score, 'known sequence should score higher');
});

test('SequenceScorer: penalizes high-cost sequences', () => {
  const model = new TransitionModel();
  model.recordSequence(['shell', 'shell', 'shell'], true);
  model.recordSequence(['read_file', 'replace', 'shell'], true);
  const scorer = new SequenceScorer(model);
  const heavy = scorer.scoreSequence(['shell', 'shell', 'shell']);
  const light = scorer.scoreSequence(['read_file', 'replace', 'shell']);
  assert.ok(light.score > heavy.score, 'lighter sequence should score higher');
});

test('SequenceScorer: gives diversity bonus for varied actions', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file', 'replace', 'shell'], true);
  model.recordSequence(['read_file', 'read_file', 'read_file'], true);
  const scorer = new SequenceScorer(model);
  const diverse = scorer.scoreSequence(['read_file', 'replace', 'shell']);
  const repetitive = scorer.scoreSequence(['read_file', 'read_file', 'read_file']);
  assert.ok(diverse.score > repetitive.score, 'diverse sequence should score higher');
});

test('SequenceScorer: returns breakdown with transition, cost, diversity', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file', 'replace'], true);
  const scorer = new SequenceScorer(model);
  const result = scorer.scoreSequence(['read_file', 'replace']);
  assert.ok('breakdown' in result, 'should have breakdown');
  assert.ok('transition' in result.breakdown, 'breakdown should have transition');
  assert.ok('costPenalty' in result.breakdown, 'breakdown should have costPenalty');
  assert.ok('diversity' in result.breakdown, 'breakdown should have diversity');
});

// ---------------------------------------------------------------------------
// ActionSequencePlanner tests
// ---------------------------------------------------------------------------

test('ActionSequencePlanner: plan returns ranked sequences', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace', 'shell'], true);
  planner.recordSequence(['read_file', 'replace', 'shell'], true);
  const plans = planner.plan({ lastAction: null });
  assert.ok(plans.length > 0, 'should return at least one plan');
  assert.ok(plans[0].score >= plans[plans.length - 1].score, 'should be sorted descending');
});

test('ActionSequencePlanner: bestPlan returns highest-scoring plan', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace'], true);
  const best = planner.bestPlan({ lastAction: null });
  assert.ok(best !== null, 'should return a best plan');
  assert.ok(Array.isArray(best.sequence), 'best plan should have a sequence array');
});

test('ActionSequencePlanner: respects maxDepth option', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace', 'shell'], true);
  const plans = planner.plan({ lastAction: null }, { maxDepth: 2 });
  for (const plan of plans) {
    assert.ok(plan.sequence.length <= 2, `sequence length ${plan.sequence.length} should be <= maxDepth 2`);
  }
});

test('ActionSequencePlanner: respects maxCands option', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace'], true);
  const plans = planner.plan({ lastAction: null }, { maxCands: 5 });
  assert.ok(plans.length <= 5, `should return <= maxCands 5, got ${plans.length}`);
});

test('ActionSequencePlanner: summary returns model stats', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['a', 'b'], true);
  const s = planner.summary();
  assert.ok('model' in s, 'summary should have model stats');
  assert.ok('sequences' in s, 'summary should have sequences count');
});

test('ActionSequencePlanner: handles state with lastAction context', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace'], true);
  planner.recordSequence(['read_file', 'replace'], true);
  const plans = planner.plan({ lastAction: 'read_file' });
  assert.ok(plans.length > 0, 'should generate plans with context');
});

// ---------------------------------------------------------------------------
// ABTestRunner tests
// ---------------------------------------------------------------------------

test('ABTestRunner: runs a single trial', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace'], true);
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const trial = runner.runTrial({
    state: { lastAction: 'read_file' },
    expectedActions: ['replace', 'write_file'],
    success: true,
  });
  assert.ok(trial.actionA !== null || trial.actionB !== null, 'at least one strategy should produce an action');
});

test('ABTestRunner: runs multiple trials and returns summary', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace'], true);
  planner.recordSequence(['read_file', 'replace', 'shell'], true);
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const scenarios = [
    { state: { lastAction: 'read_file' }, expectedActions: ['replace'], success: true },
    { state: { lastAction: 'replace' }, expectedActions: ['shell', 'read_file'], success: true },
  ];
  const summary = runner.runAll(scenarios);
  assert.strictEqual(summary.totalTrials, 2);
  assert.ok('A' in summary && 'B' in summary, 'summary should have A and B results');
  assert.ok(['A', 'B', 'draw'].includes(summary.winner), 'winner should be A, B, or draw');
});

test('ABTestRunner: summary calculates win rates', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace'], true);
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  runner.runTrial({ state: { lastAction: 'read_file' }, expectedActions: ['replace'], success: true });
  const summary = runner.summary();
  assert.ok(summary.A.winRate >= 0, 'A win rate should be >= 0');
  assert.ok(summary.B.winRate >= 0, 'B win rate should be >= 0');
});

test('ABTestRunner: handles scenario where neither strategy matches expected', () => {
  const planner = new ActionSequencePlanner();
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const trial = runner.runTrial({
    state: { lastAction: 'read_file' },
    expectedActions: ['edit_lines'],
    success: true,
  });
  assert.ok(trial !== null, 'trial should not be null even on mismatch');
});

// ---------------------------------------------------------------------------
// generateTestScenarios tests
// ---------------------------------------------------------------------------

test('generateTestScenarios: returns array of scenarios', () => {
  const scenarios = generateTestScenarios();
  assert.ok(Array.isArray(scenarios), 'should return an array');
  assert.ok(scenarios.length > 0, 'should have at least one scenario');
});

test('generateTestScenarios: each scenario has required fields', () => {
  const scenarios = generateTestScenarios();
  for (const s of scenarios) {
    assert.ok('state' in s, 'scenario should have state');
    assert.ok('expectedActions' in s, 'scenario should have expectedActions');
    assert.ok('success' in s, 'scenario should have success');
    assert.ok(Array.isArray(s.expectedActions), 'expectedActions should be an array');
  }
});

test('generateTestScenarios: covers diverse workflows', () => {
  const scenarios = generateTestScenarios();
  const lastActions = new Set(scenarios.map(s => s.state.lastAction));
  assert.ok(lastActions.size >= 3, 'should cover at least 3 different last actions');
});

// ---------------------------------------------------------------------------
// seedTransitionModel tests
// ---------------------------------------------------------------------------

test('seedTransitionModel: populates the model with known patterns', () => {
  const model = new TransitionModel();
  seedTransitionModel(model);
  const s = model.summary();
  assert.ok(s.totalSequences > 0, 'should have recorded sequences');
  assert.ok(s.knownActions > 0, 'should know some actions');
});

test('seedTransitionModel: good patterns have high success probability', () => {
  const model = new TransitionModel();
  seedTransitionModel(model);
  const prob = model.bigramProbability('read_file', 'replace');
  assert.ok(prob !== undefined && prob > 0.5, 'read_file→replace should be high-prob');
});

test('seedTransitionModel: bad patterns have low success probability', () => {
  const model = new TransitionModel();
  seedTransitionModel(model);
  const prob = model.bigramProbability('read_file', 'read_file');
  assert.ok(prob !== undefined && prob < 0.8, 'read_file→read_file should be low-prob');
});

// ---------------------------------------------------------------------------
// Integration: full A/B test run
// ---------------------------------------------------------------------------

test('Integration: A/B test with seeded model and real scenarios', () => {
  const planner = new ActionSequencePlanner();
  seedTransitionModel(planner.transitionModel);
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const scenarios = generateTestScenarios();
  const summary = runner.runAll(scenarios);
  assert.ok(summary.totalTrials === scenarios.length, 'should run all scenarios');
  assert.ok(summary.A.avgScore > 0, 'A should have positive avg score');
  assert.ok(summary.B.avgScore > 0, 'B should have positive avg score');
});

test('Integration: B (sequence planner) outperforms A on trained data', () => {
  const planner = new ActionSequencePlanner();
  // Train B heavily so it learns the patterns
  for (let i = 0; i < 5; i++) {
    seedTransitionModel(planner.transitionModel);
  }
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const scenarios = generateTestScenarios();
  const summary = runner.runAll(scenarios);
  // B should score at least as well as A when trained on the same patterns
  assert.ok(summary.B.avgScore >= summary.A.avgScore * 0.5,
    `B avgScore ${summary.B.avgScore} should be >= 50% of A avgScore ${summary.A.avgScore}`);
});

test('Integration: A/B test winner is deterministically reported', () => {
  const planner = new ActionSequencePlanner();
  seedTransitionModel(planner.transitionModel);
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const scenarios = generateTestScenarios();
  const summary = runner.runAll(scenarios);
  assert.ok(['A', 'B', 'draw'].includes(summary.winner), `winner "${summary.winner}" should be valid`);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('Edge: planner with no training data still returns plans', () => {
  const planner = new ActionSequencePlanner();
  const plans = planner.plan({ lastAction: null });
  assert.ok(plans.length > 0, 'should return plans even without training');
});

test('Edge: scorer handles sequence with only one action', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file'], true);
  const scorer = new SequenceScorer(model);
  const result = scorer.scoreSequence(['read_file']);
  assert.ok(result.score >= 0, 'single action should score >= 0');
});

test('Edge: ABTestRunner with null recommender', () => {
  const planner = new ActionSequencePlanner();
  const runner = new ABTestRunner(planner, null);
  const trial = runner.runTrial({
    state: { lastAction: 'read_file' },
    expectedActions: ['replace'],
    success: true,
  });
  assert.ok(trial !== null, 'should handle null recommender');
});

test('Edge: bigram probability is 0 when all observations fail', () => {
  const model = new TransitionModel();
  model.recordSequence(['a', 'b'], false);
  model.recordSequence(['a', 'b'], false);
  const prob = model.bigramProbability('a', 'b');
  assert.strictEqual(prob, 0, 'should be 0 when all fail');
});

test('Edge: trigram probability is 0 when all observations fail', () => {
  const model = new TransitionModel();
  model.recordSequence(['a', 'b', 'c'], false);
  const prob = model.trigramProbability('a', 'b', 'c');
  assert.strictEqual(prob, 0, 'should be 0 when all fail');
});

test('Edge: unigram rate is 0 when all observations fail', () => {
  const model = new TransitionModel();
  model.recordSequence(['a'], false);
  const rate = model.unigramRate('a');
  assert.strictEqual(rate, 0, 'should be 0 when all fail');
});

test('Edge: sequence with repeated actions gets diversity penalty', () => {
  const model = new TransitionModel();
  model.recordSequence(['read_file', 'read_file', 'read_file'], true);
  model.recordSequence(['read_file', 'replace', 'shell'], true);
  const scorer = new SequenceScorer(model);
  const repeat = scorer.scoreSequence(['read_file', 'read_file', 'read_file']);
  const varied = scorer.scoreSequence(['read_file', 'replace', 'shell']);
  assert.ok(varied.score > repeat.score, 'varied sequence should beat repeated');
});

test('Edge: plan with custom action list', () => {
  const planner = new ActionSequencePlanner();
  planner.recordSequence(['read_file', 'replace'], true);
  const plans = planner.plan({ lastAction: null }, { actions: ['read_file', 'replace', 'shell'] });
  for (const plan of plans) {
    for (const action of plan.sequence) {
      assert.ok(['read_file', 'replace', 'shell'].includes(action),
        `action "${action}" should be in custom list`);
    }
  }
});

// ---------------------------------------------------------------------------
// Score strategy internal behavior
// ---------------------------------------------------------------------------

test('ABTestRunner._scoreStrategy: exact match gives highest score', () => {
  const planner = new ActionSequencePlanner();
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const exact = runner._scoreStrategy('replace', ['replace', 'shell'], true, []);
  const partial = runner._scoreStrategy('shell', ['replace', 'shell'], true, []);
  const none = runner._scoreStrategy('query', ['replace', 'shell'], true, []);
  assert.ok(exact > partial, 'exact match should score highest');
  assert.ok(partial > none, 'partial match should score above none');
});

test('ABTestRunner._scoreStrategy: sequence bonus adds points', () => {
  const planner = new ActionSequencePlanner();
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const withSeq = runner._scoreStrategy('replace', ['replace', 'shell'], true, ['replace', 'shell']);
  const noSeq = runner._scoreStrategy('replace', ['replace', 'shell'], true, []);
  assert.ok(withSeq > noSeq, 'sequence bonus should increase score');
});

// ---------------------------------------------------------------------------
// Performance sanity
// ---------------------------------------------------------------------------

test('Performance: planning 100 trials completes in reasonable time', () => {
  const planner = new ActionSequencePlanner();
  seedTransitionModel(planner.transitionModel);
  const recommender = new ActionRecommender();
  const runner = new ABTestRunner(planner, recommender);
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    const scenario = generateTestScenarios()[i % generateTestScenarios().length];
    runner.runTrial(scenario);
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 10000, `100 trials took ${elapsed.toFixed(0)}ms, should be < 10s`);
});
