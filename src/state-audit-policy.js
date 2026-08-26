const ON_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

const ASYNC_STATE = /\b(?:async(?:hronous(?:ly)?)?|concurren(?:t|cy)|in[- ]flight|promise|completion order|AbortSignal|abort(?:ed|ing)?)\b/i;
// "Regardless of completion order" is the ordinary contract of a stateless
// ordered concurrent map. It is not evidence of stale state or supersession.
// Treating it as such sent two correct async implementations through an
// irrelevant lifecycle probe and induced a synchronous-throw API regression.
const ORDERING_RISK = /\b(?:most recent(?:ly)?|latest|newer|older|stale|supersed(?:e|ed|ing|es))\b/i;
const RESET_RISK = /\b(?:invalidate|invalidation|clear|reset|cancel(?:lation|led|ing)?|abort(?:ed|ing)?|expir(?:e|y|ed)|ttl)\b/i;
const ABORT_RISK = /\b(?:AbortSignal|abort(?:ed|ing)?|signal\.reason|abort listener)\b/i;
const SETTLEMENT_RISK = /\b(?:pending|in[- ]flight|settle(?:ment|d|s|ing)?|resolv(?:e|ed|es|ing)|reject(?:ion|ed|s|ing)?)\b/i;
const KEYED_STATE = /\b(?:keyed|per[- ]key|same[- ]key|same key|a key|the key|that key|each key|duplicate (?:key|submission)|key already)\b/i;
const COALESCING = /\b(?:coalesc(?:e|ed|es|ing)|deduplicat(?:e|ed|es|ing|ion)|duplicate submissions?|same[- ]key callers?|shared (?:promise|result)|fan out|exact same promise|receive the exact same promise)\b/i;
const REUSABLE_AFTER_SETTLEMENT = /\b(?:after (?:that )?(?:promise )?(?:settles?|settlement|resolution|rejection)|until (?:it|the (?:task|promise|operation)) (?:settles?|resolves?|rejects?)|through settlement|remove (?:the )?(?:entry|key|pending state)|reus(?:e|ed|able)|submitted again|new submission|start fresh|free (?:the )?(?:slot|key|capacity))\b/i;

/** Decide whether the completion audit needs async state-machine counterexamples. */
export function decideStateAudit(task, setting = false) {
  const mode = normalizeStateAuditMode(setting);
  if (mode === "on") return decision(mode, true, "forced-on");
  if (mode === "off") return decision(mode, false, "configured-off");

  const text = String(task ?? "").replace(/\s+/g, " ").trim();
  if (!ASYNC_STATE.test(text)) {
    return decision(mode, false, "auto-no-async-state-signal");
  }
  // A keyed in-flight Promise is a tiny state machine whose correctness
  // depends on publication and retirement timing, not merely on whether the
  // public suite is green. Requiring every signal keeps ordinary Promise use,
  // synchronous maps, and text coalescing off this higher-cost audit path.
  if (KEYED_STATE.test(text)
      && COALESCING.test(text)
      && SETTLEMENT_RISK.test(text)
      && REUSABLE_AFTER_SETTLEMENT.test(text)) {
    return decision(mode, true, "auto-keyed-promise-lifecycle");
  }
  if (ORDERING_RISK.test(text)) {
    return decision(mode, true, "auto-async-supersession");
  }
  if (ABORT_RISK.test(text) && SETTLEMENT_RISK.test(text)) {
    return decision(mode, true, "auto-async-abort-lifecycle");
  }
  if (RESET_RISK.test(text) && SETTLEMENT_RISK.test(text)) {
    return decision(mode, true, "auto-async-lifecycle");
  }
  return decision(mode, false, "auto-no-high-confidence-lifecycle-risk");
}

export function normalizeStateAuditMode(setting) {
  if (setting === true) return "on";
  if (setting === false || setting === null || setting === undefined) return "off";
  const value = String(setting).trim().toLowerCase();
  if (value === "auto") return "auto";
  if (ON_VALUES.has(value)) return "on";
  if (OFF_VALUES.has(value)) return "off";
  throw new TypeError(`invalid state audit mode: ${setting}`);
}

function decision(mode, enabled, reason) {
  return Object.freeze({ mode, enabled, reason });
}
