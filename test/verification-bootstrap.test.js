import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pendingInitialVerifier } from '../src/verification-bootstrap.js';
import { runAgent } from '../src/agent.js';
import { QWEN_ASSISTANT_PREFILL } from '../src/profiles.js';

const baseline = { complete: true, initialPaths: ['package.json', 'test'], excludedPaths: [] };
const options = { command: 'npm test', provenance: baseline,
  readFile: () => JSON.stringify({ scripts: { test: 'node test/smoke.js' } }), exists: () => false };

test('a premature completion names the missing check and invokes reasoning before the next action', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-missing-check-response-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node test/smoke.js' } }));
  fs.mkdirSync(path.join(workspace, 'src')); fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src/add.cjs'), 'module.exports = (a, b) => a + b;\n');
  const actions = [
    { a: 'respond', text: 'The complete implementation is ready for testing.' },
    { a: 'write_file', p: 'test/smoke.js', content: "const assert = require('node:assert/strict'); assert.equal(require('../src/add.cjs')(2, 3), 5);\n" },
  ];
  const calls = []; let observed = 0;
  const result = await runAgent({ workspace, task: 'Build and verify the addition implementation.',
    maxTurns: Infinity, shouldAbort: () => observed >= 2, thinkMode: 'auto',
    useGrammar: true, grounding: false, preGate: false, shellSandbox: 'host',
    verificationScript: 'npm test', autoVerifyBlindEdits: 1, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    completionAudit: false, progressAwareness: false,
    model: { assistantPrefill: QWEN_ASSISTANT_PREFILL, stop: [], async complete(prompt, options) {
      calls.push({ prompt, thought: !options.grammar });
      return { content: options.grammar ? JSON.stringify(actions.shift()) : 'The implementation needs meaningful executable checks before completion.', tokens: 12, stoppedEos: true };
    } }, onEvent: event => { if (event.type === 'observation') observed++; },
  });
  assert.match(result.turns[0].observation, /^\[implementation-response\] Completion is blocked: npm test cannot run because test\/smoke.js is still missing/);
  assert.equal(result.reachedDone, false);
  assert.deepEqual(calls.map(call => call.thought), [true, false, true, false]);
  assert.match(calls[2].prompt, /test\/smoke\.js is still missing/);
  assert.equal(result.turns[1].editApplied, true);
  assert.equal(result.turns[1].verificationEvidence.status, 'pass', 'the new actual check runs; the earlier claim supplies no proof');
});

test('defer a proven absent starter entrypoint until it exists, preserving removed checks and changed scripts', () => {
  assert.equal(pendingInitialVerifier(options), 'test/smoke.js');
  assert.equal(pendingInitialVerifier({ ...options, command: 'node test/smoke.js' }), 'test/smoke.js');
  assert.equal(pendingInitialVerifier({ ...options, observedPaths: new Set(['src/main.js', 'src/utils.js']) }), 'test/smoke.js');
  for (const overrides of [
    { observedPaths: new Set(['test/smoke.js']) }, { observedPaths: new Set(['package.json']) }, { exists: () => true },
    { exists: () => { throw Error('access denied'); } },
    { provenance: { ...baseline, complete: false } },
    { provenance: { ...baseline, initialPaths: [...baseline.initialPaths, 'test/smoke.js'] } },
    { provenance: { ...baseline, excludedPaths: ['test'] } },
    { command: 'node --test' }, { command: 'node test/smoke.js || true' }, { command: 'node ../test.js' },
    { readFile: () => JSON.stringify({ scripts: { test: 'node test/smoke.js', pretest: 'node generate.js' } }) },
  ]) assert.equal(pendingInitialVerifier({ ...options, ...overrides }), null);
});

test('planning in a starter does not produce a phantom failing test; creating the check arms cadence', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-verifier-bootstrap-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node test/smoke.js' } }));
  fs.mkdirSync(path.join(workspace, 'test'));
  const actions = [
    { a: 'write_file', p: 'PROGRESS.md', content: '# Plan\nBuild the first milestone and its smoke check.\n' },
    { a: 'list_dir', p: '.' },
    { a: 'write_file', p: 'src/add.cjs', content: 'module.exports = (a, b) => a + b;\n' },
    { a: 'write_file', p: 'test/smoke.js', content: "const assert = require('node:assert/strict'); assert.equal(require('../src/add.cjs')(2, 3), 5); console.log('smoke completed');\n" },
    { a: 'respond', text: 'First check passed.' },
  ];
  const events = [];
  const result = await runAgent({ workspace, task: 'Plan a new project and create a first smoke check.',
    model: { assistantPrefill: '', async complete() {
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
    } }, maxTurns: 5, interactive: true, useGrammar: false, grounding: false, preGate: false,
    verificationScript: 'npm test', autoVerifyBlindEdits: 1, autoVerifyProbes: 0, autoVerifyStaleTurns: 1,
    shellSandbox: 'host', completionAudit: false, progressAwareness: false,
    onEvent: e => events.push(e) });
  assert.equal(events.filter(e => e.type === 'auto_verify_deferred').length, 1);
  assert.equal(events.filter(e => e.type === 'auto_verify').length, 1);
  assert.equal(events.find(e => e.type === 'auto_verify').verdict, 'PASS');
  assert.doesNotMatch(result.turns[0].observation, /verification: fail|MODULE_NOT_FOUND/);
  assert.ok(!result.turns[0].verificationEvidence, 'deferral never fabricates a passing receipt');
  assert.ok(!result.turns[2].verificationEvidence, 'a source module cannot make an absent verifier runnable');
});

test('resuming a missing starter check permits building and restores failure guidance once the check exists', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-bootstrap-resume-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node test/smoke.js' } }));
  fs.mkdirSync(path.join(workspace, 'test'));
  for (const file of ['a.txt', 'b.txt', 'c.txt', 'DESIGN.md']) fs.writeFileSync(path.join(workspace, file), `Requirements in ${file}\n`);
  const settings = { workspace, task: 'Build the project described in DESIGN.md and verify its behavior.',
    maxTurns: 100, interactive: false, useGrammar: true, grounding: false, preGate: false,
    verificationScript: 'npm test', autoVerifyBlindEdits: 1, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    shellSandbox: 'host', completionAudit: false, progressNudgeAfter: 2, promptTrajectory: 'extension' };
  async function phase(actions, extra = {}) {
    const controller = new AbortController(), calls = [], events = [];
    const result = await runAgent({ ...settings, ...extra, signal: controller.signal,
      model: { assistantPrefill: '', async complete(prompt, options) {
        calls.push({ prompt, options });
        if (!actions.length) controller.abort();
        return { content: JSON.stringify(actions.shift() ?? { a: 'respond', text: 'Checkpoint.' }), tokens: 1, stoppedEos: true, timings: {} };
      } }, onEvent: e => events.push(e) });
    return { result, calls, events };
  }
  const first = await phase([
    { a: 'write_file', p: 'PROGRESS.md', content: '# Plan\nBuild the initial milestone and its checks.\n' },
    { a: 'shell', c: 'npm test' },
    { a: 'write_file', p: 'src/main.js', content: 'export const milestone = 1;\n' },
    { a: 'shell', c: 'npm test' },
  ]);
  assert.equal(first.result.turns[1].verificationEvidence.status, 'fail');
  const resumed = await phase([
    ...['a.txt', 'b.txt', 'c.txt', 'DESIGN.md'].map(p => ({ a: 'read_file', p })),
    { a: 'write_file', p: 'test/smoke.js', content: "throw new Error('Milestone not implemented');\n" },
    { a: 'read_file', p: 'test/smoke.js' },
  ], { resumeTurns: first.result.turns });
  const decision = prompt => prompt.slice(prompt.lastIndexOf('[verification workflow: current decision]'));
  assert.match(decision(resumed.calls[0].prompt), /was absent from the supplied starter and is still missing/);
  assert.match(decision(resumed.calls[0].prompt), /failed receipt remains recorded/);
  assert.doesNotMatch(decision(resumed.calls[0].prompt), /actual failing API call/);
  assert.match(resumed.calls[2].options.grammar, /read_file/, 'the recovery mask must not force a nonexistent check');
  assert.equal(resumed.events.filter(e => e.type === 'verification_recovery_mask').length, 0);
  assert.equal(resumed.result.turns[1].verificationEvidence.status, 'fail', 'the resumed failed receipt is retained');
  assert.equal(resumed.events.find(e => e.type === 'auto_verify').verdict, 'FAIL');
  assert.match(decision(resumed.calls[5].prompt), /actual failing API call/);
  assert.doesNotMatch(decision(resumed.calls[5].prompt), /was absent from the supplied starter/);
  assert.equal(resumed.result.done, false);
});
