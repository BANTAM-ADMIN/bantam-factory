import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { Executor } from '../src/executor.js';
import { buildPrompt } from '../src/prompt.js';

function fixture(t, lines = 35) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-source-delivery-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const names = ['packer.js', 'behavior.test.js', 'public.test.js', 'config.js'];
  for (const [i, name] of names.entries()) fs.writeFileSync(path.join(workspace, name),
    Array.from({ length: lines }, (_, j) => `export const sentinel_${i}_${j} = "source evidence ${'x'.repeat(24)}";`).join('\n'));
  return { workspace, names, ops: names.map(p => ({ a: 'read_file', p, limit: 500 })) };
}

test('Codex receives a small multi-file inspection whole through the literal outgoing prompt', async t => {
  const { workspace, ops } = fixture(t);
  const prompts = [], actions = [
    { a: 'inspect', ops }, { a: 'list_dir', p: '.' }, { a: 'respond', text: 'Reviewed.' },
  ];
  await runAgent({ workspace, task: 'Review the supplied source.', interactive: true,
    maxTurns: 4, grounding: false, useGrammar: false, shellSandbox: 'host',
    promptTrajectory: 'extension', model: { codex: true, assistantPrefill: '', stop: [],
      async complete(prompt) {
        prompts.push(String(prompt));
        return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
      } },
  });
  assert.equal(prompts.length, 3);
  for (let i = 0; i < 4; i++) {
    assert.ok(prompts[1].includes(`sentinel_${i}_0`));
    assert.ok(prompts[1].includes(`sentinel_${i}_17`));
    assert.ok(prompts[1].includes(`sentinel_${i}_34`));
  }
  assert.doesNotMatch(prompts[1], /clipped ops|chars clipped/);
  assert.ok(prompts[2].startsWith(prompts[1]), 'later turns retain the exact cacheable prefix');
});

test('local inspection remains bounded; larger Codex inspections still identify omissions', t => {
  const { workspace, ops } = fixture(t, 150);
  const local = new Executor(workspace).inspect({ ops });
  const cloud = new Executor(workspace, { inspectMaxChars: 24000 }).inspect({ ops });
  assert.ok(local.length <= 4000);
  assert.ok(cloud.length <= 24000);
  assert.match(local, /clipped ops/);
  assert.match(cloud, /clipped ops/);
});

test('larger source context does not enlarge ordinary shell output', () => {
  const prompt = buildPrompt({ task: 'Inspect results', env: '.', readObservationMaxChars: 24000,
    turns: [{ action: { a: 'shell', c: 'check' }, observation: 'A'.repeat(7000) + 'MIDDLE' + 'Z'.repeat(7000) }] });
  assert.doesNotMatch(prompt, /MIDDLE/);
  assert.match(prompt, /chars clipped/);
});
