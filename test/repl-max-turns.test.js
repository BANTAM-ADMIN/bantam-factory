import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/bantam.js', import.meta.url));

test(':max-turns shows, validates and changes the next request budget without a model call', { timeout: 30000 }, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-repl-turns-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'hello');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ data: [] }));
    if (req.method === 'DELETE') return res.end('{}');
    calls.push(JSON.parse(body));
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ a: 'read_file', p: 'sample.txt' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BANTAM_')));
  const child = spawn(process.execPath, [cli, 'chat', '--workspace', workspace,
    '--api-url', `http://127.0.0.1:${server.address().port}/v1`, '--api-dialect', 'chat', '--model', 'test-model',
    '--max-turns', '7', '--no-ground', '--no-factory', '--no-pregate'], {
    cwd: workspace, env: { ...env, HOME: workspace, BANTAM_HOME: workspace, BANTAM_SKIP_GRAMMAR_CHECK: '1', BANTAM_STREAM: '0', BANTAM_CHAT_RUNS: '0', BANTAM_MAX_TURNS: '9', NO_COLOR: '1' },
  });
  t.after(() => child.kill());
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  // Separate Enter presses: bulk input is deliberately treated as one paste by
  // the REPL, and EOF before its paste timer fires closes the pending prompt.
  async function waitFor(pattern, start = 0) {
    const deadline = Date.now() + 10000;
    while (!pattern.test(stdout.slice(start))) {
      assert.ok(Date.now() < deadline && child.exitCode === null, `Waiting for ${pattern}\n${stdout}\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async function enter(line, response) {
    const start = stdout.length;
    child.stdin.write(line + '\n');
    await waitFor(response, start);
  }
  await waitFor(/BANTAM|bantam/);
  await enter(':max-turns', /max-turns: 7/);
  for (const invalid of ['0', '-1', '1.5', 'nope', '2 extra', '9007199254740992']) {
    await enter(`:max-turns ${invalid}`, /Usage: :max-turns \[N\]/);
  }
  await enter(':max-turns', /max-turns: 7/);
  await enter(':MAX-TURNS 2', /max-turns: 2/);
  await enter(':max-turns', /max-turns: 2/);
  await enter(':help', /:max-turns \[N\]/);
  assert.equal(calls.length, 0, 'settings and help never invoke the model');
  await enter('Read sample.txt repeatedly.', /Paused at the 2-turn limit/);
  await enter(':max-turns 3', /max-turns: 3/);
  await enter('keep going', /Paused at the 3-turn limit/);
  child.stdin.write('exit\n');
  assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
  assert.match(stderr, /^model: test-model @ http:\/\/127\.0\.0\.1:\d+\/v1 \(openai\)/);
  assert.match(stderr, /modes:/);
  assert.doesNotMatch(stderr, /Error|exception|unhandled/i);
  assert.equal((stdout.match(/max-turns: 7/g) || []).length, 2, stdout);
  assert.equal((stdout.match(/Usage: :max-turns \[N\]/g) || []).length, 6, stdout);
  assert.match(stdout, /max-turns: 2/);
  assert.match(stdout, /max-turns: 3/);
  assert.match(stdout, /:max-turns \[N\]/);
  assert.match(stdout, /Paused at the 2-turn limit/);
  assert.match(stdout, /Paused at the 3-turn limit/);
  assert.match(stdout, /:max-turns N/);
  assert.equal(calls.length, 5, 'commands must not invoke the model');
});
