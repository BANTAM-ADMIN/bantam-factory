import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Executor } from '../src/executor.js';
import { clipReadObservation } from '../src/read-observation.js';
import { buildPrompt } from '../src/prompt.js';
import { deliveredReadRange, runAgent } from '../src/agent.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-read-window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = Array.from({ length: 650 }, (_, i) => `Requirement ${i + 1}: ${'complete source bytes 🐓 '.repeat(12)}`);
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), lines.join('\n'));
  return { dir, lines, exec: new Executor(dir) };
}

function verifyReceipt(action, text, lines) {
  const range = deliveredReadRange(action, text);
  assert.ok(range, 'complete source lines must have a receipt');
  assert.match(text, new RegExp(`showing ${range.start}-${range.end}\\)`));
  for (let line = range.start; line <= range.end; line++) assert.ok(text.includes(`\n${line}\t${lines[line - 1]}\n`));
  if (range.end < lines.length) assert.match(text, new RegExp(`(?:next unread line |"start":)${range.end + 1}`));
  return range;
}

test('executor delivers contiguous windows and following the receipts recovers every byte', t => {
  const { exec, lines } = fixture(t);
  let start = 1, count = 0;
  while (start <= lines.length) {
    const action = { a: 'read_file', p: 'DESIGN.md', start, limit: 400 };
    const observation = exec.readFile(action);
    assert.ok(observation.length <= 24000);
    assert.doesNotMatch(observation, /chars clipped/);
    const range = verifyReceipt(action, observation, lines);
    count += range.end - range.start + 1;
    start = range.end + 1;
  }
  assert.equal(count, lines.length);
});

for (const cap of [4000, 24000]) test(`literal prompt read receipts remain truthful at ${cap} characters with controller guidance`, t => {
  const { exec, lines } = fixture(t), receipts = [], cache = new Map();
  const action = { a: 'read_file', p: 'DESIGN.md', start: 1, limit: 400 };
  const observation = exec.readFile(action) + '\n[requirement-checklist] Keep every public contract item.\n';
  const turn = { i: 0, action, observation };
  const options = { task: 'Read DESIGN.md.', env: '', turns: [turn], readObservationMaxChars: cap,
    extensionTrajectory: true, renderCache: cache, preserveSlimmedControlAnnotations: true, onRenderedObservation: (_, text) => receipts.push(text) };
  const first = buildPrompt(options);
  assert.ok(receipts[0].length <= cap);
  verifyReceipt(action, receipts[0], lines);
  assert.match(receipts[0], /\[requirement-checklist\] Keep every public contract item/);
  const second = buildPrompt({ ...options, turns: [turn, { i: 1, action: { a: 'list_dir', p: '.' }, observation: 'DESIGN.md' }] });
  assert.ok(second.startsWith(first), 'receipt repair does not break the frozen prefix');
});

test('inspect preserves a truthful range for each bounded read', t => {
  const { exec, lines } = fixture(t);
  const ops = [1, 200, 400].map(start => ({ a: 'read_file', p: 'DESIGN.md', start, limit: 100 }));
  const observation = exec.inspect({ ops });
  assert.ok(observation.length <= 4000);
  for (const op of ops) verifyReceipt(op, observation, lines);
  assert.match(observation, /clipped ops/);
  const tighter = clipReadObservation(observation, 3000);
  assert.ok(tighter.length <= 3000);
  for (const op of ops) verifyReceipt(op, tighter, lines);
});

test('oversized single lines are explicit partial previews, never read coverage', t => {
  const { dir, exec } = fixture(t);
  fs.writeFileSync(path.join(dir, 'one.md'), '🐓'.repeat(30000));
  const op = { a: 'read_file', p: 'one.md' }, observation = exec.readFile(op);
  assert.ok(observation.length <= 24000);
  assert.equal(deliveredReadRange(op, observation), null);
  assert.match(observation, /no complete lines delivered/);
  assert.doesNotMatch(observation, /end of file|showing/);
});

test('tiny and repeated clipping budgets remain bounded', t => {
  const { exec } = fixture(t);
  const read = exec.readFile({ p: 'DESIGN.md' }) + '\n[guidance] ' + '🐓'.repeat(500);
  const batch = '# 1 {"a":"read_file","p":"DESIGN.md"}\n' + read;
  for (const cap of [0, 1, 2, 10, 100, 500, 4000]) for (const input of [read, batch]) {
    const result = clipReadObservation(input, cap);
    assert.ok(result.length <= cap);
    assert.equal(clipReadObservation(result, cap), result);
    assert.ok(result.isWellFormed());
  }
});

for (const via of ['read_file', 'inspect']) test(`user-supplied specification stays readable through ${via} after three windows`, async t => {
  const { dir } = fixture(t);
  const prompts = [], events = [];
  const actions = [1, 21, 41, 61].map(start => {
    const read = { a: 'read_file', p: './DESIGN.md', start, limit: 20 };
    return via === 'inspect' ? { a: 'inspect', ops: [read] } : read;
  });
  actions.push({ a: 'respond', text: 'Read.' });
  const result = await runAgent({ workspace: dir, task: 'Read DESIGN.md to understand the requirements.',
    model: { assistantPrefill: '', async complete(prompt) {
      prompts.push(String(prompt));
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
    } }, maxTurns: 6, interactive: true, useGrammar: false, grounding: false, openFilesView: false,
    verificationPolicy: 'after_edit', shellSandbox: 'host', promptTrajectory: 'extension',
    onEvent: event => events.push(event) });
  assert.equal(result.responded, true);
  assert.ok(events.every(event => event.type !== 'paging_steer'));
  assert.ok(prompts.every(prompt => !prompt.includes('STOP paging')));
});
