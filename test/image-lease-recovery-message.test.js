import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acquireImageLease } from '../src/image-gpu.js';

test('reserved image endpoint explains recovery rather than implying active generation', () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.image-lease-test-'));
  try {
    const config = { url: 'http://127.0.0.1:8188' };
    const lease = acquireImageLease(config, { workspace: '/example/project', state: 'recovery_required' }, directory);
    assert.throws(() => acquireImageLease(config, {}, directory), error => {
      assert.match(error.message, /:image recover/);
      assert.match(error.message, /recovery_required/);
      assert.match(error.message, /\/example\/project/);
      assert.match(error.message, /does not necessarily mean.*generating/i);
      return true;
    });
    assert.ok(fs.existsSync(lease.file), 'reporting a conflict must preserve the lease');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
