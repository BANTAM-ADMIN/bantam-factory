#!/usr/bin/env node

/** Test diversified, stable-prefix DiffusionGemma inspection racks as redundant wickets. */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const endpoint = option('endpoint', 'http://127.0.0.1:8001/v1/chat/completions');
const model = option('model', 'dg-awq');
const rounds = Number(option('rounds', '3'));
const confidenceThreshold = Number(option('confidence-threshold', '-0.07229331135749817'));
const handlePath = resolve(option('handles', '.bantam/factory-benchmarks/diffusiongemma-handles.json'));
const output = resolve(option('output', '.bantam/factory-benchmarks/diffusiongemma-redundant-rack.json'));
const handleEvidence = JSON.parse(await readFile(handlePath, 'utf8'));
const handles = handleEvidence.handles.map((row) => row.handle);
if (handles.length < 180) throw new Error('redundant rack lab requires 180 compiled handles');
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');

const needles = [
  ['seal fracture', 'a hairline fracture beneath the ceramic seal'],
  ['missing calibration', 'the measurement lacks a traceable calibration certificate'],
  ['conflicting instruction', 'one active instruction says proceed while another requires lockout'],
  ['customer escape', 'the defect can propagate directly into customer-bound product'],
  ['thermal runaway', 'temperature is accelerating upward despite the controller command'],
  ['stale dependency', 'downstream release depends on an obsolete acceptance result'],
  ['unapproved substitution', 'an alternate alloy was installed without engineering approval'],
  ['quota outage', 'the assigned worker has no remaining service quota'],
  ['silent data loss', 'the transformation drops valid source records without reporting an error'],
  ['rollback failure', 'the failed promotion left live state partially mutated'],
  ['ambiguous authority', 'two supervisors claim incompatible release authority'],
  ['unverified output', 'the article completed without independent quality evidence'],
];

const records = Array.from({ length: 60 }, (_, i) => ({
  id: `REC-${String(i + 1).padStart(3, '0')}`,
  text: `Routine observation ${i + 1}: readings are stable, evidence is attached, instructions agree, and no customer material is exposed.`,
}));
needles.forEach(([, phrase], i) => {
  records[i * 5 + 2].text = `Exception observation ${i * 5 + 3}: ${phrase}. The rest of the record is routine.`;
});
const expected = needles.map((_, i) => records[i * 5 + 2].id);

const layouts = [
  { name: 'rack-a', base: 0, order: Array.from({ length: 60 }, (_, i) => i) },
  { name: 'rack-b', base: 60, order: Array.from({ length: 60 }, (_, i) => (i * 17 + 7) % 60) },
  { name: 'rack-c', base: 120, order: Array.from({ length: 60 }, (_, i) => (i * 19 + 11) % 60) },
].map((layout) => {
  const rows = layout.order.map((recordIndex, position) => ({
    ...records[recordIndex],
    handle: handles[layout.base + position],
  }));
  return {
    ...layout,
    rows,
    handleToRecord: Object.fromEntries(rows.map((row) => [row.handle, row.id])),
    fingerprint: rows.map((row) => `${row.handle}:${row.id}`).join('|'),
  };
});

const pointSchema = {
  type: 'object',
  properties: { points: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 } },
  required: ['points'],
  additionalProperties: false,
};

function parseJson(content) {
  try { return JSON.parse(content); } catch { /* continue */ }
  const candidate = content.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function confidenceTelemetry(logprobs, emittedHandle) {
  const tokens = Array.isArray(logprobs?.content) ? logprobs.content : [];
  const rows = tokens.map((row) => {
    const alternatives = Array.isArray(row.top_logprobs) ? row.top_logprobs : [];
    const second = alternatives.find((candidate) => candidate.token !== row.token);
    return {
      token: row.token,
      logprob: row.logprob,
      margin: second ? row.logprob - second.logprob : null,
    };
  });
  const handleRow = emittedHandle
    ? rows.find((row) => row.token === emittedHandle || row.token.includes(emittedHandle)) ?? null
    : null;
  const finite = rows.filter((row) => Number.isFinite(row.logprob));
  return {
    handleLogprob: handleRow?.logprob ?? null,
    handleMargin: handleRow?.margin ?? null,
    meanLogprob: finite.length ? finite.reduce((sum, row) => sum + row.logprob, 0) / finite.length : null,
    minLogprob: finite.length ? Math.min(...finite.map((row) => row.logprob)) : null,
    tokens: rows,
  };
}

async function inspect(layout, query, expectedId, round) {
  const material = layout.rows.map((row) => `[${row.handle}] ${row.text}`).join('\n');
  const prompt = `MATERIAL RACK ${layout.name}. Select only an issued bracketed handle.\n${material}\n\nINSPECTION BUTTON: Return the ONE handle whose record reports ${query}. Return {"points":["HANDLE"]}.`;
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 96,
      chat_template_kwargs: { enable_thinking: false },
      guided_json: pointSchema,
      logprobs: true,
      top_logprobs: 5,
    }),
  });
  const rawEnvelope = await response.text();
  const elapsedMs = Number((performance.now() - started).toFixed(2));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawEnvelope.slice(0, 500)}`);
  const envelope = JSON.parse(rawEnvelope);
  const raw = envelope.choices?.[0]?.message?.content ?? '';
  const parsed = parseJson(raw);
  const emittedHandle = Array.isArray(parsed?.points) && parsed.points.length === 1 ? parsed.points[0] : null;
  const actualId = emittedHandle ? layout.handleToRecord[emittedHandle] ?? null : null;
  const confidence = confidenceTelemetry(envelope.choices?.[0]?.logprobs, emittedHandle);
  return {
    round,
    rack: layout.name,
    query,
    expectedId,
    emittedHandle,
    actualId,
    pass: actualId === expectedId,
    knownHandle: emittedHandle !== null && actualId !== null,
    elapsedMs,
    promptTokens: envelope.usage?.prompt_tokens ?? 0,
    completionTokens: envelope.usage?.completion_tokens ?? 0,
    confidence,
    raw,
  };
}

const startedAt = new Date().toISOString();
const inspections = [];
// Keep each physical rack resident for a complete button cycle. Subsequent
// rounds test whether multiple prefixes remain useful in the server cache.
for (let round = 1; round <= rounds; round += 1) {
  for (const layout of layouts) {
    for (let i = 0; i < needles.length; i += 1) {
      inspections.push(await inspect(layout, needles[i][0], expected[i], round));
    }
  }
}

const articles = [];
for (let round = 1; round <= rounds; round += 1) {
  for (let i = 0; i < needles.length; i += 1) {
    const rows = layouts.map((layout) => inspections.find((row) => row.round === round && row.rack === layout.name && row.query === needles[i][0]));
    const [a, b, c] = rows.map((row) => row.actualId);
    const counts = new Map(rows.filter((row) => row.actualId).map((row) => [row.actualId, rows.filter((other) => other.actualId === row.actualId).length]));
    const majority = [...counts.entries()].find(([, count]) => count >= 2)?.[0] ?? null;
    const dualAgreement = a !== null && a === b ? a : null;
    articles.push({
      round,
      query: needles[i][0],
      expectedId: expected[i],
      racks: rows.map((row) => ({ rack: row.rack, actualId: row.actualId, pass: row.pass })),
      single: { released: a !== null, actualId: a, pass: a === expected[i], elapsedMs: rows[0].elapsedMs },
      dual: { released: dualAgreement !== null, actualId: dualAgreement, pass: dualAgreement === expected[i], held: dualAgreement === null, elapsedMs: Number((rows[0].elapsedMs + rows[1].elapsedMs).toFixed(2)) },
      triple: { released: majority !== null, actualId: majority, pass: majority === expected[i], held: majority === null, unanimous: a !== null && a === b && b === c, elapsedMs: Number(rows.reduce((sum, row) => sum + row.elapsedMs, 0).toFixed(2)) },
    });
  }
}

const mean = (values) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
function modeSummary(mode) {
  const rows = articles.map((article) => article[mode]);
  return {
    articles: rows.length,
    released: rows.filter((row) => row.released).length,
    held: rows.filter((row) => !row.released).length,
    correctReleases: rows.filter((row) => row.released && row.pass).length,
    escapedWrongReleases: rows.filter((row) => row.released && !row.pass).length,
    releaseYield: Number((rows.filter((row) => row.released).length / rows.length).toFixed(4)),
    releasedAccuracy: rows.some((row) => row.released)
      ? Number((rows.filter((row) => row.released && row.pass).length / rows.filter((row) => row.released).length).toFixed(4))
      : null,
    meanSequentialMs: mean(rows.map((row) => row.elapsedMs)),
  };
}

function confidenceAnalysis() {
  const firstRack = inspections.filter((row) => row.rack === 'rack-a' && Number.isFinite(row.confidence.handleLogprob));
  const correct = firstRack.filter((row) => row.pass);
  const wrong = firstRack.filter((row) => !row.pass);
  const candidates = [...new Set(firstRack.map((row) => row.confidence.handleLogprob))].sort((a, b) => a - b);
  const policies = candidates.map((threshold) => {
    let requests = 0;
    let released = 0;
    let correctReleases = 0;
    let escapedWrongReleases = 0;
    let held = 0;
    for (const article of articles) {
      const first = inspections.find((row) => row.round === article.round && row.rack === 'rack-a' && row.query === article.query);
      if (first.confidence.handleLogprob >= threshold) {
        requests += 1;
        released += 1;
        if (first.pass) correctReleases += 1;
        else escapedWrongReleases += 1;
      } else {
        requests += 3;
        if (article.triple.released) {
          released += 1;
          if (article.triple.pass) correctReleases += 1;
          else escapedWrongReleases += 1;
        } else held += 1;
      }
    }
    return {
      threshold,
      requests,
      meanRequests: Number((requests / articles.length).toFixed(3)),
      released,
      held,
      correctReleases,
      escapedWrongReleases,
    };
  });
  const fixed = { threshold: confidenceThreshold, requests: 0, released: 0, held: 0, correctReleases: 0, escapedWrongReleases: 0 };
  for (const article of articles) {
    const first = inspections.find((row) => row.round === article.round && row.rack === 'rack-a' && row.query === article.query);
    if (first.confidence.handleLogprob >= confidenceThreshold) {
      fixed.requests += 1;
      fixed.released += 1;
      if (first.pass) fixed.correctReleases += 1;
      else fixed.escapedWrongReleases += 1;
    } else {
      fixed.requests += 3;
      if (article.triple.released) {
        fixed.released += 1;
        if (article.triple.pass) fixed.correctReleases += 1;
        else fixed.escapedWrongReleases += 1;
      } else fixed.held += 1;
    }
  }
  fixed.meanRequests = Number((fixed.requests / articles.length).toFixed(3));
  return {
    firstRackSamples: firstRack.length,
    correctMeanHandleLogprob: correct.length ? mean(correct.map((row) => row.confidence.handleLogprob)) : null,
    wrongMeanHandleLogprob: wrong.length ? mean(wrong.map((row) => row.confidence.handleLogprob)) : null,
    correctRange: correct.length ? [Math.min(...correct.map((row) => row.confidence.handleLogprob)), Math.max(...correct.map((row) => row.confidence.handleLogprob))] : null,
    wrongRange: wrong.length ? [Math.min(...wrong.map((row) => row.confidence.handleLogprob)), Math.max(...wrong.map((row) => row.confidence.handleLogprob))] : null,
    fixedThresholdPolicy: fixed,
    zeroEscapePolicies: policies.filter((row) => row.escapedWrongReleases === 0).sort((a, b) => a.requests - b.requests),
  };
}

const report = {
  schema: 'bantam.factory.diffusiongemma-redundant-rack-lab.v1',
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint,
  model,
  rounds,
  records: records.length,
  queriesPerRound: needles.length,
  rackFingerprints: Object.fromEntries(layouts.map((layout) => [layout.name, layout.fingerprint])),
  summary: {
    rackAccuracy: Object.fromEntries(layouts.map((layout) => {
      const rows = inspections.filter((row) => row.rack === layout.name);
      return [layout.name, { passed: rows.filter((row) => row.pass).length, total: rows.length, meanMs: mean(rows.map((row) => row.elapsedMs)) }];
    })),
    single: modeSummary('single'),
    dual: modeSummary('dual'),
    triple: modeSummary('triple'),
    confidence: confidenceAnalysis(),
  },
  articles,
  inspections,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`redundant-rack evidence: ${output}`);
