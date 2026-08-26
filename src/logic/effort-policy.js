// How hard should Codex think on THIS turn?
//
// Reasoning effort is a per-turn parameter on Codex's `turn/start`, not a
// property of the thread -- codex-transport guards against changing the MODEL
// inside a run-scoped thread and deliberately does not guard effort. So varying
// it mid-run reuses the same thread and leaves delta prompting, and its prefix
// reuse, untouched. Varying effort is architecturally free.
//
// The measured curve (gpt-5.6-terra, 2026-07-31, two fixtures, every arm PASSing)
// says the opportunity is NOT to think less on easy turns:
//
//   low      9 turns  222,750 in  3,659 out    443 reasoning
//   medium   8 turns  186,376 in  3,321 out    438 reasoning
//   high     9 turns  231,517 in  5,325 out  1,681 reasoning
//   xhigh    9 turns  237,598 in  6,506 out  2,864 reasoning
//
// low is WORSE than medium on turns and cache misses, so there is little room
// below the baseline. The room is above it, spent selectively: most turns are
// reads and mechanical edits where deep reasoning is wasted, while a few turns --
// the ones after a failed verification or a refused `done` -- are where thinking
// actually decides the outcome. Paying for xhigh on every hole drilled is waste;
// paying for it when the part comes back out of spec is the point.
//
// Deliberately conservative: escalation is bounded, one step at a time, and
// returns to base as soon as the run recovers. A policy that ratchets up and
// stays there is just an expensive default with extra steps.

const LADDER = ["low", "medium", "high", "xhigh"];

/** One step up the ladder from `level`, saturating at the top. */
function escalate(level, steps) {
  const at = LADDER.indexOf(level);
  if (at < 0) return level;
  return LADDER[Math.min(LADDER.length - 1, at + Math.max(0, steps))];
}

/**
 * Effort for the coming turn.
 *
 * @param {object} signals
 * @param {string} signals.base           the run's configured effort
 * @param {number} [signals.consecutiveSetbacks]  verification failures / gate
 *   refusals / invalid actions since the last clean turn
 * @param {boolean} [signals.enabled]     policy armed (off = always base)
 * @param {number} [signals.maxSteps]     ceiling on escalation, in ladder steps
 * @returns {{effort:string, reason:string}}
 */
export function turnEffort({
  base = "medium",
  consecutiveSetbacks = 0,
  enabled = false,
  maxSteps = 2,
} = {}) {
  if (!enabled) return { effort: base, reason: "policy-off" };
  if (!LADDER.includes(base)) return { effort: base, reason: "unknown-base" };
  const setbacks = Number.isFinite(consecutiveSetbacks) ? Math.max(0, consecutiveSetbacks) : 0;
  if (setbacks === 0) return { effort: base, reason: "steady" };
  const steps = Math.min(maxSteps, setbacks);
  const effort = escalate(base, steps);
  return {
    effort,
    reason: effort === base ? "at-ceiling" : `escalated-${steps}`,
  };
}

/**
 * Did this turn go badly enough to warrant more thinking next time?
 *
 * Kept separate from turnEffort so the SIGNAL and the POLICY can be tested and
 * changed independently -- and so "what counts as a setback" is one auditable
 * list rather than a condition scattered through the agent loop.
 */
export function isSetback({
  verificationFailed = false,
  doneRejected = false,
  invalidAction = false,
  editFailed = false,
} = {}) {
  return Boolean(verificationFailed || doneRejected || invalidAction || editFailed);
}
