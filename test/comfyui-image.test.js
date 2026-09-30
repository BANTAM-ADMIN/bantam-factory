import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generationProvider, readComfyConfig, renderWorkflow } from '../src/logic/comfyui-client.js';
import { ComfyImageJobs, ImageSleepInput, checkComfyGpuHeadroom, expandKreaPrompt, extractComfyImageOptions, resolveComfyDimensions, formatComfySizeChoices } from '../src/logic/comfyui-image.js';
import { acquireImageLease, recoverOrphanedImageLease, gpuPlan } from '../src/image-gpu.js';
import { ImageProgress, imageTimingEstimate, saveImageTiming, timingKey } from '../src/logic/image-progress.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-comfyui-'));
  fs.mkdirSync(path.join(dir, '.bantam'));
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'fixture' } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    '3': { class_type: 'KSampler', inputs: { seed: 1 } },
    '4': { class_type: 'SaveImage', inputs: { filename_prefix: 'fixture', images: ['3', 0] } },
  }));
  fs.writeFileSync(path.join(dir, '.bantam', 'comfyui.json'), JSON.stringify({
    url: 'http://127.0.0.1:8188', workflow: '../workflow.json',
    bindings: { prompt: ['1', 'text'], width: ['2', 'width'], height: ['2', 'height'], seed: ['3', 'seed'], filename_prefix: ['4', 'filename_prefix'] },
    outputs: ['4'], gpu: { mode: 'auto' },
  }));
  return dir;
}

test('ComfyUI selection is explicit and never silently falls back to Codex', () => {
  assert.equal(generationProvider({}), 'off');
  assert.equal(generationProvider({ BANTAM_CODEX_IMAGE: '1' }), 'codex');
  assert.equal(generationProvider({ BANTAM_IMAGE_GENERATION_PROVIDER: 'comfyui', BANTAM_CODEX_IMAGE: '1' }), 'comfyui');
  assert.throws(() => generationProvider({ BANTAM_IMAGE_GENERATION_PROVIDER: 'somewhere-else' }), /off, codex, or comfyui/);
});

test('workflow configuration binds only existing literal inputs', t => {
  const workspace = fixture();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const config = readComfyConfig(workspace, {});
  const workflow = renderWorkflow(config, { prompt: 'a bantam', seed: 99, width: 768, height: 640, prefix: 'BANTAM/test' });
  assert.equal(workflow['1'].inputs.text, 'a bantam');
  assert.equal(workflow['2'].inputs.width, 768);
  assert.equal(workflow['3'].inputs.seed, 99);
  assert.equal(workflow['4'].inputs.filename_prefix, 'BANTAM/test');
});

test('a user-wide ComfyUI configuration works from a workspace without one', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-comfy-empty-'));
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-comfy-home-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(configHome, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(workspace, 'workflow.json'), JSON.stringify({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'fixture' } },
    '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'fixture' } },
  }));
  fs.writeFileSync(path.join(configHome, 'comfyui.json'), JSON.stringify({
    url: 'http://127.0.0.1:8188', workflow: path.join(workspace, 'workflow.json'),
    bindings: { prompt: ['1', 'text'], filename_prefix: ['2', 'filename_prefix'] }, outputs: ['2'],
  }));
  const config = readComfyConfig(workspace, { BANTAM_CONFIG_DIR: configHome });
  assert.equal(config.file, path.join(configHome, 'comfyui.json'));
});

test('Krea size presets, aspect ratios, and exact dimensions resolve predictably', () => {
  const config = { dimensionMultiple: 16, sizes: { banner: '1536x512' } };
  assert.deepEqual(resolveComfyDimensions({ size: 'landscape', aspect: null }, config), { width: 1280, height: 720, selected: '1280x720' });
  assert.deepEqual(resolveComfyDimensions({ size: 'auto', aspect: '9:16' }, config), { width: 720, height: 1280, selected: '720x1280' });
  assert.deepEqual(resolveComfyDimensions({ size: 'banner', aspect: null }, config), { width: 1536, height: 512, selected: '1536x512' });
  assert.throws(() => resolveComfyDimensions({ size: '1024x1024', aspect: '1:1' }, config), /either --size or --aspect/);
  assert.throws(() => resolveComfyDimensions({ size: '1025x1024', aspect: null }, config), /multiples of 16/);
  assert.match(formatComfySizeChoices(config), /banner \(1536x512\)/);
});

test('Krea prompt expansion preserves a raw bypass and asks the active model for prose', async () => {
  const prompts = [];
  const model = { complete: async (prompt, options) => {
    prompts.push({ prompt, options });
    return { content: 'A tiny red fox trots through fresh snow at golden hour, captured in a low-angle wildlife photograph with crisp fur, soft drifting flakes, and warm luminous light.' };
  } };
  const expanded = await expandKreaPrompt('a fox in snow', { model, env: {} });
  assert.equal(expanded.expanded, true);
  assert.match(expanded.prompt, /low-angle wildlife/);
  assert.match(prompts[0].prompt, /Krea 2 Turbo/);
  assert.equal(prompts[0].options.nPredict, 700);
  const raw = await expandKreaPrompt('only this', { model, raw: true, env: {} });
  assert.deepEqual(raw, { prompt: 'only this', expanded: false, reason: 'raw prompt requested' });
  assert.deepEqual(extractComfyImageOptions('cat --aspect 16:9 --raw'), { rest: 'cat', size: null, quality: null, aspect: '16:9', raw: true });
});

test('auto GPU control shares only with the active local model', () => {
  const config = { url: 'http://127.0.0.1:8188', gpu: { mode: 'auto', endpoint: 'http://127.0.0.1:8085' } };
  assert.deepEqual(gpuPlan(config, { endpoint: 'http://localhost:8085' }), { mode: 'llamacpp', endpoint: 'http://127.0.0.1:8085', shared: true });
  assert.deepEqual(gpuPlan(config, { codex: true }), { mode: 'none', endpoint: null, shared: false });
  assert.deepEqual(gpuPlan(config, { codexBacked: true }), { mode: 'none', endpoint: null, shared: false });
  assert.deepEqual(gpuPlan(config, null), { mode: 'none', endpoint: null, shared: false });
  assert.deepEqual(gpuPlan({ ...config, gpu: { mode: 'llamacpp', endpoint: 'http://127.0.0.1:8085' } }, { codex: true }), { mode: 'none', endpoint: null, shared: false });
});

test('ComfyUI GPU headroom is checked without a local LLM and fails closed on missing telemetry', async () => {
  const stats = free => ({ devices: [{ type: 'cuda', index: 0, vram_total: 24 * 1024 ** 3, vram_free: free }] });
  const client = response => ({ request: async route => { assert.equal(route, '/system_stats'); return response; } });
  const config = { gpu: { minFreeVramMb: 8192 } };
  assert.deepEqual(await checkComfyGpuHeadroom(client(stats(10 * 1024 ** 3)), config), [{ index: 0, free: 10 * 1024 ** 3 }]);
  await assert.rejects(checkComfyGpuHeadroom(client(stats(4 * 1024 ** 3)), config), /GPU headroom/);
  await assert.rejects(checkComfyGpuHeadroom(client({ devices: [{ type: 'cuda', index: 0, vram_total: 24 * 1024 ** 3 }] }), config), /GPU telemetry/);
  await assert.rejects(checkComfyGpuHeadroom(client({ devices: [] }), config), /GPU telemetry/);
});

test('lease conflict does not leave the session stuck in prompting', async t => {
  const workspace = fixture();
  const leases = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-comfy-leases-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(leases, { recursive: true, force: true }); });
  const config = readComfyConfig(workspace, {});
  const held = acquireImageLease(config, { id: 'other-job', workspace, state: 'generating' }, leases);
  const jobs = new ComfyImageJobs(workspace, { leaseDirectory: leases, clientFactory: () => ({ check: async () => { throw Error('ComfyUI is offline'); } }) });
  await assert.rejects(jobs.generate('a bantam --raw', { env: {} }), error =>
    /reserved by another image job/.test(error.message)
    && error.message.includes(`workspace ${workspace}`)
    && /state generating/.test(error.message)
    && /owning BANTAM session/.test(error.message));
  assert.equal(jobs.busy, false);
  assert.match(jobs.status(), /failed.*reserved by another image job/);
  held.release();
  assert.match(await jobs.generate('a bantam --raw', { env: {} }), /failed.*ComfyUI is offline/);
});

test('cancellation interrupts prompt expansion before any GPU or ComfyUI work', async t => {
  const workspace = fixture();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const jobs = new ComfyImageJobs(workspace, { leaseDirectory: path.join(workspace, 'leases'),
    clientFactory: () => { throw Error('must not contact ComfyUI'); } });
  const generation = jobs.generate('a bantam', { env: {}, model: { codex: true, complete: (_prompt, { signal }) => {
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  await ready;
  const rejected = assert.rejects(generation, /cancelled/i);
  await jobs.cancel();
  await rejected;
  assert.equal(jobs.busy, false);
  assert.equal(jobs.job.state, 'cancelled');
});

function jobFixture(t, overrides = {}) {
  const workspace = fixture();
  const leases = path.join(workspace, 'leases');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [], events = [];
  const client = {
    check: async () => {}, requireIdle: async () => {}, watch: async () => () => {},
    submit: async (_workflow, id) => id,
    wait: async () => ({ outputs: { '4': { images: [{ filename: 'test.png' }] } } }),
    request: async route => route.startsWith('/view') ? { data: Buffer.from('fixture image'), extension: '.png' }
      : { devices: [{ type: 'cuda', index: 0, vram_total: 24 * 1024 ** 3, vram_free: 24 * 1024 ** 3 }] },
    cancel: async () => { calls.push('cancel'); }, unload: async () => { calls.push('unload'); },
    ...overrides,
  };
  return { workspace, calls, events, client, options: { leaseDirectory: leases, clientFactory: () => client,
    onEvent: e => events.push(e), runtimeFactory: plan => {
      assert.equal(plan.mode, 'none');
      return { wake: async () => {}, sleep: async () => { throw Error('Codex must not sleep a local LLM'); } };
    } } };
}

for (const failCleanup of [false, true]) test(`closed foreign session is recovered automatically; cleanup failure=${failCleanup}`, async t => {
  const f = jobFixture(t);
  const config = readComfyConfig(f.workspace, {});
  const lease = acquireImageLease(config, { workspace: '/closed/workspace', state: 'recovery_required',
    mode: 'none', shared: false, promptId: 'old-prompt' }, f.options.leaseDirectory);
  // An invalid positive PID is guaranteed not to identify a live process.
  fs.writeFileSync(lease.file, JSON.stringify({ ...lease.record, pid: 2147483647 }));
  f.client.cancel = async id => {
    f.calls.push(`cancel:${id}`);
    if (failCleanup) throw Error('cleanup unavailable');
  };
  const jobs = new ComfyImageJobs(f.workspace, f.options);
  if (failCleanup) {
    await assert.rejects(jobs.generate('a bantam --raw', { env: {} }), /cleanup unavailable/);
    assert.ok(fs.existsSync(lease.file));
    assert.equal(JSON.parse(fs.readFileSync(lease.file)).promptId, 'old-prompt');
  } else {
    assert.match(await jobs.generate('a bantam --raw', { env: {} }), /completed/);
    assert.equal(f.calls[0], 'cancel:old-prompt');
    assert.equal(f.calls[1], 'unload');
    assert.equal(fs.existsSync(lease.file), false);
  }
});

for (const failure of [null, 'ECONNREFUSED', 'ETIMEDOUT', 'wake']) test(`local chat recovers orphaned GPU reservation: ${failure}`, async t => {
  const f = jobFixture(t);
  const config = readComfyConfig(f.workspace, {});
  const endpoint = 'http://127.0.0.1:8085';
  const lease = acquireImageLease(config, { workspace: '/closed/workspace', state: 'recovery_required',
    endpoint, mode: 'llamacpp', shared: true }, f.options.leaseDirectory);
  fs.writeFileSync(lease.file, JSON.stringify({ ...lease.record, pid: 2147483647 }));
  let woke = false;
  f.client.unload = async () => {
    if (failure) throw Object.assign(Error('offline'), { cause: { code: failure === 'wake' ? 'ECONNREFUSED' : failure } });
  };
  const jobs = new ComfyImageJobs(f.workspace, { ...f.options, runtimeFactory: () => ({ wake: async () => {
    if (failure === 'wake') throw Error('inference failed');
    woke = true;
  } }) });
  await jobs.prepareLocalModel({ codex: true }, {});
  await jobs.prepareLocalModel({ endpoint: 'http://localhost:9999' }, {});
  assert.ok(fs.existsSync(lease.file), 'unrelated models do not recover this lease');
  if (failure === 'ETIMEDOUT' || failure === 'wake') {
    await assert.rejects(jobs.prepareLocalModel({ endpoint }, {}), /offline|inference failed/);
    assert.ok(fs.existsSync(lease.file), 'uncertain cleanup or failed inference preserves the lease');
    assert.equal(woke, false);
  } else {
    await jobs.prepareLocalModel({ endpoint: 'http://localhost:8085' }, {});
    assert.equal(woke, true);
    assert.equal(fs.existsSync(lease.file), false);
  }
});

test('orphan recovery keeps other claimants out until restoration finishes', async t => {
  const f = jobFixture(t);
  const config = readComfyConfig(f.workspace, {});
  const lease = acquireImageLease(config, { workspace: f.workspace, mode: 'none', promptId: 'old' }, f.options.leaseDirectory);
  fs.writeFileSync(lease.file, JSON.stringify({ ...lease.record, pid: 2147483647 }));
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const recovery = recoverOrphanedImageLease(config, () => pending, f.options.leaseDirectory);
  try {
    assert.equal(await recoverOrphanedImageLease(config, () => assert.fail('duplicate cleanup'), f.options.leaseDirectory), false);
    assert.throws(() => acquireImageLease(config, {}, f.options.leaseDirectory), /reserved/);
    const contender = new ComfyImageJobs(f.workspace, f.options);
    await assert.rejects(contender.recover({}), /running BANTAM process/);
    assert.ok(fs.existsSync(lease.file));
  } finally { finish(); await recovery; }
  assert.equal(fs.existsSync(lease.file), false);
});

test('close retries recovery for an already stopped job', async t => {
  const f = jobFixture(t, { unload: async () => { throw Error('temporary cleanup failure'); } });
  const jobs = new ComfyImageJobs(f.workspace, f.options);
  await jobs.generate('a bantam --raw', { env: {} });
  assert.equal(jobs.job.state, 'recovery_required');
  const file = jobs.job.lease.file;
  f.client.unload = async () => {};
  await jobs.close();
  assert.equal(fs.existsSync(file), false);
});

test('Codex background job starts offline ComfyUI and saves its image', async t => {
  let online = false;
  const f = jobFixture(t, { check: async () => {
    if (!online) throw Object.assign(Error('offline'), { cause: { code: 'ECONNREFUSED' } });
  } });
  const jobs = new ComfyImageJobs(f.workspace, { ...f.options, startComfy: async () => {
    f.calls.push('start'); online = true;
  } });
  assert.match(await jobs.generate('a bantam --raw', { model: { codex: true }, background: true, env: {} }), /background/);
  await jobs.job.promise;
  assert.equal(jobs.job.state, 'completed');
  assert.deepEqual(f.calls, ['start', 'cancel', 'unload']);
  assert.ok(jobs.job.artifacts.some(p => p.endsWith('.png') && fs.existsSync(path.join(f.workspace, p))));
});

test('repeated Ctrl-C stops stalled cleanup once and retains a recovery lease', async t => {
  let cleaning;
  const ready = new Promise(resolve => { cleaning = resolve; });
  const f = jobFixture(t, { wait: async (_id, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), cancel: async (_id, signal) => {
    cleaning();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const jobs = new ComfyImageJobs(f.workspace, f.options);
  await jobs.generate('a bantam --raw', { model: { codex: true }, background: true, env: {} });
  while (!jobs.job.promptId) await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.interrupt(), true);
  await ready;
  jobs.interrupt();
  jobs.interrupt();
  await jobs.job.promise;
  assert.equal(jobs.job.state, 'recovery_required');
  assert.equal(jobs.busy, false);
  assert.ok(fs.existsSync(jobs.job.lease.file));
  assert.equal(f.events.filter(e => /Stopping image generation/.test(e.message)).length, 1);
  assert.equal(f.events.filter(e => /Stopping GPU cleanup/.test(e.message)).length, 1);
  const lease = jobs.job.lease.file;
  f.client.cancel = async () => {};
  assert.match(await jobs.recover({}), /cancelled/);
  assert.equal(fs.existsSync(lease), false);
  assert.equal(jobs.job.cleanupController.signal.aborted, false);
});

test('sleep input queues the request and only Y cancels the image job', () => {
  const events = [], queued = [];
  const jobs = { sleeping: true, job: { state: 'generating' }, cancel: async () => events.push('cancelled') };
  const input = new ImageSleepInput(jobs, { emit: x => events.push(x), queue: x => queued.push(x) });
  assert.equal(input.handle('what did it make?'), true);
  assert.deepEqual(queued, ['what did it make?']);
  assert.equal(input.handle('n'), true);
  assert.equal(events.some(x => /Continuing/.test(x)), true);
  input.handle('wake up now');
  input.handle('yes');
  assert.equal(events.some(x => /Stopping/.test(x)), true);
});

test('progress uses sampler measurements when available and historical timing otherwise', t => {
  const workspace = fixture();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const key = timingKey({ url: 'http://test', workflowHash: 'x', workflow: { '2': { inputs: { width: 768, height: 768 } } }, bindings: { width: ['2', 'width'], height: ['2', 'height'] } }, 768, 768);
  saveImageTiming(workspace, key, 20_000);
  assert.equal(imageTimingEstimate(workspace, key).expectedMs, 20_000);
  let now = 0;
  const progress = new ImageProgress({ now: () => now, estimate: { expectedMs: 20_000, samples: 1, longestMs: 20_000 } });
  progress.update({ type: 'executing', data: { node: '7' } });
  now = 2_000;
  progress.update({ type: 'progress', data: { node: '7', value: 2, max: 8 } });
  now = 6_000;
  progress.update({ type: 'progress', data: { node: '7', value: 4, max: 8 } });
  const state = progress.snapshot({ '7': { class_type: 'KSampler' } });
  assert.match(state.message, /4\/8 steps/);
  assert.ok(state.stageRemainingMs > 0);
  assert.ok(state.estimatedRemainingMs > 0);
});
