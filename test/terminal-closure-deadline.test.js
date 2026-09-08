import test from 'node:test';
import assert from 'node:assert/strict';
import {wallClosureDue, wallClosureReserveMs, terminalClosureEligible} from '../src/terminal-closure.js';

// A turn budget cannot see the clock. A run whose work is already verified green
// should spend its last seconds emitting DONE rather than being killed mid-turn.

test('no deadline never forces closure', () => {
  for (const deadlineMs of [null, undefined, 0, -1, NaN, 'x']) {
    assert.equal(wallClosureDue({startedAtMs: 0, nowMs: 10 ** 9, deadlineMs}), false, String(deadlineMs));
  }
});

test('closure is due only once the reserve for a final action is reached', () => {
  const deadlineMs = 600000, reserve = wallClosureReserveMs(deadlineMs);
  assert.equal(wallClosureDue({startedAtMs: 0, nowMs: 0, deadlineMs}), false);
  assert.equal(wallClosureDue({startedAtMs: 0, nowMs: deadlineMs - reserve - 1, deadlineMs}), false);
  assert.equal(wallClosureDue({startedAtMs: 0, nowMs: deadlineMs - reserve, deadlineMs}), true);
  assert.equal(wallClosureDue({startedAtMs: 0, nowMs: deadlineMs * 2, deadlineMs}), true);
});

test('the reserve leaves room for one slow final turn and stays bounded', () => {
  assert.equal(wallClosureReserveMs(600000), 48000);
  assert.ok(wallClosureReserveMs(60000) >= 15000, 'a short deadline still reserves a floor');
  assert.ok(wallClosureReserveMs(36000000) <= 60000, 'a long deadline does not reserve forever');
  assert.ok(wallClosureReserveMs(600000) < 600000);
});

test('a clock that jumps backwards does not force closure', () => {
  assert.equal(wallClosureDue({startedAtMs: 10000, nowMs: 0, deadlineMs: 600000}), false);
});

const greenProof = {
  generation: 7, command: 'npm test',
  verification: {status: 'pass'},
  evidence: {schema: 1, generation: 7, configuredCommand: 'npm test', cwd: '/ws', status: 'pass',
    exitCode: 0, timedOut: false, interrupted: false, counts: {failed: 0, total: 12}},
};
const base = {
  allowance: 1, used: false, turnsUsed: 12, workTurnLimit: 60, action: {a: 'shell'},
  proof: greenProof, generation: 7, configuredCommand: 'npm test', workspace: '/ws',
  verificationWorkspaceReadOnly: false, pendingAudit: false, interrupted: false,
  controllerStopped: false, resultDone: false, freshEvidence: true,
};

test('a reached wall deadline grants the DONE-only turn before the turn budget runs out', () => {
  assert.equal(terminalClosureEligible(base), false, 'mid-run without a deadline stays a work turn');
  assert.equal(terminalClosureEligible({...base, deadlineReached: true}), true);
  assert.equal(terminalClosureEligible({...base, turnsUsed: 60}), true, 'the turn budget path still works');
});

test('a reached deadline does not bypass any existing completion gate', () => {
  for (const override of [{proof: {...greenProof, verification: {status: 'fail'}}}, {freshEvidence: false},
    {pendingAudit: true}, {interrupted: true}, {resultDone: true}, {used: true}, {allowance: 0},
    {action: {a: 'done'}}, {evidenceless: true, proof: null}]) {
    assert.equal(terminalClosureEligible({...base, deadlineReached: true, ...override}), false, JSON.stringify(Object.keys(override)));
  }
});

test('both BANTAM lanes are told the wall budget the runner will enforce', async () => {
  const {freshCommand} = await import('../scripts/factory-fights.mjs');
  const base = {task: 'T', workspace: '/tmp/ws', dir: '/tmp/d', endpoint: 'http://127.0.0.1:9999', model: 'm'};
  for (const arm of ['bantam-local-27b', 'bantam-codex-astra']) {
    assert.equal(freshCommand({...base, arm, timeoutMs: 600000}).env.BANTAM_DEADLINE_MS, '600000');
  }
  for (const arm of ['hermes', 'opencode', 'deepseek-local-27b', 'codex-astra']) {
    assert.equal(freshCommand({...base, arm, timeoutMs: 600000}).env.BANTAM_DEADLINE_MS, undefined, arm);
  }
});
