// Action Sequence Planner
//
// Plans multi-step action sequences instead of picking one action at a time.
// Uses n-gram transition probabilities from historical data and lookahead
// scoring to evaluate whether a sequence of actions is likely to succeed.
//
// Usage:
//   const planner = new ActionSequencePlanner();
//   planner.recordSequence(['read_file', 'replace', 'shell'], true);
//   const plan = planner.plan(state, maxDepth = 3);

// ---------------------------------------------------------------------------
// 1.  TRANSITION MODEL — n-gram probabilities
// ---------------------------------------------------------------------------

/**
 * A simple n-gram transition model that learns which action sequences
 * lead to success vs. failure. Supports unigram, bigram, and trigram.
 */
export class TransitionModel {
  constructor() {
    // bigram counts: { from: { to: { success: N, fail: N } } }
    this.bigrams = new Map();
    // trigram counts: { from-to: { to: { success: N, fail: N } } }
    this.trigrams = new Map();
    // unigram success rates: { action: { success: N, fail: N } }
    this.unigrams = new Map();
    this.totalSequences = 0;
  }

  /**
   * Record an observed action sequence and whether it succeeded.
   * @param {string[]} sequence - ordered list of action names
   * @param {boolean} success - did the sequence achieve its goal?
   */
  recordSequence(sequence, success) {
    this.totalSequences++;

    // Update unigrams
    for (const action of sequence) {
      if (!this.unigrams.has(action)) this.unigrams.set(action, { success: 0, fail: 0 });
      const u = this.unigrams.get(action);
      if (success) u.success++; else u.fail++;
    }

    // Update bigrams
    for (let i = 0; i < sequence.length - 1; i++) {
      const [a, b] = [sequence[i], sequence[i + 1]];
      if (!this.bigrams.has(a)) this.bigrams.set(a, new Map());
      const bigram = this.bigrams.get(a);
      if (!bigram.has(b)) bigram.set(b, { success: 0, fail: 0 });
      const entry = bigram.get(b);
      if (success) entry.success++; else entry.fail++;
    }

    // Update trigrams
    for (let i = 0; i < sequence.length - 2; i++) {
      const [a, b, c] = [sequence[i], sequence[i + 1], sequence[i + 2]];
      const key = `${a}→${b}`;
      if (!this.trigrams.has(key)) this.trigrams.set(key, new Map());
      const trigram = this.trigrams.get(key);
      if (!trigram.has(c)) trigram.set(c, { success: 0, fail: 0 });
      const entry = trigram.get(c);
      if (success) entry.success++; else entry.fail++;
    }
  }

  /**
   * Get the probability that action B follows action A successfully.
   * Returns a value in [0, 1]. Returns undefined if no data.
   */
  bigramProbability(from, to) {
    const bigram = this.bigrams.get(from);
    if (!bigram) return undefined;
    const entry = bigram.get(to);
    if (!entry) return undefined;
    const total = entry.success + entry.fail;
    return total > 0 ? entry.success / total : undefined;
  }

  /**
   * Get the probability that action C follows A→B successfully.
   */
  trigramProbability(from, mid, to) {
    const key = `${from}→${mid}`;
    const trigram = this.trigrams.get(key);
    if (!trigram) return undefined;
    const entry = trigram.get(to);
    if (!entry) return undefined;
    const total = entry.success + entry.fail;
    return total > 0 ? entry.success / total : undefined;
  }

  /**
   * Get unigram success rate for an action.
   */
  unigramRate(action) {
    const u = this.unigrams.get(action);
    if (!u) return undefined;
    const total = u.success + u.fail;
    return total > 0 ? u.success / total : undefined;
  }

  /**
   * Get all possible next actions from a given action, sorted by probability.
   */
  nextActions(from) {
    const bigram = this.bigrams.get(from);
    if (!bigram) return [];
    return [...bigram.entries()]
      .map(([action, counts]) => {
        const total = counts.success + counts.fail;
        return { action, prob: total > 0 ? counts.success / total : 0, total };
      })
      .filter((x) => x.prob > 0.3) // filter out noisy transitions
      .sort((a, b) => b.prob - a.prob);
  }

  summary() {
    return {
      totalSequences: this.totalSequences,
      bigramPairs: [...this.bigrams.entries()].reduce((n, [, v]) => n + v.size, 0),
      trigramPairs: [...this.trigrams.entries()].reduce((n, [, v]) => n + v.size, 0),
      knownActions: this.unigrams.size,
    };
  }
}

// ---------------------------------------------------------------------------
// 2.  SEQUENCE SCORER — evaluate a candidate sequence
// ---------------------------------------------------------------------------

/**
 * Score a candidate action sequence using transition probabilities
 * and a cost model.
 */
export class SequenceScorer {
  constructor(transitionModel, costModel = null) {
    this.model = transitionModel;
    this.costModel = costModel;
    // Default costs when no cost model is available
    this.defaultCosts = {
      read_file: 1, list_dir: 0.5, search: 2, inspect: 2,
      replace: 1, write_file: 1, shell: 3, query: 0.5,
      done: 0.1, respond: 0.1, patch: 1, edit_lines: 1,
    };
  }

  /**
   * Score a sequence of actions.
   * Higher is better. Considers transition probability, cost, and diversity.
   */
  scoreSequence(sequence, context = {}) {
    if (sequence.length === 0) return { score: 0, breakdown: {} };

    let transitionScore = 0;
    let costPenalty = 0;
    let diversityBonus = 0;
    let details = [];

    // 1. Transition probability chain
    const prevAction = context.lastAction || null;
    const prevPrevAction = context.lastLastAction || null;

    for (let i = 0; i < sequence.length; i++) {
      const action = sequence[i];
      let prob = null;
      let source = null;

      // Try trigram first (most specific)
      if (i === 0 && prevAction && prevPrevAction) {
        prob = this.model.trigramProbability(prevPrevAction, prevAction, action);
        source = 'trigram';
      }
      // Then bigram
      if (prob === null) {
        const from = i === 0 ? prevAction : sequence[i - 1];
        if (from) {
          prob = this.model.bigramProbability(from, action);
          source = 'bigram';
        }
      }
      // Fall back to unigram
      if (prob === null) {
        prob = this.model.unigramRate(action);
        source = 'unigram';
      }

      if (prob !== null && prob > 0) {
        // Log-scale contribution: high prob = big bonus, low prob = penalty
        const logProb = Math.log2(Math.max(prob, 0.01));
        transitionScore += logProb * 2; // scale factor
        details.push({ step: i, action, prob: +prob.toFixed(3), source, score: +logProb.toFixed(2) });
      } else {
        // No data — small penalty for unknown actions
        transitionScore -= 0.5;
        details.push({ step: i, action, prob: null, source: 'none', score: -0.5 });
      }
    }

    // 2. Cost penalty — longer sequences cost more
    for (const action of sequence) {
      const cost = this.costModel
        ? this.costModel(action)
        : (this.defaultCosts[action] || 1);
      costPenalty += cost * 0.15;
    }

    // 3. Diversity bonus — prefer sequences that explore different action types
    const uniqueActions = new Set(sequence);
    diversityBonus = uniqueActions.size * 0.3;

    // 4. Length bonus — prefer sequences of 2-4 actions
    const len = sequence.length;
    const lengthBonus = len >= 2 && len <= 4 ? 0.5 : (len > 4 ? -0.5 : 0);

    // 5. Phase-transition bonus — reward discovery→write transitions
    if (len >= 2) {
      const phaseNames = {
        read_file: 'discovery', list_dir: 'discovery', search: 'discovery',
        inspect: 'discovery', query: 'discovery',
        replace: 'write', write_file: 'write', shell: 'write', patch: 'write',
        done: 'done', respond: 'done',
      };
      let phaseTransitions = 0;
      for (let i = 1; i < len; i++) {
        const prevPhase = phaseNames[sequence[i - 1]] || 'unknown';
        const currPhase = phaseNames[sequence[i]] || 'unknown';
        if (prevPhase === 'discovery' && currPhase === 'write') {
          phaseTransitions++;
        }
      }
      transitionScore += phaseTransitions * 0.5;
    }

    const total = transitionScore + diversityBonus + lengthBonus - costPenalty;
    return {
      score: +total.toFixed(2),
      breakdown: {
        transition: +transitionScore.toFixed(2),
        costPenalty: +costPenalty.toFixed(2),
        diversity: +diversityBonus.toFixed(2),
        lengthBonus: +lengthBonus.toFixed(2),
      },
      details,
    };
  }
}

// ---------------------------------------------------------------------------
// 3.  SEQUENCE PLANNER — generate and rank candidate sequences
// ---------------------------------------------------------------------------

const DEFAULT_ACTIONS = [
  'read_file', 'list_dir', 'search', 'inspect',
  'replace', 'write_file', 'shell', 'query',
  'done', 'respond', 'patch', 'edit_lines',
];

export class ActionSequencePlanner {
  constructor() {
    this.transitionModel = new TransitionModel();
    this.scorer = new SequenceScorer(this.transitionModel);
    this.maxDepth = 3;
    this.maxCandidates = 20;
    this.sequences = [];
  }

  /**
   * Record an observed sequence of actions and its outcome.
   */
  recordSequence(sequence, success) {
    this.transitionModel.recordSequence(sequence, success);
    this.sequences.push({ sequence, success, ts: Date.now() });
  }

  /**
   * Generate candidate sequences using a beam-search-like approach.
   * Returns ranked sequences with scores.
   */
  plan(state = {}, options = {}) {
    const maxDepth = options.maxDepth ?? this.maxDepth;
    const maxCands = options.maxCands ?? this.maxCandidates;
    const actions = options.actions ?? DEFAULT_ACTIONS;
    const context = {
      lastAction: state.lastAction || null,
      lastLastAction: state.lastLastAction || null,
    };

    // Generate candidate sequences via breadth-first expansion
    const candidates = this._generateCandidates(actions, maxDepth, maxCands, context);

    // Score each candidate
    const scored = candidates.map((seq) => {
      const result = this.scorer.scoreSequence(seq, context);
      return { sequence: seq, ...result };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }

  /**
   * Get the best single plan.
   */
  bestPlan(state = {}) {
    const plans = this.plan(state);
    return plans.length > 0 ? plans[0] : null;
  }

  /**
   * Generate candidate sequences using beam search with pruning.
   */
  _generateCandidates(actions, maxDepth, maxCands, context) {
    // Start with partial sequences (just the first action)
    let beams = actions.map((a) => [a]);

    // Expand beams up to maxDepth
    for (let depth = 1; depth < maxDepth; depth++) {
      const expanded = [];
      for (const partial of beams) {
        const last = partial[partial.length - 1];
        // Get likely next actions from transition model
        const nextActions = this.transitionModel.nextActions(last);

        if (nextActions.length > 0) {
          // Use model-suggested next actions
          for (const { action } of nextActions.slice(0, 3)) {
            expanded.push([...partial, action]);
          }
        } else {
          // No data — use all actions (with some pruning)
          for (const a of actions) {
            if (a !== last) { // don't repeat same action
              expanded.push([...partial, a]);
            }
          }
        }
      }

      // Score partial sequences to prune
      const scored = expanded.map((seq) => {
        const result = this.scorer.scoreSequence(seq, context);
        return { seq, score: result.score };
      });

      scored.sort((a, b) => b.score - a.score);
      beams = scored.slice(0, maxCands).map((x) => x.seq);
    }

    return beams;
  }

  /**
   * Summary of the planner's state.
   */
  summary() {
    return {
      model: this.transitionModel.summary(),
      sequences: this.sequences.length,
      maxDepth: this.maxDepth,
      maxCandidates: this.maxCandidates,
    };
  }
}

// ---------------------------------------------------------------------------
// 4.  A/B TEST FRAMEWORK
// ---------------------------------------------------------------------------

/**
 * Runs an A/B comparison between two strategies:
 *   A = single-action recommender (current behavior)
 *   B = sequence-based planner (new behavior)
 *
 * Simulates turns using a replay of historical data or synthetic scenarios.
 */
export class ABTestRunner {
  constructor(planner, recommender = null) {
    this.planner = planner;
    this.recommender = recommender;
    this.results = { A: { wins: 0, losses: 0, draws: 0, totalScore: 0 }, B: { wins: 0, losses: 0, draws: 0, totalScore: 0 } };
    this.trials = [];
  }

  /**
   * Run a single A/B trial against a scenario.
   * A scenario is { state, expectedActions: [...], success: boolean }.
   */
  runTrial(scenario) {
    const { state, expectedActions, success } = scenario;

    // Strategy A: single-action recommender
    let actionA = null;
    if (this.recommender) {
      const best = this.recommender.best(state);
      actionA = best ? best.action : null;
    } else {
      // Fallback: just pick the first expected action
      actionA = expectedActions[0] || null;
    }

    // Strategy B: sequence planner
    const planB = this.planner.bestPlan(state);
    const actionB = planB ? planB.sequence[0] : null;
    const fullSequenceB = planB ? planB.sequence : [];

    // Score both strategies
    const scoreA = this._scoreStrategy(actionA, expectedActions, success);
    const scoreB = this._scoreStrategy(actionB, expectedActions, success, fullSequenceB);

    const trial = {
      scenario: state.lastAction ? `after:${state.lastAction}` : 'initial',
      actionA,
      actionB,
      sequenceB: fullSequenceB,
      scoreA: +scoreA.toFixed(2),
      scoreB: +scoreB.toFixed(2),
      winner: scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : 'draw',
    };

    this.trials.push(trial);

    // Update aggregate results
    if (scoreA > scoreB) this.results.A.wins++;
    else if (scoreB > scoreA) this.results.B.wins++;
    else this.results.A.draws++, this.results.B.draws++;

    this.results.A.totalScore += scoreA;
    this.results.B.totalScore += scoreB;

    return trial;
  }

  /**
   * Score a strategy's choice against the expected outcome.
   */
  _scoreStrategy(chosen, expectedActions, success, fullSequence = []) {
    let score = 0;

    // Did the chosen action match the expected first action?
    if (chosen === expectedActions[0]) {
      score += 3;
    }

    // Did the chosen action appear anywhere in the expected sequence?
    if (expectedActions.includes(chosen)) {
      score += 1;
    }

    // Sequence bonus: does the full plan align with expected actions?
    if (fullSequence.length > 0) {
      const matches = fullSequence.filter((a) => expectedActions.includes(a));
      score += matches.length * 0.5;
    }

    // Success bonus
    if (success) score += 1;

    return score;
  }

  /**
   * Run all trials and return summary.
   */
  runAll(scenarios) {
    for (const scenario of scenarios) {
      this.runTrial(scenario);
    }
    return this.summary();
  }

  summary() {
    const total = this.trials.length;
    const aWinRate = total > 0 ? (this.results.A.wins / total * 100).toFixed(1) : 0;
    const bWinRate = total > 0 ? (this.results.B.wins / total * 100).toFixed(1) : 0;
    const drawRate = total > 0 ? (this.results.A.draws / total * 100).toFixed(1) : 0;

    return {
      totalTrials: total,
      A: {
        wins: this.results.A.wins,
        winRate: aWinRate,
        avgScore: total > 0 ? +(this.results.A.totalScore / total).toFixed(2) : 0,
      },
      B: {
        wins: this.results.B.wins,
        winRate: bWinRate,
        avgScore: total > 0 ? +(this.results.B.totalScore / total).toFixed(2) : 0,
      },
      drawRate: drawRate,
      winner: this.results.B.wins > this.results.A.wins ? 'B' : this.results.A.wins > this.results.B.wins ? 'A' : 'draw',
    };
  }
}

// ---------------------------------------------------------------------------
// 5.  SYNTHETIC SCENARIO GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate realistic test scenarios for A/B testing.
 * These represent common coding workflows.
 */
export function generateTestScenarios() {
  return [
    // Scenario: reading a file then editing it
    {
      state: { lastAction: 'read_file', lastActionFile: 'src/foo.js' },
      expectedActions: ['replace', 'write_file', 'patch'],
      success: true,
    },
    // Scenario: after listing directory
    {
      state: { lastAction: 'list_dir' },
      expectedActions: ['read_file', 'inspect', 'search'],
      success: true,
    },
    // Scenario: after a failed action
    {
      state: { lastAction: 'replace', lastFailed: true },
      expectedActions: ['read_file', 'search', 'inspect'],
      success: true,
    },
    // Scenario: after shell command
    {
      state: { lastAction: 'shell' },
      expectedActions: ['read_file', 'search', 'inspect'],
      success: true,
    },
    // Scenario: initial state (no prior action)
    {
      state: {},
      expectedActions: ['read_file', 'list_dir', 'inspect', 'query'],
      success: true,
    },
    // Scenario: after reading then searching
    {
      state: { lastAction: 'search', lastLastAction: 'read_file' },
      expectedActions: ['replace', 'write_file', 'read_file'],
      success: true,
    },
    // Scenario: budget-constrained
    {
      state: { lastAction: 'read_file', budgetUsed: 6000, budgetRemaining: 2000 },
      expectedActions: ['query', 'list_dir', 'replace'],
      success: true,
    },
    // Scenario: structure question
    {
      state: { lastAction: 'read_file', hint: 'structure' },
      expectedActions: ['query', 'search', 'inspect'],
      success: true,
    },
    // Scenario: after inspect
    {
      state: { lastAction: 'inspect' },
      expectedActions: ['read_file', 'replace', 'search'],
      success: true,
    },
    // Scenario: after write_file
    {
      state: { lastAction: 'write_file' },
      expectedActions: ['shell', 'read_file', 'done'],
      success: true,
    },
    // Scenario: debugging workflow
    {
      state: { lastAction: 'shell', lastFailed: true, hint: 'debug' },
      expectedActions: ['read_file', 'search', 'inspect'],
      success: true,
    },
    // Scenario: after query
    {
      state: { lastAction: 'query' },
      expectedActions: ['read_file', 'search', 'inspect'],
      success: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// 6.  TRAINING HELPER — seed the model with known-good patterns
// ---------------------------------------------------------------------------

/**
 * Seed the transition model with known-good action sequences
 * derived from common coding workflows.
 */
export function seedTransitionModel(model) {
  // Common successful workflows
  const workflows = [
    // Read → edit → verify
    ['read_file', 'replace', 'shell'],
    ['read_file', 'write_file', 'shell'],
    ['read_file', 'patch', 'shell'],

    // Explore → read → edit
    ['list_dir', 'read_file', 'replace'],
    ['list_dir', 'inspect', 'read_file'],
    ['list_dir', 'search', 'read_file'],

    // Debug: shell → read → fix
    ['shell', 'read_file', 'replace'],
    ['shell', 'search', 'read_file'],

    // Query → read → act
    ['query', 'read_file', 'replace'],
    ['query', 'search', 'read_file'],

    // Search → read → edit
    ['search', 'read_file', 'replace'],
    ['search', 'inspect', 'read_file'],

    // Inspect → read → edit
    ['inspect', 'read_file', 'replace'],
    ['inspect', 'search', 'read_file'],

    // Initial exploration
    ['list_dir', 'read_file', 'inspect'],
    ['read_file', 'search', 'replace'],
  ];

  for (const workflow of workflows) {
    model.recordSequence(workflow, true);
  }

  // Some known-bad patterns
  const badPatterns = [
    ['read_file', 'read_file', 'read_file'],
    ['shell', 'shell', 'shell'],
    ['list_dir', 'list_dir', 'read_file'],
    ['search', 'search', 'search'],
  ];

  for (const pattern of badPatterns) {
    model.recordSequence(pattern, false);
  }
}
