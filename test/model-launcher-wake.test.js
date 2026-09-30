import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { switchToModel } from '../src/model-launcher.js';

test('selecting a sleeping llama.cpp model wakes and attaches instead of launching another server', async t => {
  let sleeping = true;
  let completions = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/props' ? { is_sleeping: sleeping, total_slots: 1 } : { status: 'ok' }));
      return;
    }
    if (req.url === '/completion' && req.method === 'POST') {
      completions++;
      sleeping = false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"content":" ready"}');
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[{"id":"local.gguf"}]}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let selected = null;
  const messages = [];
  const ok = await switchToModel({ switchTo: value => { selected = value; } },
    { name: 'local', label: 'Local model', endpoint, script: '/must-not-run', match: '' },
    { out: text => messages.push(text), stop: async () => { throw Error('must not stop'); } });
  assert.equal(ok, true);
  assert.equal(selected, endpoint);
  assert.equal(completions, 1);
  assert.match(messages.join(''), /Waking the sleeping model/);
});
