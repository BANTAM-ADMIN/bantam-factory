// Bounded progress credit for substrate queries.
//
// Crediting a routed `query` as progress is necessary — without it the progress gate terminates a run
// for using the very tools we built (measured: 189 query turns, 1 progress event). But crediting
// EVERY query removes the anti-spiral pressure entirely, and the model will happily interrogate the
// graph until the turn budget dies without ever producing the deliverable.
//
// Measured on three live query-heavy arms with identical configuration:
//
//   jobs-hint  reward 1.0  {"query":189, "write_file":1}   queried, then shipped
//   jobs-rep1  reward 0.0  {"query":192, "write_file":0}   queried to maxTurns, 0 gate rejections
//   jobs-rep2  reward 0.0  {"query":194, "write_file":0}   same
//
// The pass and the spiral are the same behaviour. The only difference is whether the model stopped.
// So: a query should be UNTAXED, not INFINITELY REWARDED. Credit progress for a bounded run of
// genuinely new queries; once the budget is spent, queries still aren't punished (no gate rejection
// for using the substrate) but they stop resetting `progresslessTurns`, so the nudge and then the
// gate push the model to ship a draft. Any real deliverable action refills the budget, so an
// interleaved query -> edit -> query loop is never throttled.

// Must be SMALLER than the force-edit threshold (autoForceEditAfter, default 8),
// or recon outruns the gate it feeds. v27 spent 33 turns and 0 edits querying
// and reading: each fresh query reset progresslessTurns, and with a budget of 12
// the counter could never climb to 8 before another query knocked it back down.
// The budget's whole job is to let the paralysis counter WIN eventually; a budget
// above the threshold guarantees it never does. 5 < 8 leaves real recon room and
// still lets the gate bite. Any edit refills it, so query->edit->query is free.
const DEFAULT_BUDGET = 5;

export function defaultQueryProgressBudget(env = process.env) {
  const raw = Number(env.BANTAM_QUERY_PROGRESS_BUDGET);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BUDGET;
}

export class QueryProgressBudget {
  constructor({ budget = defaultQueryProgressBudget() } = {}) {
    this.budget = budget;
    this._spent = 0;
    this._seen = new Set();   // (tool, query) pairs already answered this run
  }

  get remaining() { return Math.max(0, this.budget - this._spent); }

  /**
   * Should this query action reset `progresslessTurns`?
   * @returns {boolean} true when it counts as progress.
   */
  credit({ tool, query }) {
    // An unrouted query got the menu, not an answer. It is not progress, and it must not consume
    // budget — otherwise a model that mistypes a few queries loses its whole allowance.
    if (!tool) return false;

    // A repeat cannot teach the model anything it doesn't already have. Not progress, no charge.
    const key = `${tool}\u0000${String(query ?? "").trim()}`;
    if (this._seen.has(key)) return false;
    this._seen.add(key);

    if (this.remaining <= 0) return false;
    this._spent += 1;
    return true;
  }

  /**
   * A produced artifact / edit / verification: the model is converting knowledge into a deliverable.
   * This also clears the repeat cache — after an edit, re-running the same query can return NEW data
   * (a repaired DB, a rewritten file), so the re-check is genuine progress, not a stale repeat.
   */
  noteDeliverableProgress() { this._spent = 0; this._seen.clear(); }
}

const QUERY_GATE_TAG = "[query-budget]";

/**
 * Once the query budget is spent AND the model is in a progressless streak, a further query is
 * gated like any other reconnaissance action.
 *
 * This half is not optional. `progressGateRejection` only covers read_file/list_dir/search/inspect,
 * so a model that issues nothing but `query` actions is never gated at all: rep1 ran 200 turns with
 * one nudge and zero gate rejections, and never wrote the deliverable. Bounding the progress CREDIT
 * restores the nudges; making the query gate-eligible restores the hard stop (and feeds the existing
 * consecutive-rejection termination path).
 *
 * @returns {string|null} rejection message, or null to let the action run.
 */
export function queryBudgetGateRejection(action, { budgetSpent = false, progresslessTurns = 0, threshold = 8 } = {}) {
  if (action?.a !== "query") return null;
  if (!budgetSpent || progresslessTurns < threshold) return null;
  return `${QUERY_GATE_TAG} You have spent your query budget for this stretch and are ${progresslessTurns} turns`
    + ` without producing or changing a deliverable. This query was not executed. You already have`
    + ` enough grounded facts: write the required output file now (write_file/replace), then query`
    + ` again to check it. Querying refills only after you produce or verify an artifact.`;
}
