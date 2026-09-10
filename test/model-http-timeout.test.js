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
