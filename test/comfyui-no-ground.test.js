import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent } from '../src/agent.js';

test('a ComfyUI image tool remains available when grounding is disabled', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-comfy-no-ground-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const prior = process.env.BANTAM_IMAGE_GENERATION_PROVIDER;
  process.env.BANTAM_IMAGE_GENERATION_PROVIDER = 'comfyui';
  t.after(() => { if (prior === undefined) delete process.env.BANTAM_IMAGE_GENERATION_PROVIDER; else process.env.BANTAM_IMAGE_GENERATION_PROVIDER = prior; });
  const seen = [];
  const imageJobs = { generate: async query => { seen.push(query); return '[generate_image] queued'; }, status: () => 'idle', cancel: async () => 'cancelled' };
  let step = 0;
  const model = { assistantPrefill: '', stop: [], complete: async () => ({
    content: step++ === 0 ? '{"a":"query","q":"generate_image a cat"}' : '{"a":"respond","text":"Done."}',
    tokens: 1, stoppedEos: true, timings: {},
  }) };
  const result = await runAgent({ workspace, model, imageJobs, task: 'Generate a cat image.', maxTurns: 2,
    grounding: false, interactive: true, useGrammar: false, shellSandbox: 'host' });
  assert.equal(result.turns[0].queryTool, 'generate_image');
  assert.deepEqual(seen, ['a cat']);
});
