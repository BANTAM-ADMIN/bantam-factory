import test from 'node:test';
import assert from 'node:assert/strict';
import { standbyEvictions, jevSleepAdmission } from '../src/gpu-handoff.js';
import { gpuResourceKey, acquireImageLease } from '../src/image-gpu.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the shared standby limit counts image and language engines together and evicts oldest first', () => {
  const entries = [{ key: 'old-llm', bytes: 18 }, { key: 'comfy', bytes: 19 }, { key: 'jev', bytes: 16 }];
  const result = standbyEvictions(entries, { maxStandby: 2, budgetBytes: 40 });
  assert.deepEqual(result.kept.map(e => e.key), ['comfy', 'jev']);
  assert.deepEqual(result.evicted.map(e => e.key), ['old-llm']);
  assert.equal(entries.length, 3);
});

test('RAM budget can retain fewer workloads than the count limit; zero standby means cold fallback', () => {
  const entries = [{ key: 'old', bytes: 18 }, { key: 'new', bytes: 19 }];
  assert.deepEqual(standbyEvictions(entries, { maxStandby: 2, budgetBytes: 25 }).kept.map(e => e.key), ['new']);
  assert.equal(standbyEvictions(entries, { maxStandby: 0, budgetBytes: 100 }).kept.length, 0);
  assert.equal(standbyEvictions(entries, { maxStandby: 2, budgetBytes: 10 }).kept.length, 0);
});

test('Jev admission reuses a verified worker CPU offload pool without double counting its RAM', () => {
  const previous = { identity: '123:456', ramMb: 20000, awakeHostBaselineMb: 3000 };
  const admission = jevSleepAdmission(previous, { identity: '123:456', residentMb: 19000 }, 19200);
  assert.equal(admission.reusableMb, 16000);
  assert.equal(admission.requiredMb, 5024);
  assert.equal(jevSleepAdmission(previous, { identity: '124:789', residentMb: 19000 }, 19200).requiredMb, 20224);
  assert.equal(jevSleepAdmission(previous, null, 19200).requiredMb, 20224);
  assert.equal(jevSleepAdmission(previous, { identity: '123:456', residentMb: 2000 }, 19200).reusableMb, 0);
});

test('ComfyUI, llama.cpp and Jev use one physical GPU lease even with different loopback URLs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-lease-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const comfy = { url: 'http://localhost:8188' }, llama = { url: 'http://127.0.0.1:8085' };
  assert.equal(gpuResourceKey(comfy), gpuResourceKey(llama));
  const lease = acquireImageLease(comfy, { kind: 'comfy' }, directory);
  assert.throws(() => acquireImageLease(llama, { kind: 'llama' }, directory), /reserved/);
  lease.release();
  acquireImageLease(llama, { kind: 'llama' }, directory).release();
  assert.notEqual(gpuResourceKey({ url: 'http://remote:8188' }), gpuResourceKey(comfy));
});
