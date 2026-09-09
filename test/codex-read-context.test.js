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

test('masked and malformed retries preserve the full prefix without executing rejected actions', async t => {
  const { workspace, ops } = fixture(t);
  const prompts = [], events = [], outputs = [
    JSON.stringify({ a: 'inspect', ops }),
    JSON.stringify({ a: 'shell', c: 'touch forbidden' }),
    '{"a":"write_file","p":"forbidden","content":',
    JSON.stringify({ a: 'list_dir', p: '.' }),
    JSON.stringify({ a: 'respond', text: 'Reviewed.' }),
  ];
  const model = { codex: true, assistantPrefill: '', stop: [],
    async complete(prompt) {
      prompts.push(String(prompt));
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, timings: {} };
    } };
  const options = { workspace, model, task: 'Review the supplied source.', interactive: true,
    maxTurns: 4, maxInvalidPerTurn: 2, grounding: false, useGrammar: true,
    excludeActions: ['shell'], shellSandbox: 'host', promptTrajectory: 'extension',
    onEvent: event => events.push(event) };
  const result = await runAgent(options);
  assert.equal(prompts.length, 5);
  assert.equal(result.rejectedOutputs.length, 2);
  assert.equal(result.turns.length, 3, 'invalid attempts do not become executed work or consume action turns');
  assert.equal(result.turns[1].promptAttempts.length, 2);
  assert.equal(result.metrics.actions.shell ?? 0, 0);
  assert.equal(fs.existsSync(path.join(workspace, 'forbidden')), false);
  for (let i = 1; i < prompts.length; i++) assert.ok(prompts[i].startsWith(prompts[i - 1]), `prompt ${i} preserves its predecessor`);
  assert.ok(events.some(e => e.type === 'action' && e.promptAttempts?.length === 2));
  assert.ok(events.some(e => e.type === 'observation' && e.promptAttempts?.length === 2));
  outputs.push(JSON.stringify({ a: 'respond', text: 'Still reviewed.' }));
  await runAgent({ ...options, resumeTurns: result.turns.slice(0, 2) });
  assert.match(prompts.at(-1), /unavailable at this checkpoint|disabled by the caller/);
  assert.match(prompts.at(-1), /previous output was rejected/);
});
