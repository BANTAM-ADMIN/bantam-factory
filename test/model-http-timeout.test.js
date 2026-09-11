import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { ModelClient } from '../src/model.js';

async function fixture(t, { delay = 1700, headersFirst = false } = {}) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(body);
    res.setHeader('content-type', 'application/json');
    if (headersFirst) { res.flushHeaders(); res.write('{"content":'); }
    const timer = setTimeout(() => res.end(headersFirst
      ? '"complete","tokens_predicted":2}' : '{"content":"complete","tokens_predicted":2}'), delay);
    res.once('close', () => clearTimeout(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { received, url: `http://127.0.0.1:${server.address().port}/completion` };
}

for (const headersFirst of [false, true]) {
  const phase = headersFirst ? 'response body' : 'response headers';
  test(`the configured model deadline outlasts shorter HTTP defaults for ${phase}`, async t => {
    const original = getGlobalDispatcher();
    // Same failure mechanism as the observed five-minute disconnect, scaled
    // down without asking a test to sleep for five minutes. Undici's timer
    // polling is coarse, so the server delay deliberately exceeds one tick.
    const shortHttpDefault = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
    setGlobalDispatcher(shortHttpDefault);
    t.after(async () => { setGlobalDispatcher(original); await shortHttpDefault.destroy(); });
    const { url, received } = await fixture(t, { headersFirst });
    const client = new ModelClient({ endpoint: url, apiUrl: null, timeoutMs: 5000 });
    const body = '{"prompt":"keep this exact request","n_predict":8192}', exchange = {};
    const result = await client._completeOnce({ url, method: 'POST', headers: { 'content-type': 'application/json' }, body }, {}, exchange);
    assert.equal(result.content, 'complete');
    assert.equal(result.tokens, 2);
    assert.deepEqual(received, [body], 'the original request completes without regeneration');
    assert.equal(exchange.response.normalized.content, 'complete');
    assert.equal(getGlobalDispatcher(), shortHttpDefault, 'model transport must not alter other HTTP clients');
  });

  test(`the model deadline still cancels a stalled ${phase}`, async t => {
    const { url } = await fixture(t, { delay: 5000, headersFirst });
    const client = new ModelClient({ endpoint: url, apiUrl: null, timeoutMs: 150 });
    await assert.rejects(client._completeOnce({ url, method: 'POST', body: '{}', headers: {} }),
      error => error.code === 'model_timeout' && /150ms/.test(error.message));
  });

  test(`user cancellation still stops a stalled ${phase}`, async t => {
    const { url } = await fixture(t, { delay: 5000, headersFirst });
    const client = new ModelClient({ endpoint: url, apiUrl: null, timeoutMs: 5000 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    t.after(() => clearTimeout(timer));
    await assert.rejects(client._completeOnce({ url, method: 'POST', body: '{}', headers: {} }, { signal: controller.signal }),
      error => error.code === 'aborted');
  });
}

test('a health probe is bounded so a stalled server cannot park startup', async t => {
  // A server saturated mid-generation accepts the connection and then does not
  // answer. The probe passed no signal at all, so the only bound was undici's
  // five-minute headers timeout — `repl()`'s startup gate sat on it with a blank
  // terminal, no error, and Ctrl-C as the only way out.
  const server = http.createServer(() => { /* accept the connection, never respond */ });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const client = new ModelClient({
    apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'm', apiDialect: 'vllm', healthTimeoutMs: 250,
  });
  const started = Date.now();
  assert.equal(await client.health(), false, 'a stalled probe reads as "not reachable", not a hang');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200, `the configured bound was actually waited for (${elapsed}ms)`);
  assert.ok(elapsed < 5000, `bounded far below the five-minute HTTP default (${elapsed}ms)`);
});

test('the bounded health probe still reports a reachable server', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url.endsWith('/models')
      ? JSON.stringify({ data: [{ id: 'qwen3.8-27b', owned_by: 'vllm', max_model_len: 106496 }] })
      : '{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const client = new ModelClient({ apiUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'm', apiDialect: 'vllm' });
  assert.equal(await client.health(), true);
  assert.equal(client.contextWindowTokens, 106496, 'the timeout must not cost the window it now reads');
});
