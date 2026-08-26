// Action Sequence Integration
//
// Wires the ActionSequencePlanner into the main decision pipeline alongside
// the ActionRecommender. The planner is used when it has been trained (seeded)
// and produces a plan whose first action beats the recommender's best.
//
// Usage:
//   import { createIntegratedPlanner } from './action-sequence-integration.js';
//   const planner = createIntegratedPlanner();
//   const decision = planner.decide(state);

import { ActionRecommender } from './action-recommender.js';
import {
  ActionSequencePlanner,
  TransitionModel,
  SequenceScorer,
  seedTransitionModel,
  generateTestScenarios,
  ABTestRunner,
} from './action-sequence.js';

const EDIT_ACTIONS = new Set([
  'replace', 'write_file', 'write_batch', 'patch', 'edit_lines', 'delete_file', 'move_file',
]);

/**
 * Return the protocol verb for an executed action. Keeping this normalization
 * at the integration boundary prevents action objects from leaking into
 * transition-model state, whose keys and comparisons are strings.
 */
export function actionName(action) {
  if (typeof action === 'string') return action || null;
  return typeof action?.a === 'string' && action.a ? action.a : null;
}

/**
 * Extract an evidence-backed outcome for a completed action/sequence.
 *
 * A normal, unblocked observation is deliberately inconclusive. Positive
 * outcomes require a test/verifier verdict; explicit infrastructure blocks and
 * rejected edits are meaningful failures. The return value includes the
 * evidence source so callers can audit why online learning occurred.
 */
export function completedActionOutcome({ action, turn, result, parsed } = {}) {
  const trustedVerdicts = [
    ['scoped_verify', result?.scopedVerify?.verdict],
    ['environment_verify', result?.environmentVerification?.verdict],
  ];
  for (const [evidence, verdict] of trustedVerdicts) {
    if (verdict === 'pass') return { success: true, evidence };
    if (verdict === 'fail') return { success: false, evidence };
  }

  const tests = parsed?.data?.tests ?? parsed?.extracted?.tests;
  const passed = Number(tests?.passed);
  const failed = Number(tests?.failed);
  if (Number.isFinite(failed) && failed > 0) {
    return { success: false, evidence: 'test_output' };
  }
  if (Number.isFinite(passed) && passed > 0 && (!Number.isFinite(failed) || failed === 0)) {
    return { success: true, evidence: 'test_output' };
  }

  if (result?.blocked) return { success: false, evidence: 'infrastructure_block' };

  const name = actionName(action ?? turn?.action);
  if (name && EDIT_ACTIONS.has(name) && turn?.editApplied === false) {
    return { success: false, evidence: 'edit_rejected' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1.  INTEGRATED DECIDER — chooses between recommender and sequence planner
// ---------------------------------------------------------------------------

/**
 * Unified decision interface that delegates to either the single-action
 * recommender or the sequence planner based on configuration and training.
 */
export class IntegratedDecider {
  constructor(options = {}) {
    this.recommender = new ActionRecommender();
    this.planner = new ActionSequencePlanner();

    // Strategy mode: 'recommender' | 'planner' | 'adaptive'
    this.mode = options.mode ?? 'adaptive';

    // Threshold: planner must score at least this much higher to override recommender
    this.overrideThreshold = options.overrideThreshold ?? 0.5;

    // Whether the planner has been seeded with training data
    this.seeded = false;

    // Attach efficiency/decision-tree/budget if provided
    if (options.efficiency) this.recommender.registerEfficiency(options.efficiency);
    if (options.decisionTree) this.recommender.registerDecisionTree(options.decisionTree);
    if (options.budget) this.recommender.registerBudget(options.budget);

    // Track which strategy wins for adaptive mode
    this.stats = {
      recommenderWins: 0,
      plannerWins: 0,
      totalDecisions: 0,
    };
  }

  /**
   * Seed the transition model with historical patterns.
   * Call this once at startup or when new data is available.
   */
  seed() {
    seedTransitionModel(this.planner.transitionModel);
    this.seeded = true;
  }

  /**
   * Make a decision for the current turn.
   * Returns { action, strategy, score, plan? } where strategy is 'recommender' or 'planner'.
   */
  decide(state) {
    this.stats.totalDecisions++;

    if (this.mode === 'recommender') {
      const best = this.recommender.best(state);
      return best
        ? { action: best.action, strategy: 'recommender', score: best.score }
        : { action: 'read_file', strategy: 'recommender', score: 0 };
    }

    if (this.mode === 'planner') {
      const plan = this.planner.bestPlan(state);
      if (plan && plan.sequence && plan.sequence.length > 0) {
        this.stats.plannerWins++;
        return {
          action: plan.sequence[0],
          strategy: 'planner',
          score: plan.score,
          plan: plan.sequence,
        };
      }
      // Fallback to recommender if planner produces no plan
      const best = this.recommender.best(state);
      return best
        ? { action: best.action, strategy: 'recommender', score: best.score }
        : { action: 'read_file', strategy: 'recommender', score: 0 };
    }

    // Adaptive mode: use planner if seeded and it scores higher
    if (this.seeded) {
      const plan = this.planner.bestPlan(state);
      const best = this.recommender.best(state);

      const planScore = plan ? plan.score : 0;
      const recScore = best ? best.score : 0;

      if (plan && plan.sequence && plan.sequence.length > 0 && planScore > recScore + this.overrideThreshold) {
        this.stats.plannerWins++;
        return {
          action: plan.sequence[0],
          strategy: 'planner',
          score: planScore,
          plan: plan.sequence,
        };
      }
    }

    // Default to recommender
    this.stats.recommenderWins++;
    const best = this.recommender.best(state);
    return best
      ? { action: best.action, strategy: 'recommender', score: best.score }
      : { action: 'read_file', strategy: 'recommender', score: 0 };
  }

  /**
   * Record an observed sequence outcome for online learning.
   */
  recordOutcome(sequence, success) {
    this.planner.recordSequence(sequence, success);
  }

  /**
   * Summary of current state.
   */
  summary() {
    return {
      mode: this.mode,
      seeded: this.seeded,
      stats: this.stats,
      recommender: this.recommender.summary(),
      planner: this.planner.summary(),
    };
  }
}

// ---------------------------------------------------------------------------
// 2.  A/B EVALUATOR — run the integration against test scenarios
// ---------------------------------------------------------------------------

/**
 * Run an A/B evaluation comparing the integrated decider in different modes.
 * Returns a comparison object with win rates and scores.
 */
export function runABEvaluation() {
  const scenarios = generateTestScenarios();

  // Mode A: recommender-only
  const deciderA = new IntegratedDecider({ mode: 'recommender' });

  // Mode B: planner-only (seeded)
  const deciderB = new IntegratedDecider({ mode: 'planner' });
  deciderB.seed();

  // Mode C: adaptive (seeded)
  const deciderC = new IntegratedDecider({ mode: 'adaptive' });
  deciderC.seed();

  const results = { A: { wins: 0, totalScore: 0, actions: [] }, B: { wins: 0, totalScore: 0, actions: [] }, C: { wins: 0, totalScore: 0, actions: [] } };

  for (const scenario of scenarios) {
    const { state, expectedActions, success } = scenario;

    // Score each mode's decision
    const decisionA = deciderA.decide(state);
    const decisionB = deciderB.decide(state);
    const decisionC = deciderC.decide(state);

    // Score function: match to expected actions
    const scoreA = _scoreDecision(decisionA, expectedActions, success);
    const scoreB = _scoreDecision(decisionB, expectedActions, success);
    const scoreC = _scoreDecision(decisionC, expectedActions, success);

    results.A.totalScore += scoreA;
    results.B.totalScore += scoreB;
    results.C.totalScore += scoreC;
    results.A.actions.push(decisionA.action);
    results.B.actions.push(decisionB.action);
    results.C.actions.push(decisionC.action);

    // Track wins (highest score wins each scenario)
    const maxScore = Math.max(scoreA, scoreB, scoreC);
    if (scoreA === maxScore) results.A.wins++;
    if (scoreB === maxScore) results.B.wins++;
    if (scoreC === maxScore) results.C.wins++;
  }

  const total = scenarios.length;
  return {
    totalScenarios: total,
    A: {
      mode: 'recommender',
      wins: results.A.wins,
      winRate: total > 0 ? +(results.A.wins / total * 100).toFixed(1) : 0,
      avgScore: total > 0 ? +(results.A.totalScore / total).toFixed(2) : 0,
    },
    B: {
      mode: 'planner',
      wins: results.B.wins,
      winRate: total > 0 ? +(results.B.wins / total * 100).toFixed(1) : 0,
      avgScore: total > 0 ? +(results.B.totalScore / total).toFixed(2) : 0,
    },
    C: {
      mode: 'adaptive',
      wins: results.C.wins,
      winRate: total > 0 ? +(results.C.wins / total * 100).toFixed(1) : 0,
      avgScore: total > 0 ? +(results.C.totalScore / total).toFixed(2) : 0,
    },
    winner: _pickWinner(results, total),
  };
}

function _scoreDecision(decision, expectedActions, success) {
  let score = 0;
  if (decision.action === expectedActions[0]) score += 3;
  if (expectedActions.includes(decision.action)) score += 1;
  if (decision.plan) {
    const matches = decision.plan.filter((a) => expectedActions.includes(a));
    score += matches.length * 0.5;
  }
  if (success) score += 1;
  return score;
}

function _pickWinner(results, total) {
  const aRate = results.A.wins / total;
  const bRate = results.B.wins / total;
  const cRate = results.C.wins / total;
  const maxRate = Math.max(aRate, bRate, cRate);
  if (cRate === maxRate) return 'C';
  if (bRate === maxRate) return 'B';
  return 'A';
}

// ---------------------------------------------------------------------------
// 3.  FACTORY
// ---------------------------------------------------------------------------

/**
 * Create an integrated decider, optionally seeded and in the given mode.
 */
export function createIntegratedPlanner(options = {}) {
  const decider = new IntegratedDecider(options);
  if (options.autoSeed !== false) {
    decider.seed();
  }
  return decider;
}

export default IntegratedDecider;
