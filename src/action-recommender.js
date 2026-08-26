// Action Recommender
//
// Combines cost estimates, efficiency history, decision-tree paths, and context
// budget to score and rank candidate actions for the next turn.
//
// Usage:
//   const rec = new ActionRecommender();
//   rec.registerEfficiency(efficiencyTracker);
//   rec.registerDecisionTree(decisionTree);
//   rec.registerBudget(contextBudget);
//   const ranked = rec.recommend(state);

import { estimateCost } from "./action-cost-model.js";

// ---------------------------------------------------------------------------
// 1.  HEURISTIC RULES — context-aware scoring bonuses / penalties
// ---------------------------------------------------------------------------

/**
 * Each rule returns a score delta (positive = prefer, negative = avoid).
 * Rules run in order; their deltas accumulate on each candidate action.
 */
const RULES = [
  // After a failed action, prefer re-reading or searching before editing again.
  {
    name: "post-failure-recon",
    when: (state) => state.lastAction && state.lastFailed,
    score: (action) => {
      if (action === "read_file" || action === "search" || action === "inspect") return 3;
      if (action === "replace" || action === "write_file") return -2;
      return 0;
    },
  },
  // When budget is tight (< 25% remaining), prefer cheap actions.
  {
    name: "budget-conscious",
    when: (state) => state.budgetRemaining !== undefined && state.budgetUsed !== undefined,
    score: (action, state) => {
      const ratio = state.budgetUsed / (state.budgetUsed + state.budgetRemaining);
      if (ratio >= 0.75) {
        if (action === "shell") return -3;
        if (action === "inspect") return -1;
        if (action === "query" || action === "list_dir") return 2;
      }
      return 0;
    },
  },
  // After listing a directory, next action should read or search inside it.
  {
    name: "post-listdir-explore",
    when: (state) => state.lastAction === "list_dir",
    score: (action) => {
      if (action === "read_file" || action === "search" || action === "inspect") return 2;
      if (action === "list_dir") return -3; // redundant
      return 0;
    },
  },
  // After reading a file, prefer editing, writing, or another targeted read.
  {
    name: "post-read-act",
    when: (state) => state.lastAction === "read_file",
    score: (action) => {
      if (action === "replace" || action === "write_file" || action === "edit_lines") return 2;
      if (action === "read_file") return -1; // avoid re-reading the same file
      return 0;
    },
  },
  // After a shell command, check output or proceed.
  {
    name: "post-shell-verify",
    when: (state) => state.lastAction === "shell",
    score: (action) => {
      if (action === "read_file" || action === "search") return 1;
      if (action === "shell") return -2; // avoid chaining shells without inspection
      return 0;
    },
  },
  // Avoid repeating the same action twice in a row (unless it makes sense).
  {
    name: "avoid-repeat",
    when: (state) => state.lastAction,
    score: (action, state) => {
      if (action === state.lastAction) return -2;
      return 0;
    },
  },

  // Prefer query over read_file/search when the question is about code structure.
  {
    name: "prefer-query-for-structure",
    when: (state) => state.hint === "structure" || state.hint === "symbols",
    score: (action) => {
      if (action === "query") return 3;
      return 0;
    },
  },
];

// ---------------------------------------------------------------------------
// 2.  COST WEIGHTS
// ---------------------------------------------------------------------------

const WEIGHTS = {
  latency: 0.3,
  io: 0.4,
  cpu: 0.3,
};

// ---------------------------------------------------------------------------
// 3.  RECOMMENDER CLASS
// ---------------------------------------------------------------------------

export class ActionRecommender {
  constructor() {
    this.efficiency = null;
    this.decisionTree = null;
    this.budget = null;
    this.fileStats = new Map();
  }

  /** Attach the efficiency tracker (ActionEfficiency instance). */
  registerEfficiency(efficiency) {
    this.efficiency = efficiency;
  }

  /** Attach the decision tree (ActionDecisionTree instance). */
  registerDecisionTree(decisionTree) {
    this.decisionTree = decisionTree;
  }

  /** Attach the context budget (ContextBudget instance). */
  registerBudget(budget) {
    this.budget = budget;
  }

  /**
   * Update file size cache for cost estimation.
   * Call this periodically or when files change.
   */
  updateFileStats(fileStats) {
    this.fileStats = fileStats;
  }

  /**
   * Score a single action candidate.
   * Returns { action, score, breakdown } where breakdown shows each component.
   */
  _scoreAction(action, state) {
    const breakdown = {
      cost: 0,
      efficiency: 0,
      decisionTree: 0,
      rules: 0,
    };

    // 1. Cost penalty — normalize to 0-5 range
    const cost = estimateCost({ a: action }, this.fileStats);
    const rawCost = cost.latency * WEIGHTS.latency + cost.io * WEIGHTS.io + cost.cpu * WEIGHTS.cpu;
    const costScore = Math.max(0, 5 - rawCost / 10);
    breakdown.cost = +costScore.toFixed(2);

    // 2. Efficiency bonus — prefer actions with high historical success rate
    if (this.efficiency) {
      const dist = this.efficiency.distribution();
      const stats = dist[action];
      if (stats && stats.count >= 2) {
        breakdown.efficiency = +(stats.successRate / 20).toFixed(2); // 100% → +5
      } else if (stats && stats.successRate < 50) {
        breakdown.efficiency = -2;
      }
    }

    // 3. Decision tree bonus — prefer actions that follow successful paths
    if (this.decisionTree && state.lastAction) {
      const suggested = this.decisionTree.bestAction(state.lastAction);
      if (suggested === action) {
        breakdown.decisionTree = 3;
      }
    }

    // 4. Rule-based bonuses / penalties
    let ruleScore = 0;
    for (const rule of RULES) {
      if (rule.when(state)) {
        ruleScore += rule.score(action, state);
      }
    }
    breakdown.rules = +ruleScore.toFixed(2);

    const total = breakdown.cost + breakdown.efficiency + breakdown.decisionTree + breakdown.rules;
    return { action, score: +total.toFixed(2), breakdown };
  }

  /**
   * Return a ranked list of action recommendations.
   *
   * @param {object} state - Current turn state
   * @param {string} [state.lastAction] - The action taken in the previous turn
   * @param {boolean} [state.lastFailed] - Whether the last action failed
   * @param {string} [state.hint] - Optional hint: "structure", "symbols", "debug"
   * @param {number} [state.budgetRemaining] - Remaining context budget
   * @param {number} [state.budgetUsed] - Used context budget
   * @param {string[]} [state.candidates] - Actions to consider (default: all)
   * @returns {Array<{action, score, breakdown}>} Ranked recommendations
   */
  recommend(state) {
    const candidates = state.candidates || [
      "read_file", "list_dir", "search", "inspect",
      "replace", "edit_lines", "patch", "write_file",
      "shell", "query", "done", "respond",
    ];

    const scored = candidates
      .map((action) => this._scoreAction(action, state))
      .sort((a, b) => b.score - a.score);

    return scored;
  }

  /**
   * Get the top recommendation.
   */
  best(state) {
    const ranked = this.recommend(state);
    return ranked.length > 0 ? ranked[0] : null;
  }

  /**
   * Get recommendations above a threshold score.
   */
  viable(state, threshold = 0) {
    return this.recommend(state).filter((r) => r.score >= threshold);
  }

  /**
   * Summary of current recommendation state.
   */
  summary() {
    return {
      efficiency: this.efficiency ? this.efficiency.summary() : null,
      decisionTree: this.decisionTree ? this.decisionTree.summary() : null,
      budget: this.budget ? this.budget.summary() : null,
      fileStatsSize: this.fileStats.size,
    };
  }
}

// ---------------------------------------------------------------------------
// 4.  STANDBY EXPORTS
// ---------------------------------------------------------------------------

export { RULES, WEIGHTS };

/**
 * Create a ready-to-use recommender with default configuration.
 */
export function createRecommender() {
  return new ActionRecommender();
}
