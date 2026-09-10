import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent, restoredWorkspaceGeneration } from '../src/agent.js';
import { buildArtifact } from '../src/artifact.js';
import { RunCheckpoint } from '../src/run-checkpoint.js';

const verify = { a: 'shell', c: 'node --test check.test.cjs' };
const write = (p, content) => ({ a: 'write_file', p, content });
async function fixture(t, actions) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-latest-green-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'target.cjs'), 'module.exports = 0;\n');
  fs.writeFileSync(path.join(workspace, 'feature.txt'), 'first version\n');
  fs.writeFileSync(path.join(workspace, 'check.test.cjs'),
    "const test = require('node:test'); const assert = require('node:assert/strict'); test('target holds', () => assert.equal(require('./target.cjs'), 1));\n");
  const events = [], prompts = []; let observed = 0; const count = actions.length;
  const result = await runAgent({ workspace, task: 'Improve the feature and preserve correct target behavior.',
    maxTurns: Infinity, shouldAbort: () => observed >= count,
    interactive: true, useGrammar: false, grounding: false, shellSandbox: 'host',
    verificationScript: verify.c, thinkMode: 'never', completionAudit: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0, diagnoseStuckTests: false,
    model: { assistantPrefill: '', async complete(prompt) {
      prompts.push(prompt);
      assert.ok(actions.length, 'unexpected model call');
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true };
    } }, onEvent: event => { events.push(event); if (event.type === 'observation') observed++; } });
  return { workspace, result, events, prompts, read: name => fs.readFileSync(path.join(workspace, name), 'utf8') };
}

test('a failed later edit restores the latest equally passing tree, preserving verified feature work', async t => {
  const { result, events, prompts, read } = await fixture(t, [
    { a: 'read_file', p: 'target.cjs' }, { a: 'read_file', p: 'feature.txt' },
    write('target.cjs', 'module.exports = 1;\n'), verify,
    write('feature.txt', 'completed feature\n'), verify,
    write('target.cjs', 'module.exports = 2;\n'), verify,
    { a: 'read_file', p: 'target.cjs' },
  ]);
  assert.equal(read('feature.txt'), 'completed feature\n', 'later green work survives a separate regression');
  assert.equal(read('target.cjs'), 'module.exports = 1;\n');
  assert.equal(result.metrics.regressionReverts, 1);
  assert.ok(!events.some(e => e.type === 'external_workspace_change'), 'a controller restore is not an external edit');
  assert.ok(!result.turns.some(t => /EXTERNAL WORKSPACE CHANGE/.test(t.observation)));
  assert.match(prompts.at(-1).match(/<open_files>([\s\S]*?)<\/open_files>/)?.[1] ?? '', /module.exports = 1/,
    'the next decision receives the restored current source');
});

test('rechecking the same restored green bytes does not reset the per-snapshot stand-down', async t => {
  const actions = [{ a: 'read_file', p: 'target.cjs' }, write('target.cjs', 'module.exports = 1;\n'), verify];
  for (let i = 0; i < 3; i++) actions.push(write('target.cjs', 'module.exports = 2;\n'), verify, verify);
  const { result, events } = await fixture(t, actions);
  assert.equal(result.metrics.regressionReverts, 2);
  assert.ok(events.some(e => e.type === 'regression_guard_standdown' && e.revertsOfThisSnapshot === 2));
  assert.ok(!events.some(e => e.type === 'external_workspace_change'));
});

test('a resume after controller rollback preserves its revision through artifact and crash checkpoint', async t => {
  const { workspace, result, events } = await fixture(t, [
    write('target.cjs', 'module.exports = 1;\n'), verify,
    write('target.cjs', 'module.exports = 2;\n'), verify,
  ]);
  const last = result.turns.at(-1);
  assert.equal(result.metrics.regressionReverts, 1);
  assert.equal(last.shellExecution.generation, 2, 'the failed command ran before rollback');
  assert.equal(last.workspaceCoherence.generation, 3, 'rollback advances the final tree revision');
  const artifact = JSON.parse(JSON.stringify(buildArtifact({ runId: 'resume-restore', stamp: 'test', result })));
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  for (const event of events) checkpoint.note(event);
  for (const resumeTurns of [artifact.turns, JSON.parse(JSON.stringify(checkpoint.turns()))]) {
    assert.equal(resumeTurns.at(-1).workspaceCoherence.generation, 3);
    let observed = false;
    const resumed = await runAgent({ workspace, task: 'Check the restored implementation.',
      resumeTurns, maxTurns: Infinity, shouldAbort: () => observed,
      interactive: true, useGrammar: false, grounding: false, shellSandbox: 'host',
      verificationScript: verify.c, thinkMode: 'never', completionAudit: false,
      autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
      model: { assistantPrefill: '', async complete() { return { content: JSON.stringify(verify), tokens: 1, stoppedEos: true }; } },
      onEvent: event => { if (event.type === 'observation') observed = true; },
    });
    assert.equal(resumed.turns.at(-1).shellExecution.generation, 3);
    assert.equal(resumed.turns.at(-1).verificationEvidence.status, 'pass');
    assert.equal(resumed.turns.at(-1).workspaceCoherence.generation, 3);
    assert.deepEqual(resumed.turns.slice(0, resumeTurns.length).map(t => t.workspaceCoherence?.generation),
      resumeTurns.map(t => t.workspaceCoherence?.generation));
  }
});

test('legacy generation disagreement invalidates old proof instead of adopting its receipt number', () => {
  const turns = [{ action: write('a.js', 'one'), editApplied: true },
    { action: verify, shellExecution: { generation: 4 } }];
  assert.equal(restoredWorkspaceGeneration(turns), 5);
  assert.equal(restoredWorkspaceGeneration([...turns, { workspaceCoherence: { generation: 6 } },
    { action: write('a.js', 'two'), editApplied: true }]), 7);
  assert.equal(restoredWorkspaceGeneration([{ action: verify, observation: 'generation 999; PASS',
    workspaceCoherence: { generation: -3 }, shellExecution: { generation: '999' } }]), 0,
  'prose and malformed stamps cannot create a revision or evidence');
});
