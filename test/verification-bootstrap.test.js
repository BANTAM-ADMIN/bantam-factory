import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pendingInitialVerifier } from '../src/verification-bootstrap.js';
import { runAgent } from '../src/agent.js';

const baseline = { complete: true, initialPaths: ['package.json', 'test'], excludedPaths: [] };
const options = { command: 'npm test', provenance: baseline,
  readFile: () => JSON.stringify({ scripts: { test: 'node test/smoke.js' } }), exists: () => false };

test('defer only a proven absent entrypoint before implementation starts', () => {
  assert.equal(pendingInitialVerifier(options), 'test/smoke.js');
  assert.equal(pendingInitialVerifier({ ...options, command: 'node test/smoke.js' }), 'test/smoke.js');
  for (const overrides of [
    { implementationStarted: true }, { exists: () => true },
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
    { a: 'write_file', p: 'test/smoke.js', content: "const assert = require('node:assert/strict'); assert.equal(1 + 1, 2); console.log('smoke completed');\n" },
    { a: 'respond', text: 'First check passed.' },
  ];
  const events = [];
  const result = await runAgent({ workspace, task: 'Plan a new project and create a first smoke check.',
    model: { assistantPrefill: '', async complete() {
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
    } }, maxTurns: 4, interactive: true, useGrammar: false, grounding: false, preGate: false,
    verificationScript: 'npm test', autoVerifyBlindEdits: 1, autoVerifyProbes: 0, autoVerifyStaleTurns: 1,
    shellSandbox: 'host', completionAudit: false, progressAwareness: false,
    onEvent: e => events.push(e) });
  assert.equal(events.filter(e => e.type === 'auto_verify_deferred').length, 1);
  assert.equal(events.filter(e => e.type === 'auto_verify').length, 1);
  assert.equal(events.find(e => e.type === 'auto_verify').verdict, 'PASS');
  assert.doesNotMatch(result.turns[0].observation, /verification: fail|MODULE_NOT_FOUND/);
  assert.ok(!result.turns[0].verificationEvidence, 'deferral never fabricates a passing receipt');
});
