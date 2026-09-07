// Sampling and a short volatile-tail reminder mirror the existing receipt gate.
// They supply neither executable proof nor additional work/authority.
export function contractAuditPhaseState(pending, {
  useGrammar = true, interactive = false, advisoryMode = false,
  writeBatch = false, callerExcludedActions = [],
} = {}) {
  const active = !interactive && !advisoryMode
    && Boolean(pending?.needsFocused === true || pending?.needsProject === true);
  if (!active) return { active: false, excludeVerbs: [], note: "" };
  // Exactly the existing autonomous-implementation respond veto, not a new
  // restriction on interactive/advisory or caller-enforced read-only replies.
  const implementationRoute = !callerExcludedActions.includes("write_file")
    || (writeBatch && !callerExcludedActions.includes("write_batch"))
    || !callerExcludedActions.includes("replace") || !callerExcludedActions.includes("shell");
  const excludeVerbs = useGrammar ? ["done", ...(implementationRoute ? ["respond"] : [])] : [];
  const command = pending.configuredCommand;
  const commandText = typeof command === "string" && command.length <= 512
    && !/[\x00-\x1f\x7f]/.test(command) ? JSON.stringify(command) : null;
  const next = pending.needsFocused === true
    ? "Next: execute a direct assertion against the actual API or CLI and the public contract. Create or repair the check separately if needed; printouts and broad-suite green do not replace this focused proof. Repair source only for a demonstrated defect, not merely to satisfy the review."
    : `Focused proof is accepted for the current tree. Next: run ${commandText ? `exactly the configured project verifier ${commandText}` : "the exact configured project verifier"}, directly, on that unchanged tree. Do not repeat the focused check.`;
  return { active: true, excludeVerbs, note: [
    "CONTRACT AUDIT PHASE: completion is not yet available; required current execution evidence is missing.",
    next,
    "The audit is a falsifiable model hypothesis, not an authoritative expected value. Keep intended checks; finish cleanup before final verification. Fresh focused and configured project proof clear this phase. No extra work turns are granted.",
  ].join("\n") };
}
