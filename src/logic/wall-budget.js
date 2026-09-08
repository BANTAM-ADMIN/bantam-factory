// wall-budget.js — show the model the budget it is actually killed on.
//
// prompt.js already argues the principle, for turns:
//
//   "A model cannot pace work it cannot see the edge of — it plans as if
//    unbounded and then gets a countdown."
//
// and then names only the TURN budget. On the benchmark the binding constraint
// is wall clock. write-compressor (2026-08-22, local) used 24 of its 120 turns
// and died on time: three OOM-killed commands took 286s, 276s and 260s — 822 of
// the run's 823 non-model seconds, 46% of the wall budget — and every one of
// them was reported to the model as a bare "exit 137 / Killed" with no duration.
// It could not have paced itself; nothing it was handed mentioned seconds.
//
// Shortening the shell timeout is NOT the fix: 300s was itself the correction
// after a 90s cap killed rstan-to-pystan's MCMC mid-sample, and its poll after
// it. The cost has to be visible instead of forbidden.

const pct = (x) => Math.round(100 * x);

/**
 * One line naming the wall-clock budget and what is left, or "" when no budget
 * is known. Deliberately terse: it re-renders every turn, so it lives in the
 * volatile tail and every character is paid for repeatedly.
 */
export function wallBudgetLine({ budgetMs = null, elapsedMs = 0 } = {}) {
  const budget = Number(budgetMs);
  if (!Number.isFinite(budget) || budget <= 0) return "";
  const used = Math.max(0, Number(elapsedMs) || 0);
  const left = Math.max(0, budget - used);
  const share = budget ? used / budget : 0;
  const mins = (ms) => `${Math.round(ms / 60000)}m`;

  let urgency = "";
  if (share >= 0.85) {
    urgency = " You are nearly out of time — stop exploring, make sure the task's"
      + " required output EXISTS on disk in whatever state you can manage, and verify it.";
  } else if (share >= 0.6) {
    urgency = " Past halfway — prefer finishing a working version over improving an unfinished one.";
  }
  return `[budget] wall clock: ${mins(used)} used of ${mins(budget)} (${pct(share)}%), ~${mins(left)} left.`
    + ` The wall deadline and configured turn cap both apply; reserve time for verification and the final response.${urgency}`;
}
