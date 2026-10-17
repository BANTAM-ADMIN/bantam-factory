import test from "node:test";
import assert from "node:assert/strict";

import { actionPromptMenu } from "../src/action-protocol.js";
import { systemPrompt } from "../src/prompt.js";
import { ModelClient, modelOutputTokenCap } from "../src/model.js";

test("the menu states the per-action output cap when one is known", () => {
  const menu = actionPromptMenu({ outputTokenCap: 8192 });
  assert.match(menu, /LIMIT: one action may emit at most ~8,192 tokens/);
  // the safe working figure is below the hard cap, so a plan built on it fits
  assert.match(menu, /under ~6,144 tokens/);
  assert.match(menu, /runnable skeleton first/);
});

test("no cap known, no line — nothing is invented", () => {
  assert.doesNotMatch(actionPromptMenu({}), /LIMIT:/);
  assert.doesNotMatch(actionPromptMenu({ outputTokenCap: 0 }), /LIMIT:/);
  assert.doesNotMatch(actionPromptMenu({ outputTokenCap: "abc" }), /LIMIT:/);
});

test("systemPrompt threads the cap into the menu it renders", () => {
  assert.match(systemPrompt({ outputTokenCap: 4096 }), /at most ~4,096 tokens/);
  assert.doesNotMatch(systemPrompt({}), /LIMIT:/);
});

test("Codex does not inherit the local profile's unsent sampling cap", t => {
  const model = new ModelClient({ codex: true, nPredict: 8192 });
  t.after(() => model.close());
  const request = JSON.parse(model.buildRequest('Choose an action.').body);
  assert.equal(Object.hasOwn(request, 'nPredict'), false);
  assert.equal(modelOutputTokenCap(model), null);
  assert.doesNotMatch(systemPrompt({ outputTokenCap: modelOutputTokenCap(model) }), /LIMIT:/);
});

test("local and compatible completion transports retain their configured cap", t => {
  for (const options of [{ apiUrl: null }, { apiUrl: 'http://localhost:8085/v1' }]) {
    const model = new ModelClient({ ...options, nPredict: 4096 });
    t.after(() => model.close());
    const request = JSON.parse(model.buildRequest('Choose an action.').body);
    assert.equal(options.apiUrl ? request.max_tokens : request.n_predict, 4096);
    assert.equal(modelOutputTokenCap(model), 4096);
  }
});

test('known large windows allow 16K output while unknown and small windows stay bounded', t => {
  for (const context of [null, 8192, 16384, 32768, 50000, 131072]) {
    const model = new ModelClient({ apiUrl: 'http://localhost:8085/v1', apiContextWindow: context });
    t.after(() => model.close());
    // This is the server receipt captured by discovery/health.
    model.apiContextWindow = context;
    const expected = context >= 32768 ? 16384 : context === 8192 ? 4096 : 8192;
    assert.equal(modelOutputTokenCap(model), expected);
    assert.equal(JSON.parse(model.buildRequest('Choose an action.').body).max_tokens, expected);
  }
});

test('an explicit output allowance overrides the adaptive default', t => {
  const model = new ModelClient({ nPredict: 4096 });
  t.after(() => model.close());
  model.apiContextWindow = 131072;
  assert.equal(modelOutputTokenCap(model), 4096);
  assert.equal(JSON.parse(model.buildRequest('Choose an action.').body).n_predict, 4096);
});

test('native health learns the per-slot window and refreshes it after switching', async t => {
  const { default: http } = await import('node:http');
  const makeServer = async window => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/props' ? { default_generation_settings: { n_ctx: window } } : {}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const large = await makeServer(131072), small = await makeServer(16384);
  const model = new ModelClient({ endpoint: large, apiUrl: null, chatTransport: false });
  t.after(() => model.close());
  assert.equal(await model.health(), true);
  assert.equal(model.contextWindowTokens, 131072);
  assert.equal(JSON.parse(model.buildRequest('Write a file.').body).n_predict, 16384);
  model.switchTo(small);
  assert.equal(model.contextWindowTokens, null, 'a switch clears the previous window');
  assert.equal(await model.health(), true);
  assert.equal(model.contextWindowTokens, 16384);
  assert.equal(JSON.parse(model.buildRequest('Write a file.').body).n_predict, 8192);
});

test('API output budgeting uses the selected model rather than the largest catalog window', async t => {
  const { default: http } = await import('node:http');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'small', max_model_len: 16384 }, { id: 'large', max_model_len: 131072 }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  for (const [name, expected] of [['small', 8192], ['large', 16384], ['unknown', 8192]]) {
    const model = new ModelClient({ apiUrl: `http://127.0.0.1:${server.address().port}/v1`, apiDialect: 'chat', model: name });
    t.after(() => model.close());
    assert.equal(await model.health(), true);
    assert.equal(modelOutputTokenCap(model), expected);
    assert.equal(JSON.parse(model.buildRequest('Write a file.').body).max_tokens, expected);
  }
});
