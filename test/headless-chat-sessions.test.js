import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('headless CLI discovers bridge sessions even when the grammar probe is skipped', {timeout: 30000}, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-headless-bridge-'));
  t.after(() => fs.rmSync(workspace, {recursive: true, force: true}));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({method: req.method, url: req.url, body: body ? JSON.parse(body) : null});
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({object: 'list', data: []}));
    if (req.method === 'DELETE') return res.end('{}');
    const request = JSON.parse(body);
    const content = request.response_format?.json_schema?.schema?.properties?.ok
      ? {ok: true} : {a: 'done', summary: 'Hello.'};
    res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: JSON.stringify(content)}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: {cached_tokens: 0}}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BANTAM_')));
  const cli = fileURLToPath(new URL('../bin/bantam.js', import.meta.url));
  for (const skip of ['0', '1']) {
    requests.length = 0;
    await promisify(execFile)(process.execPath, [cli, 'run', '--task', 'Say hello.', '--workspace', workspace,
      '--api-url', `http://127.0.0.1:${server.address().port}/v1`, '--api-dialect', 'chat', '--model', 'gpt-6-astra:medium',
      '--max-turns', '1', '--no-ground', '--no-factory'],
    {cwd: workspace, env: {...env, BANTAM_SKIP_GRAMMAR_CHECK: skip, BANTAM_STREAM: '0', BANTAM_CHAT_SESSIONS: '1'}, timeout: 12000});
    assert.ok(requests.some(r => r.method === 'GET' && r.url === '/v1/sessions'));
    const calls = requests.filter(r => r.method === 'POST').map(r => r.body);
    assert.equal(calls.length, skip === '1' ? 1 : 2);
    for (const call of calls) {
      assert.equal(call.chat_preamble, false);
      assert.ok(call.session_id, 'each main conversation has a bridge session');
    }
    if (calls.length === 2) assert.notEqual(calls[0].session_id, calls[1].session_id, 'probe thread is retired before the task');
    assert.equal(requests.filter(r => r.method === 'DELETE').length, calls.length);
  }
});
