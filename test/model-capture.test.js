import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readLocalLaunch, launchRecipeScript, captureLocalModel, userModelRegistryPath } from '../src/model-capture.js';

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-capture-'));
  const before = { config: process.env.BANTAM_CONFIG_DIR, gpu: process.env.BANTAM_GPU_HANDOFF };
  process.env.BANTAM_CONFIG_DIR = dir; process.env.BANTAM_GPU_HANDOFF = 'off';
  t.after(() => {
    if (before.config === undefined) delete process.env.BANTAM_CONFIG_DIR; else process.env.BANTAM_CONFIG_DIR = before.config;
    if (before.gpu === undefined) delete process.env.BANTAM_GPU_HANDOFF; else process.env.BANTAM_GPU_HANDOFF = before.gpu;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('process capture preserves JSON, spaces, working directory and selected runtime environment', t => {
  const dir = rig(t); const proc = path.join(dir, 'proc'); const pid = path.join(proc, '42'); fs.mkdirSync(pid, { recursive: true });
  const args = ['/opt/llama-server', '-m', '/models/my model.gguf', '--chat-template-kwargs', '{"reasoning_effort": "high"}', '--alias', ''];
  fs.writeFileSync(path.join(pid, 'cmdline'), args.join('\0') + '\0');
  fs.writeFileSync(path.join(pid, 'environ'), 'CUDA_VISIBLE_DEVICES=0\0LD_LIBRARY_PATH=/libs with spaces\0PROVIDER_API_KEY=secret\0');
  fs.symlinkSync(dir, path.join(pid, 'cwd'));
  assert.deepEqual(readLocalLaunch(42, { proc }), { args, cwd: dir, env: { CUDA_VISIBLE_DEVICES: '0', LD_LIBRARY_PATH: '/libs with spaces' } });
  fs.symlinkSync('/resolved/llama-server', path.join(pid, 'exe'));
  assert.equal(readLocalLaunch(42, { proc }).args[0], '/resolved/llama-server');
});

test('replay quotes argv literally without evaluating shell expressions', t => {
  const dir = rig(t); const output = path.join(dir, 'output.json');
  const args = [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1],JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.CUDA_VISIBLE_DEVICES}))', output,
    'a b', '$(touch unexpected)', '`touch unexpected`', "it's literal", '{"a": "b c"}', ''];
  const script = path.join(dir, 'start.sh');
  fs.writeFileSync(script, launchRecipeScript({ args, cwd: dir, env: { CUDA_VISIBLE_DEVICES: '0' } }));
  execFileSync('bash', [script]);
  const result = JSON.parse(fs.readFileSync(output));
  assert.deepEqual(result, { args: args.slice(4), cwd: dir, env: '0' });
  assert.equal(fs.existsSync(path.join(dir, 'unexpected')), false);
});

test('new local model becomes a restartable menu entry, duplicate observations stay one entry', async t => {
  const dir = rig(t);
  const recipe = { args: ['/opt/llama-server', '-m', '/models/my model.gguf', '--parallel', '1', '--ctx-size', '123456'], cwd: dir, env: {} };
  const options = { portPid: 42, registry: [], readLaunch: () => recipe,
    fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('/props') ? { model_path: '/models/my model.gguf' } : { data: [{ id: 'Qwen-custom' }] } }) };
  const one = await captureLocalModel('http://localhost:8085', options);
  const two = await captureLocalModel('http://127.0.0.1:8085', options);
  assert.equal(one.name, two.name);
  assert.equal(one.ctx, 123456);
  assert.equal(one.profile, 'qwen');
  assert.equal(JSON.parse(fs.readFileSync(userModelRegistryPath())).length, 1);
  assert.equal(fs.statSync(one.script).mode & 0o777, 0o600);
  const { listModels } = await import('../src/model-launcher.js');
  assert.ok(listModels().some(entry => entry.name === one.name));
});

test('a known startup script stays authoritative and remote endpoints are never captured as local launches', async t => {
  rig(t);
  const known = { name: 'mine', match: 'Qwen-custom', slots: 1, ctx: 123456, endpoint: 'http://127.0.0.1:8085', script: '/existing/start.sh' };
  const options = { portPid: 42, registry: [known], readLaunch: () => ({ args: ['/opt/llama-server', '--parallel', '1', '--ctx-size', '123456'], cwd: '/tmp', env: {} }),
    fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('/props') ? { model_path: '/model.gguf' } : { data: [{ id: 'Qwen-custom' }] } }) };
  assert.equal(await captureLocalModel(known.endpoint, options), known);
  assert.equal(fs.existsSync(userModelRegistryPath()), false);
  assert.equal(await captureLocalModel('http://gpu-server:8085', { fetchImpl: () => { throw Error('must not probe'); } }), null);
});
