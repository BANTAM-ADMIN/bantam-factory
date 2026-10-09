// Machine-local restart recipes. Read argv as NUL-separated bytes, never ps text.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bantamConfigDirectory } from './config-directory.js';
import { writeJsonAtomic } from './atomic-file.js';
import { endpointKey } from './image-gpu.js';
import { loadoutHash, recordLoadout } from './logic/loadouts.js';
import { acquireExclusiveFileLock } from './exclusive-file-lock.js';

export const userModelRegistryPath = () => path.join(bantamConfigDirectory(), 'user-models.json');
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const allowedEnvironment = /^(CUDA_VISIBLE_DEVICES|CUDA_DEVICE_ORDER|CUDA_HOME|LD_LIBRARY_PATH|LLAMA_ARG_[A-Z0-9_]+|GGML_[A-Z0-9_]+|OMP_NUM_THREADS)$/;

export function readLocalLaunch(pid, { proc = '/proc' } = {}) {
  const directory = path.join(proc, String(pid));
  const args = fs.readFileSync(path.join(directory, 'cmdline'), 'utf8').split('\0');
  if (args.at(-1) === '') args.pop();
  if (!/^llama-server(?:$|[-.])/.test(path.basename(args[0] || ''))) return null;
  // PATH at the next launch can differ from the process's original shell.
  try { args[0] = fs.readlinkSync(path.join(directory, 'exe')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const env = Object.fromEntries(fs.readFileSync(path.join(directory, 'environ'), 'utf8').split('\0').filter(Boolean)
    .map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)])
    .filter(([key]) => allowedEnvironment.test(key)));
  return { args, cwd: fs.readlinkSync(path.join(directory, 'cwd')), env };
}

export function launchRecipeScript({ args, cwd, env }) {
  return '#!/usr/bin/env bash\nset -e\ncd -- ' + shellQuote(cwd) + '\nexec env ' +
    Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`)).concat(args.map(shellQuote)).join(' ') + '\n';
}

export async function captureLocalModel(endpoint, { registry, readLaunch = readLocalLaunch, portPid, fetchImpl = fetch } = {}) {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  const get = async route => {
    const response = await fetchImpl(`${endpointKey(endpoint)}${route}`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw Error(`model capture ${route}: HTTP ${response.status}`);
    return response.json();
  };
  const props = await get('/props');
  if (!props.model_path) return null;
  let pid = portPid;
  if (!pid) {
    try { pid = Number(execFileSync('fuser', [`${url.port || '80'}/tcp`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim().split(/\s+/)[0]); }
    catch { return null; }
  }
  const recipe = readLaunch(pid);
  if (!recipe) return null;
  const files = [path.resolve(recipe.cwd, props.model_path)];
  for (let i = 1; i < recipe.args.length; i++) if (['--mmproj', '--chat-template-file', '--model-draft', '-md'].includes(recipe.args[i])) files.push(path.resolve(recipe.cwd, recipe.args[++i]));
  const card = (await get('/v1/models')).data?.[0];
  const id = card?.id || path.basename(props.model_path);
  const hash = loadoutHash([...recipe.args, recipe.cwd, ...Object.entries(recipe.env).flat()]);
  const root = bantamConfigDirectory();
  const script = path.join(root, 'launchers', `captured-${hash}.sh`);
  const argNumber = (...flags) => { const at = recipe.args.findIndex(arg => flags.includes(arg)); return at < 0 ? undefined : Number(recipe.args[at + 1]); };
  const slots = argNumber('--parallel', '-np');
  const ctx = argNumber('--ctx-size', '-c');
  recordLoadout({ args: recipe.args, slots, ctx, label: id });
  const existing = registry ?? (await import('./model-launcher.js')).listModels();
  const known = existing.find(entry => endpointKey(entry.endpoint) === endpointKey(endpoint)
    && entry.match && id.toLowerCase().includes(entry.match.toLowerCase())
    && (entry.slots == null || entry.slots === slots) && (entry.ctx == null || entry.ctx === ctx));
  // Curated startup scripts remain authoritative; capture never rewrites them.
  if (known) { await (await import('./gpu-handoff.js')).ensureGpuHandoff(endpoint); return known; }
  const entry = { name: `captured-${hash}`, label: id, endpoint: endpointKey(endpoint), script, match: id,
    slots, ctx, vision: Boolean(props.modalities?.vision), profile: /gemma|orion|mero/i.test(id) ? 'gemma' : /qwen/i.test(id) ? 'qwen' : 'generic',
    files, captured: true, recipe };
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(script), 0o700);
  fs.writeFileSync(script, launchRecipeScript(recipe), { mode: 0o600 });
  fs.chmodSync(script, 0o600);
  const file = userModelRegistryPath();
  const lock = acquireExclusiveFileLock(`${file}.lock`, { waitMs: 5000 });
  try {
    let entries;
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); fs.chmodSync(file, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; fs.writeFileSync(file, '[]\n', { flag: 'wx', mode: 0o600 }); }
    writeJsonAtomic(file, entries.filter(item => item.name !== entry.name).concat(entry));
  } finally { lock.release(); }
  await (await import('./gpu-handoff.js')).ensureGpuHandoff(endpoint);
  return entry;
}
