import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const offlineCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']);

export function parseNvidiaSmiMemory(output) {
  const devices = String(output).trim().split(/\r?\n/).map(line => {
    const parts = line.split(',').map(value => Number(value.trim()));
    return { index: parts[0], freeMb: parts[1], totalMb: parts[2] };
  });
  if (!devices.length || devices.some(d => !Number.isInteger(d.index) || d.index < 0 || !Number.isFinite(d.freeMb) || !Number.isFinite(d.totalMb) || d.freeMb < 0 || d.totalMb <= 0)) {
    throw Error('Cannot verify GPU telemetry from nvidia-smi');
  }
  return devices;
}

async function probeGpu() {
  const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=index,memory.free,memory.total', '--format=csv,noheader,nounits'], { timeout: 10_000 });
  return stdout;
}

function launch(config) {
  const dir = config.startup.directory;
  const python = config.startup.python || [path.join(dir, 'venv/bin/python'), path.join(dir, '.venv/bin/python')].find(p => fs.existsSync(p)) || 'python3';
  const url = new URL(config.url);
  const child = spawn(python, ['main.py', '--listen', '127.0.0.1', '--port', url.port || '8188'], { cwd: dir, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

function isOffline(error) {
  for (let current = error; current; current = current.cause) if (offlineCodes.has(current.code)) return true;
  return false;
}

export async function ensureComfyStarted(config, client, { signal, probeGpu: gpu = probeGpu, launch: start = launch, wait = delay } = {}) {
  try { await client.request('/system_stats', { signal, timeoutMs: 3000 }); return false; }
  catch (error) { if (!isOffline(error)) throw error; }
  const url = new URL(config.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Automatic startup requires a local ComfyUI URL');
  if (!config.startup?.directory) throw Error('ComfyUI is offline; configure startup.directory to enable automatic startup');
  if (!path.isAbsolute(config.startup.directory) || !fs.existsSync(path.join(config.startup.directory, 'main.py'))) {
    throw Error(`ComfyUI startup.directory must be an absolute ComfyUI installation containing main.py: ${config.startup.directory}`);
  }
  let devices;
  try { devices = parseNvidiaSmiMemory(await gpu()); }
  catch (error) { throw Error(`Cannot start ComfyUI without verified GPU headroom: ${error.message}`); }
  const minimum = config.gpu?.minFreeVramMb;
  if (minimum !== undefined && (!Number.isFinite(minimum) || minimum <= 0)) throw Error('gpu.minFreeVramMb must be a positive number');
  if (devices.some(d => d.freeMb < (minimum ?? d.totalMb * 0.85))) throw Error('Insufficient GPU headroom for ComfyUI; free VRAM before starting it');
  signal?.throwIfAborted();
  const child = start(config);
  let launchError;
  child?.once?.('error', error => { launchError = error; });
  child?.once?.('exit', (code, exitSignal) => { launchError = Error(`ComfyUI exited before readiness (${code ?? exitSignal})`); });
  const deadline = Date.now() + (config.startup.timeoutMs ?? 120_000);
  for (;;) {
    signal?.throwIfAborted();
    if (launchError) throw launchError;
    try { await client.request('/system_stats', { signal, timeoutMs: 3000 }); return true; }
    catch (error) {
      if (!isOffline(error)) throw error;
      if (launchError) throw launchError;
      if (Date.now() >= deadline) throw Error(`ComfyUI did not become ready after launch (PID ${child?.pid || 'unknown'})`);
      await wait(1000, undefined, { signal });
    }
  }
}
