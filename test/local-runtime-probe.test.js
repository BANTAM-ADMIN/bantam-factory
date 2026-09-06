import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CASES, GRAMMAR, framePrompt, growPrompt, judgeAnswer, probeRequest, summarizePhase, parseOptions, runLocalRuntimeProbe } from '../scripts/local-runtime-probe.mjs';

test('semantic oracle checks actual trusted code, not a singleton grammar answer', () => {
  assert.equal(CASES.length, 4);
  assert.match(GRAMMAR, /choice ::=/);
  for (const item of CASES) {
    assert.equal(runInNewContext(item.code, {}, { timeout: 100 }), item.expected.value);
    assert.equal(item.options[item.expected.choice], item.expected.value);
    for (const [choice, value] of Object.entries(item.options)) {
      const result = judgeAnswer(JSON.stringify({ choice, value }), item);
      assert.equal(result.structuralPass, true);
      assert.equal(result.semanticPass, choice === item.expected.choice);
    }
  }
});

test('malformed, extra-field and structurally valid wrong outputs fail closed', () => {
  for (const value of ['not json', 'null', '[]', '{"choice":"B","value":"16"}', '{"choice":"B","value":16,"pass":true}', '{"choice":["B"],"value":16}']) {
    assert.equal(judgeAnswer(value, CASES[0]).semanticPass, false);
  }
  assert.equal(judgeAnswer('{"choice":"A","value":20}', CASES[0]).structuralPass, true);
  assert.equal(judgeAnswer('{"choice":"B","value":17}', CASES[0]).semanticPass, false);
});

test('scripted fake endpoint records all nine calls with bounded concurrency and no real model', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runtime-fake-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  let active = 0, peak = 0, calls = 0;
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end('{"status":"ok"}');
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"SCRIPTED-NOT-A-MODEL"}]}');
    if (req.url === '/props') return res.end('{"build_info":"scripted-fixture","default_generation_settings":{"n_ctx":4096}}');
    if (req.url === '/slots') return res.end(JSON.stringify([{ is_processing: active > 0 }, { is_processing: active > 1 }]));
    if (req.url === '/metrics') return res.end(`llamacpp:prompt_tokens_total ${calls * 40}\nllamacpp:prompt_tokens_cached_total ${calls * 60}\nllamacpp:tokens_predicted_total ${calls * 10}\nllamacpp:prompt_seconds_total ${calls * 0.001}\nllamacpp:tokens_predicted_seconds_total ${calls * 0.002}\nllamacpp:requests_processing ${active}\nllamacpp:requests_deferred 0\n`);
    if (req.url !== '/completion') { res.statusCode = 404; return res.end('{}'); }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const item = CASES.findLast(c => body.prompt.includes(c.code));
    active++; peak = Math.max(peak, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 15)); active--;
    res.end(JSON.stringify({ content: JSON.stringify(item.expected), tokens_evaluated: 100, tokens_predicted: 10,
      timings: { prompt_n: 40, cache_n: 60, prompt_ms: 1, predicted_n: 10, predicted_ms: 2, draft_n: 12, draft_n_accepted: 7 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const output = path.join(temporary, 'probe');
  const result = await runLocalRuntimeProbe({ endpoint: `http://127.0.0.1:${upstream.address().port}`, output,
    concurrency: 2, requests: 4, tokens: 256, timeoutSeconds: 2, expectedModel: 'SCRIPTED-NOT-A-MODEL' });
  assert.equal(result.pass, true); assert.equal(calls, 9); assert.equal(peak, 2);
  assert.equal(result.wireUsage.inputTokens, 900); assert.equal(result.wireUsage.outputTokens, 90);
  assert.equal(result.wireUsage.freshInputTokens, 360);
  assert.equal(result.phases[2].outputTokensPerSecond, 40 / (result.phases[2].wallMs / 1000));
  assert.equal(result.phases[0].records[0].mtp.timings.draft_n, 12);
  assert.equal(result.phases[0].records[0].wireIndex, 1);
  assert.equal(fs.readdirSync(path.join(output, 'wire')).filter(p => p.endsWith('.request.body')).length, 9);
  await assert.rejects(runLocalRuntimeProbe({ endpoint: `http://127.0.0.1:${upstream.address().port}`, output }), /EEXIST/);
  const overbooked = await runLocalRuntimeProbe({ endpoint: `http://127.0.0.1:${upstream.address().port}`,
    output: path.join(temporary, 'overbooked'), concurrency: 4 });
  assert.equal(overbooked.pass, false); assert.match(overbooked.error, /exceeds observed server slots 2/);
  assert.equal(calls, 9, 'capacity rejection sends no generation request');
});

test('raw Qwen frame and append-only growth preserve the actual preceding prefix', () => {
  const first = framePrompt(CASES[1], { referenceContext: true });
  assert.ok(first.startsWith('<|im_start|>system\n'));
  assert.ok(first.endsWith('<|im_start|>assistant\n<think>\n</think>\n\n'));
  assert.ok(first.length > 10000);
  const second = growPrompt(first, '{"choice":"D","value":26}', CASES[2]);
  assert.ok(second.startsWith(first));
  assert.match(second, /<\|im_end\|>\n<\|im_start\|>user\n/);
});

test('request builder uses explicit raw Qwen profile without transport execution', () => {
  const prompt = framePrompt(CASES[0]);
  const a = probeRequest('http://127.0.0.1:7777', prompt, { tokens: 256 });
  const b = probeRequest('http://127.0.0.1:8888', prompt, { tokens: 32 });
  assert.equal(a.url, 'http://127.0.0.1:7777/completion');
  const body = JSON.parse(a.body);
  assert.equal(body.prompt, prompt); assert.equal(body.grammar, GRAMMAR);
  assert.equal(body.n_predict, 256); assert.equal(body.temperature, 0.4);
  assert.equal(body.cache_prompt, true); assert.deepEqual(body.stop, ['<|im_end|>']);
  assert.equal(JSON.parse(b.body).n_predict, 32);
  assert.equal(a.headers.Authorization, undefined);
});

test('throughput uses shared makespan; missing cache or usage is unknown', () => {
  const row = { httpStatus: 200, error: null, judgment: { structuralPass: true, semanticPass: true },
    usage: { inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, freshInputTokens: 20 } };
  const summary = summarizePhase([row, row], 1000);
  assert.equal(summary.outputTokensPerSecond, 40); assert.equal(summary.inputTokens, 200);
  assert.equal(summary.freshInputTokens, 40);
  const partial = summarizePhase([row, { ...row, usage: null }], 1000);
  assert.equal(partial.outputTokens, null); assert.equal(partial.outputTokensPerSecond, null);
  assert.equal(partial.observedOutputTokens, 20);
  const unknownCache = summarizePhase([{ ...row, usage: { ...row.usage, cacheHitTokens: null, freshInputTokens: null } }], 1000);
  assert.equal(unknownCache.cacheHitTokens, null); assert.equal(unknownCache.outputTokens, 20);
});

test('CLI is bounded and loopback only; default workload includes separate diagnostics', () => {
  const base = ['--endpoint', 'http://127.0.0.1:8085', '--output', '/tmp/new-probe'];
  assert.equal(parseOptions(base).requests, 4);
  assert.throws(() => parseOptions([...base, '--endpoint', 'http://localhost:7777']), /duplicate option/);
  for (const extra of [['--concurrency', '3'], ['--requests', '65'], ['--tokens', '0'], ['--timeout-seconds', '601'], ['--unknown', 'x']]) {
    assert.throws(() => parseOptions([...base, ...extra]));
  }
  for (const endpoint of ['http://example.com', 'http://127.0.0.1/v1', 'http://user:pass@localhost', 'http://localhost/?x=y']) {
    assert.throws(() => parseOptions(['--endpoint', endpoint, '--output', '/tmp/new-probe']));
  }
});
