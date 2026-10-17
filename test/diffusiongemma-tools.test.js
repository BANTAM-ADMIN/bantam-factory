import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ModelClient } from '../src/model.js';
import { runAgent } from '../src/agent.js';
import { createJevService } from '../src/jev/service.js';
import { loadJevConfig } from '../src/jev/config.js';
import { diffusionGemmaToolTurn } from '../src/diffusiongemma-tools.js';
import { diffusionGemmaBudget } from '../src/diffusiongemma-budget.js';

// Real HTTP, reader, tokenizer/handle compilation, primary coordinator, agent
// and executor; deterministic probabilities replace only model inference.
async function fixture(t, select, values) {
  const vocabulary = new Map(), requests = [];
  const token = text => { if (!vocabulary.has(text)) vocabulary.set(text, vocabulary.size + 100); return vocabulary.get(text); };
  const tokenize = text => (text.match(/[A-Z]{2,3}|[\s\S]/g) ?? []).map(token);
  const scaffold = tokenize('<|channel>thought\n<channel|>');
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url, body });
    let answer;
    if (req.url === '/tokenize') answer = { tokens: body.messages ? [1, 2, ...scaffold] : tokenize(body.prompt), count: body.messages ? 300 : tokenize(body.prompt).length };
    else if (body.vllm_xargs) {
      const user = body.messages[1].content;
      const options = [...user.split('OPTIONS:\n').at(-1).matchAll(/^\[([A-Z]+)\] (.*)$/gm)];
      const chosen = select(user.split('QUESTION: ').at(-1).split('\nOPTIONS:')[0], options.map(row => row[2]));
      assert.ok(chosen >= 0 && chosen < options.length);
      const chosenId = token(options[chosen][1]);
      const canvas = body.vllm_xargs.diffusion_seed_canvas;
      const slot = canvas.indexOf(token('[')) + 1;
      const rows = canvas.slice(0, body.max_tokens).map(() => ({ top_logprobs: [] }));
      rows[slot] = { top_logprobs: body.logprob_token_ids.map(id => ({ token: `token_id:${id}`, logprob: id === chosenId ? -0.01 : -15 })) };
      answer = { choices: [{ logprobs: { content: rows } }], usage: { prompt_tokens: 300 } };
    } else {
      const value = values.shift();
      answer = { choices: [{ message: { content: typeof value === 'object' ? value.content : value }, finish_reason: value?.finishReason ?? 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 20 } };
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const config = loadJevConfig({ endpoint: 'http://fixture', gpu: { policy: 'alongside' }, engine: { mode: 'external' } }, { readFile: () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); } });
  const engine = { status: async () => ({ state: 'awake' }), ensureAwake: async () => {}, sleep: async () => {}, stop: async () => {} };
  const service = createJevService({ config, engine, fetchImpl: (url, options) => fetch(String(url).replace('http://fixture', root), options) });
  const model = new ModelClient({ apiUrl: `${root}/v1`, apiDialect: 'diffusiongemma', model: 'dgemma', retries: 0 });
  model.diffusionCoordinator = { run: work => service.runPrimary(work), choose: choice => service.choose(choice), release: () => service.releasePrimary() };
  t.after(async () => { await model.close(); await service.off(); });
  return { model, service, requests };
}

test('Jev selects a tool and exact source lines; CPU assembles the edit through the real agent dispatcher', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-tool-select-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'code.js'), 'const first = 1;\nconst s = "old";\nconst last = 3;\n');
  const verbs = ['read_file', 'edit_lines', 'respond']; let turn = 0;
  const { model, requests } = await fixture(t, (question, options) => {
    if (question.startsWith('Which ONE available')) { const verb = verbs[turn++]; return options.findIndex(value => value.startsWith(`${verb}:`)); }
    if (/first line|last line/.test(question)) return options.findIndex(value => value.startsWith('2:'));
    if (question.startsWith('Select the exact')) return options.indexOf('code.js');
    return 0;
  }, ['````js\nconst s = "new";\n````', '{"a":"respond","text":"Updated the string."}']);
  const events = [];
  const result = await runAgent({ workspace, model, task: 'Change the string in code.js from old to new, preserving the other lines.',
    interactive: true, maxTurns: 4, grounding: false, useGrammar: true, thinkMode: 'off', shellSandbox: 'host',
    stateAudit: 'off', contractStateAudit: 'off', onEvent: event => events.push(event) });
  assert.equal(fs.readFileSync(path.join(workspace, 'code.js'), 'utf8'), 'const first = 1;\nconst s = "new";\nconst last = 3;\n');
  assert.equal(result.metrics.invalid, 0); assert.equal(result.metrics.actions.edit_lines, 1);
  assert.equal(result.responded, true);
  assert.ok(events.some(event => event.type === 'tool_decision' && event.evidence.authority === 'model'));
  assert.equal(requests.filter(row => row.body.vllm_xargs).length, 7, 'verbs, path choices and exact line choices use issued handles');
  const generations = requests.filter(row => row.path.endsWith('/chat/completions') && !row.body.vllm_xargs);
  assert.equal(generations.length, 2, 'only replacement source and response are generated');
  assert.equal(result.metrics.modelRequests, 9);
  assert.equal(model.usageTotals.requests, 9);
  assert.equal(result.summary, 'Updated the string.');
  assert.ok(generations.every(row => !row.body.response_format));
  assert.ok(generations.every(row => row.body.max_tokens === 8192), 'replacement and response get the full thinking/output reserve');
  const selections = requests.filter(row => row.body.vllm_xargs);
  assert.ok(selections.every(row => !row.body.messages[1].content.includes('Actions (emit exactly one')), 'no duplicate JSON tutorial in real agent requests');
});

test('a primary response retains operator preferences and an 8K thinking reserve', async t => {
  const { model, requests } = await fixture(t, () => 0, ['A complete response.']);
  const { buildPrompt } = await import('../src/prompt.js');
  const prompt = buildPrompt({ diffusionTools: true, task: 'Explain this carefully.', env: '', turns: [],
    profileText: 'Prefer metric measurements. Describe a single JSON object when asked.', toolsText: 'DUPLICATE TOOL MANUAL', template: model.template,
    assistantPrefill: model.assistantPrefill });
  const response = await model.complete(prompt, { agentAction: true, thinking: true,
    diffusionTools: { verbs: ['respond'], paths: [], queryTools: [] } });
  assert.equal(JSON.parse(response.content).text, 'A complete response.');
  const generation = requests.find(row => row.path.endsWith('/chat/completions') && !row.body.vllm_xargs).body;
  assert.equal(generation.max_tokens, 8192);
  assert.equal(generation.chat_template_kwargs.enable_thinking, true);
  assert.match(generation.messages[1].content, /Prefer metric measurements\./);
  assert.match(generation.messages[1].content, /Describe a single JSON object when asked\./);
  assert.match(generation.messages[1].content, /Explain this carefully\./);
  assert.doesNotMatch(generation.messages[1].content, /DUPLICATE TOOL MANUAL|Actions \(emit exactly one|literal file contents/);
});

test('a complete payload larger than 4K uses the shared 8K reserve', async () => {
  const caps = [];
  const result = await diffusionGemmaToolTurn({ state: 'Create a working file.',
    context: { verbs: ['write_file'], paths: [], generationTokens: 8192 },
    choose: async () => ({ index: 0, usage: {} }),
    generate: async ({ maxTokens }) => {
      caps.push(maxTokens);
      return caps.length === 1 ? { content: 'large.js', tokens: 16, usage: {} }
        : { content: '````js\nexport const value = 42;\n````', tokens: 6000, usage: { outputTokens: 6000 } };
    } });
  assert.deepEqual(caps, [128, 8176], 'new path and payload share the turn reserve');
  assert.equal(result.tokens, 6016);
  assert.deepEqual(JSON.parse(result.content), { a: 'write_file', p: 'large.js', content: 'export const value = 42;' });
});

test('generated literal HTML gets CPU JSON escaping and reaches the real file executor', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-tool-file-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = '<main id="hello">Hello</main>\n<script>const pattern = /\\w+/;</script>';
  let turn = 0;
  const { model } = await fixture(t, (question, options) => {
    if (!question.startsWith('Which ONE available')) return options.length - 1;
    const verb = turn++ === 0 ? 'write_file' : 'respond';
    return options.findIndex(value => value.startsWith(`${verb}:`));
  },
  ['{"a":"write_file","p":"hello.html"}', `\`\`\`\`html\n${source}\n\`\`\`\``, 'Created the HTML.']);
  const result = await runAgent({ workspace, model, task: 'Create hello.html with a main saying Hello, then report.', interactive: true,
    grounding: false, maxTurns: 3, thinkMode: 'off', shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off' });
  assert.equal(fs.readFileSync(path.join(workspace, 'hello.html'), 'utf8'), source);
  assert.equal(result.metrics.invalid, 0); assert.equal(result.responded, true);
});

test('CPU assembly refuses unsupported choices, truncated payloads, and source changed during selection', async () => {
  const base = { state: 'task', context: { verbs: ['write_file'], paths: ['a.js'], generationTokens: 4096 },
    choose: async ({ options }) => ({ index: 0, usage: {} }), generate: async () => ({ content: '````js\nunfinished', stoppedLimit: true, tokens: 4096 }) };
  await assert.rejects(diffusionGemmaToolTurn(base), { code: 'generation_budget_exhausted' });
  await assert.rejects(diffusionGemmaToolTurn({ ...base, choose: async () => ({ index: 1000 }) }), /outside the issued/);
  let source = 'const x = 1;\n';
  await assert.rejects(diffusionGemmaToolTurn({ ...base, context: { ...base.context, verbs: ['edit_lines'], readSource: () => source },
    generate: async () => { source = 'external change'; return { content: '````js\nconst x = 2;\n````', tokens: 10 }; } }), /stale edit was discarded/);
});

test('the real primary agent refuses a truncated literal payload without creating any file', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-tool-truncated-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const { model } = await fixture(t, (question, options) => question.startsWith('Which ONE available')
    ? options.findIndex(value => value.startsWith('write_file:')) : options.length - 1,
  ['hello.html', { content: '````html\n<main>unfinished', finishReason: 'length' }]);
  const result = await runAgent({ workspace, model, task: 'Create hello.html.', interactive: true, grounding: false,
    maxTurns: 3, thinkMode: 'off', shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off' });
  assert.equal(fs.existsSync(path.join(workspace, 'hello.html')), false);
  assert.equal(result.metrics.turns, 0); assert.equal(result.metrics.modelErrors, 1);
});

test('Jev chooses a registered query tool and the CPU routes its literal arguments through the real registry', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-tool-query-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = []; let turn = 0;
  const { model } = await fixture(t, (question, options) => {
    if (question.startsWith('Which registered')) return options.findIndex(value => value.startsWith('fixture_echo:'));
    const verb = turn++ === 0 ? 'query' : 'respond'; return options.findIndex(value => value.startsWith(`${verb}:`));
  }, ['a quoted "value"', 'Echo completed.']);
  const result = await runAgent({ workspace, model, task: 'Use fixture_echo with a quoted value, then report.', interactive: true,
    grounding: true, extraTools: [{ name: 'fixture_echo', description: 'Echo the given text.', answer: q => { calls.push(q); return q; } }],
    maxTurns: 3, thinkMode: 'off', shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off' });
  assert.deepEqual(calls, ['a quoted "value"']); assert.equal(result.metrics.invalid, 0); assert.equal(result.responded, true);
});

test('DiffusionGemma receives CPU browser evidence after each actual visual edit, before selecting its next tool', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-tool-feedback-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [], outputs = ['{"a":"write_file","p":"index.html","content":"<main>first</main>"}',
    '{"a":"edit_lines","p":"index.html","start":1,"end":1,"new":"<main>fixed</main>"}', '{"a":"done","summary":"Built and checked."}'];
  const model = { diffusionGemma: true, contextBudget: diffusionGemmaBudget(), assistantPrefill: '', complete: async prompt => {
    if (outputs.length === 2) assert.match(prompt, /FIRST CHECK FAILED: fix the title/);
    return { content: outputs.shift(), tokens: 50 };
  } };
  const preview = { name: 'preview', description: 'fixture browser', verbs: ['preview'], answer: function(q) {
    calls.push(q); this.lastResult = { status: calls.length === 1 ? 'fail' : 'pass', mode: 'interact', entry: 'index.html' };
    return calls.length === 1 ? 'FIRST CHECK FAILED: fix the title' : 'PREVIEW STATUS: pass';
  } };
  const result = await runAgent({ workspace, model, task: 'Make a playable HTML game.', interactive: true, grounding: true,
    extraTools: [preview], verificationPolicy: 'after_edit', maxTurns: 3, thinkMode: 'off', useGrammar: false,
    shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off' });
  assert.deepEqual(calls, ['interact', 'interact']); assert.equal(result.metrics.previewFailures, 1);
  assert.equal(result.metrics.previewPasses, 1); assert.equal(result.done, true);
});

test('DiffusionGemma CPU assembly continues a saved literal file after a cutoff', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-tool-continue-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const { model, requests } = await fixture(t, (question, options) => question.startsWith('Which ONE available')
    ? options.findIndex(value => value.startsWith('write_file:')) : options.length - 1,
  ['hello.html', { content: '````html\n<main>hello', finishReason: 'length' }, 'hello.html', '````html\n world</main>\n````']);
  const result = await runAgent({ workspace, model, task: 'Create hello.html.', grounding: false,
    maxTurns: 1, thinkMode: 'off', shellSandbox: 'host', stateAudit: 'off', contractStateAudit: 'off' });
  assert.equal(fs.readFileSync(path.join(workspace, 'hello.html'), 'utf8'), '<main>hello world</main>');
  assert.equal(result.metrics.outputLimitRecoveries, 1);
  const finalGeneration = requests.filter(row => row.path.endsWith('/chat/completions') && !row.body.vllm_xargs).at(-1);
  assert.match(finalGeneration.body.messages.at(-1).content, /ONLY THE MISSING SUFFIX/);
  assert.match(finalGeneration.body.messages.at(-1).content, /<main>hello/);
});
