import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { bantamConfigDirectory } from './config-directory.js';
import { writeJsonAtomic } from './atomic-file.js';
import { endpointKey } from './image-gpu.js';
import { loadJevConfig } from './jev/config.js';
import { createJevEngine } from './jev/engine.js';

const exec = promisify(execFile);
const cacheProgram = fileURLToPath(new URL('./ram-model-cache.py', import.meta.url));
const owners = new Map();
const mib = 1024 ** 2;

export function gpuHandoffConfig() {
  if (process.env.BANTAM_GPU_HANDOFF === 'off') return null;
  const root = bantamConfigDirectory();
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(root, 'gpu-handoff.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!config.enabled) return null;
  const maxStandby = config.maxStandby ?? 2;
  const reserveRamMb = config.reserveRamMb ?? 12288;
  if (!Number.isInteger(maxStandby) || maxStandby < 0 || maxStandby > 2) throw Error('GPU handoff maxStandby must be 0, 1, or 2');
  if (!Number.isFinite(reserveRamMb) || reserveRamMb < 4096) throw Error('GPU handoff reserveRamMb must be at least 4096');
  for (const key of ['comfyRamMb', 'jevRamMb']) if (config[key] != null && (!Number.isFinite(config[key]) || config[key] < 0)) throw Error(`GPU handoff ${key} must be a nonnegative number`);
  return { ...config, root, maxStandby, reserveRamMb, stateFile: path.join(root, 'gpu-handoff-state.json'),
    socket: path.join(root, 'ram-model-cache.sock') };
}

export function managesLocalEndpoint(endpoint) {
  const config = gpuHandoffConfig();
  return !!config && endpointKey(endpoint) === endpointKey(config.llamaEndpoint);
}

export async function ensureGpuHandoff(endpoint) {
  if (process.env.BANTAM_GPU_HANDOFF === 'off' || process.platform !== 'linux') return;
  const url = new URL(endpoint);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
  const root = bantamConfigDirectory();
  const file = path.join(root, 'gpu-handoff.json');
  if (fs.existsSync(file)) return; // Includes an explicit disabled configuration.
  try {
    await exec('python3', ['--version'], { timeout: 5000 });
    const { stdout } = await exec('nvidia-smi', ['--query-gpu=index', '--format=csv,noheader,nounits'], { timeout: 5000 });
    if (stdout.trim() !== '0') return; // Multiple GPUs need an explicit resource configuration.
  } catch { return; }
  let comfy;
  try { comfy = JSON.parse(fs.readFileSync(path.join(root, 'comfyui.json'), 'utf8')); } catch {}
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, { enabled: true, llamaEndpoint: endpointKey(endpoint), comfyUrl: comfy?.url || 'http://127.0.0.1:8188', maxStandby: 2, reserveRamMb: 12288 });
}

export function registerGpuOwner(kind, release) { owners.set(kind, release); return () => { if (owners.get(kind) === release) owners.delete(kind); }; }
export async function yieldGpuOwner(kind, { restoreLocal = false } = {}) { await owners.get(kind)?.({ restoreLocal }); }

function readState(config) {
  try { return JSON.parse(fs.readFileSync(config.stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { standbys: [], models: {}, parkedLocal: null }; }
}
function saveState(config, state) { writeJsonAtomic(config.stateFile, state); }

async function cacheRequest(config, request) {
  const send = async () => {
    const { stdout } = await exec('python3', [cacheProgram, '--socket', config.socket, '--request', JSON.stringify(request)], { timeout: 125000 });
    const result = JSON.parse(stdout);
    if (!result.ok) throw Error(result.error);
    return result;
  };
  try { return await send(); }
  catch (error) {
    if (!/No such file|Connection refused/.test(String(error.stderr))) throw error;
    fs.rmSync(config.socket, { force: true });
    const child = spawn('python3', [cacheProgram, '--socket', config.socket], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let n = 0; n < 30; n++) {
      await delay(100);
      try { return await send(); } catch (next) { if (!/No such file|Connection refused/.test(String(next.stderr))) throw next; }
    }
    throw Error('RAM model cache did not start');
  }
}

async function jsonRequest(url, body, timeoutMs = 15000) {
  const response = await fetch(url, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function gpuFreeMb() {
  const { stdout } = await exec('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 10000 });
  const free = Number(stdout.trim().split('\n')[0]);
  if (!Number.isFinite(free)) throw Error('Cannot verify GPU headroom');
  return free;
}

async function processGpuMb(pid) {
  const { stdout } = await exec('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], { timeout: 10000 });
  const row = stdout.trim().split('\n').map(line => line.split(',').map(s => Number(s.trim()))).find(row => row[0] === pid);
  return row?.[1] || 0;
}

export async function stopLlamaEndpoint(endpoint) {
  const port = new URL(endpoint).port;
  let pid;
  try { const { stdout } = await exec('fuser', [`${port}/tcp`], { timeout: 5000 }); pid = Number(stdout.trim().split(/\s+/)[0]); }
  catch { return; }
  if (!Number.isInteger(pid) || pid <= 0) throw Error('Cannot identify the local model process');
  const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  if (!path.basename(command[0]).startsWith('llama-server')) throw Error(`Port ${port} belongs to a non-llama.cpp process`);
  process.kill(pid, 'SIGTERM');
  for (let n = 0; n < 200; n++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    try { if (fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z')) return; }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await delay(100);
  }
  throw Error('llama.cpp did not release its process after SIGTERM');
}

async function resetComfy(config) {
  try {
    const queue = await jsonRequest(`${config.comfyUrl}/queue`);
    if (queue.queue_running?.length || queue.queue_pending?.length) throw Error('ComfyUI is busy; wait or cancel its image job');
    await jsonRequest(`${config.comfyUrl}/free`, { unload_models: true, free_memory: true });
  } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
}

export async function parkComfyModels() {
  const config = gpuHandoffConfig();
  if (!config) return;
  let bytes = 18 * 1024 ** 3;
  try {
    const { stdout } = await exec('fuser', [`${new URL(config.comfyUrl).port}/tcp`]);
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    const rss = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
    if (rss) bytes = Number(rss[1]) * 1024;
  } catch { /* Use the conservative weight estimate if RSS is unavailable. */ }
  await remember(config, { kind: 'comfy', key: 'comfy', bytes });
}

async function unloadComfy(config) {
  try {
    const queue = await jsonRequest(`${config.comfyUrl}/queue`);
    if (queue.queue_running?.length || queue.queue_pending?.length) throw Error('ComfyUI is still generating; cancel it before switching');
    await jsonRequest(`${config.comfyUrl}/free`, { unload_models: true, free_memory: false });
    const deadline = Date.now() + 60000;
    for (;;) {
      const stats = await jsonRequest(`${config.comfyUrl}/system_stats`);
      if (stats.devices?.filter(device => device.type !== 'cpu').every(device => device.torch_vram_total <= 1024 * mib)) return;
      if (Date.now() >= deadline) throw Error('ComfyUI GPU release could not be verified');
      await delay(200);
    }
  } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
}

async function dropStandby(config, entry) {
  if (entry.kind === 'llama') {
    if (entry.checkpoint && sameProcess(entry.checkpoint)) process.kill(entry.checkpoint.pid, 'SIGKILL');
    await cacheRequest(config, { op: 'drop', key: entry.key });
  }
  else if (entry.kind === 'comfy') await resetComfy(config);
  else if (entry.kind === 'jev') await createJevEngine(loadJevConfig()).stop();
}

export function standbyEvictions(entries, { maxStandby, budgetBytes }) {
  const kept = [...entries];
  const evicted = [];
  while (kept.length > maxStandby || kept.reduce((sum, entry) => sum + entry.bytes, 0) > budgetBytes) evicted.push(kept.shift());
  return { kept, evicted };
}

async function remember(config, entry) {
  const state = readState(config);
  const entries = state.standbys.filter(item => item.key !== entry.key).concat({ ...entry, at: Date.now() });
  const budgetBytes = Math.max(0, os.totalmem() - (config.reserveRamMb + 8192) * mib);
  const { kept, evicted } = standbyEvictions(entries, { maxStandby: config.maxStandby, budgetBytes });
  for (const item of evicted) await dropStandby(config, item);
  const pressureEvictions = [];
  while (kept.length && availableRamMb() < config.reserveRamMb) { const item = kept.shift(); pressureEvictions.push(item); await dropStandby(config, item); }
  if (evicted.length || pressureEvictions.length) state.lastEvictions = { at: Date.now(), budgetBytes, budgetOrCount: evicted, memoryPressure: pressureEvictions };
  state.standbys = kept;
  saveState(config, state);
  return kept.some(item => item.key === entry.key);
}

export function availableRamMb() {
  if (process.platform !== 'linux') return os.freemem() / mib;
  const match = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
  if (!match) throw Error('Cannot verify available system RAM');
  return Number(match[1]) / 1024;
}

async function activate(config, key) {
  const state = readState(config);
  state.standbys = state.standbys.filter(entry => entry.key !== key);
  saveState(config, state);
  await cacheRequest(config, { op: 'activate', key });
}

function sameProcess({ pid, startTick }) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] === startTick; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function checkpointAction(config, action, pid) {
  return exec(config.cudaCheckpointBinary, ['--action', action, '--pid', String(pid), ...(action === 'lock' ? ['--timeout', '5000'] : [])], { timeout: 120000 });
}

// vLLM's pinned CPU allocator keeps its offload buffers after wake-up. They
// can be reused by the same worker's next sleep; counting them a second time
// needlessly stops an otherwise warm engine. PSS excludes shared file pages.
async function jevHostMemory(jev) {
  if (jev.engine.mode !== 'managed') return null;
  try {
    const { stdout } = await exec('docker', ['top', jev.container, '-eo', 'pid,args'], { timeout: 10000 });
    const row = stdout.split('\n').find(line => /VLLM::EngineCore/.test(line));
    if (!row) return null;
    const pid = Number(row.trim().split(/\s+/)[0]);
    const tick = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
    let memory;
    try { memory = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'); }
    catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
      // Docker workers commonly run as root, so the desktop user cannot read
      // their host smaps. Read the same verified worker in its PID namespace.
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const innerPid = Number(status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1));
      if (!Number.isInteger(innerPid) || innerPid <= 0) return null;
      ({ stdout: memory } = await exec('docker', ['exec', '--user', '0', jev.container, 'cat', `/proc/${innerPid}/smaps_rollup`], { timeout: 10000 }));
    }
    const anon = memory.match(/^Pss_Anon:\s+(\d+) kB/m);
    const shared = memory.match(/^Pss_Shmem:\s+(\d+) kB/m);
    return anon ? { identity: `${pid}:${tick}`, residentMb: (Number(anon[1]) + Number(shared?.[1] || 0)) / 1024 } : null;
  } catch { return null; } // No measurable reuse: keep conservative admission.
}

export function jevSleepAdmission(previous, memory, floorMb) {
  const sameWorker = memory && previous?.identity === memory.identity;
  const expectedMb = Math.max(floorMb, sameWorker ? previous.ramMb || 0 : 0);
  const baselineMb = sameWorker ? Math.min(previous.awakeHostBaselineMb ?? memory.residentMb, memory.residentMb) : memory?.residentMb;
  // Only credit the fixed weight offload, leaving CUDA checkpoint overhead
  // and another GiB of transient allocation headroom in the admission test.
  const reusableMb = sameWorker ? Math.min(expectedMb * 0.8, Math.max(0, memory.residentMb - baselineMb)) : 0;
  return { expectedMb, requiredMb: expectedMb - reusableMb + 1024, baselineMb, reusableMb };
}

export async function parkLocalModel(endpoint, { keepProcess = true } = {}) {
  const config = gpuHandoffConfig();
  if (!config || !managesLocalEndpoint(endpoint)) return null;
  const previous = readState(config);
  if (previous.parkedLocal?.checkpoint && sameProcess(previous.parkedLocal.checkpoint)) {
    if (keepProcess) return previous.parkedLocal;
    process.kill(previous.parkedLocal.checkpoint.pid, 'SIGKILL');
    delete previous.parkedLocal.checkpoint;
    saveState(config, previous);
    await stopLlamaEndpoint(endpoint);
    const target = previous.parkedLocal;
    if (await remember(config, { kind: 'llama', key: target.name, bytes: target.bytes })) await cacheRequest(config, { op: 'cache', key: target.name, files: target.files, maxEntries: config.maxStandby, maxBytes: Math.max(0, os.totalmem() - (config.reserveRamMb + 8192) * mib) });
    return target;
  }
  let props;
  try { props = await jsonRequest(`${endpointKey(endpoint)}/props`); }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return readState(config).parkedLocal; throw error; }
  const { listModels } = await import('./model-launcher.js');
  const model = await (await import('./model-capture.js')).captureLocalModel(endpoint)
    || listModels().find(entry => endpointKey(entry.endpoint) === endpointKey(endpoint)
    && entry.match && path.basename(props.model_path || '').toLowerCase().includes(entry.match.toLowerCase()));
  if (!model) throw Error('The loaded local model has no matching startup registration; register it before managed GPU handoff');
  if (!props.is_sleeping) {
    const slots = await jsonRequest(`${endpointKey(endpoint)}/slots`);
    if (slots.some(slot => slot.is_processing)) throw Error('The local model is processing a request; wait before swapping');
  }
  const { stdout } = await exec('fuser', [`${new URL(endpoint).port}/tcp`], { timeout: 5000 });
  const pid = Number(stdout.trim().split(/\s+/)[0]);
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const files = [props.model_path];
  for (let n = 0; n < args.length; n++) if (args[n] === '--mmproj' && fs.existsSync(args[n + 1])) files.push(args[n + 1]);
  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const vramMb = await processGpuMb(pid);
  const state = readState(config);
  state.parkedLocal = { ...model, files, bytes, vramMb };
  state.models[model.name] = { vramMb, bytes };
  saveState(config, state);
  if (keepProcess && !props.is_sleeping && config.cudaCheckpointBinary && fs.existsSync(config.cudaCheckpointBinary)) {
    const copyBytes = Math.ceil(vramMb * mib);
    // Checkpointing is optional. Keep an existing warm engine rather than
    // evicting it just to make room for a second full CUDA copy in host RAM.
    // ComfyUI can temporarily hold CPU weights while loading them onto the
    // GPU. Its unloaded RSS alone underestimates that incoming allocation.
    const imageRamMb = config.comfyRamMb ?? 18432;
    if (availableRamMb() >= config.reserveRamMb + vramMb + imageRamMb) {
      const checkpoint = { pid, startTick: fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] };
      try {
        await checkpointAction(config, 'lock', pid);
        await checkpointAction(config, 'checkpoint', pid);
        const { stdout: actual } = await exec(config.cudaCheckpointBinary, ['--get-state', '--pid', String(pid)], { timeout: 5000 });
        if (actual.trim() !== 'checkpointed') throw Error(`llama.cpp CUDA checkpoint is ${actual.trim()}`);
        state.parkedLocal.checkpoint = checkpoint;
        saveState(config, state);
        await cacheRequest(config, { op: 'activate', key: model.name });
        await remember(config, { kind: 'llama', key: model.name, bytes: copyBytes, checkpoint });
        return state.parkedLocal;
      } catch (error) {
        // A failed NVIDIA checkpoint may leave CUDA locked. Kill only the
        // process we just verified, then retain the exact restart recipe.
        if (sameProcess(checkpoint)) process.kill(pid, 'SIGKILL');
        delete state.parkedLocal.checkpoint;
        saveState(config, state);
      }
    }
  }
  await stopLlamaEndpoint(endpoint);
  if (await remember(config, { kind: 'llama', key: model.name, bytes })) {
    await cacheRequest(config, { op: 'cache', key: model.name, files,
      maxEntries: config.maxStandby, maxBytes: Math.max(0, os.totalmem() - (config.reserveRamMb + 8192) * mib) });
  }
  return state.parkedLocal;
}

export async function parkDiffusionGemma({ jev = loadJevConfig(), engine = createJevEngine(jev) } = {}) {
  const config = gpuHandoffConfig();
  if (!config) return;
  if (jev.engine.mode === 'unconfigured') return;
  const url = new URL(jev.endpoint);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
  const status = await engine.status();
  if (status.state === 'starting') throw Error('DiffusionGemma is still loading; wait before switching GPU workloads');
  if (status.state !== 'awake' && status.state !== 'asleep') {
    const state = readState(config); state.standbys = state.standbys.filter(entry => entry.kind !== 'jev'); saveState(config, state);
    return;
  }
  if (status.state === 'awake') {
    const state = readState(config);
    const memory = await jevHostMemory(jev);
    const admission = jevSleepAdmission(state.models.jev, memory, config.jevRamMb ?? 20480);
    const expectedRamMb = admission.expectedMb;
    while (state.standbys.length && availableRamMb() < config.reserveRamMb + admission.requiredMb) {
      await dropStandby(config, state.standbys.shift());
    }
    saveState(config, state);
    if (availableRamMb() < config.reserveRamMb + admission.requiredMb) {
      if (jev.engine.mode === 'external') throw Error('Not enough host RAM to sleep the external DiffusionGemma engine safely');
      state.lastRamFallback = { at: Date.now(), availableRamMb: availableRamMb(), admission };
      state.standbys = state.standbys.filter(entry => entry.kind !== 'jev');
      saveState(config, state);
      await engine.stop();
      return;
    }
    const availableBefore = availableRamMb();
    await engine.sleep();
    const measuredMb = Math.max(0, availableBefore - availableRamMb());
    const current = readState(config);
    current.models.jev = { ramMb: Math.max(expectedRamMb, measuredMb + admission.reusableMb),
      ...(memory ? { identity: memory.identity, awakeHostBaselineMb: admission.baselineMb } : {}) };
    saveState(config, current);
  }
  // Summing process RSS double-counts shared file mappings and forked pages.
  // Use the measured offload delta with a conservative configured floor.
  const bytes = (readState(config).models.jev?.ramMb ?? config.jevRamMb ?? 20480) * mib;
  await remember(config, { kind: 'jev', key: 'jev', bytes });
}

export async function prepareGpuFor(kind, target) {
  const config = gpuHandoffConfig();
  if (!config) return;
  if (kind === 'comfy' || kind === 'jev') {
    await activate(config, kind);
    await parkLocalModel(config.llamaEndpoint, { keepProcess: kind !== 'jev' });
  }
  if (kind !== 'jev') await parkDiffusionGemma();
  if (kind === 'comfy') {
    const requiredRamMb = config.reserveRamMb + (config.comfyRamMb ?? 18432) + 1024;
    const state = readState(config), evicted = [];
    while (state.standbys.length && availableRamMb() < requiredRamMb) {
      const entry = state.standbys.shift(); evicted.push(entry); await dropStandby(config, entry);
    }
    if (evicted.length) state.lastImageRamEvictions = { at: Date.now(), requiredRamMb, evicted };
    saveState(config, state);
    if (availableRamMb() < requiredRamMb) throw Error('Not enough host RAM for ComfyUI loading and the configured system reserve');
  }
  if (kind !== 'comfy') {
    await unloadComfy(config);
  }
  if (kind === 'llama') {
    const state = readState(config);
    const requirement = (state.models[target.name]?.vramMb || target.vramMb || 22000) + 512;
    let free = await gpuFreeMb();
    const deadline = Date.now() + 5000;
    while (free < requirement && Date.now() < deadline) { await delay(200); free = await gpuFreeMb(); }
    if (free < requirement) {
      const engine = createJevEngine(loadJevConfig());
      const status = await engine.status();
      if (status.state === 'asleep') {
        if (engine.mode !== 'managed') throw Error('The external DiffusionGemma engine retains too much VRAM for this model; stop it externally or choose a smaller local model');
        await engine.stop();
        const current = readState(config); current.standbys = current.standbys.filter(entry => entry.kind !== 'jev');
        current.lastVramFallback = { at: Date.now(), freeMb: free, requiredMb: requirement, model: target.name };
        saveState(config, current);
      }
    }
    if (await gpuFreeMb() < requirement) throw Error(`Insufficient GPU headroom to load ${target.name}: needs approximately ${Math.ceil(requirement)} MiB`);
    await activate(config, target.name);
  }
}

export async function markLocalActive(target) {
  const config = gpuHandoffConfig();
  if (!config) return;
  const state = readState(config); state.parkedLocal = null; saveState(config, state);
  await activate(config, target.name);
}

export async function restoreLocalModel(endpoint) {
  const config = gpuHandoffConfig();
  if (!config || !managesLocalEndpoint(endpoint)) return false;
  const state = readState(config);
  const target = state.parkedLocal;
  if (!target) return false;
  await prepareGpuFor('llama', target);
  const { startRegisteredModel } = await import('./model-launcher.js');
  let started;
  let checkpointRestored = false;
  if (target.checkpoint && sameProcess(target.checkpoint)) {
    try {
      await checkpointAction(config, 'restore', target.checkpoint.pid);
      await checkpointAction(config, 'unlock', target.checkpoint.pid);
      started = true; checkpointRestored = true;
    } catch (error) {
      if (sameProcess(target.checkpoint)) process.kill(target.checkpoint.pid, 'SIGKILL');
      delete target.checkpoint;
      const current = readState(config); current.parkedLocal = target; saveState(config, current);
      await stopLlamaEndpoint(endpoint);
      await prepareGpuFor('llama', target);
      started = await startRegisteredModel(target);
    }
  } else started = await startRegisteredModel(target);
  if (!started) throw Error(`Could not restore ${target.name}`);
  const { verifyResidentProfile } = await import('./model-launcher.js');
  const resident = await verifyResidentProfile(target);
  if (!resident.ok) throw Error(`Restore returned the wrong model: ${resident.detail}`);
  const current = readState(config); current.parkedLocal = null; saveState(config, current);
  return { restored: true, checkpoint: checkpointRestored };
}

export async function gpuHandoffStatus() {
  const config = gpuHandoffConfig();
  return config ? { ...readState(config), maxStandby: config.maxStandby, reserveRamMb: config.reserveRamMb, availableRamMb: availableRamMb(),
    cache: await cacheRequest(config, { op: 'status' }) } : { enabled: false };
}

export async function recoverManagedGpu(record) {
  const config = gpuHandoffConfig();
  if (!config || !managesLocalEndpoint(record.endpoint)) throw Error('This GPU reservation needs its original managed handoff configuration');
  if (!['llama', 'jev'].includes(record.kind)) throw Error('Image jobs must be recovered by their ComfyUI job manager');
  if (record.kind === 'jev') {
    const engine = createJevEngine(loadJevConfig());
    if (engine.mode === 'managed') await engine.stop();
    else await parkDiffusionGemma();
  } else {
    const target = readState(config).parkedLocal;
    if (!target?.checkpoint || !sameProcess(target.checkpoint)) await stopLlamaEndpoint(record.endpoint);
  }
  await unloadComfy(config);
  await restoreLocalModel(record.endpoint);
}
