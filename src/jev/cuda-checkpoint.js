// Optional NVIDIA checkpointing removes CUDA allocations left by vLLM sleep.
// The utility is supplied by the user; it is never downloaded by the runtime.
import fs from 'node:fs';
import path from 'node:path';
import { bantamConfigDirectory } from '../config-directory.js';
import { writeJsonAtomic } from '../atomic-file.js';

export function checkpointRecordPath(config) {
  return path.join(bantamConfigDirectory(), `cuda-checkpoint-${Buffer.from(config.container).toString('hex')}.json`);
}

export function liveCheckpoint(config) {
  if (config.engine.mode !== 'managed' || !config.gpu.checkpointBinary) return null;
  try {
    const record = JSON.parse(fs.readFileSync(checkpointRecordPath(config), 'utf8'));
    const stat = fs.readFileSync(`/proc/${record.hostPid}/stat`, 'utf8').split(') ')[1].split(' ');
    return stat[19] === record.startTick && record.endpoint === config.endpoint ? record : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function forgetCheckpoint(config) {
  if (config.engine.mode === 'managed' && config.gpu.checkpointBinary) fs.rmSync(checkpointRecordPath(config), { force: true });
}

export async function checkpointSleepingEngine(config, docker) {
  const binary = config.gpu.checkpointBinary;
  if (!binary || config.engine.mode !== 'managed') return;
  if (!path.isAbsolute(binary) || !fs.existsSync(binary)) throw Error('gpu.checkpointBinary must be an existing absolute NVIDIA cuda-checkpoint path');
  if (liveCheckpoint(config)) return;
  const top = await docker(['top', config.container, '-eo', 'pid,args']);
  const row = top.split('\n').find(line => /VLLM::EngineCore/.test(line));
  if (!row) throw Error('Cannot identify the managed DiffusionGemma CUDA worker');
  const hostPid = Number(row.trim().split(/\s+/)[0]);
  const status = fs.readFileSync(`/proc/${hostPid}/status`, 'utf8');
  const innerPid = Number(status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1));
  if (!innerPid) throw Error('Cannot identify the CUDA worker in its container');
  const startTick = fs.readFileSync(`/proc/${hostPid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  const tool = '/tmp/bantam-cuda-checkpoint';
  await docker(['cp', binary, `${config.container}:${tool}`]);
  // Save before locking so a failed operation still has a safe kill/recovery path.
  writeJsonAtomic(checkpointRecordPath(config), { hostPid, innerPid, startTick, tool, endpoint: config.endpoint, state: 'locking' });
  await docker(['exec', config.container, tool, '--action', 'lock', '--pid', String(innerPid), '--timeout', '5000']);
  await docker(['exec', config.container, tool, '--action', 'checkpoint', '--pid', String(innerPid)]);
  const state = await docker(['exec', config.container, tool, '--get-state', '--pid', String(innerPid)]);
  if (state.trim() !== 'checkpointed') throw Error(`CUDA worker did not checkpoint: ${state}`);
  writeJsonAtomic(checkpointRecordPath(config), { hostPid, innerPid, startTick, tool, endpoint: config.endpoint, state: 'checkpointed' });
}

export async function restoreCheckpointedEngine(config, docker) {
  const record = liveCheckpoint(config);
  if (!record) return;
  if (record.state !== 'checkpointed') throw Error('DiffusionGemma CUDA checkpoint needs recovery; stop its managed container before retrying');
  await docker(['exec', config.container, record.tool, '--action', 'restore', '--pid', String(record.innerPid)]);
  await docker(['exec', config.container, record.tool, '--action', 'unlock', '--pid', String(record.innerPid)]);
  forgetCheckpoint(config);
}
