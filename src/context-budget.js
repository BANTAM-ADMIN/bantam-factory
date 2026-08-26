// Context budgeting: track token/line budget per turn
//
// Tracks how much context is consumed each turn and across the session,
// warns when budget is running low, and projects remaining turns.
//
// Categories: reads, writes, shell, queries, misc
// Thresholds: warn at 75%, critical at 90%

const CATEGORIES = ["reads", "writes", "shell", "queries", "misc"];

const CATEGORY_ACTIONS = {
  read_file: "reads",
  list_dir: "reads",
  search: "reads",
  inspect: "reads",
  replace: "writes",
  edit_lines: "writes",
  patch: "writes",
  write_file: "writes",
  write_batch: "writes",
  shell: "shell",
  query: "queries",
  done: "misc",
  respond: "misc",
};

/**
 * ContextBudget — per-turn and session-wide context tracking.
 *
 * @param {number} maxTokens   - Max tokens for the session (default 8000)
 * @param {number} warnPct     - Warning threshold as 0-1 (default 0.75)
 * @param {number} criticalPct - Critical threshold as 0-1 (default 0.90)
 * @param {number} perTurnMax  - Max tokens per turn (default 2000)
 */
export class ContextBudget {
  constructor(maxTokens = 8000, warnPct = 0.75, criticalPct = 0.90, perTurnMax = 2000) {
    this.max = maxTokens;
    this.perTurnMax = perTurnMax;
    this.warnPct = warnPct;
    this.criticalPct = criticalPct;
    this.used = 0;
    this.turns = [];
    this.categories = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
    this.warnings = [];
    this.criticals = [];
  }

  /**
   * Allocate tokens for a single turn.
   * @param {number} turnId   - Turn number
   * @param {number} cost     - Token cost for this turn
   * @param {string} [action] - Action type (for category tracking)
   * @returns {object} Allocation record with remaining budget
   */
  allocate(turnId, cost, action) {
    const cat = action ? (CATEGORY_ACTIONS[action] || "misc") : "misc";
    this.used += cost;
    if (cat in this.categories) this.categories[cat] += cost;

    const remaining = this.remaining();
    const entry = { turn: turnId, cost, category: cat, remaining };
    this.turns.push(entry);

    // Check thresholds
    const ratio = this.used / this.max;
    if (ratio >= this.criticalPct) {
      this.criticals.push({ turn: turnId, ratio: +ratio.toFixed(3), remaining });
    } else if (ratio >= this.warnPct) {
      this.warnings.push({ turn: turnId, ratio: +ratio.toFixed(3), remaining });
    }

    return entry;
  }

  /** Remaining tokens for the session. */
  remaining() {
    return Math.max(0, this.max - this.used);
  }

  /** Usage ratio 0-1. */
  ratio() {
    return this.max > 0 ? this.used / this.max : 1;
  }

  /**
   * Estimate how many more turns we can afford at the current average cost.
   * Returns 0 if no turns recorded yet.
   */
  estimatedTurnsRemaining() {
    if (this.turns.length === 0) return 0;
    const avgCost = this.used / this.turns.length;
    if (avgCost === 0) return 0;
    return Math.floor(this.remaining() / avgCost);
  }

  /**
   * Check if a proposed cost fits within the current turn's budget.
   * Sums all allocations for the last turnId and checks against perTurnMax.
   * @param {number} cost - Proposed additional cost
   * @returns {boolean}
   */
  fitsInTurn(cost) {
    if (this.turns.length === 0) return cost <= this.perTurnMax;
    const lastTurnId = this.turns[this.turns.length - 1].turn;
    const turnCost = this.turns.filter(t => t.turn === lastTurnId).reduce((s, t) => s + t.cost, 0);
    return turnCost + cost <= this.perTurnMax;
  }

  /**
   * Check if a proposed action fits within the session budget.
   * @param {number} cost - Estimated cost of the action
   * @returns {boolean}
   */
  fitsInSession(cost) {
    return this.used + cost <= this.max;
  }

  /**
   * Get the current budget status.
   * @returns {"ok"|"warning"|"critical"|"exhausted"}
   */
  status() {
    if (this.used >= this.max) return "exhausted";
    if (this.ratio() >= this.criticalPct) return "critical";
    if (this.ratio() >= this.warnPct) return "warning";
    return "ok";
  }

  /**
   * Get category breakdown.
   * @returns {object} Category costs
   */
  categoryBreakdown() {
    return { ...this.categories };
  }

  /**
   * Reset the budget for a new session.
   */
  reset() {
    this.used = 0;
    this.turns = [];
    this.categories = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
    this.warnings = [];
    this.criticals = [];
  }

  /**
   * Full summary for reporting.
   * @returns {object}
   */
  summary() {
    return {
      max: this.max,
      perTurnMax: this.perTurnMax,
      used: this.used,
      remaining: this.remaining(),
      ratio: +this.ratio().toFixed(3),
      status: this.status(),
      turns: this.turns.length,
      avgCost: this.turns.length ? Math.round(this.used / this.turns.length) : 0,
      estimatedTurnsRemaining: this.estimatedTurnsRemaining(),
      categories: this.categoryBreakdown(),
      warnings: this.warnings.length,
      criticals: this.criticals.length,
    };
  }
}
