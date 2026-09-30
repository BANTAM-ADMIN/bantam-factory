import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent.js';
import { classifyInteractiveResult } from '../src/interactive-verdict.js';

test('a GPU recovery error before inference is a model error, not a zero-turn limit', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-model-error-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const message = 'Local LLM is held for image recovery. Run :image recover before using it again.';
  const result = await runAgent({
    workspace, task: 'Hello', maxTurns: 60, interactive: true,
    grounding: false, useGrammar: false, shellSandbox: 'host',
    model: { assistantPrefill: '', async complete() { throw Error(message); } },
  });
  assert.equal(result.metrics.turns, 0);
  assert.equal(result.modelFailure.message, message);
  assert.equal(classifyInteractiveResult(result).kind, 'model_error');
  assert.equal(classifyInteractiveResult({ ...result, interrupted: true }).kind, 'interrupted');
  assert.equal(classifyInteractiveResult({ reachedDone: false, metrics: { turns: 60 } }).kind, 'paused');
});
