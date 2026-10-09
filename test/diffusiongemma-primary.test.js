import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelClient, modelOutputTokenCap } from '../src/model.js';
import { diffusionGemmaBudget, diffusionGemmaOutputTokens } from '../src/diffusiongemma-budget.js';
import { buildSessionTask } from '../src/continuation.js';
import { createJevService } from '../src/jev/service.js';
import { loadJevConfig } from '../src/jev/config.js';
import { runAgent } from '../src/agent.js';
import { discoverRunningDiffusionGemma } from '../src/diffusiongemma-primary.js';
import { diffusionGemmaFinalText, parseDiffusionGemmaAction, diffusionGemmaActionSystem, completedDiffusionGemmaAction, completedDiffusionGemmaValue } from '../src/diffusiongemma-output.js';
import { buildPrompt } from '../src/prompt.js';

test('lean primary head preserves task, preferences and evidence without duplicate tool instructions', () => {
  const options = { task: 'CURRENT USER REQUEST: preserve every clause.', env: 'src/code.js', turns: [
    { i: 0, action: { a: 'shell', c: 'node test.js' }, observation: 'ACTUAL TEST RESULT: 6 passed' }],
    profileText: 'USER PREFERENCE: metric units.', interactive: true, maxTurns: 12,
    toolsText: 'REGISTERED TOOL DOCUMENTATION '.repeat(200), contractText: 'CURRENT CONTRACT: do not edit tests.' };
  const lean = buildPrompt({ ...options, diffusionTools: true });
  const regular = buildPrompt({ ...options, compactRules: true });
  assert.ok(lean.length < regular.length / 2, 'prompt overhead substantially reduced');
  for (const anchor of ['CURRENT USER REQUEST', 'USER PREFERENCE', 'ACTUAL TEST RESULT', 'CURRENT CONTRACT', 'src/code.js']) assert.ok(lean.includes(anchor));
  assert.doesNotMatch(lean, /REGISTERED TOOL DOCUMENTATION|Actions \(emit exactly one/);
  assert.match(regular, /REGISTERED TOOL DOCUMENTATION|Actions \(emit exactly one/);
});

test('file blocks preserve literal source while rejecting incomplete or ambiguous actions', () => {
  const source = '<!DOCTYPE html>\n<canvas id="tetris"></canvas>\n<script>const s = "quoted"; const pattern = /\\w+/;</script>';
  const block = `{"a":"write_file","p":"tetris.html"}\n\`\`\`html\n${source}\n\`\`\``;
  assert.deepEqual(parseDiffusionGemmaAction(block).action, { a: 'write_file', p: 'tetris.html', content: source });
  for (const bad of [block.slice(0, -3), block + '\n{"a":"shell","c":"touch unwanted"}', block.replace('"p":"tetris.html"', '"p":"tetris.html","content":"other"'), block.replace('"write_file"', '"shell"')]) {
    assert.equal(parseDiffusionGemmaAction(bad).ok, false);
  }
  assert.equal(parseDiffusionGemmaAction(block.slice(0, -3)).partialAction.path, 'tetris.html');
  assert.equal(parseDiffusionGemmaAction('{"a":"respond","text":"Hello"}').action.text, 'Hello');
  assert.equal(parseDiffusionGemmaAction(block.replace('"p":"tetris.html"', '"p":12')).ok, false);
  const edit = '{"a":"edit_lines","p":"code.js","start":2,"end":3}\n```js\nconst s = "quoted";\n```';
  assert.deepEqual(parseDiffusionGemmaAction(edit).action, { a: 'edit_lines', p: 'code.js', start: 2, end: 3, new: 'const s = "quoted";' });
  assert.equal(parseDiffusionGemmaAction(edit.replace('"start":2', '"start":0')).ok, false);
  assert.equal(parseDiffusionGemmaAction(edit.replace('"end":3', '"end":3,"new":"ambiguous"')).ok, false);
  const rules = diffusionGemmaActionSystem('- {"a":"write_file","p":"path","content":"..."}\n- {"a":"edit_lines","p":"path","start":1,"end":2,"new":"..."}');
  assert.match(rules, /Read the current file/); assert.doesNotMatch(rules, /"content":"\.\.\."|"new":"\.\.\."/);
  assert.deepEqual(parseDiffusionGemmaAction('{"a":"preview","p":"tetris.html interact"}').action, { a: 'query', q: 'preview tetris.html interact' });
  assert.equal(parseDiffusionGemmaAction('{"a":"preview","p":"tetris.html","c":"touch unwanted"}').ok, false);
  assert.equal(parseDiffusionGemmaAction('{"a":"preview","p":"tetris.html","q":"other"}').ok, false);
});

test('the native preview shorthand reaches the registered tool through the normal dispatcher', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-preview-alias-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [], outputs = ['{"a":"preview","p":"hello.html interact"}', '{"a":"respond","text":"Preview completed."}'];
  const preview = { name: 'preview', verbs: ['preview'], description: 'fixture browser', answer(q) { calls.push(q); this.lastResult = { status: 'pass', mode: 'interact', entry: 'hello.html' }; return 'PREVIEW STATUS: pass'; } };
  const model = { diffusionGemma: true, contextBudget: diffusionGemmaBudget(), assistantPrefill: '', complete: async () => ({ content: outputs.shift(), tokens: 50 }) };
  const result = await runAgent({ workspace, model, task: 'Preview hello.html without editing.', interactive: true, maxTurns: 3,
    grounding: true, useGrammar: false, extraTools: [preview], shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off' });
  assert.deepEqual(calls, ['hello.html interact']); assert.equal(result.metrics.previewPasses, 1); assert.equal(result.metrics.invalid, 0);
});

test('literal line edits reach the real executor with numbered source and preserve surrounding lines', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-line-block-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'code.js'), 'const first = 1;\nconst s = "old";\nconst last = 3;\n');
  const outputs = ['{"a":"read_file","p":"code.js"}', '{"a":"edit_lines","p":"code.js","start":2,"end":2}\n```js\nconst s = "new";\n```', '{"a":"respond","text":"Updated the string."}'];
  const model = { diffusionGemma: true, contextBudget: diffusionGemmaBudget(), assistantPrefill: '', complete: async () => ({ content: outputs.shift(), tokens: 100 }) };
  const result = await runAgent({ workspace, model, task: 'Change the string in code.js from old to new, preserving all other lines.', interactive: true, maxTurns: 4,
    grounding: true, useGrammar: false, shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off' });
  assert.equal(fs.readFileSync(path.join(workspace, 'code.js'), 'utf8'), 'const first = 1;\nconst s = "new";\nconst last = 3;\n');
  assert.equal(result.metrics.actions.edit_lines, 1); assert.equal(result.metrics.invalid, 0);
});

test('interactive diffusion file actions reach the executor after a truncated attempt, without a false cache warning', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-file-block-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = '<main id="hello">Hello</main>', events = [], opts = [];
  const outputs = ['{"a":"write_file","p":"hello.html"}\n```html\nunfinished', `{"a":"write_file","p":"hello.html"}\n\`\`\`html\n${source}\n\`\`\``, '{"a":"respond","text":"Created hello.html."}'];
  const model = { diffusionGemma: true, contextBudget: diffusionGemmaBudget(), assistantPrefill: '',
    async complete(prompt, options) {
      opts.push(options);
      if (outputs.length === 2) assert.equal(fs.existsSync(path.join(workspace, 'hello.html')), false, 'truncated content was never applied');
      return { content: outputs.shift(), tokens: opts.length === 1 ? 4096 : 100, stoppedLimit: opts.length === 1, usage: { inputTokens: 3000, cacheHitTokens: 0 } };
    },
  };
  const result = await runAgent({ workspace, model, task: 'Create hello.html containing a main element saying Hello, then report.', interactive: true, maxTurns: 4,
    grounding: false, useGrammar: false, shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off', onEvent: event => events.push(event) });
  assert.equal(fs.readFileSync(path.join(workspace, 'hello.html'), 'utf8'), source);
  assert.ok(opts.every(options => options.agentAction));
  assert.equal(result.metrics.outputLimitRecoveries, 1); assert.equal(result.metrics.protocolViolations, 0);
  assert.equal(result.responded, true); assert.ok(!events.some(event => event.type === 'throughput_andon'));
});

test('thought delimiters are parsed before final text enters chat history or action parsing', () => {
  assert.equal(diffusionGemmaFinalText('<|channel>thought\nprivate reasoning<channel|>{"a":"done"}<turn|>'), '{"a":"done"}');
  assert.equal(diffusionGemmaFinalText('<|channel>thought\n'), '');
  assert.equal(diffusionGemmaFinalText('<|cha'), '');
  assert.equal(diffusionGemmaFinalText('A normal answer'), 'A normal answer');
  assert.equal(diffusionGemmaFinalText('<|channel>thought\n<channel|>OK<turn|>'), 'OK');
  assert.equal(diffusionGemmaFinalText('<channel|>{"a":"read_file"}<turn|>'), '{"a":"read_file"}');
});

test('startup adopts the awake configured engine, without starting a stopped or sleeping one', async () => {
  const config = { engine: { mode: 'external' }, endpoint: 'http://host:8001', servedModel: 'dgemma' };
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return new Response(JSON.stringify({ data: [{ id: 'dgemma', max_model_len: 16384 }] })); };
  for (const state of ['stopped', 'asleep', 'starting']) assert.equal(await discoverRunningDiffusionGemma({ config, engine: { status: async () => ({ state }) }, fetchImpl }), null);
  assert.equal(fetches, 0);
  const found = await discoverRunningDiffusionGemma({ config, engine: { status: async () => ({ state: 'awake' }) }, fetchImpl });
  assert.equal(found.dialect, 'diffusiongemma'); assert.equal(found.contextTokens, 16384);
});

test('16K deployment reserves generation and compacts with hysteresis', () => {
  const b = diffusionGemmaBudget();
  assert.equal(b.compactAtTokens, 5376); assert.equal(b.compactToTokens, 4032);
  assert.equal(b.hardInputTokens + b.generationTokens + b.marginTokens, 16384);
  assert.equal(diffusionGemmaOutputTokens(null, b), 8192);
  assert.equal(diffusionGemmaOutputTokens(16000, b), 8192);
  assert.throws(() => diffusionGemmaOutputTokens(0, b));
  for (const ctx of [4096, 8192, 16384, 32768]) {
    const small = diffusionGemmaBudget(ctx);
    assert.ok(small.hardInputTokens + small.generationTokens + small.marginTokens <= ctx);
    assert.ok(small.compactToTokens < small.compactAtTokens);
  }
});

test('exact server tokenizer counts the assembled prompt and blocks an over-budget generation', async t => {
  let count = 5376, blanks = 0, clippedThought = false; const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null; calls.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/tokenize') res.end(JSON.stringify({ count }));
    else if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ message: { content: clippedThought ? '<|channel>thought\nReasoning without a final answer' : blanks-- > 0 ? '' : '<|channel>thought\n<channel|>OK<turn|>' }, finish_reason: clippedThought ? 'length' : 'stop' }], usage: { prompt_tokens: count, completion_tokens: 1 } }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const model = new ModelClient({ codex: false, apiUrl: `http://127.0.0.1:${server.address().port}/v1`, apiDialect: 'diffusiongemma', model: 'dgemma', retries: 0 });
  model.diffusionCoordinator = { run: work => work(), release: async () => {} };
  t.after(() => model.close());
  const prompt = model.probePrompt('A complete user request.');
  const receipt = await model.inspectContext(prompt);
  assert.equal(receipt.inputTokens, 5376); assert.equal(receipt.shouldCompact, true);
  assert.equal(modelOutputTokenCap(model), 8192);
  assert.equal(modelOutputTokenCap(model, { action: true }), 8192);
  assert.equal((await model.complete(prompt)).content, 'OK');
  assert.equal(calls.filter(c => c.path === '/tokenize').length, 1, 'reuse only an identical tokenized request');
  const body = calls.find(c => c.path === '/v1/chat/completions').body;
  assert.equal(body.max_tokens, 8192); assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.equal(body.skip_special_tokens, false);
  assert.equal(body.response_format, undefined, 'diffusion decoder does not support AR output grammar');
  for (const key of ['temperature', 'min_p', 'seed']) assert.equal(body[key], undefined);
  count = 12000;
  await assert.rejects(model.complete(model.probePrompt('A different oversized request.')), { code: 'context_overflow' });
  assert.equal(calls.filter(c => c.path === '/v1/chat/completions').length, 1, 'never submit the oversized request');
  count = 100; blanks = 1;
  assert.equal((await model.complete(model.probePrompt('Retry a blank sample.'))).content, 'OK');
  assert.equal(calls.filter(c => c.path === '/v1/chat/completions').length, 3);
  blanks = 10;
  await assert.rejects(model.complete(model.probePrompt('Bound persistent empty samples.')), { code: 'empty_completion' });
  assert.equal(calls.filter(c => c.path === '/v1/chat/completions').length, 6, 'only three blank generations');
  clippedThought = true;
  await assert.rejects(model.complete(model.probePrompt('Bound reasoning that exhausts the output reserve.'), { thinking: true }), { code: 'generation_budget_exhausted' });
  assert.equal(calls.filter(c => c.path === '/v1/chat/completions').length, 7, 'a clipped thought must not repeat the same expensive generation');
  const thinking = JSON.parse(model.buildRequest(prompt, { thinking: true, nPredict: 5000 }).body);
  assert.equal(thinking.max_tokens, 5000); assert.equal(thinking.chat_template_kwargs.enable_thinking, true);
  const action = JSON.parse(model.buildRequest(prompt, { agentAction: true }).body);
  assert.equal(action.max_tokens, 8192); assert.match(action.messages[0].content, /literal file contents/);
  assert.equal(action.stream, true); assert.deepEqual(action.stream_options, { include_usage: true });
  assert.ok(!action.stop?.includes('\n```\n'), 'a bare opening fence must not trigger a server stop');
  model.switchToApi({ url: 'https://example.com/v1', model: 'other', dialect: 'chat' });
  assert.equal(model.diffusionGemma, false); assert.equal(model.contextBudget, null);
});

test('shortening previous session context preserves the entire new request', () => {
  const request = 'CURRENT TASK ' + 'specific requirement '.repeat(400);
  const history = [{ request: 'earlier '.repeat(2000), summary: 'report '.repeat(3000) }];
  const task = buildSessionTask({ request, sessionLog: history, maxHistoryChars: 6000 });
  assert.ok(task.endsWith(`New request: ${request.trim()}`));
  assert.ok(task.length < request.length + 6100); assert.match(task, /saved transcript/);
  assert.match(buildSessionTask({ request, sessionLog: history }), /Your last report, in full/);
});

test('primary requests wake without a broker, serialize, and Jev off keeps chat alive', async () => {
  const calls = []; let state = 'stopped';
  const engine = { status: async () => ({ state }), ensureAwake: async () => { state = 'awake'; calls.push('wake'); }, stop: async () => { state = 'stopped'; calls.push('stop'); } };
  const config = loadJevConfig({ gpu: { policy: 'swap' } }, { readFile: () => { throw Object.assign(Error('none'), { code: 'ENOENT' }); } });
  const service = createJevService({ config, engine, worker: { diffusionGemma: true, apiMode: true, apiUrl: 'http://127.0.0.1:8001/v1' } });
  const order = [];
  await Promise.all([service.runPrimary(async () => { order.push(1); await new Promise(resolve => setTimeout(resolve, 20)); order.push(2); }), service.runPrimary(async () => order.push(3))]);
  assert.deepEqual(order, [1, 2, 3]);
  await service.off(); assert.equal(state, 'awake'); assert.equal((await service.status()).primary, true);
  assert.ok(!calls.includes('stop'));
  await service.releasePrimary(); assert.equal((await service.status()).primary, false);
  await service.off(); assert.equal(state, 'stopped');
});

test('agent trims early to the 4K target while keeping the current task', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-compact-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"private":true}');
  const events = [], prompts = [], budgets = [6000, 4800, 3900];
  const b = diffusionGemmaBudget();
  const model = { diffusionGemma: true, contextWindowTokens: 16384, contextBudget: b, assistantPrefill: '',
    inspectContext: async prompt => { prompts.push(prompt); const inputTokens = budgets.shift() ?? 3900; return { ...b, inputTokens, shouldCompact: inputTokens >= b.compactAtTokens }; },
    complete: async () => ({ content: JSON.stringify({ a: 'done', summary: 'Finished.' }), tokens: 1, stoppedEos: true, timings: {} }),
  };
  await runAgent({ workspace, task: 'Keep this exact current task anchor.', model, maxTurns: 10, useGrammar: false, shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off',
    resumeTurns: Array.from({ length: 8 }, (_, i) => ({ i, action: { a: 'shell', c: 'pwd' }, observation: `Earlier observation ${i}` })),
    onEvent: event => events.push(event),
  });
  assert.equal(events.filter(e => e.type === 'context_trim' && e.cause === 'diffusiongemma_soft_limit').length, 2);
  assert.ok(prompts.every(p => p.includes('Keep this exact current task anchor.')));
  assert.ok(events.some(e => e.type === 'context_budget' && e.inputTokens === 3900));
});

for (const [label, fence, language, source, fieldOnly] of [
  ['bare opening fence', '```', '', '<main id="quoted">Hello</main>'],
  ['nested Markdown fences', '````', 'markdown', '# Notes\n```js\nconst value = "quoted";\n```\nMore notes.'],
  ['CPU-owned source field', '````', 'markdown', '# Notes\n```js\nconst value = "quoted";\n```\nMore notes.', true],
]) test(`streaming stops after a complete file action with ${label}, cancels excess generation and preserves source`, async t => {
  const frame = `${fieldOnly ? '' : '{"a":"write_file","p":"notes.md"}\n'}${fence}${language}\n${source}\n${fence}`;
  const finish = fieldOnly ? completedDiffusionGemmaValue : completedDiffusionGemmaAction;
  assert.equal(finish(frame.slice(0, -fence.length)), null);
  if (fieldOnly) assert.equal(finish(frame + '\nMore drafts'), frame);
  else assert.deepEqual(JSON.parse(finish(frame + '\nMore drafts')), { a: 'write_file', p: 'notes.md', content: source });
  assert.equal(finish('<|channel>thought\n' + frame), null, 'a complete frame inside a thought is not an action');
  let cancelled = 0, sentTail = false, requests = 0, tokenizations = 0;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === '/tokenize') {
      res.setHeader('content-type', 'application/json');
      if (body.prompt !== undefined) { tokenizations++; assert.equal(body.add_special_tokens, false); assert.ok(body.prompt.includes(source)); }
      return res.end(JSON.stringify({ count: body.prompt !== undefined ? 200 : 100 }));
    }
    requests++; assert.equal(body.stream, true);
    res.setHeader('content-type', 'text/event-stream'); res.flushHeaders();
    const parts = ['<|channel>thought\nA thought containing a code fence:\n```js\nlet x = 1;\n```\n', '<channel|>', frame.slice(0, 20), frame.slice(20)];
    let timer;
    res.on('close', () => { cancelled++; clearTimeout(timer); });
    const send = () => {
      if (parts.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts.shift() }, finish_reason: null }] })}\n\n`); timer = setTimeout(send, 15); }
      else { sentTail = true; res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '\n{"a":"shell","c":"touch unwanted"}' }, finish_reason: 'stop' }] })}\n\n`); }
    };
    send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const model = new ModelClient({ codex: false, apiUrl: `http://127.0.0.1:${server.address().port}/v1`, apiDialect: 'diffusiongemma', model: 'dgemma', retries: 0 });
  model.diffusionCoordinator = { run: work => work(), release: async () => {} };
  t.after(() => model.close());
  const result = await model.complete(model.probePrompt('Write notes.md.'), fieldOnly ? { diffusionValue: true } : { agentAction: true });
  if (fieldOnly) assert.equal(result.content, frame);
  else assert.deepEqual(JSON.parse(result.content), { a: 'write_file', p: 'notes.md', content: source });
  assert.equal(result.completionBoundary, 'validated_action'); assert.equal(result.tokensSource, 'server_tokenizer_received_text');
  assert.equal(result.tokens, 200); assert.equal(requests, 1); assert.equal(tokenizations, 1);
  assert.equal(sentTail, false); assert.equal(cancelled, 1);
});
