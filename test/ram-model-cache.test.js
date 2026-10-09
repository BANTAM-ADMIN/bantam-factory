import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

test('RAM cache daemon enforces count and bytes, releases mappings on activation and rejects oversized models', async t => {
  if (process.platform !== 'linux') { t.skip('Linux mmap cache'); return; }
  try { execFileSync('python3', ['--version']); } catch { t.skip('Python3 unavailable'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ram-cache-'));
  const socket = path.join(dir, 'cache.sock');
  const program = fileURLToPath(new URL('../src/ram-model-cache.py', import.meta.url));
  const daemon = spawn('python3', [program, '--socket', socket], { stdio: 'ignore' });
  t.after(async () => { const exited = new Promise(resolve => daemon.once('exit', resolve)); daemon.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await delay(10);
  assert.ok(fs.existsSync(socket));
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  const send = async request => JSON.parse((await promisify(execFile)('python3', [program, '--socket', socket, '--request', JSON.stringify(request)])).stdout);
  const files = ['a', 'b', 'c'].map(name => { const file = path.join(dir, name); fs.writeFileSync(file, Buffer.alloc(1024 ** 2)); return file; });
  const cache = (key, file) => send({ op: 'cache', key, files: [file], maxEntries: 2, maxBytes: 2 * 1024 ** 2 });
  assert.equal((await cache('a', files[0])).ok, true);
  assert.equal((await cache('b', files[1])).entries.length, 2);
  assert.deepEqual((await cache('c', files[2])).entries.map(entry => entry.key), ['b', 'c']);
  assert.deepEqual((await send({ op: 'activate', key: 'b' })).entries.map(entry => entry.key), ['c']);
  assert.equal((await send({ op: 'cache', key: 'oversized', files: [files[0]], maxEntries: 2, maxBytes: 1 })).ok, false);
  assert.equal((await send({ op: 'cache', key: 'zero', files: [files[0]], maxEntries: 0, maxBytes: 1024 ** 2 })).ok, false);
  assert.equal((await send({ op: 'drop', key: 'c' })).entries.length, 0);
});
