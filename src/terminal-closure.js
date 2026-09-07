// Permission for one final action, never proof of task correctness. Existing
// DONE gates remain authoritative; ordinary maxTurns stays a hard limit.
export function terminalClosureAllowance(value) {
  if (value !== 0 && value !== 1) throw new TypeError('terminalClosureTurns must be 0 or 1');
  return value;
}

export function terminalClosureEligible({allowance, used, turnsUsed, workTurnLimit, action,
  proof, generation, configuredCommand, workspace, verificationWorkspaceReadOnly,
  pendingAudit, interrupted, controllerStopped, resultDone, callerExcludedActions = [], freshEvidence = false}) {
  if (allowance !== 1 || used || turnsUsed !== workTurnLimit || !Number.isSafeInteger(workTurnLimit)
      || workTurnLimit < 1 || !action || ['done','respond'].includes(action.a)
      || interrupted || controllerStopped || resultDone || pendingAudit || !freshEvidence
      || callerExcludedActions.includes('done') || !configuredCommand) return false;
  const evidence = proof?.evidence;
  return proof?.generation === generation && proof.command === configuredCommand
    && proof.verification?.status === 'pass' && evidence?.schema === 1
    && evidence.generation === generation && evidence.configuredCommand === configuredCommand
    && evidence.cwd === workspace && evidence.status === 'pass' && evidence.exitCode === 0
    && evidence.timedOut === false && evidence.interrupted === false
    && !evidence.blocked && !evidence.error && !evidence.invalidated && !evidence.bufferExceeded
    && !(evidence.counts?.failed > 0) && evidence.counts?.total !== 0
    && (verificationWorkspaceReadOnly ? evidence.workspaceReadOnly === true : evidence.workspaceReadOnly !== true);
}

export function terminalClosureNote(workTurnLimit) {
  return `[terminal-closure] The ${workTurnLimit} work-turn budget is exhausted. The controller grants ONE additional DONE-only action because current-generation verification is green and no audit checkpoint remains. Emit {"a":"done","summary":"..."} with the verified result and remaining limitations. No tools, reads, edits, cleanup or extra work are permitted. This is not automatic acceptance: every existing completion gate still applies.`;
}
