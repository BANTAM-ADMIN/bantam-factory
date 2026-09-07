import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {streamContractGuidance, TIMEOUT_LOCALIZATION} from '../src/stream-contract-guidance.js';
import {buildPrompt} from '../src/prompt.js';
import {buildContractStateAuditPrompt} from '../src/contract-state-audit.js';

const task = 'Repair a decoder that receives arbitrary chunks. UTF-8 must be strict; rejected calls poison its state.';
test('stream work order routes on public semantics, without adding requirements to unrelated work', () => {
  for (const value of ['', undefined, 'Draw a stream', 'Sort chunks by size', 'Build a CLI']) {
    assert.equal(streamContractGuidance(value), '');
  }
  const text = streamContractGuidance(task);
  assert.ok(text.length < 2000);
  assert.match(text, /ALL two-part byte splits/);
  assert.match(text, /each distinct rejection entry path/);
  assert.match(text, /If strict incremental UTF-8 is required/);
  assert.match(text, /NOT verification evidence/);
  assert.doesNotMatch(text, /stream-framer|\[DONE\]|hidden|DavidAU/);
});

test('work order reaches worker and source audit, without claiming executed coverage', () => {
  const worker = buildPrompt({task, env: 'workspace', turns: []});
  const audit = buildContractStateAuditPrompt({task, documents: [], sources: []});
  for (const prompt of [worker, audit]) {
    assert.match(prompt, /progress measure/);
    assert.match(prompt, /passing these witnesses does not certify/);
  }
  assert.match(audit, /never use bare throws or throws Error as JSON/);
  assert.doesNotMatch(buildPrompt({task, env: 'workspace', turns: [], interactive: true}), /stream contract work order/);
});

test('external timeout and synchronous markers localize a nonadvancing delimiter cursor', () => {
  // Reduced mechanism from the failed run, not a repaired contender or grader.
  const script = `
    const fs = require('node:fs');
    const mark = x => fs.writeSync(2, x + '\\n');
    function push(bytes) {
      let pos = 0;
      while (pos < bytes.length) {
        let end = bytes.indexOf(10, pos);
        if (end < 0) break;
        if (end > 0 && bytes[end - 1] === 13) end--;
        pos = end + 1;
      }
    }
    mark('before push'); push(Buffer.from('x\\r\\n')); mark('after push');
    mark('before finish');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 750});
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.match(result.stderr, /before push/);
  assert.doesNotMatch(result.stderr, /after push|before finish/);
  assert.match(TIMEOUT_LOCALIZATION, /do not assume a later finalizer ran/);
  assert.match(TIMEOUT_LOCALIZATION, /in-process timer cannot interrupt/);
});
