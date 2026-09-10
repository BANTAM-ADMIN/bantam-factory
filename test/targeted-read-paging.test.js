import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent } from '../src/agent.js';

async function replay(t, actions) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-targeted-reads-'));
  t.after(() => fs.rmSync(workspace, {recursive: true, force: true}));
  fs.writeFileSync(path.join(workspace, 'big.js'),
    Array.from({length: 605}, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
  const calls = [];
  const model = {assistantPrefill: '', actTemperature: null,
    async complete(prompt, options) {
      calls.push({prompt, grammar: options?.grammar});
      return {content: JSON.stringify(actions.shift() ?? {a: 'respond', text: 'Inspected.'}),
        tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {}};
    }};
  const result = await runAgent({task: 'Inspect the relevant functions in big.js.', workspace, model,
    maxTurns: 8, interactive: true, useGrammar: true, grounding: false,
    openFilesView: false, promptTrajectory: 'extension',
    verificationPolicy: 'after_edit', shellSandbox: 'host'});
  return {result, calls};
}

const read = (start, limit) => ({a: 'read_file', p: 'big.js', start, limit});

for (const batched of [false, true]) {
  test(`jumps between function regions remain readable${batched ? ' inside inspect' : ''}`, async t => {
    // Recorded repair sequence: AI update, spawn, then kill/damage. These are
    // disjoint lookups, not three pages walking forward through the file.
    const wrap = op => batched ? {a: 'inspect', ops: [op]} : op;
    const {result, calls} = await replay(t, [
      ...[read(422, 60), read(100, 100), read(264, 120), read(566, 40)].map(wrap),
    ]);
    assert.equal(result.metrics.pagingSteers ?? 0, 0);
    assert.ok(result.turns.slice(0, 4).every(turn => !turn.observation.includes('[paging]')));
    const actionGrammar = calls[3].grammar.split('\ninspect-ops ::=')[0];
    assert.ok(actionGrammar.includes(batched ? '\\"inspect\\"' : '\\"read_file\\"'),
      'the next targeted read must remain available in the actual action grammar');
  });
}

test('editing a file starts a new paging sequence for its changed bytes', async t => {
  const {result} = await replay(t, [read(1, 60), read(61, 60),
    {a: 'replace', p: 'big.js', old: 'export const v0 = 0;', new: 'export const v0 = -1;'},
    read(121, 60),
  ]);
  assert.equal(result.turns[2].editApplied, true);
  assert.equal(result.metrics.pagingSteers ?? 0, 0);
});

test('overlapping forward windows still trigger the paging guard', async t => {
  const {result} = await replay(t, [read(1, 60), read(51, 60), read(101, 60)]);
  assert.equal(result.metrics.pagingSteers, 1);
  assert.match(result.turns[2].observation, /\[paging\]/);
});

test('repeating the same window still triggers the paging guard when reads execute', async t => {
  const {result} = await replay(t, [read(10, 40), read(10, 40), read(10, 40)]);
  assert.equal(result.metrics.pagingSteers, 1);
  assert.match(result.turns[2].observation, /\[paging\]/);
});
