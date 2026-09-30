import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localLlmEndpoint, startLocalLlmBridge } from '../src/local-llm-bridge.js';
import { runShellProcess } from '../src/executor.js';

function request(socketPath, url, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url, method }, res => {
      let text = ''; res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('only local active model transports receive a bridge', () => {
  assert.equal(localLlmEndpoint({ endpoint: 'http://localhost:8085' }), 'http://127.0.0.1:8085');
  assert.equal(localLlmEndpoint({ apiMode: true, apiUrl: 'http://127.0.0.1:8000/v1' }), 'http://127.0.0.1:8000/v1');
  for (const endpoint of ['https://example.com', 'http://localhost.example.com', 'file:///tmp/a', 'http://user:secret@localhost']) {
    assert.equal(localLlmEndpoint({ endpoint }), null);
  }
  assert.equal(localLlmEndpoint({ codex: true, endpoint: 'http://localhost:8085' }), null);
  assert.equal(localLlmEndpoint({ apiMode: true, apiUrl: 'https://example.com', endpoint: 'http://localhost:8085' }), null);
});

test('forwards inference and streaming; blocks other routes and redirect destinations', async t => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      received.push({ url: req.url, body, auth: req.headers.authorization });
      if (req.url === '/health') { res.writeHead(302, { location: 'http://example.com' }).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n'); res.end('data: two\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const bridge = await startLocalLlmBridge(`http://127.0.0.1:${server.address().port}/v1`, { apiKey: 'test-secret' });
  t.after(() => bridge.close());
  const result = await request(bridge.socketPath, '/v1/chat/completions', 'POST', '{"stream":true}');
  assert.equal(result.status, 200);
  assert.equal(result.text, 'data: one\n\ndata: two\n\n');
  assert.deepEqual(received[0], { url: '/v1/chat/completions', body: '{"stream":true}', auth: 'Bearer test-secret' });
  for (const url of ['/slots', '/props', '/v1/models?url=http://example.com', 'http://example.com/v1/models', '//example.com/v1/models', '/v1/../slots']) {
    assert.equal((await request(bridge.socketPath, url)).status, 403);
  }
  assert.equal((await request(bridge.socketPath, '/v1/models', 'DELETE')).status, 403);
  const redirected = await request(bridge.socketPath, '/health');
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.location, undefined);
  assert.equal(received.length, 2);
});

test('Docker stays offline and confined; bridge is removed on success and failure', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-bridge-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const fail of [false, true]) {
    let directory;
    const operation = runShellProcess(workspace, 'true', {
      shellSandbox: 'docker', shellNetwork: false,
      localLlm: { endpoint: 'http://127.0.0.1:8085' },
      processRunner: async (_file, args) => {
        assert.equal(args[args.indexOf('--network') + 1], 'none');
        assert.ok(args.includes('--read-only'));
        assert.ok(args.includes('no-new-privileges'));
        assert.ok(args.includes('BANTAM_LLM_SOCKET=/run/bantam-llm/api.sock'));
        const mount = args.find(x => x.endsWith(':/run/bantam-llm:ro'));
        directory = mount.split(':')[0];
        assert.ok(fs.statSync(path.join(directory, 'api.sock')).isSocket());
        if (fail) throw new Error('spawn failure');
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    if (fail) await assert.rejects(operation, /spawn failure/);
    else await operation;
    assert.equal(fs.existsSync(directory), false);
  }
});
