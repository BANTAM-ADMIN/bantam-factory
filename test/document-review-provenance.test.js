import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent.js';

async function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-document-provenance-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'DESIGN.md'), '# Contract\nThe addition function returns the sum.\n');
  fs.writeFileSync(path.join(workspace, 'NOTES.md'), '# Notes\nImplementation pending.\n');
  fs.writeFileSync(path.join(workspace, 'check.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./add.cjs')(2, 3), 5);\n");
  const settings = { workspace, task: 'Build the addition function from DESIGN.md. Preserve DESIGN.md unchanged. Write NOTES.md with the result.',
    maxTurns: Infinity, useGrammar: true, grounding: false, preGate: false, thinkMode: 'never',
    verificationScript: 'node check.cjs', autoVerifyBlindEdits: 1, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    shellSandbox: 'host', completionAudit: true, progressAwareness: true, artifactVerifyAfter: 1 };
  async function phase(actions, extra = {}) {
    let observed = 0; const count = actions.length, events = [];
    const result = await runAgent({ ...settings, ...extra, shouldAbort: () => observed >= count,
      model: { assistantPrefill: '', async complete() {
        assert.ok(actions.length, 'unexpected extra model action');
        return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true };
      } }, onEvent: e => { events.push(e); if (e.type === 'observation') observed++; } });
    return { result, events };
  }
  return { workspace, phase };
}

test('green code checks do not turn a supplied design into an edited prose deliverable', async t => {
  const { workspace, phase } = await fixture(t);
  const { result, events } = await phase([
    { a: 'write_file', p: 'add.cjs', content: 'module.exports = (a, b) => a + b;\n' },
    { a: 'read_file', p: 'add.cjs' },
  ]);
  assert.equal(result.turns[0].verificationEvidence.status, 'pass');
  assert.match(result.turns[0].observation, /\[completion-audit\]/);
  assert.equal(events.filter(e => e.type === 'document_review_rearmed').length, 0);
  assert.match(result.turns[1].observation, /add\.cjs/);
  assert.doesNotMatch(result.turns[1].observation, /Document review gate|DOCUMENT REVIEW CHECKPOINT/);
  assert.equal(fs.readFileSync(path.join(workspace, 'DESIGN.md'), 'utf8'), '# Contract\nThe addition function returns the sum.\n');

  // Legacy recorded audits wrongly named the unedited input. Replay only
  // mutation evidence, never the old annotation's claim that the file changed.
  const legacy = result.turns.map((turn, i) => i ? turn : { ...turn,
    observation: turn.observation + '\nDOCUMENT REVIEW CHECKPOINT: DESIGN.md must be reread.' });
  const resumed = await phase([{ a: 'read_file', p: 'add.cjs' }], { resumeTurns: legacy });
  assert.match(resumed.result.turns.at(-1).observation, /add\.cjs/);
  assert.doesNotMatch(resumed.result.turns.at(-1).observation, /Document review gate/);
  assert.equal(resumed.events.filter(e => e.type === 'document_review_mask').length, 0);
});

test('an actually authored document still requires review, including after resume', async t => {
  const { workspace, phase } = await fixture(t);
  fs.writeFileSync(path.join(workspace, 'add.cjs'), 'module.exports = (a, b) => a + b;\n');
  const first = await phase([{ a: 'write_file', p: 'NOTES.md', content: '# Notes\nImplemented the sum in add.cjs and checked it with check.cjs.\n' }]);
  assert.equal(first.result.turns[0].verificationEvidence.status, 'pass');
  assert.deepEqual(first.events.find(e => e.type === 'document_review_rearmed')?.documents, ['NOTES.md']);
  const resumed = await phase([{ a: 'read_file', p: 'NOTES.md' }], { resumeTurns: first.result.turns });
  assert.deepEqual(resumed.events.find(e => e.type === 'document_review_mask')?.documents, ['NOTES.md']);
  assert.match(resumed.result.turns.at(-1).observation, /Document review context:/);
  assert.doesNotMatch(resumed.result.turns.at(-1).observation, /DESIGN\.md was modified/);
});
