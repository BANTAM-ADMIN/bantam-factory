// Sampling and a short volatile-tail reminder mirror the existing receipt gate.
// They supply neither executable proof nor additional work/authority.
const STANDALONE_NODE_CHECK = "Next: use a permitted file-edit action (e.g. write_file) to create a new workspace check script, e.g. check-contract.mjs. Import the real production API and assert public-contract expectations with node:assert/strict. Temporary fixture DATA goes under os.tmpdir(); the check SCRIPT stays in the workspace. In a separate permitted shell action run only node check-contract.mjs (substitute its actual relative path): no cd, bash -c, setup, echo, filters or cleanup. Keep the check; printed pass messages are not proof.";

function focusedWorkOrder(pending) {
  const d = pending?.admissionDiagnostic, c = pending?.checkCandidate;
  const reasons = {
    'inline-assertion-not-recognized': 'The inline check has no recognized node:assert binding/call. A custom assert helper or if/exit check is not admitted by this bounded recognizer.',
    'non-direct-or-status-opaque': 'The launcher is compound or its status is opaque; an outer zero does not establish the required direct assertion result.',
    'execution-evidence-incomplete': 'The receipt does not establish a recognized focused assertion with complete execution evidence; zero matched tests and printed PASS are not proof.',
    'execution-failed': 'The process or its measured tests failed. Repair a demonstrated source or fixture defect before retrying.',
  };
  const diagnostic = d?.schema === 1 && d.generation === pending.generation && d.admission === 'not-admitted'
    && Number.isSafeInteger(d.turn) && d.turn >= 0 && Number.isInteger(d.exitCode) && d.exitCode >= 0 && d.exitCode < 125
    && /^[a-f0-9]{64}$/.test(d.outputSha256 ?? '') && Object.hasOwn(reasons, d.reason)
    ? `Execution: turn ${d.turn + 1} ran and exited ${d.exitCode}. Focused-proof admission: NOT ADMITTED. ${reasons[d.reason]} ` : '';
  const candidate = c?.schema === 1 && c.generation === pending.generation && c.verified === false
    && c.authority === 'current-source-launcher-hint' && /^[a-f0-9]{64}$/.test(c.sourceSha256 ?? '')
    && typeof c.path === 'string' && c.path.length <= 240 && /^[\w./-]+\.[cm]?js$/.test(c.path)
    && !c.path.startsWith('/') && !c.path.split('/').includes('..')
    && [ `node ${c.path}`, `node --test ${c.path}` ].includes(c.command);
  if (!diagnostic && !candidate) return '';
  const failed = diagnostic && d.reason === 'execution-failed';
  // Source discovery establishes a usable launcher, not relevance to the
  // current milestone. After later edits an old check may exercise another
  // subsystem entirely; do not turn its continued existence into an immediate
  // rerun instruction. An observed failed execution still calls for repair.
  const candidateNext = failed
    ? `Repair the demonstrated source or fixture defect before retrying; then run exactly ${JSON.stringify(c?.command)} directly.`
    : `Continue any unfinished implementation milestone. At its verification boundary, reuse ${JSON.stringify(c?.command)} directly if it covers the behavior changed; otherwise use a relevant focused assertion. Do not rerun an unrelated check after each edit.`;
  return diagnostic + (candidate
    ? `Existing authored check located in CURRENT source: ${JSON.stringify(c.path)} (sha256 ${c.sourceSha256}). ${candidateNext} It imports local code and uses node:assert; this is a launcher hint, NOT proof of coverage or correctness. If a specific public-contract obligation is missing, add one discriminating assertion; do not build another comprehensive suite just to obtain a receipt. `
    : failed ? 'Next: use the observed failure to repair a demonstrated source or fixture defect, then rerun the affected check directly. Preserve its assertions and use the existing check where possible; a failed execution does not require creating a replacement suite. '
    : `${STANDALONE_NODE_CHECK} Start with one discriminating fixture/assertion and execute it before expanding coverage. `)
    + 'A successful admitted focused check still requires fresh configured project verification. No completion gate is waived.';
}

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
    ? focusedWorkOrder(pending) || (pending.focusedCheckRecovery === "standalone-node-file" ? STANDALONE_NODE_CHECK
      : "Next: run a direct assertion against the actual API or CLI and the public contract. Prefer an existing focused check or one minimal witness for the hypothesis. Use node check-contract.mjs (its actual path), node --test test/edge.test.js, or an inline node:assert assertion; a final 2>&1 stderr merge is allowed. Start with one discriminating fixture/assertion and execute it before expanding coverage. Create or repair the check separately if needed. Printouts and broad-suite green do not replace focused proof. Repair source only for a demonstrated defect, not merely to satisfy the review.")
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
      + " These receipts cover the executed checks, not all requested work. Continue the next unfinished milestone from the task, progress record or latest review; passing a scoped check does not finish the project. There is NO optional cleanup step remaining. Keep the passing check as regression coverage; it is not disposable scratch. Only if every requested requirement is complete and verified, emit DONE now on this unchanged tree. Other completion gates still apply. Necessary implementation remains allowed and needs fresh verification; do not manufacture edits or delete checks to tidy up.";
  } else if (pending.needsFocused === true) {
    phase = "focused";
    const workOrder = focusedWorkOrder(pending);
    if (workOrder) return { schema: 1, phase, generation,
      text: `CONTRACT AUDIT PHASE: completion is not yet available; generation ${generation} still needs focused proof. ${workOrder} The audit is a hypothesis, not an oracle.`,
      ...(pending.admissionDiagnostic ? { admissionDiagnostic: pending.admissionDiagnostic } : {}),
      ...(pending.checkCandidate ? { checkCandidate: pending.checkCandidate } : {}) };
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
    else if (command) text += ` Continue any unfinished implementation milestone. At its verification boundary, run a focused assertion for the behavior changed, then the configured project check. Reuse ${command} if it covers that behavior; its earlier success alone does not make it the next required action. Do not rerun an unrelated check after each edit.`;
    else text += " Next: run an existing focused assertion directly, or make one minimal witness against the public API/CLI and contract. Accepted launchers include node check-contract.mjs (its actual path), node --test test/edge.test.js, or an inline node:assert assertion. A final 2>&1 stderr merge is allowed; chains, output filters and status masks are not.";
    text += " Start with one discriminating fixture/assertion and execute it before expanding coverage. Rereading unchanged implementation and print-only probes do not discharge this step. The review is a hypothesis, not an expected value. Keep passing checks; do not clean them away.";
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
  const repair = typeof value.repairContext === 'string' && value.repairContext.length <= 8000
    && /^\[repair (?:context\]|handoff; advisory, NOT verification evidence\])/.test(value.repairContext)
    ? `${value.repairContext}\n` : '';
  return `${repair}[verification workflow: current decision]\n${value.text}\n`;
}
