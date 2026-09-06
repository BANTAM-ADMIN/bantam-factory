#!/usr/bin/env node
// A bounded local runtime diagnostic, not a coding benchmark or model admission.
// buildRequest + direct fetch deliberately avoids ModelClient's model-card writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ModelClient } from '../src/model.js';
import { MODEL_PROFILES } from '../src/profiles.js';
import { startModelRecorder, responseUsage } from './fight-model-proxy.mjs';
import { serverCounters, counterDelta } from './fight-usage.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const integer = value => Number.isSafeInteger(value) && value >= 0;
export const CASES = Object.freeze([
  { id: 'filter-map', code: '[2,3,5,8].filter(x => x % 2 === 1).map(x => x * 2).reduce((a,b) => a+b, 0)',
    options: { A: 20, B: 16, C: 10, D: 13 }, expected: { choice: 'B', value: 16 } },
  { id: 'sequential-update', code: 'let n=1; for (const x of [2,3,4]) n=n*2+x; n;',
    options: { A: 22, B: 24, C: 28, D: 26 }, expected: { choice: 'D', value: 26 } },
  { id: 'object-alias', code: 'const a={n:2}; const b=a; b.n+=3; a.n*2;',
    options: { A: 10, B: 4, C: 6, D: 5 }, expected: { choice: 'A', value: 10 } },
  { id: 'lexical-queue', code: "const q=['c','a']; q.sort(); const first=q.shift(); q.push('b'); q.sort(); first.charCodeAt(0)+q.shift().charCodeAt(0);",
    options: { A: 193, B: 197, C: 195, D: 196 }, expected: { choice: 'C', value: 195 } },
]);

export const GRAMMAR = String.raw`root ::= "{" ws "\"choice\"" ws ":" ws choice ws "," ws "\"value\"" ws ":" ws integer ws "}" ws
choice ::= "\"A\"" | "\"B\"" | "\"C\"" | "\"D\""
integer ::= "-"? ("0" | [1-9] [0-9]*)
ws ::= [ \t\n\r]*`;

const profile = MODEL_PROFILES.qwen;
const system = 'Read the supplied JavaScript exactly. Select its resulting integer from A/B/C/D. Return only {"choice":"LETTER","value":INTEGER}. Do not execute tools. A syntactically valid wrong answer is a failure.';
const message = item => `Evaluate this JavaScript (the final expression is the answer):\n${item.code}\nAlternatives: ${JSON.stringify(item.options)}`;
// Deliberately synthetic stable source context, labeled as a cache exercise.
// It is not a transcript from a coding task or evidence of coding capability.
const reference = Array.from({ length: 128 }, (_, i) =>
  `export function reference${String(i).padStart(3, '0')}(xs) { return xs.filter(n => n > ${i}).reduce((sum, n) => sum + n, 0); }`).join('\n');

export function framePrompt(item, { referenceContext = false, tag = '' } = {}) {
  const t = profile.template;
  return t.open('system') + system + t.close + t.open('user')
    + (referenceContext ? `Synthetic reusable source context for a cache diagnostic:\n${reference}\n\n` : '')
    + (tag ? `Request identity: ${tag}\n` : '') + message(item) + t.close + profile.assistantPrefill;
}

export function growPrompt(previous, answer, next) {
  const t = profile.template;
  return previous + answer + t.close + t.open('user') + message(next) + t.close + profile.assistantPrefill;
}

export function judgeAnswer(text, item) {
  let value;
  try { value = JSON.parse(text); } catch { return { structuralPass: false, semanticPass: false, value: null }; }
  const structuralPass = value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'choice,value' && typeof value.choice === 'string' && /^[ABCD]$/.test(value.choice)
    && Number.isSafeInteger(value.value);
  return { structuralPass, semanticPass: structuralPass && value.choice === item.expected.choice
    && value.value === item.expected.value, value };
}

export function probeRequest(endpoint, prompt, { tokens = 256, model = 'local' } = {}) {
  // Pin fields which otherwise consult the operator environment. A new client
  // per request owns its counters; complete() is never called by this script.
  const client = new ModelClient({ endpoint, profile: 'qwen', model, apiUrl: null,
    apiDialect: 'llama', codex: false, deepseek: false, temperature: 0.4,
    actTemperature: 0.4, topP: 0.95, topK: 20, nPredict: tokens, cachePrompt: true,
    codexThreadMode: 'run', codexPromptMode: 'delta', codexRebaseEvery: 0,
    codexRebaseMinSavings: 0, retries: 0 });
  return client.buildRequest(prompt, { grammar: GRAMMAR, nPredict: tokens, temperature: 0.4 });
}

export function summarizePhase(records, wallMs) {
  const sum = key => records.length && records.every(r => integer(r.usage?.[key]))
    ? records.reduce((n, r) => n + r.usage[key], 0) : null;
  const usageComplete = records.length > 0 && records.every(r => r.httpStatus === 200 && !r.error && r.usage);
  const inputTokens = usageComplete ? sum('inputTokens') : null;
  const outputTokens = usageComplete ? sum('outputTokens') : null;
  return { requests: records.length, wallMs, structuralPasses: records.filter(r => r.judgment.structuralPass).length,
    semanticPasses: records.filter(r => r.judgment.semanticPass).length, usageComplete,
    inputTokens, outputTokens, cacheHitTokens: usageComplete ? sum('cacheHitTokens') : null,
    freshInputTokens: usageComplete ? sum('freshInputTokens') : null,
    observedOutputTokens: records.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0),
    outputTokensPerSecond: outputTokens !== null && wallMs > 0 ? outputTokens / (wallMs / 1000) : null,
    completedRequestsPerSecond: wallMs > 0 ? records.filter(r => r.httpStatus === 200 && !r.error).length / (wallMs / 1000) : null };
}

export function parseOptions(argv) {
  const opts = { concurrency: 1, requests: 4, tokens: 256, timeoutSeconds: 120 };
  const names = { '--endpoint': 'endpoint', '--output': 'output', '--concurrency': 'concurrency',
    '--requests': 'requests', '--tokens': 'tokens', '--timeout-seconds': 'timeoutSeconds', '--expected-model': 'expectedModel' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('unknown option or missing value');
    if (seen.has(key)) throw Error(`duplicate option: ${argv[i]}`);
    seen.add(key);
    opts[key] = ['concurrency', 'requests', 'tokens', 'timeoutSeconds'].includes(key) ? Number(argv[i + 1]) : argv[i + 1];
  }
  const u = new URL(opts.endpoint);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw Error('endpoint must be a loopback HTTP origin');
  opts.endpoint = u.origin;
  if (!path.isAbsolute(opts.output ?? '') || ![1, 2, 4].includes(opts.concurrency)
    || !Number.isInteger(opts.requests) || opts.requests < opts.concurrency || opts.requests > 64
    || !Number.isInteger(opts.tokens) || opts.tokens < 16 || opts.tokens > 4096
    || !Number.isInteger(opts.timeoutSeconds) || opts.timeoutSeconds < 1 || opts.timeoutSeconds > 600) throw Error('invalid output, concurrency or resource limit');
  return opts;
}

async function inspect(endpoint) {
  const data = {};
  for (const route of ['health', 'v1/models', 'props', 'slots']) {
    const r = await fetch(`${endpoint}/${route}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Error(`${route}: HTTP ${r.status}`);
    data[route] = await r.json();
  }
  data.modelId = data['v1/models'].data?.[0]?.id ?? null;
  if (!data.modelId || !Array.isArray(data.slots)) throw Error('missing model identity or slot metadata');
  return data;
}
async function counters(endpoint) {
  try { return await serverCounters(endpoint); } catch (error) { return { error: error.message, at: new Date().toISOString(), counters: null }; }
}

export async function runLocalRuntimeProbe(options) {
  const o = parseOptions(Object.entries(options).flatMap(([key, value]) => [({ endpoint: '--endpoint', output: '--output',
    concurrency: '--concurrency', requests: '--requests', tokens: '--tokens', timeoutSeconds: '--timeout-seconds', expectedModel: '--expected-model' })[key], String(value)]));
  // No writes to an existing output, including a dangling symlink.
  fs.mkdirSync(o.output, { mode: 0o700 });
  const report = { schema: 'bantam.local-runtime-probe.v1', startedAt: new Date().toISOString(), options: o,
    scope: 'Synthetic constrained-output and runtime/cache diagnostic; not coding qualification or model admission.',
    policy: 'No model-card writes; fresh per-request ModelClient.buildRequest + direct fetch, no retries. Shared warm cache; no external inference client assumed.',
    phases: [], complete: false, error: null };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let recorder;
  try {
    report.before = await inspect(o.endpoint);
    write(path.join(o.output, 'runtime-before.json'), report.before);
    if (report.before.slots.some(s => s.is_processing)) throw Error('endpoint is busy; do not overlap another client');
    if (o.concurrency > report.before.slots.length) throw Error(`requested concurrency ${o.concurrency} exceeds observed server slots ${report.before.slots.length}`);
    if (o.expectedModel && report.before.modelId !== o.expectedModel) throw Error('model identity mismatch');
    report.countersBefore = await counters(o.endpoint);
    write(path.join(o.output, 'counters-before.json'), report.countersBefore);
    recorder = await startModelRecorder({ upstream: o.endpoint, output: path.join(o.output, 'wire') });
    let sequence = 0;
    const call = async (phase, item, prompt) => {
      const id = ++sequence, name = String(id).padStart(3, '0');
      const request = probeRequest(recorder.endpoint, prompt, { tokens: o.tokens, model: report.before.modelId });
      const started = Date.now();
      const receipt = { id, phase, caseId: item.id, expected: item.expected, startedAt: new Date(started).toISOString(),
        requestSha256: sha(request.body), httpStatus: null, error: null, content: '', usage: null, mtp: null };
      write(path.join(o.output, `${name}.request.json`), request);
      try {
        const r = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(o.timeoutSeconds * 1000)]) });
        receipt.httpStatus = r.status;
        const raw = await r.text();
        fs.writeFileSync(path.join(o.output, `${name}.response.body`), raw, { flag: 'wx', mode: 0o600 });
        receipt.usage = responseUsage(raw, r.headers.get('content-type') ?? '');
        const data = JSON.parse(raw);
        receipt.content = typeof data.content === 'string' ? data.content : '';
        receipt.responseModel = data.model ?? null;
        const mtpFields = object => Object.fromEntries(Object.entries(object ?? {}).filter(([key]) => /draft|accept|mtp|spec/i.test(key)));
        const topLevel = mtpFields(data), timings = mtpFields(data.timings);
        receipt.mtp = Object.keys(topLevel).length || Object.keys(timings).length ? { topLevel, timings } : null;
        if (!r.ok) receipt.error = `HTTP ${r.status}`;
      } catch (error) { receipt.error = error.message; }
      receipt.wallMs = Date.now() - started;
      receipt.judgment = judgeAnswer(receipt.content, item);
      if (receipt.error) receipt.judgment.semanticPass = receipt.judgment.structuralPass = false;
      const wire = recorder.exchanges.findLast(r => r.requestSha256 === receipt.requestSha256);
      receipt.wireIndex = wire?.index ?? null;
      write(path.join(o.output, `${name}.receipt.json`), receipt);
      return receipt;
    };
    const phase = async (name, work) => {
      const start = Date.now(), records = await work();
      report.phases.push({ name, ...summarizePhase(records, Date.now() - start), records });
    };
    await phase('structural-smoke', () => Promise.all([call('structural-smoke', CASES[0], framePrompt(CASES[0]))]));
    await phase('growing-prefix-pairs', async () => {
      const records = [];
      for (let pair = 0; pair < 2; pair++) {
        if (controller.signal.aborted) break;
        const prompt = framePrompt(CASES[1], { referenceContext: true });
        const first = await call(`prefix-${pair}-base`, CASES[1], prompt); records.push(first);
        if (first.error || controller.signal.aborted) break;
        records.push(await call(`prefix-${pair}-grow`, CASES[2], growPrompt(prompt, first.content, CASES[2])));
      }
      return records;
    });
    await phase('concurrent-load', async () => {
      let next = 0; const records = [];
      await Promise.all(Array.from({ length: o.concurrency }, async () => {
        while (next < o.requests && !controller.signal.aborted) {
          const i = next++, item = CASES[i % CASES.length];
          records.push(await call('concurrent-load', item, framePrompt(item, { tag: `load-${i}` })));
        }
      }));
      return records.sort((a, b) => a.id - b.id);
    });
    report.complete = !controller.signal.aborted && report.phases.flatMap(p => p.records).length === o.requests + 5;
  } catch (error) { report.error = error.message; }
  finally {
    if (recorder) report.wireUsage = await recorder.close();
    report.countersImmediate = await counters(o.endpoint);
    // Client cancellation can precede server accounting settlement. Bound the
    // wait; retain both snapshots and never fill missing primary wire usage.
    const deadline = Date.now() + 5000;
    let settled = report.countersImmediate;
    while (settled.counters && (settled.counters.requests_processing || settled.counters.requests_deferred) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100)); settled = await counters(o.endpoint);
    }
    report.countersSettled = settled;
    report.serverWindow = counterDelta(report.countersBefore, settled);
    try { report.after = await inspect(o.endpoint); } catch (error) { report.after = { error: error.message }; }
    report.identityStable = report.before?.modelId != null && report.after?.modelId === report.before.modelId
      && report.before?.props?.build_info === report.after?.props?.build_info;
    report.finishedAt = new Date().toISOString();
    report.wallMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.wholeRunOutputTokensPerSecond = report.wireUsage?.complete && report.wallMs > 0
      ? report.wireUsage.outputTokens / (report.wallMs / 1000) : null;
    report.pass = report.complete && report.identityStable && report.phases.every(p => p.semanticPasses === p.requests);
    write(path.join(o.output, 'result.json'), report);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('node scripts/local-runtime-probe.mjs --endpoint http://127.0.0.1:8085 --output /absolute/NEW-DIR [--concurrency 1|2|4] [--requests 4] [--tokens 256] [--timeout-seconds 120] [--expected-model ID]\nRuns N load requests plus one structural smoke and two serial growing-prefix pairs (N+5 total). No coding qualification or model-card writes.');
  } else {
    try {
      const result = await runLocalRuntimeProbe(parseOptions(process.argv.slice(2)));
      console.log(JSON.stringify({ output: result.options.output, complete: result.complete, pass: result.pass, error: result.error, phases: result.phases.map(({ records, ...p }) => p) }));
      if (!result.pass) process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
