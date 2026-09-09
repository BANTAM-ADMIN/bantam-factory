import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RequiredReadHistory } from '../src/required-read-history.js';
import { RunCheckpoint } from '../src/run-checkpoint.js';
import { buildArtifact } from '../src/artifact.js';
import { clipKeepingControllerAnnotation } from '../src/prompt.js';

function fixture(t, text = 'First requirement\nSecond requirement\n') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-required-read-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'DESIGN.md'), text);
  return { workspace, paths: ['DESIGN.md'] };
}
const VIEW = 'DESIGN.md (3 lines, showing 1-3):\n1\tFirst requirement\n2\tSecond requirement\n3\t\n';

test('recover actual delivered spec lines, including the final blank line, without trusting raw read headers', t => {
  const config = fixture(t);
  const rawOnly = new RequiredReadHistory({ ...config, turns: [{ observation: VIEW }] });
  assert.equal(rawOnly.render(), '', 'raw executor output is not proof it reached a prompt');
  const clipped = new RequiredReadHistory({ ...config, turns: [{ prompt: VIEW.replace('Second requirement\n3\t\n', 'Second\n… clipped …\n') }] });
  assert.deepEqual(clipped.snapshot().files[0].ranges, [[1, 1]], 'neither claimed tail nor truncated line earns delivery');
  const full = new RequiredReadHistory({ ...config, turns: [{ prompt: 'system\n' + VIEW + 'next action' }] });
  assert.match(full.render(), /all 3 lines delivered previously/);
  assert.match(full.render(), /not a claim of understanding, current context residency or correct implementation/);
});

test('hash-bound compact history survives prompt-free checkpoints and rejects stale or malformed coverage', t => {
  const config = fixture(t), first = new RequiredReadHistory(config);
  first.notePrompt(VIEW);
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  checkpoint.note({ type: 'action', action: { a: 'read_file', p: 'DESIGN.md' } });
  checkpoint.note({ type: 'observation', observation: VIEW });
  checkpoint.note({ type: 'required_read_history', turn: 0, history: first.snapshot() });
  const artifact = buildArtifact({ runId: 'delivery', stamp: 'test', result: { turns: checkpoint.turns(), metrics: {} } });
  const restored = new RequiredReadHistory({ ...config, turns: artifact.turns });
  assert.match(restored.render(), /all 3 lines/);
  fs.writeFileSync(path.join(config.workspace, 'DESIGN.md'), 'Changed requirement\nSecond requirement\n');
  const stale = new RequiredReadHistory({ ...config, turns: artifact.turns });
  assert.equal(stale.render(), '', 'an edited file cannot inherit the previous hash receipt');
  assert.doesNotThrow(() => new RequiredReadHistory({ ...config, turns: [
    { requiredReadHistory: { schema: 1, files: {} } },
    { requiredReadHistory: { schema: 1, files: [null, { path: 'DESIGN.md', ranges: 'bad' }] } },
  ] }));
});

test('coverage remains partial across gaps, source changes and incomplete line sequences', t => {
  const config = fixture(t), history = new RequiredReadHistory(config);
  history.notePrompt('DESIGN.md (3 lines, showing 1-3):\n1\tFirst requirement\n3\t\n');
  assert.deepEqual(history.snapshot().files[0].ranges, [[1, 1]]);
  fs.writeFileSync(path.join(config.workspace, 'DESIGN.md'), 'New requirement\nSecond requirement\n');
  history.invalidate('DESIGN.md');
  history.notePrompt(VIEW);
  assert.deepEqual(history.snapshot().files[0].ranges, [[2, 3]], 'unchanged complete lines are historical delivery; changed lines need reloading');
  assert.doesNotMatch(history.render(), /all 3 lines/);
});

test('required read history cannot follow an outside symlink or consume an unbounded specification', t => {
  const config = fixture(t);
  fs.symlinkSync('/etc/hosts', path.join(config.workspace, 'outside.md'));
  fs.writeFileSync(path.join(config.workspace, 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
  const history = new RequiredReadHistory({ ...config, paths: ['outside.md', 'huge.md', '../outside.md'] });
  assert.equal(history.files.size, 0);
});

test('the bounded history qualification reaches the model whole beside a clipped long observation', t => {
  const config = fixture(t), history = new RequiredReadHistory(config);
  history.notePrompt(VIEW);
  const text = history.render();
  assert.ok(clipKeepingControllerAnnotation('tool output\n'.repeat(1200) + '\n' + text, true, 4000).includes(text));
});
