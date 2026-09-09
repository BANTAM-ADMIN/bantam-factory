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

for (const via of ['read_file','inspect']) test(`fresh required ${via} windows survive the no-progress threshold`, async t => {
  const { dir } = fixture(t), events = [], controller = new AbortController();
  const actions = Array.from({length:12},(_,i)=>{
    const read={a:'read_file',p:'DESIGN.md',start:1+i*12,limit:12};
    return via==='inspect'?{a:'inspect',ops:[read]}:read;
  });
  const result=await runAgent({workspace:dir,task:'Build the app specified in DESIGN.md. Read all requirements before writing its implementation.',
    model:{assistantPrefill:'',async complete(){return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true,timings:{}};}},
    maxTurns:100,interactive:false,useGrammar:false,grounding:false,openFilesView:false,signal:controller.signal,
    shellSandbox:'host',promptTrajectory:'extension',progressNudgeAfter:3,
    onEvent:e=>{
      events.push(e);
      if (events.filter(event=>event.type==='spec_read_progress').length===12) controller.abort();
    }});
  assert.equal(events.filter(e=>e.type==='spec_read_progress').length,12);
  assert.equal(result.metrics.progressNudges,0);
  assert.equal(result.metrics.progressGateRejections,0);
});

test('repeated clipped requirements do not earn credit for their undelivered tail', async t => {
  const {dir}=fixture(t),events=[],controller=new AbortController();
  const actions=Array.from({length:9},(_,i)=>({a:'read_file',p:'DESIGN.md',start:1,limit:300+i}));
  await runAgent({workspace:dir,task:'Build the app specified in DESIGN.md. Read all requirements before writing its implementation.',
    model:{assistantPrefill:'',async complete(){return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true,timings:{}};}},
    maxTurns:100,interactive:false,useGrammar:false,grounding:false,openFilesView:false,signal:controller.signal,
    shellSandbox:'host',promptTrajectory:'extension',progressNudgeAfter:3,
    onEvent:e=>{events.push(e);if(e.type==='progress_nudge')controller.abort();}});
  assert.equal(events.filter(e=>e.type==='spec_read_progress').length,1);
  assert.ok(events.some(e=>e.type==='progress_nudge'));
  assert.ok(events.find(e=>e.type==='spec_read_progress').end<300);
});

for (const via of ['read_file', 'inspect']) test(`fresh ${via} windows of resumed worker source remain inspectable`, async t => {
  const { dir } = fixture(t), events = [], controller = new AbortController();
  const source = Array.from({ length: 200 }, (_, i) => `// Contract ${i}: ${'implementation detail '.repeat(12)}`).join('\n');
  fs.writeFileSync(path.join(dir, 'app.js'), source);
  let calls = 0;
  await runAgent({ workspace: dir, task: 'Finish the application.', maxTurns: 100, interactive: false,
    grounding: false, openFilesView: false, useGrammar: false, shellSandbox: 'host', progressNudgeAfter: 3,
    promptTrajectory: 'extension', signal: controller.signal,
    resumeTurns: [{ action: { a: 'write_file', p: 'app.js', content: source }, editApplied: true, observation: 'wrote app.js' }],
    model: { assistantPrefill: '', async complete() {
      const read = { a: 'read_file', p: 'app.js', start: 1 + calls++ * 12, limit: 12 };
      return { content: JSON.stringify(via === 'inspect' ? { a: 'inspect', ops: [read] } : read), tokens: 1, stoppedEos: true, timings: {} };
    } }, onEvent: e => {
      events.push(e);
      if (events.filter(e => e.type === 'source_read_progress').length === 12) controller.abort();
    },
  });
  assert.equal(events.filter(e => e.type === 'source_read_progress').length, 12);
  assert.ok(events.every(e => !['progress_nudge', 'progress_gate'].includes(e.type)));
});

test('a rejected edit does not turn arbitrary reconnaissance into authored-source progress', async t => {
  const { dir } = fixture(t), events = [], controller = new AbortController();
  fs.copyFileSync(path.join(dir, 'DESIGN.md'), path.join(dir, 'unrelated.txt'));
  let calls = 0;
  await runAgent({ workspace: dir, task: 'Finish the application.', maxTurns: 100, interactive: false,
    grounding: false, openFilesView: false, useGrammar: false, shellSandbox: 'host', progressNudgeAfter: 3,
    signal: controller.signal,
    resumeTurns: [{ action: { a: 'write_file', p: 'unrelated.txt', content: 'rejected' }, editApplied: false, observation: 'edit rejected' }],
    model: { assistantPrefill: '', async complete() {
      return { content: JSON.stringify({ a: 'read_file', p: 'unrelated.txt', start: 1 + calls++ * 12, limit: 12 }), tokens: 1, stoppedEos: true, timings: {} };
    } }, onEvent: e => { events.push(e); if (e.type === 'progress_nudge') controller.abort(); },
  });
  assert.ok(events.some(e => e.type === 'progress_nudge'));
  assert.ok(events.every(e => e.type !== 'source_read_progress'));
});

test('owned source rereads earn fresh credit only after the bytes change', async t => {
  const { dir } = fixture(t), events = [], controller = new AbortController();
  const actions = [
    { a: 'write_file', p: 'app.js', content: 'export const value = 1;\n' },
    { a: 'read_file', p: 'app.js', start: 1, limit: 100 },
    { a: 'read_file', p: 'app.js', start: 1, limit: 200 },
    { a: 'replace', p: 'app.js', old: 'value = 1', new: 'value = 2' },
    { a: 'read_file', p: 'app.js', start: 1, limit: 100 },
  ];
  await runAgent({ workspace: dir, task: 'Build the application.', maxTurns: 100, interactive: false,
    grounding: false, openFilesView: false, useGrammar: false, shellSandbox: 'host', signal: controller.signal,
    model: { assistantPrefill: '', async complete() {
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
    } }, onEvent: e => {
      events.push(e);
      if (events.filter(e => e.type === 'source_read_progress').length === 2) controller.abort();
    },
  });
  assert.equal(actions.length, 0, 'the unchanged reread did not earn credit');
  assert.equal(events.filter(e => e.type === 'source_read_progress').length, 2);
  assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /value = 2/);
});
