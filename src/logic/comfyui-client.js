import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'undici';
import { bantamConfigDirectory } from '../config-directory.js';

export function generationProvider(env = process.env) {
  const selected = String(env.BANTAM_IMAGE_GENERATION_PROVIDER ?? '').trim().toLowerCase();
  if (selected && !['off', 'codex', 'comfyui'].includes(selected)) {
    throw Error('BANTAM_IMAGE_GENERATION_PROVIDER must be off, codex, or comfyui');
  }
  return selected || (/^(1|true|yes|on)$/i.test(env.BANTAM_CODEX_IMAGE ?? '') ? 'codex' : 'off');
}

export function readComfyConfig(workspace, env = process.env) {
  const explicit = env.BANTAM_COMFYUI_CONFIG;
  const candidates = explicit
    ? [path.resolve(workspace, explicit)]
    : [path.resolve(workspace, '.bantam/comfyui.json'), path.join(bantamConfigDirectory(undefined, env.BANTAM_CONFIG_DIR), 'comfyui.json')];
  const file = candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e?.code === 'ENOENT') {
      const locations = candidates.map(candidate => `- ${candidate}`).join('\n');
      throw Error(`No ComfyUI configuration was found. Checked:\n${locations}\nAdd .bantam/comfyui.json to this workspace, add a user default at ${path.join(bantamConfigDirectory(undefined, env.BANTAM_CONFIG_DIR), 'comfyui.json')}, or set BANTAM_COMFYUI_CONFIG=/absolute/path/to/comfyui.json.`);
    }
    throw Error(`Cannot read ComfyUI configuration ${file}: ${e.message}`);
  }
  const url = new URL(config.url || 'http://127.0.0.1:8188');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Error('ComfyUI url must be an HTTP(S) base URL without credentials, query, or fragment');
  }
  if (typeof config.workflow !== 'string' || !config.workflow) throw Error('ComfyUI config needs an API workflow file');
  const workflowFile = path.resolve(path.dirname(file), config.workflow);
  const workflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  if (!workflow || Array.isArray(workflow) || workflow.nodes || !Object.values(workflow).every(n => n?.class_type && n.inputs)) {
    throw Error('Export the workflow in ComfyUI API format (node-ID object), not editor format');
  }
  const bindings = config.bindings || {};
  if (!bindings.prompt) throw Error('ComfyUI config needs bindings.prompt: [nodeID, inputName]');
  for (const [name, binding] of Object.entries(bindings)) {
    if (!['prompt', 'seed', 'width', 'height', 'filename_prefix'].includes(name)
        || !Array.isArray(binding) || binding.length !== 2
        || !Object.hasOwn(workflow[binding[0]]?.inputs || {}, binding[1])
        || Array.isArray(workflow[binding[0]].inputs[binding[1]])) {
      throw Error(`Invalid ComfyUI input binding: ${name}`);
    }
  }
  if (!Array.isArray(config.outputs) || !config.outputs.length || config.outputs.some(id => !workflow[id])) {
    throw Error('ComfyUI config needs outputs: [image output node IDs]');
  }
  const positive = (value, fallback, name) => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value <= 0) throw Error(`${name} must be a positive number`);
    return value;
  };
  return {
    ...config, file, url: url.href.replace(/\/$/, ''), workflow, bindings,
    timeoutMs: positive(config.timeoutMs, 900_000, 'timeoutMs'),
    pollMs: positive(config.pollMs, 1000, 'pollMs'),
    cleanupTimeoutMs: positive(config.cleanupTimeoutMs, 120_000, 'cleanupTimeoutMs'),
    stallWarningMs: positive(config.stallWarningMs, 180_000, 'stallWarningMs'),
    workflowHash: crypto.createHash('sha256').update(JSON.stringify(workflow)).digest('hex'),
  };
}

export function renderWorkflow(config, { prompt, seed, width, height, prefix }) {
  const workflow = structuredClone(config.workflow);
  for (const [name, value] of Object.entries({ prompt, seed, width, height, filename_prefix: prefix })) {
    if (value === undefined) continue;
    const binding = config.bindings[name];
    if (!binding && ['width', 'height'].includes(name)) throw Error(`Workflow has no ${name} binding; use --size auto`);
    if (binding) workflow[binding[0]].inputs[binding[1]] = value;
  }
  return workflow;
}

export class ComfyClient {
  constructor(config, { fetchImpl = fetch } = {}) { this.config = config; this.fetch = fetchImpl; }

  async request(route, { body, signal, timeoutMs = 15_000, binary = false } = {}) {
    const response = await this.fetch(`${this.config.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw Error(`ComfyUI ${route.split('?')[0]}: HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    if (binary) {
      const type = response.headers.get('content-type') || '';
      if (!/^image\/(png|jpeg|webp)/i.test(type)) throw Error(`ComfyUI returned non-image content: ${type}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (!data.length) throw Error('ComfyUI returned an empty image');
      return { data, extension: /jpeg/i.test(type) ? '.jpg' : /webp/i.test(type) ? '.webp' : '.png' };
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async check(signal) {
    await this.request('/system_stats', { signal });
    const info = await this.request('/object_info', { signal });
    for (const node of Object.values(this.config.workflow)) {
      const definition = info[node.class_type];
      if (!definition) throw Error(`ComfyUI node is unavailable: ${node.class_type}`);
      for (const [key, value] of Object.entries(node.inputs)) {
        const choices = (definition.input?.required?.[key] || definition.input?.optional?.[key])?.[0];
        if (!Array.isArray(value) && Array.isArray(choices) && !choices.includes(value)) {
          throw Error(`ComfyUI ${node.class_type}.${key} is unavailable: ${value}`);
        }
      }
    }
    await this.requireIdle(signal);
  }

  async requireIdle(signal) {
    const queue = await this.request('/queue', { signal });
    if (queue.queue_running?.length || queue.queue_pending?.length) {
      throw Error('ComfyUI is busy with another job; retry when its queue is empty');
    }
  }

  async submit(workflow, id) {
    // Do not abort submission mid-flight: we need the ID to cancel an accepted job.
    const result = await this.request('/prompt', { body: { prompt: workflow, client_id: id, prompt_id: id } });
    if (!result?.prompt_id || Object.keys(result.node_errors || {}).length) {
      throw Error(`ComfyUI rejected workflow: ${JSON.stringify(result).slice(0, 700)}`);
    }
    return result.prompt_id;
  }

  async watch(id, onEvent, signal) {
    const url = new URL(`${this.config.url}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', id);
    const socket = new WebSocket(url);
    const close = () => { try { socket.close(); } catch { /* already closed */ } };
    socket.addEventListener('error', () => {}); // History polling remains authoritative.
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return; // Binary preview frames are not progress.
      try {
        const message = JSON.parse(event.data);
        if (message.data?.prompt_id === id) onEvent(message);
      } catch { /* Ignore malformed progress; do not corrupt the generation job. */ }
    });
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      const done = () => { clearTimeout(timeout); resolve(); };
      socket.addEventListener('open', done, { once: true });
      socket.addEventListener('error', done, { once: true });
      socket.addEventListener('close', done, { once: true });
    });
    return () => { signal?.removeEventListener('abort', close); close(); };
  }

  async wait(id, signal, onProgress = () => {}) {
    for (;;) {
      signal?.throwIfAborted();
      const history = await this.request(`/history/${encodeURIComponent(id)}`, { signal });
      const entry = history[id];
      if (entry?.status?.status_str === 'error') {
        const error = entry.status.messages?.find(m => m[0] === 'execution_error')?.[1];
        throw Error(error ? `Node ${error.node_id}: ${error.exception_message}` : 'ComfyUI execution failed or was interrupted');
      }
      if (entry?.status?.completed) return entry;
      onProgress();
      await delay(this.config.pollMs, undefined, { signal });
    }
  }

  async cancel(id, signal) {
    if (!id) return;
    await this.request('/queue', { body: { delete: [id] }, signal });
    const queue = await this.request('/queue', { signal });
    if (queue.queue_running?.some(item => item[1] === id)) {
      // Current ComfyUI supports targeted interruption; never send an empty body.
      await this.request('/interrupt', { body: { prompt_id: id }, signal });
    }
    for (;;) {
      const q = await this.request('/queue', { signal });
      if (![...(q.queue_running || []), ...(q.queue_pending || [])].some(item => item[1] === id)) return;
      await delay(this.config.pollMs, undefined, { signal });
    }
  }

  async unload(signal) {
    await this.requireIdle(signal);
    // Keeping the executor cache permits CPU-side reuse. /free itself is asynchronous.
    await this.request('/free', { body: { unload_models: true, free_memory: false }, signal });
    const max = this.config.gpu?.maxComfyVramMb ?? 1024;
    for (;;) {
      const stats = await this.request('/system_stats', { signal });
      const devices = (stats.devices || []).filter(d => d.type !== 'cpu');
      if (!devices.length) throw Error('Cannot verify ComfyUI GPU release: system_stats has no GPU devices');
      if (devices.every(d => Number.isFinite(d.torch_vram_total) && d.torch_vram_total <= max * 1024 * 1024)) return;
      await delay(this.config.pollMs, undefined, { signal });
    }
  }
}
