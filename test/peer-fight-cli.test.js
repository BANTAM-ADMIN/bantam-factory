import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDockerArgs, nativeConfig, normalizeEndpoint, parseOptions, runPeer } from '../scripts/peer-fight-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = { arm: 'opencode', workspace: '/tmp/peer-test/candidate', taskFile: '/tmp/peer-test/task.txt', output: '/tmp/peer-test/output', endpoint: 'http://127.0.0.1:39123/recorded/v1', model: '/models/local-27b.gguf', timeoutSeconds: 600, maxOutputTokens: 8192, probe: false };
const runtime = { arm: 'opencode', entry: ['/opt/opencode'], version: 'test-native', executableDigest: 'a'.repeat(64), mounts: [{ source: '/opt/installed/opencode', target: '/opt/opencode' }], tools: ['/usr/bin/node', '/usr/bin/git'], libraries: [], npm: '/usr/lib/node_modules/npm' };
const argumentsFor = (options = base) => ['--arm', options.arm, '--workspace', options.workspace, '--task-file', options.taskFile, '--output', options.output, '--endpoint', options.endpoint, '--model', options.model];
const values = (args, flag) => args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);
const docker = (options = base) => buildDockerArgs({ options, runtime: { ...runtime, identity: { uid: 2345, gid: 2346 }, arm: options.arm }, control: '/tmp/peer-test/output/control', state: '/tmp/peer-test/output/native', cidfile: '/tmp/peer-test/output/container.cid', name: 'bantam-peer-opencode-test' });

test('loopback endpoints preserve arbitrary proxy port and base path', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:39123/recorded/'), base.endpoint);
  assert.equal(normalizeEndpoint(base.endpoint), base.endpoint);
  assert.equal(normalizeEndpoint('http://localhost:8085'), 'http://localhost:8085/v1');
  assert.equal(normalizeEndpoint('http://[::1]:8085/v1/'), 'http://[::1]:8085/v1');
  for (const endpoint of ['https://127.0.0.1:8085', 'http://example.com', 'http://127.0.0.1:8085?q=secret', 'http://user:secret@localhost', 'http://localhost/#fragment', 'invalid']) assert.throws(() => normalizeEndpoint(endpoint));
});

test('adapter CLI is exact, absolute-path only, and defaults to a 600 second bound', () => {
  assert.deepEqual(parseOptions(argumentsFor()), base);
  assert.equal(parseOptions([...argumentsFor(), '--probe', '--timeout-seconds', '30']).probe, true);
  assert.equal(parseOptions([...argumentsFor(), '--max-output-tokens', '32768']).maxOutputTokens, 32768);
  for (const argv of [
    [...argumentsFor(), '--arm', 'hermes'], [...argumentsFor(), '--unknown', 'x'],
    argumentsFor({ ...base, arm: 'codex' }), argumentsFor({ ...base, workspace: 'relative' }),
    argumentsFor({ ...base, output: '/tmp/injected,readonly' }), argumentsFor({ ...base, model: '' }),
    [...argumentsFor(), '--timeout-seconds', '0'], [...argumentsFor(), '--timeout-seconds', '1801'],
    ...['0', '32769', 'NaN', '1.5', ''].map(value => [...argumentsFor(), '--max-output-tokens', value]),
  ]) assert.throws(() => parseOptions(argv));
});

test('optional 32K output profile reaches both native configs and rejects invalid programmatic budgets', () => {
  for (const arm of ['opencode', 'hermes']) {
    const config = nativeConfig({ ...base, arm, maxOutputTokens: 32768 });
    assert.equal(arm === 'opencode' ? config.provider.local.models[base.model].limit.output : config.model.max_tokens, 32768);
    for (const maxOutputTokens of [0, 32769, NaN, null, '32768', 1.5]) assert.throws(() => nativeConfig({ ...base, arm, maxOutputTokens }), /max output tokens/);
  }
});

for (const arm of ['opencode', 'hermes']) test(`${arm} native configuration pins main and auxiliary inference to the recording endpoint`, () => {
  const config = nativeConfig({ ...base, arm });
  if (arm === 'opencode') {
    assert.equal(config.model, `local/${base.model}`);
    assert.equal(config.small_model, config.model);
    assert.deepEqual(config.enabled_providers, ['local']);
    assert.equal(config.provider.local.options.baseURL, base.endpoint);
    assert.deepEqual(config.provider.local.models[base.model].limit, { context: 65536, output: 8192 });
    assert.equal(config.autoupdate, false);
    assert.deepEqual(config.plugin, []);
  } else {
    assert.equal(config.model.provider, 'custom');
    assert.equal(config.model.default, base.model);
    assert.equal(config.model.base_url, base.endpoint);
    assert.equal(config.model.context_length, 65536);
    assert.equal(config.model.max_tokens, 8192);
    for (const auxiliary of Object.values(config.auxiliary)) {
      assert.equal(auxiliary.provider, 'main');
      assert.equal(auxiliary.model, base.model);
      assert.equal(auxiliary.base_url, base.endpoint);
    }
    assert.equal(config.auxiliary.title_generation.enabled, false);
    assert.deepEqual(config.fallback_providers, []);
    assert.equal(config.delegation.base_url, base.endpoint);
  }
});

test('only candidate and fresh native state are writable bind mounts; credentials and host HOME are absent', () => {
  const args = docker();
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  assert.deepEqual(values(args, '--user'), ['2345:2346']);
  assert.deepEqual(values(args, '--mount').filter(value => !value.endsWith(',readonly')), [
    'type=bind,src=/tmp/peer-test/candidate,dst=/workspace',
    'type=bind,src=/tmp/peer-test/output/native,dst=/state',
  ]);
  assert.ok(!values(args, '--mount').some(value => /docker.sock|auth.json|\.env,/.test(value)));
  assert.ok(!values(args, '--env').some(value => /^(HOME|CODEX_HOME|ANTHROPIC_API_KEY|BANTAM_API_KEY)=/.test(value)));
  assert.ok(values(args, '--env').includes('OPENAI_API_KEY=local-no-credential'));
  assert.ok(values(args, '--env').includes('OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=8192'));
  assert.ok(values(docker({ ...base, maxOutputTokens: 32768 }), '--env').includes('OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=32768'));
  assert.ok(!args.includes('--env-file'));
  assert.deepEqual(values(args, '--network'), ['host']);
  assert.deepEqual(values(docker({ ...base, probe: true }), '--network'), ['none']);
  assert.deepEqual(values(args, '--cidfile'), ['/tmp/peer-test/output/container.cid']);
});

test('Docker builder rejects broad roots, invalid deadlines, arm mismatches and mount injection', () => {
  for (const workspace of ['/', os.homedir(), root, '/tmp/evil:mount', '/tmp/evil,readonly']) assert.throws(() => docker({ ...base, workspace }));
  for (const timeoutSeconds of [undefined, 0, 1801, NaN, 1.5]) assert.throws(() => docker({ ...base, timeoutSeconds }));
  assert.throws(() => buildDockerArgs({ options: base, runtime: { ...runtime, arm: 'hermes' } }), /mismatch/);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-peer-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'candidate'), taskFile = path.join(directory, 'task.txt');
  fs.mkdirSync(workspace); fs.writeFileSync(taskFile, 'Write a useful file.');
  return { directory, options: { ...base, workspace, taskFile, output: path.join(directory, 'output') } };
}

test('run receipt preserves native version and launcher digest and cleans only exact returned container ID', async t => {
  const { options } = fixture(t), calls = [], id = 'b'.repeat(64);
  const processRunner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'run') {
      fs.writeFileSync(values(args, '--cidfile')[0], id);
      return { code: 124, signal: null, timedOut: false, aborted: false, bufferExceeded: false };
    }
    return { code: 1, stderr: `Error response from daemon: No such container: ${id}` };
  };
  const result = await runPeer(options, { runtime, processRunner });
  assert.equal(result.nativeVersion, 'test-native');
  assert.match(result.launcherDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanup.absent, true);
  assert.deepEqual(calls[1].args, ['rm', '--force', id]);
  const launch = JSON.parse(fs.readFileSync(path.join(options.output, 'launch.json')));
  assert.match(launch.network, /not an egress allowlist/);
  assert.equal(launch.endpoint, base.endpoint);
  assert.equal(launch.outputLimit, 8192);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.output, 'result.json'))).cleanup.exactCid, id);
});

test('spawn failures still persist a result and exact-name cleanup receipt', async t => {
  const { options } = fixture(t), calls = [];
  const processRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'run') throw new Error('scripted spawn failure');
    return { code: 0, stdout: 'removed' };
  };
  const result = await runPeer({ ...options, maxOutputTokens: 32768 }, { runtime, processRunner });
  assert.equal(result.error, 'scripted spawn failure');
  assert.equal(result.code, null);
  assert.equal(result.cleanup.exactCid, null);
  assert.match(calls[1][2], /^bantam-peer-opencode-[a-f0-9-]+$/);
  const launch = JSON.parse(fs.readFileSync(path.join(options.output, 'launch.json')));
  assert.equal(launch.outputLimit, 32768);
  assert.equal(launch.outputProfile.maxOutputTokens, 32768);
  assert.match(launch.outputProfile.reservationCaveat, /compaction/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.output, 'control/native-config.json'))).provider.local.models[base.model].limit.output, 32768);
});

test('unconfirmed cleanup fails closed but preserves the failure evidence', async t => {
  const { options } = fixture(t);
  const processRunner = async (_command, args) => args[0] === 'run' ? { code: 0 } : { code: 1, stderr: 'daemon unavailable' };
  await assert.rejects(runPeer(options, { runtime, processRunner }), /cannot confirm/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.output, 'cleanup.json'))).absent, false);
  assert.ok(fs.existsSync(path.join(options.output, 'result.json')));
});

test('candidate and evidence must be disjoint even through symlink ancestors; existing output is never overwritten', async t => {
  const { directory, options } = fixture(t);
  const noLaunch = async () => { throw new Error('unexpected Docker launch'); };
  fs.symlinkSync(options.workspace, path.join(directory, 'alias'));
  for (const output of [options.workspace, path.join(options.workspace, 'output'), directory, path.join(directory, 'alias', 'new-output')]) {
    await assert.rejects(runPeer({ ...options, output }, { runtime, processRunner: noLaunch }), /fresh directory separate/);
  }
  fs.symlinkSync(path.join(options.workspace, 'not-yet-created'), path.join(directory, 'broken-alias'));
  await assert.rejects(runPeer({ ...options, output: path.join(directory, 'broken-alias', 'output') }, { runtime, processRunner: noLaunch }), /unresolved symlink/);
});

// Explicit opt-in: uses the installed native tools in Docker against this
// scripted server only. It never calls the real local model or scores a bench.
for (const arm of ['opencode', 'hermes', 'pi']) for (const maxOutputTokens of [8192, 32768]) test(`${arm}: isolated native CLI executes a real file tool using a scripted recording endpoint (${maxOutputTokens} output)`, { skip: process.env.BANTAM_PEER_DOCKER_TEST !== '1', timeout: 120000 }, async t => {
  const arena = fs.mkdtempSync(path.join(root, '.bantam/arenas/peer-scripted-'));
  const workspace = path.join(arena, 'candidate'), taskFile = path.join(arena, 'task.txt');
  fs.mkdirSync(workspace);
  fs.writeFileSync(taskFile, 'Use your file writing tool to write exactly "peer adapter smoke passed\\n" into native-smoke.txt in the current workspace. Then say done.');
  // The actual llama.cpp server exposes a full filesystem path as its model
  // ID. Exercise slashes here as well as the arbitrary recording base path.
  const model = '/models/scripted-native-peer.gguf', requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    requests.push({ method: req.method, url: req.url, body });
    fs.writeFileSync(path.join(arena, 'requests.json'), JSON.stringify(requests, null, 2));
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'scripted-fixture', context_length: 65536 }] })); return;
    }
    if (!req.url.endsWith('/chat/completions') || requests.length > 12) { res.writeHead(400); res.end('unexpected scripted request'); return; }
    const hasResult = body.messages?.some(message => message.role === 'tool');
    const writer = body.tools?.find(tool => ['write', 'write_file'].includes(tool.function?.name));
    const call = !hasResult && writer ? { id: 'call_scripted_write_1', type: 'function', function: { name: writer.function.name, arguments: JSON.stringify(writer.function.parameters?.properties?.filePath ? { filePath: '/workspace/native-smoke.txt', content: 'peer adapter smoke passed\n' } : { path: '/workspace/native-smoke.txt', content: 'peer adapter smoke passed\n' }) } } : null;
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } };
    const common = { id: `chatcmpl-scripted-${requests.length}`, created: Math.floor(Date.now() / 1000), model };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: call ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : { role: 'assistant', content: 'Done.' }, finish_reason: null }] });
      send({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] });
      send({ ...common, object: 'chat.completion.chunk', choices: [], usage });
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: call ? null : 'Done.', ...(call ? { tool_calls: [call] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }], usage }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/recorded/local/v1`;
  const result = await runPeer({ arm, workspace, taskFile, output: path.join(arena, 'native-output'), endpoint, model, timeoutSeconds: 60, maxOutputTokens, probe: false,
    ...(arm === 'pi' && process.env.BANTAM_PI_TEST_EXECUTABLE ? { executable: process.env.BANTAM_PI_TEST_EXECUTABLE } : {}) });
  t.diagnostic(`Scripted-only native evidence retained: ${arena}`);
  assert.equal(result.code, 0, `${arm} native launch failed; see ${arena}`);
  assert.equal(result.cleanup.absent, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'native-smoke.txt'), 'utf8'), 'peer adapter smoke passed\n');
  const completions = requests.filter(request => request.url.endsWith('/chat/completions'));
  assert.ok(completions.length >= 2, 'native file tool result must return to a second model request');
  assert.ok(completions.every(request => request.url === '/recorded/local/v1/chat/completions' && request.body.model === model));
  assert.ok(completions.some(request => request.body.messages?.some(message => message.role === 'tool')));
  const toolResults = completions.flatMap(request => request.body.messages?.filter(message => message.role === 'tool') ?? []);
  assert.ok(toolResults.every(message => !String(message.content).includes('"error":')), 'native file tool must report successful write, not merely leave matching bytes');
  assert.ok(completions.every(request => (request.body.max_tokens ?? request.body.max_completion_tokens ?? maxOutputTokens) <= maxOutputTokens));
  assert.ok(completions.some(request => request.body.tools?.length && (request.body.max_tokens ?? request.body.max_completion_tokens) === maxOutputTokens), 'a real native tool-loop request must use the exact requested output cap');
  assert.ok(fs.existsSync(path.join(arena, 'native-output/native/native-version.json')));
  if (arm === 'hermes') {
    assert.ok(fs.existsSync(path.join(arena, 'native-output/native/usage.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(arena, 'native-output/native/provider-check.json'))).maxOutputTokens, maxOutputTokens);
  }
  if (arm === 'pi') {
    assert.ok(completions.every(r => r.body.chat_template_kwargs?.enable_thinking === true && r.body.chat_template_kwargs?.preserve_thinking === true));
    assert.ok(completions.every(r => !Object.hasOwn(r.body, 'reasoning_effort') && !Object.hasOwn(r.body, 'store')));
    const journal = fs.readFileSync(path.join(arena, 'native-output/native/pi-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(journal.every(chunk => Number.isFinite(Date.parse(chunk.at)) && typeof chunk.text === 'string'));
    const events = journal.map(chunk => chunk.text).join('').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.type === 'tool_execution_start').length, 1);
    assert.equal(events.filter(e => e.type === 'tool_execution_end' && !e.isError).length, 1);
    assert.ok(fs.readdirSync(path.join(arena, 'native-output/native/pi/sessions')).some(name => name.endsWith('.jsonl')));
  }
});

test('Pi config and mounts use the explicit recorder, combined output cap and isolated agent state', () => {
  const config = nativeConfig({ ...base, arm: 'pi', maxOutputTokens: 32768 });
  assert.equal(config.providers.local.baseUrl, base.endpoint);
  assert.equal(config.providers.local.models[0].id, base.model);
  assert.equal(config.providers.local.models[0].maxTokens, 32768);
  assert.equal(config.providers.local.models[0].contextWindow, 65536);
  assert.equal(parseOptions(argumentsFor({ ...base, arm: 'pi' })).arm, 'pi');
  const args = docker({ ...base, arm: 'pi' });
  assert.ok(values(args, '--mount').includes('type=bind,src=/tmp/peer-test/output/control/native-config.json,dst=/state/pi/models.json,readonly'));
  assert.ok(values(args, '--env').includes('PI_CODING_AGENT_DIR=/state/pi'));
  assert.ok(values(args, '--env').includes('PI_OFFLINE=1'));
});
