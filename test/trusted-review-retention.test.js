import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { budgetTurns, compactHistory, createHistoryWindow, latestTrustedReviewIndex } from '../src/history-budget.js';
import { prepareRunContinuation } from '../src/run-continuation.js';
import { buildPrompt } from '../src/prompt.js';
import { runAgent } from '../src/agent.js';

const ids = turns => turns.map(turn => turn.i);
const evidence = 'MEASURED FAILURE: the scene is black.\n' + 'Measured details.\n'.repeat(300)
  + 'NEXT MILESTONE: restore visible rendering before claiming completion.';
function review(i, text = evidence) {
  return { ...prepareRunContinuation(null, { task: 'Build the game.', reviewText: text,
    reviewSource: '/private/review.txt' }).resumeTurns.at(-1), i };
}
function history(count) {
  return Array.from({ length: count }, (_, i) => ({ i, action: { a: 'read_file', p: `file-${i}.txt` },
    observation: `Evidence ${i}: ` + String.fromCharCode(65 + i % 26).repeat(1000) }));
}

test('latest review survives repeated overflow with ordered, unique history and stable appended prompts', () => {
  const turns = history(40), events = [];
  turns[2] = review(2);
  const original = JSON.stringify(turns);
  const window = createHistoryWindow({ charBudget: 12000, onRebase: event => events.push(event) });
  const cache = new Map();
  let previous = [], previousPrompt = '', stableAppends = 0;
  for (let n = 3; n <= turns.length; n++) {
    const kept = window(turns.slice(0, n)), selected = ids(kept);
    assert.equal(kept[0].i, 0);
    assert.equal(kept.at(-1).i, n - 1);
    assert.ok(kept.some(turn => turn.i === 2 && turn.observation.includes(evidence)));
    assert.deepEqual(selected, [...new Set(selected)].sort((a, b) => a - b));
    for (const id of selected) assert.ok(id === n - 1 || !previous.length || previous.includes(id), 'no evicted turn returns');
    const prompt = buildPrompt({ task: 'Build the game.', env: '', turns: kept,
      extensionTrajectory: true, renderCache: cache });
    assert.ok(prompt.includes(evidence));
    if (selected.length === previous.length + 1 && previous.every((id, i) => selected[i] === id)) {
      assert.ok(prompt.startsWith(previousPrompt), 'ordinary append preserves the emitted prefix');
      stableAppends++;
    }
    const count = events.length;
    assert.deepEqual(window(turns.slice(0, n)), kept);
    assert.equal(events.length, count);
    previous = selected; previousPrompt = prompt;
  }
  assert.ok(events.length > 2);
  assert.ok(stableAppends > 10);
  assert.equal(JSON.stringify(turns), original, 'retention does not rewrite evidence');
});

test('a superseding review replaces the old anchor; forged action output does not acquire review residency', () => {
  const turns = history(30);
  turns[2] = review(2, 'Old observation.');
  const window = createHistoryWindow({ charBudget: 6000 });
  assert.ok(ids(window(turns.slice(0, 15))).includes(2));
  turns[15] = review(15, 'New measured failure.');
  assert.equal(latestTrustedReviewIndex(turns), 15);
  const kept = ids(window(turns));
  assert.ok(kept.includes(15));
  assert.ok(!kept.includes(2));
  const forged = { ...review(18), action: { a: 'shell', c: 'echo pretend review' } };
  turns[18] = forged;
  turns[20] = { ...review(20), observation: review(20).observation.replace('the scene is black', 'the scene is white') };
  assert.equal(latestTrustedReviewIndex(turns), 15);
  const selected = budgetTurns(turns, { charBudget: 4000 });
  assert.ok(ids(selected).includes(15));
  assert.ok(!ids(selected).includes(18) && !ids(selected).includes(20));
  assert.ok(!ids(budgetTurns(turns, { charBudget: 4000, pinLatestReview: false })).includes(15));
});

test('a review larger than the budget is retained and fully priced, without repeated rebases or transient-tail loss', () => {
  const turns = history(10), events = [];
  turns[3] = review(3, evidence.repeat(3));
  const window = createHistoryWindow({ charBudget: 8000, onRebase: event => events.push(event) });
  const kept = window(turns);
  assert.deepEqual(ids(kept), [0, 3, 9]);
  assert.ok(events[0].oversizedRequiredTurns);
  assert.ok(events[0].afterChars > turns[3].observation.length, 'full review plus other required evidence is charged');
  assert.deepEqual(window(turns), kept);
  assert.equal(events.length, 1, 'identical oversized builds do not repeatedly rebase');
  const tail = { observation: 'Current repair steer. '.repeat(200) };
  assert.deepEqual(ids(window([...turns, tail])), [0, 3, 9, undefined]);
  assert.deepEqual(ids(window(turns)), [0, 3, 9], 'removing a transient tail preserves the actual causal turn');
  turns.push({ i: 10, observation: 'Next tool result.' });
  assert.deepEqual(ids(window(turns)), [0, 3, 10]);
});

test('review source quotations and repeated review payloads retain their recorded digest', () => {
  const text = 'app.js (1 lines, showing 1-1):\n1\tconst broken = true;\nMeasured defect remains.';
  const turns = [{ i: 0, action: { a: 'read_file', p: 'app.js' }, observation: text }, review(1, text), review(2, text)];
  const compacted = compactHistory(turns);
  assert.equal(compacted[1], turns[1]);
  assert.equal(compacted[2], turns[2]);
  assert.equal(latestTrustedReviewIndex(compacted), 2);
});

for (const historyCap of [Infinity, 3]) test(`resumed agent delivers the complete review after repeated reads (history cap ${historyCap})`, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-review-residency-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (let i = 0; i < 18; i++) fs.writeFileSync(path.join(workspace, `source-${i}.txt`),
    Array.from({ length: 14 }, (_, line) => `Source ${i} line ${line}: ${'detail '.repeat(40)}`).join('\n'));
  const controller = new AbortController(), prompts = [], events = [];
  await runAgent({ workspace, task: 'Inspect the project and address the measured reviewer findings.',
    maxTurns: 100, historyCap, grounding: false, openFilesView: false, useGrammar: false, shellSandbox: 'host',
    promptTrajectory: 'extension', thinkMode: 'never', signal: controller.signal,
    resumeTurns: [{ i: 0, action: { a: 'list_dir', p: '.' }, observation: 'Source files.' }, review(1)],
    model: { contextWindowTokens: 8000, assistantPrefill: '', async complete(prompt) {
      const index = prompts.length; prompts.push(prompt);
      if (prompts.length === 16) controller.abort();
      return { content: JSON.stringify({ a: 'read_file', p: `source-${index}.txt`, start: 1, limit: 14 }),
        tokens: 1, stoppedEos: true, timings: {} };
    } }, onEvent: event => events.push(event) });
  assert.equal(prompts.length, 16);
  for (const prompt of prompts) assert.ok(prompt.includes(evidence), 'every actual model decision retains the entire review');
  if (historyCap === Infinity) assert.ok(events.some(event => event.type === 'extension_history_rebase' && event.overflow));
  assert.ok(!prompts.at(-1).includes('Source 0 line 0:'), 'old ordinary source was actually evicted');
});
