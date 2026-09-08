import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReplHelp } from '../src/logic/repl-help.js';

test('quick help fits small terminals and keeps everyday descriptions together at 80 columns', () => {
  for (const cols of [32, 40, 60, 80, 100, 120]) {
    const help = renderReplHelp({ cols });
    for (const line of help.split('\n')) assert.ok(line.length < cols, `${cols}: ${line}`);
    assert.match(help, /:context \[mode\]/);
    assert.match(help, /:self-improve \[plan\]/);
    assert.match(help, /BANTAM FACTORY/);
  }
  const help = renderReplHelp({ cols: 80 });
  assert.match(help, /:model \[name\|n\] +Choose a model\. Try :model codex-sol\./);
  assert.match(help, /:context \[mode\] +rebuild \/ immutable \/ extension/);
});
