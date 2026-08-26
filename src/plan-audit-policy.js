const ON_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

// A document-only task delivers reasoning about the repository instead of
// code. Plans were the first measured case; impact reports and audits have the
// same no-oracle failure mode, so they share the one post-green checklist.
const PLAN_DELIVERABLE = /\b(?:write|create|produce|draft|author)\b[^.]{0,100}\b(?:(?:plan|impact|report|audit|assessment|analysis|proposal|design)\.(?:md|markdown|rst|adoc)|implementation plan|design plan|migration plan|impact (?:report|analysis|audit)|audit report|a plan)\b|\bplan\.md\b/i;
const NO_IMPLEMENTATION = /\bdo\s+not\s+(?:implement|write|modify|edit|change)\b|\bwithout\s+implementing\b|\bplanning[- ]only\b|\bthe only file you may (?:create|edit|touch)\b/i;

export const REPOSITORY_DOCUMENT_CONTRACT_CHECK =
  "Treat inspected comments and README statements containing must, never, invariant, public contract, or a named external consumer as requirements. Carry each one into the draft and reconcile it explicitly; do not call a format or ordering change acceptable while a named consumer is unaddressed. For every must, never, always, or after-N behavioral guarantee, trace one concrete worst-case event sequence and verify that the proposed update point runs on every event that counts, including events affecting work that is still waiting.";

/**
 * Decide whether the post-green audit should carry the plan-quality
 * checklist (consumers, behavior diffs, guarantee traces, marked decisions)
 * instead of only the requirement-to-code mapping.
 */
export function decidePlanAudit(task, setting = "auto") {
  const mode = normalizePlanAuditMode(setting);
  if (mode === "on") return decision(mode, true, "forced-on");
  if (mode === "off") return decision(mode, false, "configured-off");

  const text = String(task ?? "").replace(/\s+/g, " ").trim();
  if (!PLAN_DELIVERABLE.test(text)) {
    return decision(mode, false, "auto-no-plan-deliverable-signal");
  }
  if (NO_IMPLEMENTATION.test(text)) {
    return decision(mode, true, "auto-plan-document-task");
  }
  return decision(mode, false, "auto-plan-mention-but-implementation-task");
}

/** Cheap pre-draft context for repository-grounded document-only work. */
export function repositoryDocumentContractCue(task) {
  return decidePlanAudit(task, "auto").enabled
    ? `REPOSITORY DOCUMENT DRAFT CHECK: ${REPOSITORY_DOCUMENT_CONTRACT_CHECK}`
    : "";
}

export function normalizePlanAuditMode(setting) {
  if (setting === true) return "on";
  if (setting === false || setting === null || setting === undefined) return "off";
  const value = String(setting).trim().toLowerCase();
  if (value === "auto") return "auto";
  if (ON_VALUES.has(value)) return "on";
  if (OFF_VALUES.has(value)) return "off";
  throw new TypeError(`invalid plan audit mode: ${setting}`);
}

function decision(mode, enabled, reason) {
  return Object.freeze({ mode, enabled, reason });
}
