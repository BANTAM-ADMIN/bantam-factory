import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireImageLease } from '../src/image-gpu.js';

test('orphaned image lease reports recovery rather than another active job', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lease-diagnostics-'));
  try {
    const config = { url: 'http://127.0.0.1:8188' };
    const lease = acquireImageLease(config, { workspace: '/original', state: 'generating' }, directory);
    const record = { ...lease.record, pid: 2147483647 };
    fs.writeFileSync(lease.file, JSON.stringify(record));
    assert.throws(() => acquireImageLease(config, {}, directory), error => {
      assert.match(error.message, /orphaned image reservation/i);
      assert.match(error.message, /:image recover/);
      assert.match(error.message, /\/original/);
      assert.doesNotMatch(error.message, /reserved by another image job/);
      return true;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(lease.file, 'utf8')), record);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
