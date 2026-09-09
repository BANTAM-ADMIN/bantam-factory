import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPrompt, clipKeepingControllerAnnotation } from '../src/prompt.js';
import { clipReadObservation } from '../src/read-observation.js';
import { formatWorkingNoteReanchor, deliveredReadRange, runAgent } from '../src/agent.js';
import { buildContextFlightRecorder } from '../src/context-flight-recorder.js';

const reasoning = 'The parser is written. NEXT_MILESTONE: wire the parser into the UI and test malformed input.\n'
  + 'Preserve the current module contracts.\n'.repeat(25);
const note = formatWorkingNoteReanchor({ workingNote: { turn: 42, text: reasoning }, editsSinceWorkingNote: 1 });
const action = { a: 'read_file', p: 'DESIGN.md', start: 1, limit: 100 };
const read = 'DESIGN.md (100 lines, showing 1-100):\n'
  + Array.from({ length: 100 }, (_, i) => `${i + 1}\tRequirement ${i + 1}: ${'detail '.repeat(30)}`).join('\n') + '\n';

test('a long task reminder cannot clip the current working checkpoint out of the literal read prompt', () => {
  const observation = read + '\n[guidance]\nReminder: ' + 'Build the complete requested application. '.repeat(95) + '\n' + note;
  const delivered = clipKeepingControllerAnnotation(observation, true, 4000, clipReadObservation);
  assert.ok(delivered.length <= 4000);
  assert.ok(delivered.includes(note), 'keep the decision and its hypothesis qualification whole');
  assert.ok(deliveredReadRange(action, delivered), 'the read still carries actual complete source lines');
  const options = { task: 'Build DESIGN.md.', env: '', extensionTrajectory: true, renderCache: new Map(), preserveSlimmedControlAnnotations: true,
    turns: [{ i: 0, action, observation }] };
  const first = buildPrompt(options);
  assert.ok(first.includes(note));
  const second = buildPrompt({ ...options, turns: [...options.turns,
    { i: 1, action: { a: 'list_dir', p: '.' }, observation: 'src' }] });
  assert.ok(second.startsWith(first), 'ordinary continuation retains the cached prefix');
  assert.ok(second.includes(note));
});

test('the recorder detects a checkpoint payload deletion even when the header survives', () => {
  const observation = read + '\n' + note;
  const options = { task: 'Build DESIGN.md.', env: '', preserveSlimmedControlAnnotations: true, turns: [{ i: 0, action, observation }] };
  const complete = buildPrompt(options), clipped = complete.replace(reasoning, '');
  const audit = prompt => buildContextFlightRecorder({
    turns: [{ parsedAction: action, observation }, { parsedAction: { a: 'list_dir', p: '.' }, observation: 'src' }],
    modelCalls: [{ index: 0, request: { body: JSON.stringify({ prompt: '' }) } },
      { index: 1, request: { body: JSON.stringify({ prompt }) } }],
  });
  assert.ok(clipped.includes('[working-checkpoint from turn 43;'));
  assert.equal(audit(clipped).summary.risks['guidance-block-clipped'], 1);
  assert.equal(audit(complete).summary.risks['guidance-block-clipped'] ?? 0, 0);
  const malformed = clipKeepingControllerAnnotation(read + '\n[working-checkpoint]\n' + 'unbounded '.repeat(10000));
  assert.ok(malformed.length <= 4000, 'malformed notes cannot consume unlimited context');
});

test('evicting the note-bearing turn restores the current hypothesis before the next model decision', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-checkpoint-residency-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'DESIGN.md'), Array.from({ length: 300 }, (_, i) => `Requirement ${i}: ${'detail '.repeat(40)}`).join('\n'));
  fs.writeFileSync(path.join(workspace, 'app.js'), 'export const parser = () => 1;\n');
  const controller = new AbortController(), prompts = [], events = [];
  await runAgent({ workspace, task: 'Build the app in DESIGN.md.', maxTurns: 100, interactive: false,
    grounding: false, openFilesView: false, useGrammar: false, shellSandbox: 'host', promptTrajectory: 'extension',
    signal: controller.signal, resumeTurns: [
      { i: 0, action: { a: 'list_dir', p: '.' }, observation: 'DESIGN.md' },
      { i: 1, action: { a: 'write_file', p: 'app.js', content: 'export const parser = () => 1;\n' },
        editApplied: true, observation: 'wrote app.js', reasoning },
    ],
    model: { contextWindowTokens: 8000, assistantPrefill: '', async complete(prompt) {
      prompts.push(prompt);
      if (prompts.length === 18) controller.abort();
      return { content: JSON.stringify({ ...action, start: 1 + (prompts.length - 1) * 14, limit: 14 }),
        tokens: 1, stoppedEos: true, timings: {} };
    } }, onEvent: event => events.push(event),
  });
  assert.ok(events.some(e => e.type === 'extension_history_rebase' && e.overflow));
  assert.ok(events.some(e => e.type === 'working_checkpoint_restored'));
  assert.ok(prompts.length >= 18);
  for (const prompt of prompts) assert.ok(prompt.includes(reasoning), 'every decision retains the current milestone');
});
