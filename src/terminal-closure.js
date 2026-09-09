// Permission for one final action, never proof of task correctness. Existing
// DONE gates remain authoritative; ordinary maxTurns stays a hard limit.
export function terminalClosureAllowance(value) {
  if (value !== 0 && value !== 1) throw new TypeError('terminalClosureTurns must be 0 or 1');
  return value;
}

// A turn budget cannot see the clock, so a run can be killed mid-turn with its
// work already verified green and never emit DONE. Reserve room for one final
// slow action, bounded so a short deadline still gets a floor and a long one
// does not hand back minutes. A missing or nonsensical deadline reserves
// nothing and never forces closure.
export function wallClosureReserveMs(deadlineMs) {
  const deadline = Number(deadlineMs);
  if (!Number.isFinite(deadline) || deadline <= 0) return 0;
  return Math.min(60000, Math.max(15000, Math.floor(deadline * 0.08)));
}

export function wallClosureDue({startedAtMs, nowMs, deadlineMs} = {}) {
  const deadline = Number(deadlineMs), started = Number(startedAtMs), now = Number(nowMs);
  if (!Number.isFinite(deadline) || deadline <= 0) return false;
  if (!Number.isFinite(started) || !Number.isFinite(now)) return false;
  const elapsed = now - started;
  if (!(elapsed >= 0)) return false;
  return elapsed >= deadline - wallClosureReserveMs(deadline);
}

export function terminalClosureEligible({allowance, used, turnsUsed, workTurnLimit, action, deadlineReached = false,
  proof, generation, configuredCommand, workspace, verificationWorkspaceReadOnly,
  pendingAudit, interrupted, controllerStopped, resultDone, callerExcludedActions = [], freshEvidence = false}) {
  const budgetExhausted = deadlineReached === true || turnsUsed === workTurnLimit;
  const validLimit = Number.isSafeInteger(workTurnLimit) || (workTurnLimit === Infinity && deadlineReached === true);
  if (allowance !== 1 || used || !budgetExhausted || !validLimit
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
  const boundary = workTurnLimit === Infinity ? 'caller-declared wall-clock closing reserve' : `${workTurnLimit}-turn cap or wall-clock closing reserve`;
  return `[terminal-closure] The work budget has reached its ${boundary}. The controller grants ONE additional DONE-only action because current-generation verification is green and no audit checkpoint remains. Emit {"a":"done","summary":"..."} with the verified result and remaining limitations. No tools, reads, edits, cleanup or extra work are permitted. This is not automatic acceptance: every existing completion gate still applies.`;
}
