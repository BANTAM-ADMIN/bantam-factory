#!/usr/bin/env node

/**
 * SUPERSEDED by Jev mode (`bantamfactory jev serve`, `:jev on`; see docs/JEV-MODE.md), which
 * serves the full Jev wire contract (errors, auth, headers, model list) with the
 * adopted configuration. Kept for the Decision Index lab runs, which used
 * these flags.
 *
 * A Jev-compatible System One endpoint backed by BANTAM's DiffusionGemma
 * reads (`decideJev`). Anything that speaks TypeSafe's wire contract (their
 * SDKs, JevBench's `typesafe` adapter) can call it unchanged.
 *
 *   node scripts/bantam-system-one-server.mjs [--port 8090] [--base http://127.0.0.1:8001]
 *                                             [--model dgemma] [--racks 3] [--noul-labels handles|words]
 *                                             [--profile racks|adaptive|think|deep] [--think-budget 1024] [--gate 0.95]
 *                                             [--debias] [--debias-gate confidence|disagree] [--quant-gate]
 *                                             [--temperature 1] [--joint-select]
 *
 * Profiles: `racks` is one fast read per rack (decideJev); `think` is one
 * thought whose answer is read in the same request (decideJevThink);
 * `adaptive` is one fast read, and a thought only under --gate
 * (decideJevAdaptive); `deep`
 * adds the calculator gauge, racks and a duel on disagreement (decideJevDeep).
 *
 * Requests are served one at a time; the DiffusionGemma server on this box
 * runs two sequences and the reads of one request already use both.
 */

import { createHash } from 'node:crypto';
import http from 'node:http';

import { compileHandlePool, createExecCell, createStructuredReader, decideJev, decideJevAdaptive, decideJevDeep, decideJevThink } from '../src/factory.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const port = Number(option('port', '8090'));
const host = option('host', '127.0.0.1');
const base = option('base', 'http://127.0.0.1:8001');
const model = option('model', 'dgemma');
const racks = Number(option('racks', '3'));
const noulLabels = option('noul-labels', 'handles');
const profile = option('profile', 'racks');
const thinkBudget = Number(option('think-budget', '1024'));
const gate = Number(option('gate', '0.95'));
const flag = (name) => argv.includes(`--${name}`);
const adaptiveOptions = { binaryDebias: flag('debias'), quantGate: flag('quant-gate'), jointSelect: flag('joint-select'), temperature: Number(option('temperature', '1')), debiasGate: option('debias-gate', 'confidence'), thinkStyle: option('think-style', 'full'), truncatedThought: option('truncated-thought', 'read'), rowThinkLimit: Number(option('row-think-limit', 'Infinity')), execCell: flag('exec-gauge') ? createExecCell() : null, toolGauge: flag('tool-gauge'), rowThought: flag('row-thought'), estimateBlend: option('estimate-blend', null) == null ? null : Number(option('estimate-blend', null)), thinkBlend: Number(option('think-blend', '1')), preferenceGauge: flag('preference-gauge'), stateGauge: flag('state-gauge'), evidenceFirst: flag('evidence-first'), claimGauge: flag('claim-gauge'), thinkMinOptions: Number(option('think-min-options', 'Infinity')), selectAllFraming: flag('select-all-framing'), stanceFraming: flag('stance-framing'), digestFirst: flag('digest-first') };
if (!['racks', 'adaptive', 'think', 'deep'].includes(profile)) throw new Error('--profile must be racks, adaptive, think or deep');
const MODEL_NAME = profile !== 'racks' ? `bantam-system-one-${profile}-t${thinkBudget}` : `bantam-system-one-r${racks}${noulLabels === 'words' ? '-noulwords' : ''}`;

const reader = createStructuredReader({ baseUrl: base, model });
const pool = await compileHandlePool(reader, { size: 256 });

let queue = Promise.resolve();
const serial = (work) => {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
};

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && req.url === '/v1/models') return send(res, 200, { data: [{ id: MODEL_NAME }, { id: 'jev-latest' }] });
    if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(res, 404, { error: { type: 'not_found_error', message: 'not found' } });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.state === undefined || !body.questions || typeof body.questions !== 'object') {
      return send(res, 400, { error: { type: 'invalid_request_error', message: 'state and questions are required' } });
    }
    // Same request, same noise draws: answers are reproducible.
    const seed = createHash('sha256').update(JSON.stringify([body.state, body.questions])).digest().readUInt32BE(0) % 1_000_000;
    const started = performance.now();
    const decided = await serial(() => (profile === 'deep'
      ? decideJevDeep({ reader, pool, state: body.state, questions: body.questions, seed, thinkBudget })
      : profile === 'adaptive'
        ? decideJevAdaptive({ reader, pool, state: body.state, questions: body.questions, seed, gate, thinkBudget, ...adaptiveOptions })
      : profile === 'think'
        ? decideJevThink({ reader, pool, state: body.state, questions: body.questions, seed, thinkBudget })
        : decideJev({ reader, pool, state: body.state, questions: body.questions, racks, seed, noulLabels })));
    const elapsedMs = performance.now() - started;
    return send(res, 200, { model: MODEL_NAME, answers: decided.answers, usage: { input_tokens: decided.usage.inputTokens, output_tokens: 0 }, bantam: { racks, elapsedMs, evidence: decided.evidence } });
  } catch (error) {
    return send(res, 400, { error: { type: 'invalid_request_error', message: String(error.message).slice(0, 400) } });
  }
});

server.listen(port, host, () => {
  console.log(`bantam system one: http://${host}:${port}/v1/systemone -> ${base} (${model}), ${JSON.stringify({ ...adaptiveOptions, execCell: adaptiveOptions.execCell ? "on" : "off" })}, profile ${profile}${profile !== 'racks' ? ` think ${thinkBudget}` : `, ${racks} racks`}, ${pool.length} handles`);
});
