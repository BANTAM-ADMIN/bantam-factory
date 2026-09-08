import test from 'node:test';
import assert from 'node:assert/strict';
import {freshCommand} from '../scripts/factory-fights.mjs';
import {historyCharBudget, HISTORY_CHARS_PER_TOKEN, HISTORY_MAX_HISTORY_TOKENS} from '../src/history-budget.js';

// A fixed character budget cannot know the served context window. Compacting far
// below it wastes the window and, because an eviction rebases the prompt prefix,
// forces the server to re-prefill every surviving turn.

test('extension budget is derived from the served window instead of a fixed constant', () => {
  const derived = historyCharBudget({contextTokens: 72192, extensionTrajectory: true});
  assert.ok(derived > 120000, `expected more than the old fixed 120000, got ${derived}`);
  assert.ok(derived / HISTORY_CHARS_PER_TOKEN < 72192, 'history alone must not claim the whole window');
  // Reserve real room for the non-history prompt and the response.
  assert.ok(derived / HISTORY_CHARS_PER_TOKEN <= 72192 * 0.7, 'must leave headroom');
});

test('a small served window shrinks the budget so history cannot overflow it', () => {
  const small = historyCharBudget({contextTokens: 8192, extensionTrajectory: true});
  assert.ok(small < 120000, 'an 8K window must not keep the 120000-char default');
  assert.ok(small / HISTORY_CHARS_PER_TOKEN < 8192, 'derived history must fit inside the window');
});

test('a very large window is capped where small-model action discipline degrades', () => {
  const huge = historyCharBudget({contextTokens: 1000000, extensionTrajectory: true});
  assert.equal(huge, HISTORY_MAX_HISTORY_TOKENS * HISTORY_CHARS_PER_TOKEN);
});

test('an explicit operator override always wins and an unknown window keeps the documented defaults', () => {
  assert.equal(historyCharBudget({contextTokens: 72192, extensionTrajectory: true, override: 4242}), 4242);
  assert.equal(historyCharBudget({extensionTrajectory: true}), 120000);
  assert.equal(historyCharBudget({extensionTrajectory: false}), 36000);
  for (const bad of [null, 0, -5, 'x', NaN, 1.5]) {
    assert.equal(historyCharBudget({contextTokens: bad, extensionTrajectory: true}), 120000);
  }
});

test('the panel trajectory keeps its narrower budget on this window and still shrinks on a small one', () => {
  const panel = historyCharBudget({contextTokens: 72192, extensionTrajectory: false});
  assert.ok(Math.abs(panel - 36000) <= 2000, `panel budget should stay near 36000, got ${panel}`);
  assert.ok(historyCharBudget({contextTokens: 8192, extensionTrajectory: false}) < 36000);
});

test('the local BANTAM lane carries the inspected window to the agent; other lanes do not', () => {
  const base = {task: 'T', workspace: '/tmp/ws', dir: '/tmp/d', endpoint: 'http://127.0.0.1:9999', model: 'm'};
  const local = freshCommand({...base, arm: 'bantam-local-27b', contextTokens: 72192});
  assert.equal(local.env.BANTAM_CONTEXT_TOKENS, '72192');
  assert.equal(freshCommand({...base, arm: 'bantam-local-27b'}).env.BANTAM_CONTEXT_TOKENS, undefined);
  for (const arm of ['hermes', 'opencode', 'deepseek-local-27b', 'codex-astra', 'bantam-codex-astra']) {
    assert.equal(freshCommand({...base, arm, contextTokens: 72192}).env.BANTAM_CONTEXT_TOKENS, undefined, arm);
  }
});
