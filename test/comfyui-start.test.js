import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureComfyStarted, parseNvidiaSmiMemory } from '../src/logic/comfyui-start.js';

const install = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-comfy-start-'));
fs.writeFileSync(path.join(install, 'main.py'), '# test fixture');
const config = { url: 'http://127.0.0.1:8188', gpu: { minFreeVramMb: 8192 }, startup: { directory: install, timeoutMs: 100 } };
const stats = '0, 12000, 24000\n';

test('nvidia-smi memory is parsed and malformed telemetry fails closed', () => {
  assert.deepEqual(parseNvidiaSmiMemory(stats), [{ index: 0, freeMb: 12000, totalMb: 24000 }]);
  assert.throws(() => parseNvidiaSmiMemory('not numbers'), /GPU telemetry/);
});

test('online ComfyUI is reused without probing VRAM or launching', async () => {
  const calls = [];
  await ensureComfyStarted(config, { request: async () => ({}) }, { probeGpu: async () => { calls.push('gpu'); }, launch: () => { calls.push('launch'); } });
  assert.deepEqual(calls, []);
});

test('offline ComfyUI starts only with enough VRAM, then waits for readiness', async () => {
  const calls = []; let ready = false;
  const client = { request: async () => { if (!ready) throw Object.assign(Error('refused'), { cause: { code: 'ECONNREFUSED' } }); return {}; } };
  await ensureComfyStarted(config, client, { probeGpu: async () => stats, launch: () => { calls.push('launch'); ready = true; return { pid: 123, once() {} }; }, wait: async () => {} });
  assert.deepEqual(calls, ['launch']);
});

test('cancellation while probing VRAM never launches ComfyUI', async () => {
  const controller = new AbortController();
  let launched = false;
  const client = { request: async () => { throw Object.assign(Error('refused'), { code: 'ECONNREFUSED' }); } };
  await assert.rejects(ensureComfyStarted(config, client, {
    signal: controller.signal,
    probeGpu: async () => { controller.abort(Error('cancelled')); return stats; },
    launch: () => { launched = true; },
  }), /cancelled/);
  assert.equal(launched, false);
});

test('insufficient VRAM prevents launch', async () => {
  let launched = false;
  const client = { request: async () => { throw Object.assign(Error('refused'), { cause: { code: 'ECONNREFUSED' } }); } };
  await assert.rejects(ensureComfyStarted(config, client, { probeGpu: async () => '0, 4000, 24000', launch: () => { launched = true; } }), /Insufficient GPU headroom/);
  assert.equal(launched, false);
});

test('non-connectivity failures and remote endpoints do not launch', async () => {
  let launched = false;
  const client = { request: async () => { throw Error('HTTP 500'); } };
  await assert.rejects(ensureComfyStarted(config, client, { launch: () => { launched = true; } }), /HTTP 500/);
  assert.equal(launched, false);
  await assert.rejects(ensureComfyStarted({ ...config, url: 'http://example.com:8188' }, { request: async () => { throw Object.assign(Error('refused'), { cause: { code: 'ECONNREFUSED' } }); } }), /local ComfyUI/);
});
