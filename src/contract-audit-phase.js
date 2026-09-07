// Sampling and a short volatile-tail reminder mirror the existing receipt gate.
// They supply neither executable proof nor additional work/authority.
const STANDALONE_NODE_CHECK = "Next: use a permitted file-edit action (e.g. write_file) to create a new workspace check script, e.g. check-contract.mjs. Import the real production API and assert public-contract expectations with node:assert/strict. Temporary fixture DATA goes under os.tmpdir(); the check SCRIPT stays in the workspace. In a separate permitted shell action run only node check-contract.mjs (substitute its actual relative path): no cd, bash -c, setup, echo, filters or cleanup. Keep the check; printed pass messages are not proof.";

export function contractAuditPhaseState(pending, {
  useGrammar = true, interactive = false, advisoryMode = false,
  writeBatch = false, callerExcludedActions = [],
} = {}) {
  const active = !interactive && !advisoryMode
    && Boolean(pending?.needsFocused === true || pending?.needsProject === true || pending?.needsCli === true);
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
  const next = pending.needsCli === true
    ? "The separate public CLI process check is still missing, stale, or failing. Repair a demonstrated source or fixture defect and run the configured verifier; the controller will execute its fixed real-CLI check. API-only green cannot substitute for CLI evidence."
    : pending.needsFocused === true
    ? pending.focusedCheckRecovery === "standalone-node-file" ? STANDALONE_NODE_CHECK
      : "Next: execute a direct assertion against the actual API or CLI and the public contract. Create or repair the check separately if needed; printouts and broad-suite green do not replace this focused proof. Repair source only for a demonstrated defect, not merely to satisfy the review."
    : `Focused proof is accepted for the current tree. Next: run ${commandText ? `exactly the configured project verifier ${commandText}` : "the exact configured project verifier"}, directly, on that unchanged tree. Do not repeat the focused check.`;
  return { active: true, excludeVerbs, note: [
    "CONTRACT AUDIT PHASE: completion is not yet available; required current execution evidence is missing.",
    next,
    "The audit is a falsifiable model hypothesis, not an authoritative expected value. Keep intended checks; finish cleanup before final verification. Fresh focused and configured project proof clear this phase. No extra work turns are granted.",
  ].join("\n") };
}

// Current controller state, not model advice or acceptance authority. Unlike
// ordinary guidance this travels on EVERY newest turn outside tool clipping.
// Old copies remain immutable history; only the newest copy describes now.
export function contractAuditDecisionContext(pending, witness = null) {
  const current = pending ?? witness;
  if (!current || !Number.isSafeInteger(current.generation) || current.generation < 0) return null;
  const literal = value => {
    if (typeof value !== "string" || !value.length || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return null;
    const encoded = JSON.stringify(value);
    return encoded.length <= 512 ? encoded : null;
  };
  const generation = current.generation;
  let phase, text;
  if (!pending && witness) {
    phase = "ready";
    text = `VERIFICATION READY: this audit's focused and configured project checks passed on the current tree (generation ${generation}).`
      + (literal(witness.command) ? ` Focused command: ${literal(witness.command)}.` : "")
      + " There is NO optional cleanup step remaining. Keep the passing check as regression coverage; it is not disposable scratch. If the requested work is complete, emit DONE now on this unchanged tree. Other completion gates still apply. If a real requirement is unfinished, repair it and reverify; do not manufacture edits or delete checks to tidy up.";
  } else if (pending.needsFocused === true) {
    phase = "focused";
    if (pending.focusedCheckRecovery === "standalone-node-file") {
      text = `CONTRACT AUDIT PHASE: completion is not yet available; generation ${generation} still needs focused proof. ${STANDALONE_NODE_CHECK} The audit is a hypothesis, not an oracle.`;
      return { schema: 1, phase, generation, text };
    }
    const stale = pending.staleFocus, command = literal(stale?.command);
    const removed = (Array.isArray(stale?.removedPaths) ? stale.removedPaths : [])
      .filter(p => literal(p)).slice(0, 2);
    text = `CONTRACT AUDIT PHASE: completion is not yet available; generation ${generation} needs fresh focused execution, then the configured project check.`;
    if (command) text += ` Earlier successful check ${command} belongs to generation ${stale.generation}, NOT this tree.`;
    if (removed.length) text += ` Removed files: ${removed.map(p => literal(p)).join(", ")}. Recreate the assertion check or use a direct inline assertion against the public API; do not rerun a missing file.`;
    else if (command) text += ` Next: rerun ${command} directly against the current tree. If it fails, repair the demonstrated defect and rerun it.`;
    else text += " Next: execute a direct assertion against the actual API or CLI and the public contract. Create the check separately if needed.";
    text += " Rereading unchanged implementation and print-only probes do not discharge this step. The review is a hypothesis, not an expected value. Keep passing checks; do not clean them away.";
  } else if (pending.needsProject === true) {
    phase = "project";
    text = `CONTRACT AUDIT PHASE: focused proof is current (generation ${generation}); only configured project verification remains. Next: run ${literal(pending.configuredCommand) ?? "the exact configured project command"} directly. Do not repeat the focused check, delete its script, or emit DONE yet.`;
  } else return null;
  return { schema: 1, phase, generation, text };
}

export function verificationWorkflowPromptText(value) {
  if (!value || value.schema !== 1 || !["focused", "project", "ready", "failure", "cli"].includes(value.phase)
      || !Number.isSafeInteger(value.generation) || value.generation < 0
      || typeof value.text !== "string" || value.text.length > 2400
      || !value.text.startsWith(value.phase === "cli" ? "CLI VERIFICATION REQUIRED:"
        : value.phase === "failure" ? "EXECUTION FAILURE:"
        : value.phase === "ready" ? "VERIFICATION READY:" : "CONTRACT AUDIT PHASE:")) return "";
  return `[verification workflow: current decision]\n${value.text}\n`;
}
