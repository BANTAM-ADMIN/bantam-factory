// escalation-policy: when does a run "suspect a major error" worth escalating to
// a stronger external agent, and the hard consent gate that must clear first.
//
// Escalation costs money and sends the task's data to an external service, so the
// gate is absolute: an interactive run needs a live confirm(); an autonomous run
// needs a durable pre-authorization (the budget policy supplies it in Phase 3).
// Consent is never a default. Pure/injectable — the caller distills the live
// distress snapshot from src/failure-diagnostics.js and injects confirm().
//
// See docs/superpowers/plans/2026-07-18-escalation-and-showcase.md (Phase 2).

// Per-signal trigger thresholds. A signal fires when its snapshot value reaches
// its threshold; any one fired signal is enough to suspect a major error (these
// are already-distilled distress counters, not raw noise).
const DEFAULT_THRESHOLDS = Object.freeze({
  repetition: 3,       // same failing action/outcome repeated (repeatedFailureDiagnostic)
  redVerifyStreak: 3,  // consecutive turns with a red verify
  stuckTurns: 4,       // consecutive no-progress turns
  blindEdits: 3,       // consecutive failed edits from a stale mental image
});

const SIGNAL_LABEL = {
  repetition: "repetition",
  redVerifyStreak: "red-verify-streak",
  stuckTurns: "stuck-turns",
  blindEdits: "blind-edits",
  staleContext: "stale-context",
};

/**
 * Distill a distress snapshot from a recorded run's turns, reading the structured
 * observation tags the harness already emits ([repetition], [progress-awareness],
 * [fix-tests]) rather than re-deriving distress.
 *
 * Streaks are the PEAK consecutive run anywhere in the trajectory, not just the
 * trailing one: a run that spun for ten turns and then confidently emitted a
 * (wrong) `done` has a trailing streak of 0 but was in real distress mid-run —
 * exactly the moment a live trigger would have fired. For a live per-turn trigger
 * the peak-so-far equals the trailing streak, so the two agree in that use.
 * @param {Array<{observation?, parsedAction?}>} turns
 * @returns {{repetition, redVerifyStreak, stuckTurns, blindEdits, staleContext}}
 */
export function distillDistress(turns = []) {
  const obs = turns.map((t) => String(t.observation ?? ""));
  const has = (s, tag) => s.includes(tag);
  const peakStreak = (pred) => {
    let best = 0, cur = 0;
    for (const s of obs) { cur = pred(s) ? cur + 1 : 0; if (cur > best) best = cur; }
    return best;
  };
  return {
    repetition: obs.filter((s) => has(s, "[repetition]")).length,
    stuckTurns: peakStreak((s) => has(s, "[progress-awareness]")),
    redVerifyStreak: peakStreak((s) => has(s, "[fix-tests]")),
    blindEdits: obs.filter((s) => has(s, "[repetition]") && has(s, "[fix-tests]")).length,
    staleContext: obs.some((s) => /\bstale\b/i.test(s)),
  };
}

/**
 * @param {{repetition?, redVerifyStreak?, stuckTurns?, blindEdits?, staleContext?}} signals
 * @param {{thresholds?}} opts
 * @returns {{escalate:boolean, reason:string, signals:string[]}}
 */
export function suspectsMajorError(signals = {}, { thresholds = {} } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const fired = [];
  for (const key of ["repetition", "redVerifyStreak", "stuckTurns", "blindEdits"]) {
    if ((Number(signals[key]) || 0) >= t[key]) fired.push(SIGNAL_LABEL[key]);
  }
  // staleContext is a boolean amplifier: it only escalates alongside another
  // counter, never alone (a stale open-file set with real progress is normal).
  if (signals.staleContext && fired.length) fired.push(SIGNAL_LABEL.staleContext);

  const escalate = fired.length > 0;
  const reason = escalate
    ? `suspected major error — distress signals over threshold: ${fired.join(", ")}. `
      + `A stronger reference agent may see what this run cannot.`
    : "no distress signal over threshold; the run is progressing normally.";
  return { escalate, reason, signals: fired };
}

/**
 * The hard consent gate. Never proceeds without a positive, explicit consent for
 * the run's mode.
 * @param {{escalate, mode:"interactive"|"autonomous", confirm?, preAuthorized?}} in
 * @returns {{proceed:boolean, why:string}}
 */
export function requireConsent({ escalate, mode = "interactive", confirm, preAuthorized = false }) {
  if (!escalate) return { proceed: false, why: "no escalation was suspected; nothing to consent to." };
  if (mode === "autonomous") {
    return preAuthorized
      ? { proceed: true, why: "autonomous escalation pre-authorized (budget policy cleared it)." }
      : { proceed: false, why: "autonomous escalation requires prior authorization (budget/consent not granted)." };
  }
  // interactive
  const ok = typeof confirm === "function" ? Boolean(confirm()) : false;
  return ok
    ? { proceed: true, why: "user confirmed escalation." }
    : { proceed: false, why: "user declined escalation (or no confirmation available)." };
}
