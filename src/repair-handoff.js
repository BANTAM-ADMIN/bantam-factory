// Explicit worker hypotheses linked to the shared ordered execution ledger.
// This module supplies context only. It never creates verification evidence.
import { canonicalAuditCommand, sameAuditCommand, sameRecordedCommand, isConfiguredAuditCommand } from './verification-command.js';
import { verificationExecutionEntries } from './verification-failure-context.js';
import { turnEditApplied } from './edit-actions.js';
import crypto from 'node:crypto';

const LIMITS = { evidenceSha256: 64, fixture: 700, priorExpected: 400,
  proposedExpected: 400, requirement: 400, nextCheck: 400 };
const HASH = /^[a-f0-9]{64}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = value => !['invalidated', 'blocked', 'timedOut', 'interrupted', 'aborted', 'bufferExceeded', 'error', 'signal', 'cached', 'uncertainty'].some(k => value?.[k]);
function measured(entry) {
  const proof = entry.verificationEvidence, shell = entry.shellExecution;
  const value = proof ?? shell;
  if (!record(value) || !clean(value) || !HASH.test(value.outputSha256 ?? '')
      || !Number.isSafeInteger(value.generation) || value.generation < 0
      || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255
      || typeof value.cwd !== 'string' || !value.cwd.startsWith('/')
      || typeof value.command !== 'string' || value.command.length > 1600
      || typeof value.executedCommand !== 'string' || value.executedCommand.length > 1600
      || !canonicalAuditCommand(value.command)) return null;
  if (proof) {
    if (proof.schema !== 1 || !['shell','automatic','scoped','landing','completion'].includes(proof.source)
        || !['pass','fail'].includes(proof.status) || proof.statusScope !== 'execution'
        || proof.statusCommand !== proof.executedCommand
        || (proof.status === 'pass' && (proof.exitCode !== 0 || proof.counts?.failed > 0))
        || (proof.status === 'fail' && proof.exitCode === 0 && !(proof.counts?.failed > 0))) return null;
    if (proof.source === 'shell' && !shell) return null;
    if (shell && (!clean(shell) || !sameRecordedCommand(proof.command, shell.command)
        || ['executedCommand','generation','exitCode','cwd','workspaceReadOnly','sandbox']
          .some(k => (proof[k] ?? null) !== (shell[k] ?? null)))) return null;
    if (!sameRecordedCommand(proof.command, proof.executedCommand)
        && !(proof.source !== 'shell' && isConfiguredAuditCommand(proof.executedCommand, proof.command))) return null;
  } else if (!sameRecordedCommand(shell.command, shell.executedCommand)) return null;
  return { ...value, status: proof?.status ?? (shell.exitCode === 0 ? 'pass' : 'fail'),
    source: proof?.source ?? 'shell' };
}

function executions(turn, index) {
  return verificationExecutionEntries(turn, index).map((entry, sequence) => {
    const value = measured(entry); return value ? { ...value, sequence } : null;
  }).filter(Boolean);
}

function linkProposal(proposal, turns, { generation, workspace }) {
  if (!record(proposal) || Object.keys(proposal).length !== Object.keys(LIMITS).length
      || Object.entries(LIMITS).some(([k,max]) => typeof proposal[k] !== 'string' || !proposal[k].trim() || proposal[k].length > max)
      || !HASH.test(proposal.evidenceSha256) || !canonicalAuditCommand(proposal.nextCheck)) return null;
  for (let i = turns.length - 1; i >= Math.max(0, turns.length - 32); i--) {
    for (const evidence of executions(turns[i], i).reverse()) {
      if (evidence.outputSha256 !== proposal.evidenceSha256 || evidence.cwd !== workspace
          || evidence.status !== 'fail' || evidence.generation > generation) continue;
      return { schema: 'bantam.repair-handoff.v1', authority: 'worker-proposal-linked-to-execution',
        generation, proposalTurn: turns.length, evidenceTurn: i,
        observation: { generation: evidence.generation, command: evidence.executedCommand,
          exitCode: evidence.exitCode, outputSha256: evidence.outputSha256,
          source: evidence.source, sequence: evidence.sequence },
        proposal: { ...proposal }, verified: false };
    }
  }
  return null;
}

function sourceBinding(action, readSource) {
  if (action?.a !== 'read_file' || typeof action.p !== 'string' || action.p.length > 240
      || !/^[\w./-]+$/.test(action.p) || action.p.startsWith('/') || action.p.split('/').includes('..')) return null;
  try {
    const text = readSource?.(action.p);
    if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) return null;
    return { path: action.p, sha256: crypto.createHash('sha256').update(text).digest('hex') };
  } catch { return null; }
}
function readSucceeded(turn) {
  const action = turn?.action ?? turn?.parsedAction;
  return action?.a === 'read_file' && typeof turn.observation === 'string'
    && turn.observation.startsWith(`${action.p} (`) && !turn.controllerStop;
}
function readHandoff(linked, generation, turn, source) {
  return { schema: 'bantam.repair-handoff.v3', authority: 'worker-proposals-linked-to-executions',
    generation, proposalTurn: turn, source, repairs: linked, verified: false };
}

export function createRepairHandoff(action, turns, { generation, workspace, editApplied, readApplied = false, readSource } = {}) {
  const source = readApplied ? sourceBinding(action, readSource) : null;
  if ((!editApplied && !source) || !Number.isSafeInteger(generation) || generation < 0 || !Array.isArray(turns)
      || !Array.isArray(action?.repair) || action.repair.length < 1 || action.repair.length > 4
      || JSON.stringify(action.repair).length > 4500) return null;
  const linked = action.repair.map(p => linkProposal(p, turns, { generation, workspace }));
  if (linked.some(p => !p)) return null; // atomic admission; never silently lose one correction
  if (source) return readHandoff(linked, generation, turns.length, source);
  return linked.length === 1 ? linked[0] : { schema: 'bantam.repair-handoff.v2',
    authority: 'worker-proposals-linked-to-executions', generation, proposalTurn: turns.length,
    repairs: linked, verified: false };
}

export function repairHandoffContext(turns, { generation, workspace, readSource } = {}) {
  for (let i = turns.length - 1; i >= Math.max(0, turns.length - 32); i--) {
    const turn = turns[i], action = turn.action ?? turn.parsedAction;
    if (!turn.repairHandoff) continue;
    const saved = turn.repairHandoff;
    let expected;
    if (saved.schema === 'bantam.repair-handoff.v3') {
      if (!readSucceeded(turn) || saved.source?.path !== action.p || !HASH.test(saved.source?.sha256 ?? '')
          || !Array.isArray(action.repair) || !action.repair.length || action.repair.length > 4
          || JSON.stringify(action.repair).length > 4500 || !Number.isSafeInteger(saved.generation)
          || saved.generation < 0 || saved.generation > generation) continue;
      const linked = action.repair.map(p => linkProposal(p, turns.slice(0,i), { generation: saved.generation, workspace }));
      if (linked.some(p => !p)) continue;
      expected = readHandoff(linked, saved.generation, i, saved.source);
    } else expected = createRepairHandoff(action, turns.slice(0,i), {
      generation: saved.generation, workspace, editApplied: turnEditApplied(turn) });
    if (!expected || JSON.stringify(expected) !== JSON.stringify(turn.repairHandoff)) continue;
    // Controller checks can execute after the edit in this same sealed turn.
    // Generation binding prevents pre-edit receipts from settling the repair.
    const later = turns.slice(i).flatMap((t,j) => executions(t,i+j));
    const pending = (expected.repairs ?? [expected]).filter(item => {
      const last = later.filter(e => e.cwd === workspace && e.generation === generation
        && sameAuditCommand(e.executedCommand,item.proposal.nextCheck)).at(-1);
      return last?.status !== 'pass';
    });
    if (!pending.length) return '';
    const text = '[repair handoff; advisory, NOT verification evidence]\n'
      + pending.map(item => {
        const last = later.filter(e => e.cwd === workspace && e.generation === generation
          && sameAuditCommand(e.executedCommand,item.proposal.nextCheck)).at(-1);
        return 'Observed process receipt (execution/exit only): ' + JSON.stringify(item.observation)
        + '\nWorker-proposed fixture, implementation decision or expectation correction (NOT independently established): '
        + JSON.stringify(item.proposal)
        + (last ? '\nCurrent matching check most recently exited ' + last.exitCode + '; recorded status: ' + last.status + '.' : '');
      }).join('\n')
      + (expected.source ? '\nRetained across a read; source binding: ' + JSON.stringify(expected.source)
        + (sourceBinding(action, readSource)?.sha256 === expected.source.sha256
          ? '. Current source hash matches; the decision is still only a hypothesis.'
          : '. Source differs or is unavailable: re-evaluate the proposal against current bytes.') : '')
      + '\nProposed at generation ' + expected.generation + '; current generation ' + generation + '. '
      + (expected.generation === generation ? 'The proposal remains unverified. ' : 'Source has changed since this proposal; re-evaluate it against current bytes. ')
      + 'These checks have no matching current successful execution, or most recently exited with a failure; do not claim they passed. '
      + 'Carry forward all still-unapplied corrections. Use the public contract to judge expectations, not candidate output. '
      + 'Execute the checks; existing focused/project completion gates still apply.';
    return text.length <= 8000 ? text : '';
  }
  return '';
}

export function repairHandoffOffer(turn, { generation, workspace, index = turn?.i ?? turn?.verificationReceipts?.turn ?? 0 } = {}) {
  const evidence = executions(turn,index).filter(e => e.generation === generation && e.cwd === workspace).at(-1);
  if (!evidence || evidence.status !== 'fail') return '';
  return '[repair context] Preserve a concrete implementation decision OR mistaken test-expectation correction before a read or edit using the optional repair array on read_file or edit actions (1-4 records, <=4500 chars total; keys in this order): '
    + JSON.stringify({ evidenceSha256: evidence.outputSha256, fixture: 'exact input/call (<=700 chars)',
      priorExpected: 'current mistaken behavior or expectation', proposedExpected: 'exact intended correction/invariant',
      requirement: 'public-contract reason', nextCheck: 'direct assertion command' })
    + '. Other text fields <=400 chars. This current receipt came from ' + evidence.source + ', generation ' + generation + '. '
    + 'These are unverified proposals, never PASS receipts. Retain corrections not applied by this action so the next turn need not derive them again. '
    + 'Use available atomic patch for multiple understood corrections; do not invent changes merely to use it. '
    + 'If you reason out a repair then read source before editing, attach that decision to read_file so the next edit retains it. '
    + 'Write/run the assertions; never change an expectation merely to match candidate output. Omit repair when no concrete correction has been identified.';
}
