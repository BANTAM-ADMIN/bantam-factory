// Explicit live qualification; never invoked by the unit test suite.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ModelClient } from '../src/model.js';
import { selectDiffusionGemma, discoverRunningDiffusionGemma } from '../src/diffusiongemma-primary.js';
import { jevSessionFor } from '../src/jev/commands.js';
import { runAgent } from '../src/agent.js';
import { ComfyImageJobs } from '../src/logic/comfyui-image.js';
import { availableRamMb, gpuHandoffConfig } from '../src/gpu-handoff.js';
import { parse } from 'acorn';
import { runPreviewSync, classifyPreviewReport } from '../src/logic/preview.js';

if (!process.argv.includes('--live')) throw Error('Use --live to load your configured DiffusionGemma and run a real task; --image also generates an image.');
const output = path.resolve(process.argv.find(a => a.startsWith('--output='))?.slice(9) ?? '.bantam/gpu-validation/diffusiongemma-primary-benchmark');
fs.mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), steps: [], events: [] };
report.minAvailableRamMb = availableRamMb();
report.reserveRamMb = gpuHandoffConfig()?.reserveRamMb;
const ramTimer = setInterval(() => { report.minAvailableRamMb = Math.min(report.minAvailableRamMb, availableRamMb()); }, 250); ramTimer.unref();
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const model = new ModelClient({ codex: false, apiUrl: null });
let service;
async function step(name, work) {
  console.log(name); const t = performance.now();
  try { const result = await work(); report.steps.push({ name, ms: performance.now() - t, result }); save(); return result; }
  catch (error) { report.steps.push({ name, ms: performance.now() - t, error: error.stack }); save(); throw error; }
}
async function chat(text, opts = {}) {
  const answer = await model.complete(model.probePrompt(text), { nPredict: 512, ...opts });
  assert.ok(answer.content.trim(), 'Empty chat response');
  return { ...answer, budget: model.lastContextBudget };
}
try {
  await step('cold start primary', () => selectDiffusionGemma(model, { out: s => process.stdout.write(s) }));
  service = jevSessionFor(model).service;
  report.budget = model.contextBudget;
  await step('startup detects an already-awake DiffusionGemma', async () => {
    const found = await discoverRunningDiffusionGemma();
    assert.equal(found?.dialect, 'diffusiongemma'); assert.equal(found.contextTokens, model.contextWindowTokens); return found;
  });
  for (let i = 0; i < 3; i++) await step(`short chat ${i + 1}`, () => chat('In two sentences, explain why compacting chat history leaves room for an answer.'));
  await step('thinking within 4K generation reserve', () => chat('A shop discounts a $120 item by 25%, then adds 10% tax. What is the final price? Explain briefly.', { thinking: true, nPredict: 4096 }));
  await step('streaming chat hides thought channels', async () => {
    const progress = [];
    const result = await chat('Say HELLO in your final answer.', { thinking: true, nPredict: 512, onProgress: event => progress.push(event.content) });
    assert.match(result.content, /HELLO/);
    assert.ok(progress.every(text => !/<\|channel>|<channel\|>|^thought\n/.test(text)));
    return { result, progress };
  });
  await step('Jev and chat share the primary engine', async () => {
    const status = await service.on({ serve: true, port: 0 });
    const token = jevSessionFor(model).config.api.token;
    const results = await Promise.all([
      fetch(`${status.api.url}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ model: 'bantam-jev-fast', state: 'The package was delivered at 14:00. The receiver signed for it.', questions: { delivered: { type: 'noul', instructions: 'Was the package delivered?' } }, seed: 12 }),
        signal: AbortSignal.timeout(60000) }).then(async response => { const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; }),
      chat('Reply with a short greeting.'),
    ]);
    assert.ok(results[0].answers.delivered.noul > .5);
    await service.off();
    assert.equal((await service.status()).engine, 'awake', 'Jev off must preserve primary chat');
    return results;
  });
  await step('hard context ceiling refuses before generation', async () => {
    let text = 'context-budget-check '.repeat(4000);
    while ((await model.inspectContext(model.probePrompt(text))).inputTokens <= model.contextBudget.hardInputTokens) text += text;
    await assert.rejects(model.complete(model.probePrompt(text)), { code: 'context_overflow' });
    return model.lastContextBudget;
  });
  await step('real light coding task', async () => {
    const workspace = path.join(output, 'task'); fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(workspace, 'clamp.js'), 'export function clamp(value, min, max) {\n  return Math.max(max, Math.min(min, value));\n}\n');
    const checks = `import assert from 'node:assert/strict';\nimport { clamp } from './clamp.js';\nassert.equal(clamp(5, 0, 10), 5);\nassert.equal(clamp(-2, 0, 10), 0);\nassert.equal(clamp(12, 0, 10), 10);\nassert.equal(clamp(-3, -10, -1), -3);\nassert.equal(clamp(3, 3, 3), 3);\nassert.equal(clamp(0.5, 0, 1), 0.5);\nconsole.log('6 clamp checks passed');\n`;
    fs.writeFileSync(path.join(workspace, 'test.js'), checks);
    execFileSync('git', ['init', '-q', workspace]);
    const result = await runAgent({ workspace, model, maxTurns: 12, wallDeadlineMs: 180000,
      task: 'Fix clamp(value, min, max) in clamp.js so it returns value inside the inclusive range, min below it, and max above it. Bounds are already ordered. Read the source, make the smallest fix, run node test.js, then report the result. Preserve test.js unchanged.',
      verificationScript: 'node test.js', shellSandbox: 'host', thinkMode: 'off',
      stateAudit: 'off', contractStateAudit: 'off',
      onEvent: event => { report.events.push(event); save(); if (['action','context_trim','context_budget','done'].includes(event.type)) console.log(JSON.stringify(event)); },
    });
    const unmodifiedTests = fs.readFileSync(path.join(workspace, 'test.js'), 'utf8') === checks;
    let grade; try { grade = { passed: true, stdout: execFileSync(process.execPath, ['test.js'], { cwd: workspace, encoding: 'utf8' }) }; } catch (error) { grade = { passed: false, error: String(error.stderr ?? error.message) }; }
    const taskResult = { result, grade, unmodifiedTests, source: fs.readFileSync(path.join(workspace, 'clamp.js'), 'utf8'), testSha256: crypto.createHash('sha256').update(checks).digest('hex') };
    report.taskPassed = grade.passed && unmodifiedTests;
    fs.writeFileSync(path.join(output, 'task-result.json'), JSON.stringify(taskResult, null, 2));
    return taskResult;
  });
  await step('long-history task compacts before generation', async () => {
    const workspace = path.join(output, 'task'), events = [];
    const historicalTurns = Array.from({ length: 8 }, (_, i) => ({ i, action: { a: 'shell', c: `printf archived-log-${i}` },
      observation: `Archived unrelated output ${i}, retained only to exercise context trimming: ` + '🧩🪵🪨🦆'.repeat(150) }));
    const result = await runAgent({ workspace, model, maxTurns: 12, resumeTurns: historicalTurns, wallDeadlineMs: 60000,
      task: 'Read clamp.js and briefly confirm whether it now clamps to the inclusive ordered bounds correctly. Do not edit any files. The archived logs are unrelated to this task.',
      shellSandbox: 'host', thinkMode: 'off', stateAudit: 'off', contractStateAudit: 'off',
      onEvent: event => { events.push(event); if (['context_trim','context_budget'].includes(event.type)) console.log(JSON.stringify(event)); },
    });
    const trims = events.filter(e => e.type === 'context_trim' && e.cause === 'diffusiongemma_soft_limit');
    const receipts = events.filter(e => e.type === 'context_budget');
    assert.ok(trims.length, 'The live stress prompt must exercise early compaction');
    assert.ok(receipts.every(e => e.inputTokens <= report.budget.hardInputTokens));
    return { result, trims, receipts };
  });
  if (process.argv.includes('--tetris')) try { await step('interactive single-file Tetris regression', async () => {
    const workspace = fs.mkdtempSync(path.join(output, 'tetris-'));
    execFileSync('git', ['init', '-q', workspace]);
    const result = await runAgent({ workspace, model, maxTurns: 12, interactive: true, grounding: true, wallDeadlineMs: 180000,
      task: 'Make me a single-file tetris in a HTML file right now.', shellSandbox: 'host', thinkMode: 'off', verificationPolicy: 'after_edit',
      onEvent: event => { if (event.type !== 'model_stream') { report.events.push(event); save(); } },
    });
    fs.writeFileSync(path.join(workspace, 'agent-result.json'), JSON.stringify(result, null, 2));
    const files = fs.readdirSync(workspace).filter(name => name.endsWith('.html'));
    assert.equal(files.length, 1, 'Exactly one HTML deliverable is required');
    const source = fs.readFileSync(path.join(workspace, files[0]), 'utf8');
    assert.match(source, /<canvas\b/i);
    const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    assert.ok(scripts.length, 'The HTML needs embedded game logic');
    for (const [, attributes, body] of scripts) {
      assert.doesNotMatch(attributes, /\bsrc\s*=/i, 'Game scripts must be embedded');
      parse(body, { ecmaVersion: 'latest', sourceType: /\btype\s*=\s*["']module["']/i.test(attributes) ? 'module' : 'script' });
    }
    const browser = runPreviewSync(workspace, files[0], { interact: true, captureInteractiveScreenshot: true });
    fs.writeFileSync(path.join(workspace, 'browser-check.json'), JSON.stringify(browser, null, 2));
    report.tetrisPassed = classifyPreviewReport(browser) === 'pass' && browser.interaction?.completed === true;
    assert.ok(report.tetrisPassed, 'Independent browser load and keyboard smoke must pass');
    assert.ok(result.done || result.responded, 'The agent must complete the request');
    return { result, files, browser, limits: 'Syntax, offline browser rendering and bounded keyboard smoke; not exhaustive gameplay verification.' };
  }); } catch (error) { report.tetrisPassed = false; report.tetrisError = error.stack; console.error(error); }
  if (process.argv.includes('--image')) await step('primary to image to primary chat', async () => {
    const jobs = new ComfyImageJobs(process.cwd(), { onEvent: event => { report.events.push(event); save(); console.log(JSON.stringify(event)); } });
    try { await jobs.generate('A brass telescope on a balcony under a starry sky --raw --size 512x512', { model });
      assert.equal(jobs.job.state, 'completed');
      const reply = await chat('What instrument would you use to observe distant stars? One sentence.');
      return { artifacts: jobs.job.artifacts, reply, primary: (await service.status()).primary };
    } finally { await jobs.close(); }
  });
  report.completed = true;
  report.qualified = report.taskPassed && (!process.argv.includes('--tetris') || report.tetrisPassed) && (!report.reserveRamMb || report.minAvailableRamMb >= report.reserveRamMb);
  if (!report.qualified) process.exitCode = 1;
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  try { await model.close(); if (service) await service.off(); }
  finally { clearInterval(ramTimer); report.finishedAt = new Date().toISOString(); save(); }
}
