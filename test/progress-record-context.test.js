import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { contextUpdatePromptText } from '../src/prompt.js';

test('long-run progress survives eviction, updates from authored bytes, and does not repeat on unchanged decisions', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-progress-recall-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const initial = '# Progress\n## Next milestone\nImplement the import dialog.\n## Remaining work\n- [ ] Validate malformed records.\n';
  const updated = '# Progress\n## Next milestone\nAdd cancellation to imports.\n## Remaining work\n- [ ] Validate malformed records.\n';
  fs.writeFileSync(path.join(workspace, 'PROGRESS.md'), initial);
  fs.writeFileSync(path.join(workspace, 'DESIGN.md'), Array.from({ length: 600 }, (_, i) => `Requirement ${i}: ${'precise original behavior '.repeat(8)}`).join('\n'));
  const controller = new AbortController(), prompts = [], events = [];
  const result = await runAgent({ workspace, task: 'Build DESIGN.md end to end; maintain PROGRESS.md.',
    maxTurns: Infinity, signal: controller.signal, promptTrajectory: 'extension', historyCap: 4,
    resumeTurns: [{ i: 0, action: { a: 'write_file', p: 'PROGRESS.md', content: initial },
      editApplied: true, observation: 'wrote PROGRESS.md' }],
    interactive: false, grounding: false, openFilesView: false, useGrammar: false, shellSandbox: 'host',
    progressAwareness: false, verificationPolicy: 'after_edit',
    completionAudit: false, stateAudit: 'off', contractStateAudit: 'off',
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    model: { contextWindowTokens: 8000, assistantPrefill: '', async complete(prompt) {
      prompts.push(prompt);
      if (prompts.length === 18) controller.abort();
      return { content: JSON.stringify(prompts.length === 7
        ? { a: 'write_file', p: 'PROGRESS.md', content: updated }
        : { a: 'read_file', p: 'DESIGN.md', start: prompts.length * 20, limit: 20 }),
        tokens: 1, stoppedEos: true, timings: {} };
    } }, onEvent: e => events.push(e),
  });
  assert.equal(prompts.length, 18);
  for (const [i, prompt] of prompts.entries()) {
    assert.match(prompt, /Worker-authored claims and plans, NOT verified completion evidence/);
    assert.match(prompt, /Validate malformed records/);
    assert.ok(prompt.includes(i < 7 ? 'Implement the import dialog.' : 'Add cancellation to imports.'), `decision ${i + 1}`);
  }
  const restorations = events.filter(e => e.type === 'progress_record_restored');
  assert.ok(restorations.length >= 3 && restorations.length < prompts.length / 2, 'restore on eviction/change, not each decision');
  assert.equal(new Set(restorations.map(e => e.id)).size, 2, 'unchanged file has stable identity across code/read turns');
  assert.ok(restorations.every(e => e.authority === 'worker-claims-not-verification'));
  assert.equal(result.reachedDone, false);
  assert.ok(result.turns.every(turn => !turn.verificationEvidence), 'recall supplies no passing receipt');
  for (const turn of result.turns) for (const update of turn.contextUpdates ?? []) {
    if (update.kind === 'progress') assert.ok(contextUpdatePromptText(update), 'typed full block survives normal rendering');
  }
});

test('an unrelated existing progress file is not injected into a long task', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-unowned-progress-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'TODO.md'), 'UNRELATED_PRIVATE_PLAN\n');
  const controller = new AbortController();
  await runAgent({ workspace, task: 'Explain the directory.', maxTurns: Infinity, signal: controller.signal,
    interactive: false, grounding: false, openFilesView: false, useGrammar: false, shellSandbox: 'host',
    promptTrajectory: 'extension', model: { assistantPrefill: '', async complete(prompt) {
      assert.doesNotMatch(prompt, /UNRELATED_PRIVATE_PLAN|PROGRESS RECORD SNAPSHOT/);
      controller.abort();
      return { content: JSON.stringify({ a: 'list_dir', p: '.' }), tokens: 1, stoppedEos: true };
    } } });
});
