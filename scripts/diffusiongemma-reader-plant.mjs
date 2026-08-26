#!/usr/bin/env node

/**
 * BANTAMFACTORY all-DiffusionGemma Reader Plant experiment.
 *
 * One monolithic worker must find and disposition every priority record. The
 * plant instead runs independent small-lot semantic sweeps, joins point sets
 * mechanically, and sends only the resulting candidates through tiny
 * disposition stations. The output is an append-only digital thread.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const endpoint = option('endpoint', 'http://127.0.0.1:8001/v1/chat/completions');
const model = option('model', 'dg-awq');
const rounds = Number(option('rounds', '3'));
const recordCount = Number(option('records', '96'));
const lotSize = Number(option('lot-size', '8'));
const output = resolve(option('output', '.bantam/factory-benchmarks/diffusiongemma-reader-plant.json'));

if (![rounds, recordCount, lotSize].every(Number.isInteger) || rounds < 1 || recordCount < 48 || lotSize < 1) {
  throw new Error('rounds/records/lot-size must be integers; minimums are 1/48/1');
}

const point = (n) => `GP-${String(n).padStart(4, '0')}`;
const components = ['intake press', 'coolant loop', 'weld cell', 'vision gauge', 'paint oven', 'dispatch conveyor'];
const criticalSeeds = [11, 37, 68, 91];
const stopSeeds = [22, 73];
const conflictSeeds = [45];

const phrases = {
  mandatory: [
    'Before restart, the shift supervisor is required to sign the corrective-work traveler.',
    'Return to service is permitted only after the prescribed inspection is completed and signed.',
    'The control plan requires documented supervisor approval before another production cycle.',
  ],
  advisory: [
    'A visual check at the next convenient service window is recommended.',
    'The crew may consider another inspection during ordinary monthly maintenance.',
    'No pre-restart approval is required; routine observation is sufficient.',
  ],
  anomaly: [
    'The latest readings crossed the qualified upper control limit and continue to drift upward.',
    'Three successive samples are outside the established process envelope.',
    'The observed state is abnormal: measured variation now exceeds the released tolerance.',
  ],
  normal: [
    'Measurements remain centered inside the released control limits with no trend.',
    'The last three samples are stable and comfortably within tolerance.',
    'No abnormal variation was detected in the current inspection window.',
  ],
  missing: [
    'No signed calibration certificate or traceable gauge record accompanies this result.',
    'The claimed measurement has no attached evidence packet and cannot yet be traced to a calibrated instrument.',
    'Required measurement provenance is absent from the traveler.',
  ],
  present: [
    'A signed calibration certificate and traceable gauge record are attached to the traveler.',
    'The evidence packet includes instrument identity, calibration date, and inspector signature.',
    'Measurement provenance is complete and independently auditable.',
  ],
  shutdown: [
    'Standard work calls for immediate isolation; operation must stop until the interlock is cleared.',
    'The cell is to be taken out of service now, not merely watched through the next shift.',
    'The response plan requires an immediate stop and lockout.',
  ],
  monitor: [
    'The machine may continue operating while the condition is monitored at the normal interval.',
    'No immediate isolation is called for under the released response plan.',
    'Continue production and review the observation during the next scheduled meeting.',
  ],
  impact: [
    'This equipment supplies the customer-facing final assembly line; an escape would affect released product.',
    'The affected output feeds shipped customer units rather than an internal development fixture.',
    'A defect here can propagate directly into customer-bound articles.',
  ],
  internal: [
    'This is an offline training fixture with no path to customer-bound production.',
    'The observation concerns an isolated laboratory coupon, not released product.',
    'No customer-facing material passes through this equipment.',
  ],
  dependency: [
    'Downstream release explicitly depends on this station producing a valid acceptance signal.',
    'The next operation is blocked until this record is resolved.',
    'This result is a declared prerequisite for downstream shipment authorization.',
  ],
  independent: [
    'No downstream release or shipment decision depends on this observation.',
    'The record is informational and is not a prerequisite for another operation.',
    'Later work can proceed independently of this note.',
  ],
  contradiction: [
    'Two active instructions conflict: one authorizes continued production while the other requires lockout for the same condition.',
    'The released traveler simultaneously says to proceed and to hold the identical article.',
    'Current standard work contains mutually incompatible dispositions for this state.',
  ],
  coherent: [
    'All active instructions agree on the same disposition.',
    'The traveler contains one coherent response with no conflicting direction.',
    'Applicable work instructions are mutually consistent.',
  ],
};

const choose = (list, n, round) => list[(n * 7 + round * 5) % list.length];

function buildRecords(round) {
  const shift = round * 2;
  return Array.from({ length: recordCount }, (_, index) => {
    const n = index + 1;
    const shifted = ((n + shift - 1) % recordCount) + 1;
    const forcedCritical = criticalSeeds.includes(shifted);
    const forcedStop = stopSeeds.includes(shifted);
    const forcedConflict = conflictSeeds.includes(shifted);
    const tags = {
      mandatory: forcedCritical || n % 31 === 4,
      anomaly: forcedCritical || n % 27 === 6,
      missingEvidence: forcedCritical || n % 25 === 8,
      shutdown: forcedStop || n % 33 === 10,
      customerImpact: forcedStop || n % 35 === 12,
      dependency: forcedConflict || n % 29 === 14,
      contradiction: forcedConflict || n % 37 === 16,
    };
    const route = tags.shutdown && tags.customerImpact
      ? 'STOP_SHIP'
      : tags.mandatory && tags.anomaly && tags.missingEvidence
        ? 'EVIDENCE_HOLD'
        : tags.contradiction && tags.dependency
          ? 'SUPERVISOR_REVIEW'
          : 'MONITOR';
    const component = components[(n + round) % components.length];
    const text = [
      choose(tags.mandatory ? phrases.mandatory : phrases.advisory, n, round),
      choose(tags.anomaly ? phrases.anomaly : phrases.normal, n + 1, round),
      choose(tags.missingEvidence ? phrases.missing : phrases.present, n + 2, round),
      choose(tags.shutdown ? phrases.shutdown : phrases.monitor, n + 3, round),
      choose(tags.customerImpact ? phrases.impact : phrases.internal, n + 4, round),
      choose(tags.dependency ? phrases.dependency : phrases.independent, n + 5, round),
      choose(tags.contradiction ? phrases.contradiction : phrases.coherent, n + 6, round),
    ].join(' ');
    return { id: point(n), component, tags, route, text };
  });
}

const lenses = [
  ['mandatory', 'Select records that REQUIRE inspection, approval, or corrective work before restart. Recommendations and optional checks do not qualify.'],
  ['anomaly', 'Select records reporting measurements outside control limits, outside tolerance, or otherwise abnormal. Stable in-tolerance records do not qualify.'],
  ['missingEvidence', 'Select records whose claimed result lacks required traceable measurement or calibration evidence. Complete evidence packets do not qualify.'],
  ['shutdown', 'Select records requiring immediate stop, isolation, or lockout. Monitoring while production continues does not qualify.'],
  ['customerImpact', 'Select records whose equipment or output can directly affect customer-bound or released product. Offline fixtures do not qualify.'],
  ['dependency', 'Select records that explicitly block or gate a downstream operation, release, or shipment decision. Informational observations do not qualify.'],
  ['contradiction', 'Select records containing mutually incompatible active instructions for the same state. Coherent instructions do not qualify.'],
];

const pointSchema = {
  type: 'object',
  properties: { points: { type: 'array', items: { type: 'string' } } },
  required: ['points'],
  additionalProperties: false,
};
const matrixSchema = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          mandatory: { type: 'boolean' },
          anomaly: { type: 'boolean' },
          missingEvidence: { type: 'boolean' },
          shutdown: { type: 'boolean' },
          customerImpact: { type: 'boolean' },
          dependency: { type: 'boolean' },
          contradiction: { type: 'boolean' },
        },
        required: ['point', ...lenses.map(([name]) => name)],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};
const routeSchema = {
  type: 'object',
  properties: { route: { type: 'string', enum: ['STOP_SHIP', 'EVIDENCE_HOLD', 'SUPERVISOR_REVIEW', 'MONITOR'] } },
  required: ['route'],
  additionalProperties: false,
};
const articleSchema = {
  type: 'object',
  properties: {
    articles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          route: { type: 'string', enum: ['STOP_SHIP', 'EVIDENCE_HOLD', 'SUPERVISOR_REVIEW'] },
        },
        required: ['point', 'route'],
        additionalProperties: false,
      },
    },
  },
  required: ['articles'],
  additionalProperties: false,
};

function render(records) {
  return records.map((record) => `[${record.id}] ${record.text}`).join('\n');
}

function parseJson(content) {
  try { return JSON.parse(content); } catch { /* inspect bounded objects */ }
  const candidates = [
    content.match(/(\{[\s\S]*?\})/)?.[1],
    content.match(/(\{[\s\S]*\})/)?.[1],
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* continue */ }
  }
  return null;
}

function canonicalizePoint(value, registry) {
  if (registry.has(value)) return { value, repaired: false };
  const match = typeof value === 'string'
    ? value.match(/^[\[("'\s]*GP-(\d{1,4})[\])"',\s]*$/)
    : null;
  if (!match) return { value, repaired: false };
  const candidate = `GP-${match[1].padStart(4, '0')}`;
  return registry.has(candidate)
    ? { value: candidate, repaired: candidate !== value }
    : { value, repaired: false };
}

async function ask(prompt, schema, { temperature = 0, enableThinking = false, maxTokens = 512 } = {}) {
  const started = performance.now();
  const requestBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: enableThinking },
  };
  if (schema) requestBody.guided_json = schema;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 400)}`);
  const envelope = JSON.parse(raw);
  const content = envelope.choices?.[0]?.message?.content ?? '';
  const reasoning = envelope.choices?.[0]?.message?.reasoning ?? null;
  return {
    content,
    reasoning,
    finishReason: envelope.choices?.[0]?.finish_reason ?? null,
    workerMode: enableThinking ? 'diffusiongemma-thinking' : 'diffusiongemma-fast-classification',
    parsed: parseJson(content),
    elapsedMs: Number(elapsedMs.toFixed(2)),
    promptTokens: envelope.usage?.prompt_tokens ?? 0,
    completionTokens: envelope.usage?.completion_tokens ?? 0,
  };
}

const setEqual = (a, b) => a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
const articleKey = (article) => `${article.point}:${article.route}`;
const articlesEqual = (actual, expected) => setEqual(actual.map(articleKey), expected.map(articleKey));

const thread = [];
let eventSequence = 0;
function event(round, type, station, data = {}) {
  thread.push({ sequence: ++eventSequence, at: new Date().toISOString(), round, type, station, ...data });
}

async function runRound(round) {
  const records = buildRecords(round);
  const registry = new Map(records.map((record) => [record.id, record]));
  const expectedArticles = records.filter((record) => record.route !== 'MONITOR').map((record) => ({ point: record.id, route: record.route }));
  const fullMaterial = render(records);
  event(round, 'material.received', 'receiving', { records: records.length, characters: fullMaterial.length });

  const monolithPrompt = `You are the complete inspection department. Read all records. Release an article ONLY when one of these exact rules applies:\n- STOP_SHIP: immediate stop/isolation/lockout AND direct customer-product impact.\n- EVIDENCE_HOLD: mandatory pre-restart approval/work AND an abnormal measurement AND missing traceable evidence.\n- SUPERVISOR_REVIEW: conflicting active instructions AND an explicit downstream dependency.\nIgnore all other records. Return {"articles":[{"point":"GP-...","route":"..."}]}.\n\n${fullMaterial}`;
  event(round, 'station.started', 'monolithic-control');
  const monolithResponse = await ask(monolithPrompt, null, { enableThinking: true, maxTokens: 8192 });
  const monolithArticles = Array.isArray(monolithResponse.parsed?.articles)
    ? monolithResponse.parsed.articles.map((article) => ({ ...article, point: canonicalizePoint(article.point, registry).value }))
    : [];
  const monolithPass = articlesEqual(monolithArticles, expectedArticles);
  event(round, 'station.completed', 'monolithic-control', { pass: monolithPass, articles: monolithArticles.length, ...monolithResponse });

  const sweepSets = Object.fromEntries(lenses.map(([lens]) => [lens, new Set()]));
  let matrixRepairs = 0;
  let matrixElapsedMs = 0;
  let matrixPromptTokens = 0;
  let matrixCompletionTokens = 0;
  let matrixRows = 0;
  const lensInstructions = lenses.map(([lens, instruction]) => `${lens}: ${instruction}`).join('\n');
  event(round, 'station.started', 'inspection-matrix', { lots: Math.ceil(records.length / lotSize), decisionsPerRecord: lenses.length });
  for (let index = 0; index < records.length; index += lotSize) {
    const lot = records.slice(index, index + lotSize);
    const lotIds = new Set(lot.map((record) => record.id));
    const prompt = `Inspect every record in this small lot once. Return exactly one row per Gemma Point and classify all seven fields true or false. Apply these definitions independently:\n${lensInstructions}\nReturn {"rows":[{"point":"GP-...","mandatory":false,"anomaly":false,"missingEvidence":false,"shutdown":false,"customerImpact":false,"dependency":false,"contradiction":false}]}.\n\n${render(lot)}`;
    let response;
    let emitted = [];
    let normalizedRows = [];
    let structurallyAdmissible = false;
    let attempts = 0;
    for (const temperature of [0, 0.5, 0.7]) {
      attempts += 1;
      response = await ask(prompt, matrixSchema, { temperature, enableThinking: false, maxTokens: 512 });
      matrixElapsedMs += response.elapsedMs;
      matrixPromptTokens += response.promptTokens;
      matrixCompletionTokens += response.completionTokens;
      emitted = Array.isArray(response.parsed?.rows) ? response.parsed.rows : [];
      normalizedRows = emitted.map((row) => ({ row, normalized: canonicalizePoint(row.point, registry) }));
      const emittedIds = normalizedRows.map(({ normalized }) => normalized.value);
      const fieldsValid = emitted.every((row) => lenses.every(([lens]) => typeof row[lens] === 'boolean'));
      structurallyAdmissible = fieldsValid && setEqual(emittedIds, [...lotIds]);
      if (structurallyAdmissible) break;
      event(round, 'lot.retry', 'inspection-matrix', {
        lot: `${lot[0].id}..${lot.at(-1).id}`,
        attempt: attempts,
        emittedRows: emitted.length,
        reason: 'row-completeness-gauge',
      });
    }
    const accepted = [];
    for (const { row, normalized } of structurallyAdmissible ? normalizedRows : []) {
      if (normalized.repaired) matrixRepairs += 1;
      if (!lotIds.has(normalized.value)) continue;
      matrixRows += 1;
      accepted.push(normalized.value);
      for (const [lens] of lenses) if (row[lens] === true) sweepSets[lens].add(normalized.value);
    }
    event(round, 'lot.inspected', 'inspection-matrix', {
      lot: `${lot[0].id}..${lot.at(-1).id}`,
      emittedRows: emitted.length,
      accepted,
      attempts,
      structurallyAdmissible,
      elapsedMs: response.elapsedMs,
    });
  }
  const sweepStats = lenses.map(([lens]) => {
    const expected = records.filter((record) => record.tags[lens]).map((record) => record.id);
    const actual = [...sweepSets[lens]];
    return { lens, pass: setEqual(actual, expected), expected: expected.length, actual: actual.length };
  });
  event(round, 'station.completed', 'inspection-matrix', {
    pass: sweepStats.every((stat) => stat.pass) && matrixRows === records.length,
    rows: matrixRows,
    repairs: matrixRepairs,
    elapsedMs: Number(matrixElapsedMs.toFixed(2)),
  });

  const intersects = (...names) => records
    .filter((record) => names.every((name) => sweepSets[name].has(record.id)))
    .map((record) => record.id);
  const candidates = [...new Set([
    ...intersects('shutdown', 'customerImpact'),
    ...intersects('mandatory', 'anomaly', 'missingEvidence'),
    ...intersects('contradiction', 'dependency'),
  ])];
  event(round, 'join.completed', 'mechanical-join', {
    expressions: ['shutdown∩customerImpact', 'mandatory∩anomaly∩missingEvidence', 'contradiction∩dependency'],
    candidates,
    reductionRatio: Number((candidates.length / records.length).toFixed(4)),
  });

  const factoryArticles = [];
  const branchStats = [];
  for (const candidate of candidates) {
    const record = registry.get(candidate);
    const route = sweepSets.shutdown.has(candidate) && sweepSets.customerImpact.has(candidate)
      ? 'STOP_SHIP'
      : sweepSets.mandatory.has(candidate) && sweepSets.anomaly.has(candidate) && sweepSets.missingEvidence.has(candidate)
        ? 'EVIDENCE_HOLD'
        : sweepSets.contradiction.has(candidate) && sweepSets.dependency.has(candidate)
          ? 'SUPERVISOR_REVIEW'
          : 'MONITOR';
    const pass = route === record.route;
    branchStats.push({ point: candidate, expected: record.route, actual: route, pass, mechanism: 'mechanical-join', elapsedMs: 0, promptTokens: 0, completionTokens: 0 });
    if (route && route !== 'MONITOR') factoryArticles.push({ point: candidate, route });
    event(round, 'branch.routed', 'candidate-switchyard', { point: candidate, route, pass, mechanism: 'mechanical-join' });
  }

  const factoryPass = articlesEqual(factoryArticles, expectedArticles);
  const factoryElapsedMs = matrixElapsedMs + branchStats.reduce((sum, stat) => sum + stat.elapsedMs, 0);
  const factoryPromptTokens = matrixPromptTokens + branchStats.reduce((sum, stat) => sum + stat.promptTokens, 0);
  const factoryCompletionTokens = matrixCompletionTokens + branchStats.reduce((sum, stat) => sum + stat.completionTokens, 0);
  event(round, factoryPass ? 'article.released' : 'article.contained', 'final-gauge', { expected: expectedArticles, actual: factoryArticles });

  return {
    round: round + 1,
    records: records.length,
    expectedArticles,
    monolith: { pass: monolithPass, articles: monolithArticles, ...monolithResponse },
    factory: {
      pass: factoryPass,
      articles: factoryArticles,
      candidates,
      candidateReduction: 1 - (candidates.length / records.length),
      matrix: { rows: matrixRows, repairs: matrixRepairs, elapsedMs: Number(matrixElapsedMs.toFixed(2)), promptTokens: matrixPromptTokens, completionTokens: matrixCompletionTokens },
      sweeps: sweepStats,
      branches: branchStats,
      elapsedMs: Number(factoryElapsedMs.toFixed(2)),
      promptTokens: factoryPromptTokens,
      completionTokens: factoryCompletionTokens,
    },
  };
}

const startedAt = new Date().toISOString();
const results = [];
for (let round = 0; round < rounds; round += 1) results.push(await runRound(round));

const meanMonolithMs = Number((results.reduce((sum, result) => sum + result.monolith.elapsedMs, 0) / results.length).toFixed(2));
const meanFactoryMs = Number((results.reduce((sum, result) => sum + result.factory.elapsedMs, 0) / results.length).toFixed(2));
const retries = thread.filter((item) => item.type === 'lot.retry').length;
const summary = {
  rounds,
  recordsPerRound: recordCount,
  lotSize,
  monolithPassed: results.filter((result) => result.monolith.pass).length,
  factoryPassed: results.filter((result) => result.factory.pass).length,
  sweepTrials: results.flatMap((result) => result.factory.sweeps).length,
  sweepTrialsPassed: results.flatMap((result) => result.factory.sweeps).filter((sweep) => sweep.pass).length,
  branchTrials: results.flatMap((result) => result.factory.branches).length,
  branchTrialsPassed: results.flatMap((result) => result.factory.branches).filter((branch) => branch.pass).length,
  meanMonolithMs,
  meanFactoryMs,
  meanCandidateReduction: Number((results.reduce((sum, result) => sum + result.factory.candidateReduction, 0) / results.length).toFixed(4)),
  meanCandidateRecords: Number((results.reduce((sum, result) => sum + result.factory.candidates.length, 0) / results.length).toFixed(2)),
  semanticFlagsPerRound: recordCount * lenses.length,
  meanSemanticFlagsPerSecond: Number(((recordCount * lenses.length) / (meanFactoryMs / 1000)).toFixed(2)),
  structuralRetries: retries,
  modelRequests: rounds * (1 + Math.ceil(recordCount / lotSize)) + retries,
  events: thread.length,
};

const report = {
  schema: 'bantam.factory.diffusiongemma-reader-plant.v1',
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint,
  model,
  config: { rounds, recordCount, lotSize, lenses: lenses.map(([name]) => name) },
  summary,
  results,
  thread,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`digital thread: ${output}`);
