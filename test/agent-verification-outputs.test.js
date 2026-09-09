import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { RunCheckpoint } from '../src/run-checkpoint.js';
import { buildArtifact } from '../src/artifact.js';
import { verificationOutputDirectories, isDeclaredVerificationOutput } from '../src/verification-outputs.js';

function fixture(t, value = 1) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-verification-outputs-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const dir of ['src', 'test/reports', 'test/shots', 'test/fixtures']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/value.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(workspace, 'test/check.cjs'), `const fs = require('node:fs'), assert = require('node:assert/strict');
assert.equal(JSON.parse(fs.readFileSync('src/value.json')), 1);
fs.writeFileSync('test/reports/result.json', JSON.stringify({ value: 1, at: Date.now(), args: process.argv.slice(2) }));
fs.writeFileSync('test/shots/frame.png', Buffer.from([137,80,78,71]));
if (process.argv[2] === 'mutate') fs.writeFileSync(process.argv[3], '0');
if (process.argv[2] === 'fail-after-report') assert.fail('late assertion failed');
console.log('Assertion passed; reports saved');
`);
  return workspace;
}
const shell = c => ({ a: 'shell', c });
const check = shell('node test/check.cjs');
async function run(workspace, actions, overrides = {}) {
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  const result = await runAgent({
    task: 'Implement the value and verify it with node test/check.cjs.', workspace,
    model: { async complete() {
      assert.ok(actions.length, 'bounded scripted worker');
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
    } },
    maxTurns: actions.length, useGrammar: true, grounding: false, shellSandbox: 'host',
    interactive: false, completionAudit: false, stateAudit: 'off', contractStateAudit: 'off',
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    verificationOutputDirs: ['test/reports', 'test/shots'],
    onEvent: event => checkpoint.note(event), ...overrides,
  });
  return { result, checkpoint };
}

test('declared reports preserve a real passing rerun, generation and recorded output provenance', async t => {
  const workspace = fixture(t, 0);
  const { result, checkpoint } = await run(workspace, [check,
    { a: 'write_file', p: 'src/value.json', content: '1' }, check,
    shell('node test/check.cjs again')]);
  assert.equal(result.turns[0].verificationEvidence.status, 'fail');
  const passed = result.turns[2], repeated = result.turns[3];
  for (const turn of [passed, repeated]) {
    assert.equal(turn.verificationEvidence.status, 'pass', turn.observation);
    assert.equal(turn.shellExecution.invalidated, false);
    assert.equal(turn.verificationEvidence.generation, result.turns[1].verificationEvidence?.generation ?? 1);
    assert.equal(turn.shellChangedPaths, undefined);
    assert.deepEqual(turn.shellOutputPaths.sort(), ['test/reports/result.json', 'test/shots/frame.png']);
    assert.doesNotMatch(turn.observation, /verification-scope|Unresolved focused-check/);
  }
  assert.deepEqual(result.turns[0].contextBasis.verificationOutputDirs, ['test/reports', 'test/shots']);
  const artifact = buildArtifact({ runId: 'report-outputs', stamp: 'test', result });
  for (const turns of [artifact.turns, checkpoint.turns()]) {
    assert.deepEqual(turns[2].shellOutputPaths, passed.shellOutputPaths);
    assert.equal(turns[2].verificationEvidence.status, 'pass');
  }
  const resumed = await run(workspace, [shell('node test/check.cjs resumed')], {
    resumeTurns: JSON.parse(JSON.stringify(result.turns)), maxTurns: result.turns.length + 1,
  });
  assert.equal(resumed.result.turns.at(-1).verificationEvidence.generation, passed.verificationEvidence.generation);
  assert.equal(resumed.result.turns.at(-1).verificationEvidence.status, 'pass');
});

test('report-looking files receive no exemption without an operator declaration', async t => {
  const { result } = await run(fixture(t), [check], { verificationOutputDirs: [] });
  assert.equal(result.turns[0].verificationEvidence.status, 'unverified');
  assert.equal(result.turns[0].shellOutputPaths, undefined);
});

test('a successful project check inside a chain prevents a duplicate automatic run, then later edits rearm it', async t => {
  const workspace = fixture(t, 0);
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node test/check.cjs' } }));
  const events = [];
  const { result } = await run(workspace, [
    { a: 'write_file', p: 'src/value.json', content: '1' },
    shell('node test/check.cjs && npm test'),
    { a: 'write_file', p: 'src/extra.json', content: '2' },
    { a: 'read_file', p: 'src/value.json' },
  ], { verificationScript: 'npm test', autoVerifyStaleTurns: 2, interactive: true, onEvent: event => events.push(event) });
  assert.deepEqual(result.turns[1].verificationReceipts.entries.map(e => e.verificationEvidence?.source), ['shell'],
    'the successful chain must not be followed by a duplicate automatic project check');
  assert.equal(result.turns[1].verificationEvidence.command, 'node test/check.cjs && npm test', 'retain the actual compound receipt');
  assert.equal(result.turns[3].verificationEvidence.source, 'automatic', 'later source edits still require a fresh project check');
  assert.equal(events.filter(e => e.type === 'auto_verify').length, 1);
});

for (const target of ['src/value.json', 'test/fixtures/input.json', 'test/reports/check.js', 'test/reports/package.json']) {
  test(`a passing command that also changes ${target} still invalidates verification`, async t => {
    const { result } = await run(fixture(t), [shell(`node test/check.cjs mutate ${target}`)]);
    const turn = result.turns[0];
    assert.equal(turn.verificationEvidence.status, 'unverified');
    assert.equal(turn.shellExecution.invalidated, true);
    assert.deepEqual(turn.shellChangedPaths, [target]);
    assert.match(turn.observation, /verification-scope/);
  });
}

test('non-verification shell writes cannot claim the report exemption', async t => {
  const { result } = await run(fixture(t), [shell("printf '{}' > test/reports/manual.json")]);
  assert.equal(result.turns[0].shellOutputPaths, undefined);
  assert.deepEqual(result.turns[0].shellChangedPaths, ['test/reports/manual.json']);
});

test('reports do not conceal a later assertion failure or uncertain shell status', async t => {
  const failed = await run(fixture(t), [shell('node test/check.cjs fail-after-report')]);
  assert.equal(failed.result.turns[0].verificationEvidence.status, 'fail');
  assert.equal(failed.result.turns[0].shellOutputPaths.length, 2);
  const masked = await run(fixture(t), [shell('node test/check.cjs fail-after-report; true')]);
  assert.equal(masked.result.turns[0].verificationEvidence.status, 'unverified');
  assert.equal(masked.result.turns[0].shellOutputPaths, undefined);
});

test('output declarations are bounded relative directories with segment boundaries', () => {
  assert.deepEqual(verificationOutputDirectories('test/reports/, test/shots,test/reports'), ['test/reports', 'test/shots']);
  for (const value of [true, ['.'], ['../reports'], ['/tmp/reports'], ['test//reports'], ['test/../src'], ['test\\reports'], [4], ['test/*']]) {
    assert.throws(() => verificationOutputDirectories(value));
  }
  assert.equal(isDeclaredVerificationOutput('test/reports-old/result.json', ['test/reports']), false);
  assert.equal(isDeclaredVerificationOutput('test/reports/nested/frame.png', ['test/reports']), true);
  for (const file of ['package-lock.json', 'jsconfig.json', 'tsconfig.test.json', 'jest.config.json', 'smoke.cjs', 'scene.ts', 'test.py']) {
    assert.equal(isDeclaredVerificationOutput('test/reports/' + file, ['test/reports']), false, file);
  }
});
