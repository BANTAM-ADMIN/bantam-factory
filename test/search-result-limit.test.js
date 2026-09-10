import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Executor } from '../src/executor.js';

function fixture(t, count, width = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-search-limit-'));
  fs.writeFileSync(path.join(root, 'rig.js'), Array.from({length:count}, (_, i) =>
    `const pose${i} = ${i}; // ${'x'.repeat(width)}`).join('\n'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  return new Executor(root);
}

test('search exposes omitted matches and raising its limit reveals them', t => {
  const executor = fixture(t, 27);
  const limited = executor.search({q:'const pose',p:'rig.js'});
  assert.match(limited, /^\[search limited\] Showing 20 of 27 matches/);
  assert.match(limited, /increase limit/);
  assert.doesNotMatch(limited, /rig\.js:27:/);
  const complete = executor.search({q:'const pose',p:'rig.js',limit:30});
  assert.match(complete, /rig\.js:27: const pose26/);
  assert.doesNotMatch(complete, /search limited/);
});

test('a capped scan describes a lower bound, not an invented total', t => {
  const output = fixture(t, 85).search({q:'const pose',p:'rig.js',limit:5});
  assert.match(output, /^\[search limited\] Showing 5 of at least 15 matches/);
  assert.doesNotMatch(output, /of 85 matches/);
});

test('search limit warning survives long matched lines and batched inspection', t => {
  const executor = fixture(t, 27, 700);
  const output = executor.search({q:'const pose',p:'rig.js'});
  assert.ok(output.length <= 4000);
  assert.match(output, /^\[search limited\]/);
  assert.match(executor.inspect({ops:[{a:'search',q:'const pose',p:'rig.js'}]}), /\[search limited\]/);
});

test('an exactly full result set stays complete', t => {
  const output = fixture(t, 20).search({q:'const pose',p:'rig.js'});
  assert.match(output, /^rig\.js:1:/);
  assert.match(output, /rig\.js:20:/);
  assert.doesNotMatch(output, /search limited/);
});
