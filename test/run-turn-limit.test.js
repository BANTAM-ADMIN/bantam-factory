import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseRunTurnLimit } from '../src/run-turn-limit.js';
import { runAgent } from '../src/agent.js';
import { RunCheckpoint } from '../src/run-checkpoint.js';
import { systemPrompt } from '../src/prompt.js';

test('unlimited is explicit; resumed finite budgets must cover the restored trajectory', () => {
  assert.equal(parseRunTurnLimit(undefined), 200);
  assert.equal(parseRunTurnLimit('1500', { restoredTurns: 628 }), 1500);
  assert.equal(parseRunTurnLimit('unlimited', { restoredTurns: 1500 }), Infinity);
  for (const bad of ['Infinity', Infinity, NaN, true, 0, -1, 1.5, 'oops', '9007199254740992']) {
    assert.throws(() => parseRunTurnLimit(bad), /positive integer or unlimited/);
  }
  assert.throws(() => parseRunTurnLimit(628, { restoredTurns: 628 }), /exceed the 628 restored/);
  assert.match(systemPrompt({ maxTurns: Infinity }), /no turn deadline/);
  assert.match(systemPrompt({ maxTurns: Infinity }), /complete and verified/);
  assert.doesNotMatch(systemPrompt({ maxTurns: Infinity }), /Infinity|running out is a failure/);
});

test('an unlimited resumed build keeps working, checkpoints and stops on interruption without a landing countdown', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-unlimited-'));
  const dest = path.join(workspace, 'evidence', 'run.json');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node test/smoke.js' } }));
  const checkpoint = new RunCheckpoint({ dest, workspaceDir: workspace, autosaveEvery: 3 });
  const resumeTurns = Array.from({ length: 20 }, (_, i) => ({ i,
    action: { a: 'read_file', p: 'DESIGN.md', start: i + 1, limit: 1 }, observation: `Required feature ${i}.`,
  }));
  let observations = 0;
  const prompts = [], events = [];
  const result = await runAgent({ workspace, task: 'Build the complete application and its smoke test.',
    maxTurns: Infinity, resumeTurns, thinkMode: 'never', useGrammar: true, grounding: false,
    openFilesView: false, progressAwareness: false, shellSandbox: 'host',
    verificationScript: 'node test/smoke.js',
    shouldAbort: () => observations >= 4,
    model: { assistantPrefill: '', async complete(prompt) {
      prompts.push(prompt);
      assert.ok(prompts.length <= 4, 'interrupt must stop unlimited work');
      return { content: JSON.stringify({ a: 'write_file', p: `src/part${prompts.length}.js`,
        content: `export const part = ${prompts.length};\n` }), tokens: 8, stoppedEos: true };
    } }, onEvent(event) {
      checkpoint.note(event); events.push(event);
      if (event.type === 'observation') observations++;
    },
  });
  checkpoint.flush('operator-interrupt');
  const saved = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.equal(result.interrupted, true);
  assert.equal(result.reachedDone, false);
  assert.equal(result.turns.length, 24);
  assert.equal(result.metrics.landingNotes, 0);
  assert.equal(result.metrics.landingVerifies, 0);
  assert.equal(result.metrics.unlimitedTurns, true);
  assert.equal(result.metrics.turnLimit, null);
  assert.equal(result.verification, null, 'an interrupt must not execute the absent starter verifier');
  assert.equal(saved.partial, true);
  assert.equal(saved.turns.length, 4, 'new work remains checkpointed independently of a turn cap');
  assert.ok(saved.workspaceSnapshot.files.some(f => f.path === 'src/part3.js'));
  assert.ok(prompts.every(p => p.includes('no turn deadline') && !p.includes('[budget]')));
  assert.equal(events.some(e => e.type === 'landing_window'), false);
});
