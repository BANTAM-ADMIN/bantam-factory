#!/usr/bin/env node
// Real hardware check. --live explicitly permits loading/swapping configured
// local models, generating images, and starting the configured Jev engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ModelClient, detectEndpoint } from '../src/model.js';
import { listModels, switchToModel, verifyResidentProfile } from '../src/model-launcher.js';
import { gpuHandoffStatus, availableRamMb } from '../src/gpu-handoff.js';
import { ComfyImageJobs } from '../src/logic/comfyui-image.js';
import { loadJevConfig } from '../src/jev/config.js';
import { createJevService } from '../src/jev/service.js';
import { resolveProfile } from '../src/jev/profiles.js';

if (!process.argv.includes('--live')) {
  console.error('Usage: node scripts/validate-gpu-handoff.mjs --live [--models=name,name]');
  process.exit(2);
}
const endpoint = await detectEndpoint();
const model = new ModelClient({ endpoint, codex: false, apiUrl: null });
const config = loadJevConfig();
const service = createJevService({ config, worker: model, log: event => console.log(JSON.stringify(event)) });
const root = path.resolve('.bantam/gpu-validation'); fs.mkdirSync(root, { recursive: true });
const file = path.join(root, `validation-${new Date().toISOString().replaceAll(':', '-')}.json`);
const report = { startedAt: new Date().toISOString(), events: [], minAvailableRamMb: availableRamMb(), maxStandbys: 0 };
report.reserveRamMb = (await gpuHandoffStatus()).reserveRamMb;
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const timer = setInterval(() => { report.minAvailableRamMb = Math.min(report.minAvailableRamMb, availableRamMb()); }, 250); timer.unref();

async function step(name, work) {
  console.log(`Checking ${name}…`);
  const t = Date.now(); const result = await work(); const handoff = await gpuHandoffStatus();
  assert.ok(handoff.maxStandby !== undefined, 'managed GPU handoff is not configured');
  assert.equal(handoff.reserveRamMb, report.reserveRamMb, 'RAM reserve changed during qualification');
  assert.ok(handoff.standbys.length <= handoff.maxStandby, 'standby count exceeded');
  assert.ok(handoff.availableRamMb >= handoff.reserveRamMb, 'RAM reserve exceeded');
  report.maxStandbys = Math.max(report.maxStandbys, handoff.standbys.length);
  report.events.push({ name, ms: Date.now() - t, result, handoff }); save();
  console.log(`${name}: ${Date.now() - t} ms; ${handoff.standbys.length} standbys; ${Math.round(handoff.availableRamMb)} MiB available RAM`);
  return result;
}
async function infer() {
  const response = await fetch(`${model.endpoint}/completion`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Complete this phrase: The sky is', n_predict: 8, temperature: 0, cache_prompt: true }), signal: AbortSignal.timeout(120000) });
  const body = await response.json(); assert.ok(response.ok && body.content?.trim(), 'local inference failed');
  return { content: body.content, tokensCached: body.tokens_cached, timings: body.timings };
}
async function image(worker = model) {
  const jobs = new ComfyImageJobs(process.cwd(), { onEvent: event => { if (event.state !== 'progress') console.log(event.state, event.message); } });
  await jobs.generate('A brass telescope on a balcony under a starry sky --raw --size 512x512', { model: worker });
  assert.equal(jobs.job.state, 'completed', jobs.status());
  return { state: jobs.job.state, artifacts: jobs.job.artifacts };
}
const question = { profile: resolveProfile('bantam-jev-fast'), state: 'The package was delivered at 14:00. The receiver signed for it.',
  questions: { delivered: { type: 'noul', instructions: 'Was the package delivered?' } }, seed: 12 };

try {
  const names = process.argv.find(arg => arg.startsWith('--models='))?.slice(9).split(',') || [];
  for (const name of names) {
    const target = listModels().find(entry => entry.name === name); assert.ok(target, `unregistered model ${name}`);
    await step(`switch ${name}`, async () => { assert.ok(await switchToModel(model, target)); return verifyResidentProfile(target); });
    await step(`infer ${name}`, infer);
    await step(`image and restore ${name}`, image);
    assert.ok((await verifyResidentProfile(target)).ok);
  }
  await step('local inference before Jev', infer);
  const initial = await step('prime DiffusionGemma', () => service.on({ port: 0, onProgress: console.log }));
  for (let index = 1; index <= 2; index++) await step(`DiffusionGemma text and handback ${index}`, async () => {
    const result = await service.generate({ user: 'Explain what a telescope does in one short sentence.', maxTokens: 256, releaseAfter: true });
    assert.ok(result.text.trim(), 'DiffusionGemma returned empty text'); return result;
  });
  await step('Jev HTTP API', async () => {
    const response = await fetch(`${initial.api.url}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(config.api.token ? { authorization: `Bearer ${config.api.token}` } : {}) }, body: JSON.stringify({ model: 'bantam-jev-fast', state: question.state, questions: question.questions }), signal: AbortSignal.timeout(300000) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.ok(body.answers.delivered.noul > 0.5); return body;
  });
  await step('Jev to ComfyUI to local LLM', image);
  await step('ComfyUI to Jev to local LLM', () => service.decide({ ...question, releaseAfter: true }));
  await step('Codex image restores the physical local LLM', () => image({ codex: true }));
  await step('local inference after all handoffs', infer);
  await service.off({ keepEngine: true });
  const finalHandoff = await gpuHandoffStatus();
  assert.equal(finalHandoff.reserveRamMb, report.reserveRamMb, 'RAM reserve changed during qualification');
  assert.ok(report.minAvailableRamMb >= report.reserveRamMb,
    `sampled available RAM fell to ${Math.round(report.minAvailableRamMb)} MiB below the ${report.reserveRamMb} MiB reserve`);
  report.ok = true;
} catch (error) {
  report.error = error.stack; console.error(error); process.exitCode = 1;
  try { await service.off(); } catch (cleanup) { report.cleanupError = cleanup.stack; }
} finally {
  clearInterval(timer); report.finishedAt = new Date().toISOString(); save(); console.log(`Evidence: ${file}`);
}
