import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { QWEN_ASSISTANT_PREFILL } from '../src/profiles.js';
import { inspectionCheckpointText } from '../src/thinking.js';

test('a long local inspection can reconsider and persist its next milestone without losing action access', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-inspection-checkpoint-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'DESIGN.md'), 'Build the complete application.\n'.repeat(300));
  const resumeTurns = Array.from({ length: 12 }, (_, i) => ({ i,
    action: { a: 'read_file', p: 'DESIGN.md', start: 1 + i * 20, limit: 20 },
    observation: `DESIGN.md (300 lines, showing ${1 + i * 20}-${20 + i * 20}):\n`
      + Array.from({ length: 20 }, (_, j) => `${1 + i * 20 + j}\tBuild the complete application.`).join('\n') + '\n',
  }));
  // The whole prerequisite was actually present in an earlier outgoing
  // prompt. The resumed model must not be told it has never read that spec.
  resumeTurns[0].prompt = 'DESIGN.md (301 lines, showing 1-301):\n'
    + Array.from({ length: 301 }, (_, i) => `${i + 1}\t${i < 300 ? 'Build the complete application.' : ''}\n`).join('');
  const calls = [], events = [], actions = [
    { a: 'write_file', p: 'PROGRESS.md', content: 'Next milestone: implement the parser and test malformed input.\n' },
    { a: 'respond', text: 'Checkpoint saved; work remains.' },
  ];
  const result = await runAgent({ workspace,
    task: 'Build the application specified in DESIGN.md. Keep a progress record.\n' + 'Preserve every required behavior.\n'.repeat(100),
    resumeTurns, maxTurns: 14, thinkMode: 'auto', inspectionCheckpointAfter: 12,
    promptTrajectory: 'extension', goalReanchor: true, goalReanchorAfter: 0,
    grounding: false, openFilesView: false, useGrammar: true, shellSandbox: 'host',
    verificationPolicy: 'after_edit', progressAwareness: false,
    model: { assistantPrefill: QWEN_ASSISTANT_PREFILL, stop: ['<|im_end|>'], async complete(prompt, options) {
      calls.push({ prompt, options });
      return { content: !options.grammar
        ? 'I have the required context. Save the next parser milestone in the progress record, then implement it.'
        : JSON.stringify(actions.shift()), tokens: 20, stoppedEos: true, timings: {} };
    } }, onEvent: event => events.push(event),
  });
  assert.equal(events.filter(e => e.type === 'inspection_checkpoint').length, 1);
  assert.ok(calls[0].prompt.includes(inspectionCheckpointText(12)), 'the entire checkpoint must reach the reasoning request');
  assert.ok(calls[1].prompt.includes(inspectionCheckpointText(12)), 'the action also sees the milestone review');
  assert.match(calls[0].prompt, /DESIGN\.md: all 301 lines delivered previously/);
  assert.match(calls[1].prompt, /not a claim of understanding, current context residency or correct implementation/);
  assert.match(calls[1].options.grammar, /read_file/, 'missing prerequisites remain inspectable');
  assert.match(calls[1].options.grammar, /write_file/, 'implementation remains available');
  assert.equal(result.turns[12].editApplied, true);
  assert.match(fs.readFileSync(path.join(workspace, 'PROGRESS.md'), 'utf8'), /Next milestone: implement the parser/);
  assert.equal(result.metrics.thinkPhases, 1, 'the write ends the inspection streak');
  assert.ok(events.some(e => e.type === 'required_read_history' && e.history.files[0].total === 301), 'compact delivery history survives when full prompt saving is off');
});
