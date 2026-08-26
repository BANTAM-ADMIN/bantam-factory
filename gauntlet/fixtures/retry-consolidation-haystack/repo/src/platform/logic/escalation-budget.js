// escalation-budget: the money ceiling on AUTONOMOUS escalation.
//
// When bantam may escalate without a human in the loop, spending is real. This is
// the accounting: a declared USD limit, an immutable spend ledger, a per-arm cost
// estimate, and an allow/deny decision that refuses once the estimate would push
// past the remaining budget. An unset or zero limit denies everything — autonomy
// is opt-in, never a default. Pure/immutable: recordSpend returns a new budget.
//
// This is the pre-authorization source requireConsent({mode:"autonomous"}) checks.
// See docs/superpowers/plans/2026-07-18-escalation-and-showcase.md (Phase 3).

// Rough per-arm USD estimate for one escalation task run. Deliberately generous —
// a true ceiling should over-estimate so it errs toward refusing, not overspending.
const PER_ARM_USD = Object.freeze({ "claude-code": 0.5, codex: 0.5 });
const DEFAULT_ARM_USD = 0.5;

/** A fresh budget. limitUsd<=0 (or unset) means "no autonomous spend allowed". */
export function newBudget({ limitUsd = 0, ledger = [] } = {}) {
  const limit = Number(limitUsd) || 0;
  return Object.freeze({ limitUsd: limit > 0 ? limit : 0, ledger: Object.freeze([...ledger]) });
}

/** Total spent so far. */
function spent(budget) {
  return budget.ledger.reduce((sum, e) => sum + (Number(e.usd) || 0), 0);
}

/** Estimated cost of escalating to the given external arms (bantam arms are free). */
export function estimateEscalationCost({ arms = ["claude-code", "codex"] } = {}) {
  return arms
    .filter((a) => a !== "bantam-dev" && a !== "bantam-regular")
    .reduce((sum, a) => sum + (PER_ARM_USD[a] ?? DEFAULT_ARM_USD), 0);
}

/**
 * Would an autonomous escalation costing `estimateUsd` stay within budget?
 * @returns {{allow:boolean, remaining:number, why:string}}
 */
export function authorizeAutonomous(budget, estimateUsd) {
  const remaining = Math.max(0, budget.limitUsd - spent(budget));
  if (budget.limitUsd <= 0) {
    return { allow: false, remaining, why: "no autonomous budget set; escalation must be user-initiated." };
  }
  if (estimateUsd > remaining) {
    return { allow: false, remaining, why: `estimated $${estimateUsd.toFixed(2)} exceeds $${remaining.toFixed(2)} remaining of the $${budget.limitUsd.toFixed(2)} budget.` };
  }
  return { allow: true, remaining, why: `estimated $${estimateUsd.toFixed(2)} within budget ($${remaining.toFixed(2)} remaining).` };
}

/** Record an actual spend, returning a NEW budget (input untouched). */
export function recordSpend(budget, actualUsd, { at = null, note = "" } = {}) {
  const entry = { usd: Number(actualUsd) || 0, at, note };
  return newBudget({ limitUsd: budget.limitUsd, ledger: [...budget.ledger, entry] });
}
