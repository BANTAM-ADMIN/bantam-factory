import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireExclusiveFileLock } from './exclusive-file-lock.js';

const lockDir = () => path.join(os.tmpdir(), `bantam-image-gpu-${process.getuid?.() ?? 'user'}`);

export function endpointKey(endpoint) {
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (['localhost', '0.0.0.0', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1';
  return `${url.origin}${url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '')}`;
}

export function localModelEndpoint(model) {
  if (!model || model.codex || model.codexBacked) return null;
  const endpoint = model.apiMode ? model.apiUrl : model.endpoint;
  if (!endpoint) return null;
  const url = new URL(endpoint);
  return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname) ? endpointKey(endpoint) : null;
}

export function gpuPlan(config, model) {
  const gpu = config.gpu || {};
  const local = localModelEndpoint(model);
  const mode = gpu.mode || 'auto';
  if (!['auto', 'none', 'llamacpp', 'vllm'].includes(mode)) throw Error('ComfyUI gpu.mode must be auto, none, llamacpp, or vllm');
  // Hosted/Codex sessions must not touch an unrelated dormant local server.
  if (mode === 'none' || !local) return { mode: 'none', shared: false, endpoint: null };
  const endpoint = endpointKey(gpu.endpoint || local);
  if (!endpoint) {
    if (mode !== 'auto') throw Error(`gpu.endpoint is required for ${mode}`);
    return { mode: 'none', shared: false, endpoint: null };
  }
  return { mode: mode === 'auto' ? 'llamacpp' : mode, endpoint, shared: local === endpoint };
}

export function acquireImageLease(config, metadata, directory = lockDir()) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = config.gpu?.resourceKey || config.url;
  const file = path.join(directory, `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);
  const record = { ...metadata, pid: process.pid, token: crypto.randomUUID(), url: config.url };
  try { fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code === 'EEXIST') {
      let owner = '';
      let reason = 'GPU/image endpoint is reserved by another image job.';
      try {
        const held = JSON.parse(fs.readFileSync(file, 'utf8'));
        owner = ` Owner: workspace ${held.workspace || 'unknown'}, PID ${held.pid || 'unknown'}, state ${held.state || 'unknown'}.`;
        if (held.state === 'recovery_required') reason = 'GPU/image endpoint has an image reservation requiring recovery.';
        if (Number.isInteger(held.pid) && held.pid > 0) {
          try { process.kill(held.pid, 0); }
          catch (error) {
            if (error.code === 'ESRCH') reason = 'GPU/image endpoint has an orphaned image reservation.';
          }
        }
      } catch { /* The lease may have disappeared while reporting the conflict. */ }
      throw Error(`${reason}${owner} Recover it from the owning BANTAM session before retrying: run :image recover. This reservation does not necessarily mean ComfyUI is still generating; cleanup may need recovery. If the owning session has exited, reopen BANTAM in its workspace and run :image recover there. Do not manually delete the lease. Lease: ${file}`);
    }
    throw e;
  }
  return {
    file, record,
    update(fields) {
      Object.assign(record, fields);
      const temp = `${file}.${record.token}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(temp, file);
    },
    release() {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === record.token) fs.unlinkSync(file);
    },
  };
}

// A dead owner does not prove that ComfyUI stopped. Serialize recovery and
// retain the reservation until cancellation, unloading and wake all succeed.
export async function recoverOrphanedImageLease(config, restore, directory = lockDir()) {
  const key = config.gpu?.resourceKey || config.url;
  const file = path.join(directory, `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const dead = record => {
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return false;
    try { process.kill(record.pid, 0); return false; }
    catch (e) { return e.code === 'ESRCH'; }
  };
  if (!dead(read())) return false;
  const guard = acquireExclusiveFileLock(`${file}.recovery-lock`, { staleAfterMs: 0 });
  try {
    const record = read();
    if (!dead(record)) return false;
    if (record.url !== config.url) throw Error('Orphaned image reservation uses a different ComfyUI URL; recover with its configuration');
    const update = fields => {
      if (read()?.token !== record.token) throw Error('Image recovery reservation changed');
      Object.assign(record, fields);
      const temp = `${file}.${guard.token}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(temp, file);
    };
    const originalPid = record.pid;
    update({ pid: process.pid });
    try {
      await restore(record, { update });
      if (read()?.token !== record.token) throw Error('Image recovery reservation changed');
      fs.unlinkSync(file);
    } catch (error) {
      update({ pid: originalPid, state: 'recovery_required' });
      throw error;
    }
    return true;
  } finally { guard.release(); }
}

export function imageLeases(directory = lockDir()) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(f => f.endsWith('.json')).map(name => {
    const file = path.join(directory, name);
    return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  });
}

export function assertImageGpuAvailable(endpoint) {
  const key = endpointKey(endpoint);
  if (key && imageLeases().some(lease => lease.endpoint === key)) {
    throw Error('Local GPU is reserved for ComfyUI. Wait for image completion or cancel the image job before requesting local inference.');
  }
}

export async function waitForImageGpu(endpoint, signal, directory = lockDir()) {
  const key = endpointKey(endpoint);
  if (!key) return;
  for (;;) {
    signal?.throwIfAborted();
    const held = imageLeases(directory).find(lease => lease.endpoint === key);
    if (!held) return;
    let alive = true;
    try { process.kill(held.pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
    if (!alive || held.state === 'recovery_required') {
      throw Error('Local LLM is held for image recovery. Run :image recover before using it again.');
    }
    await delay(100, undefined, { signal });
  }
}

export class ImageGpuRuntime {
  constructor(plan, config, { fetchImpl = fetch } = {}) { this.plan = plan; this.config = config; this.fetch = fetchImpl; }
  async request(route, { body, signal, method } = {}) {
    const response = await this.fetch(`${this.plan.endpoint}${route}`, {
      method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw Error(`LLM ${route}: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  async sleep(signal) {
    if (this.plan.mode === 'none') return;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.gpu?.sleepTimeoutMs ?? 60_000)]);
    if (this.plan.mode === 'vllm') {
      await this.request('/sleep?level=1', { method: 'POST', signal: deadline });
      if (!(await this.request('/is_sleeping', { signal: deadline }))?.is_sleeping) throw Error('vLLM did not enter sleep mode');
      return;
    }
    // /props bypasses llama.cpp's wake-on-request gate. /slots does not.
    for (;;) {
      const props = await this.request('/props', { signal: deadline });
      if (props.total_slots !== 1) throw Error('Shared-GPU llama.cpp requires --parallel 1; another slot could wake the model during generation');
      if (props.is_sleeping === true) return;
      await delay(this.config.pollMs, undefined, { signal: deadline }).catch(e => {
        if (!signal.aborted) throw Error('llama.cpp did not sleep. Start it with --sleep-idle-seconds 5 and keep other clients idle.');
        throw e;
      });
    }
  }
  async wake(signal) {
    if (this.plan.mode === 'none') return;
    if (this.plan.mode === 'vllm') {
      await this.request('/wake_up', { method: 'POST', signal });
      if ((await this.request('/is_sleeping', { signal }))?.is_sleeping !== false) throw Error('vLLM did not wake');
    } else {
      // A tiny real inference proves the model is usable; /health alone does not.
      await this.request('/completion', { body: { prompt: 'Ready', n_predict: 1, temperature: 0, cache_prompt: false }, signal });
      if ((await this.request('/props', { signal }))?.is_sleeping !== false) throw Error('llama.cpp did not wake');
    }
  }
}
