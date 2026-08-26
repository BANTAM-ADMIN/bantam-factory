#!/usr/bin/env node

/**
 * Factory-shaped qualification benchmark for DiffusionGemma.
 *
 * The model is never asked to invent offsets. The controller gives every
 * source record a stable Gemma Point (GP-*), the model chooses points, and
 * this script dereferences and verifies them mechanically. An exact-value A/B
 * measures the cost/reliability of making the model copy opaque payload bytes.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const endpoint = option('endpoint', 'http://127.0.0.1:8001/v1/chat/completions');
const model = option('model', 'dg-awq');
const rounds = Number(option('rounds', '3'));
const recordCount = Number(option('records', '72'));
const lotSize = Number(option('lot-size', '12'));
const output = resolve(option(
  'output',
  '.bantam/factory-benchmarks/diffusiongemma-points.json',
));

if (!Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(recordCount) || recordCount < 32 || !Number.isInteger(lotSize) || lotSize < 1) {
  throw new Error('--rounds must be >= 1, --records must be >= 32, and --lot-size must be >= 1');
}

const pad = (n) => String(n).padStart(4, '0');
const point = (n) => `GP-${pad(n)}`;
const opaque = (n) => `ZX${pad(n)}-${((n * 7919) % 99991).toString(36).toUpperCase()}-${((n * 104729) % 999983).toString(36).toUpperCase()}`;
const teams = ['amber', 'cobalt', 'fern', 'lilac', 'sienna', 'teal'];
const machines = ['press', 'lathe', 'welder', 'gauge', 'feeder', 'oven'];

function buildRecords(targetShift = 0) {
  return Array.from({ length: recordCount }, (_, i) => {
    const n = i + 1;
    const target = (n + targetShift) % 17 === 7;
    const changed = (n + targetShift) % 19 === 5;
    const team = teams[(n * 5 + targetShift) % teams.length];
    const machine = machines[(n * 7 + targetShift) % machines.length];
    return {
      id: point(n),
      opaque: opaque(n),
      team,
      machine,
      temperature: 60 + ((n * 13) % 37),
      vibration: target ? 'rising' : ['stable', 'falling', 'stable'][n % 3],
      interlock: target ? 'open' : n % 11 === 0 ? 'open' : 'closed',
      revisionA: changed ? 'Inspection is recommended before the next shift.' : 'Inspection is recommended during the monthly service.',
      revisionB: changed ? 'Inspection is mandatory before restart; supervisor sign-off required.' : 'Inspection is recommended during the monthly service.',
      note: `Routine report ${n}: ${team} crew observed the ${machine}; lubrication, alignment, guarding, and material flow were recorded for the traveler.`,
      target,
      changed,
    };
  });
}

function render(records, includeRevisions = false) {
  return records.map((r) => includeRevisions
    ? `[${r.id}] A=${r.revisionA} B=${r.revisionB} opaque=${r.opaque} ${r.note}`
    : `[${r.id}] team=${r.team} machine=${r.machine} temp=${r.temperature} vibration=${r.vibration} interlock=${r.interlock} opaque=${r.opaque} ${r.note}`
  ).join('\n');
}

const pointSchema = {
  type: 'object',
  properties: { points: { type: 'array', items: { type: 'string', pattern: '^GP-[0-9]{4}$' } } },
  required: ['points'],
  additionalProperties: false,
};

const valueSchema = {
  type: 'object',
  properties: { values: { type: 'array', items: { type: 'string' } } },
  required: ['values'],
  additionalProperties: false,
};

async function ask(prompt, schema) {
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 512,
      guided_json: schema,
    }),
  });
  const body = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
  const envelope = JSON.parse(body);
  const content = envelope.choices?.[0]?.message?.content ?? '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const candidates = [
      content.match(/(\{[\s\S]*?\})/)?.[1],
      content.match(/(?:```(?:json)?\s*)?(\{[\s\S]*\})(?:\s*```)?/i)?.[1],
    ].filter(Boolean);
    parsed = null;
    for (const candidate of candidates) {
      try { parsed = JSON.parse(candidate); break; } catch { /* try the next bounded candidate */ }
    }
  }
  return { elapsedMs, usage: envelope.usage ?? {}, content, parsed };
}

function sameSet(actual, expected) {
  if (!Array.isArray(actual)) return false;
  return actual.length === expected.length && [...actual].sort().every((v, i) => v === [...expected].sort()[i]);
}

function canonicalizePoints(values, registry) {
  if (!Array.isArray(values)) return { points: values, repairs: [] };
  const repairs = [];
  const points = values.map((value) => {
    if (registry.has(value)) return value;
    const match = typeof value === 'string'
      ? value.match(/^[\[("'\s]*GP-(\d{1,4})[\])"',\s]*$/)
      : null;
    if (!match) return value;
    const candidate = `GP-${match[1].padStart(4, '0')}`;
    if (!registry.has(candidate)) return value;
    repairs.push({ from: value, to: candidate, rule: 'unique-zero-pad' });
    return candidate;
  });
  return { points, repairs };
}

async function runCase({ name, prompt, schema, field, expected, registry, capability }) {
  const response = await ask(prompt, schema);
  const emitted = response.parsed?.[field];
  const normalized = field === 'points' ? canonicalizePoints(emitted, registry) : { points: emitted, repairs: [] };
  const actual = normalized.points;
  const idsKnown = field !== 'points' || (Array.isArray(actual) && actual.every((id) => registry.has(id)));
  const dereferenced = field === 'points' && Array.isArray(actual) && idsKnown
    ? actual.map((id) => registry.get(id).opaque)
    : [];
  return {
    name,
    capability,
    pass: sameSet(actual, expected),
    idsKnown,
    expected,
    actual,
    repairs: normalized.repairs,
    dereferenced,
    elapsedMs: Number(response.elapsedMs.toFixed(2)),
    promptTokens: response.usage.prompt_tokens ?? null,
    completionTokens: response.usage.completion_tokens ?? null,
    raw: response.content,
  };
}

async function runSegmentedCase({ name, records, promptFor, expected, registry, capability, lotSize = 18 }) {
  const calls = [];
  const actual = [];
  for (let i = 0; i < records.length; i += lotSize) {
    const lot = records.slice(i, i + lotSize);
    const response = await ask(promptFor(lot), pointSchema);
    const emitted = response.parsed?.points;
    const normalized = canonicalizePoints(emitted, registry);
    const points = normalized.points;
    if (Array.isArray(points)) actual.push(...points);
    calls.push({
      lot: `${lot[0].id}..${lot.at(-1).id}`,
      elapsedMs: Number(response.elapsedMs.toFixed(2)),
      promptTokens: response.usage.prompt_tokens ?? null,
      completionTokens: response.usage.completion_tokens ?? null,
      actual: points ?? null,
      emitted: emitted ?? null,
      repairs: normalized.repairs,
      raw: response.content,
    });
  }
  const unique = [...new Set(actual)];
  const repairs = calls.flatMap((call) => call.repairs);
  const idsKnown = unique.every((id) => registry.has(id));
  return {
    name,
    capability,
    pass: sameSet(unique, expected),
    idsKnown,
    expected,
    actual: unique,
    repairs,
    dereferenced: idsKnown ? unique.map((id) => registry.get(id).opaque) : [],
    elapsedMs: Number(calls.reduce((n, c) => n + c.elapsedMs, 0).toFixed(2)),
    promptTokens: calls.reduce((n, c) => n + (c.promptTokens ?? 0), 0),
    completionTokens: calls.reduce((n, c) => n + (c.completionTokens ?? 0), 0),
    calls,
  };
}

const results = [];
for (let round = 0; round < rounds; round += 1) {
  const records = buildRecords(round * 3);
  const registry = new Map(records.map((r) => [r.id, r]));
  const targets = records.filter((r) => r.target);
  const changes = records.filter((r) => r.changed);
  const corpus = render(records);
  const revisionCorpus = render(records, true);

  const shared = 'Gemma Points are controller-issued record handles. Select handles exactly as printed. Do not copy opaque values and do not invent handles. Return only the requested JSON.\n\n';
  results.push(await runCase({
    name: `round-${round + 1}-single-point`,
    capability: 'semantic localization -> controller dereference',
    prompt: `${shared}${corpus}\n\nSelect the ONE record where vibration is rising and interlock is open with the greatest temperature. Return {"points":["GP-..."]}.`,
    schema: pointSchema,
    field: 'points',
    expected: [targets.reduce((a, b) => a.temperature > b.temperature ? a : b).id],
    registry,
  }));
  results.push(await runCase({
    name: `round-${round + 1}-single-exact`,
    capability: 'semantic localization + opaque byte copying',
    prompt: `Read the records and return the exact opaque value from the ONE record where vibration is rising and interlock is open with the greatest temperature. Return only {"values":["..."]}.\n\n${corpus}`,
    schema: valueSchema,
    field: 'values',
    expected: [targets.reduce((a, b) => a.temperature > b.temperature ? a : b).opaque],
    registry,
  }));
  results.push(await runCase({
    name: `round-${round + 1}-multi-point`,
    capability: 'set selection -> controller collation',
    prompt: `${shared}${corpus}\n\nSelect ALL records where vibration is rising and interlock is open. Return each matching point once in source order as {"points":[...]}.`,
    schema: pointSchema,
    field: 'points',
    expected: targets.map((r) => r.id),
    registry,
    lotSize,
  }));
  results.push(await runCase({
    name: `round-${round + 1}-change-points`,
    capability: 'semantic change detection -> provenance handles',
    prompt: `${shared}${revisionCorpus}\n\nSelect ALL records where revision B materially changes inspection from recommended to mandatory before restart. Return {"points":[...]}.`,
    schema: pointSchema,
    field: 'points',
    expected: changes.map((r) => r.id),
    registry,
    lotSize,
  }));
  results.push(await runSegmentedCase({
    name: `round-${round + 1}-segmented-points`,
    capability: 'small-lot point inspection -> deterministic union',
    records,
    promptFor: (lot) => `${shared}${render(lot)}\n\nSelect ALL records in this inspection lot where vibration is rising and interlock is open. Return {"points":[...]}.`,
    expected: targets.map((r) => r.id),
    registry,
  }));
  results.push(await runSegmentedCase({
    name: `round-${round + 1}-segmented-change-points`,
    capability: 'small-lot change inspection -> deterministic union',
    records,
    promptFor: (lot) => `${shared}${render(lot, true)}\n\nSelect ALL records in this inspection lot where revision B materially changes inspection from recommended to mandatory before restart. Return {"points":[...]}.`,
    expected: changes.map((r) => r.id),
    registry,
  }));
}

const casesByCapability = Object.values(results.reduce((acc, row) => {
  const item = acc[row.capability] ??= { capability: row.capability, cases: 0, passed: 0, elapsedMs: 0, promptTokens: 0, completionTokens: 0 };
  item.cases += 1;
  item.passed += Number(row.pass);
  item.elapsedMs += row.elapsedMs;
  item.promptTokens += row.promptTokens ?? 0;
  item.completionTokens += row.completionTokens ?? 0;
  return acc;
}, {})).map((item) => ({
  ...item,
  passRate: item.passed / item.cases,
  meanElapsedMs: Number((item.elapsedMs / item.cases).toFixed(2)),
}));

const report = {
  schema: 'bantam.factory.diffusiongemma-points-benchmark.v1',
  generatedAt: new Date().toISOString(),
  endpoint,
  model,
  config: { rounds, recordCount, lotSize },
  summary: {
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    passRate: results.filter((r) => r.pass).length / results.length,
    totalElapsedMs: Number(results.reduce((n, r) => n + r.elapsedMs, 0).toFixed(2)),
    capabilities: casesByCapability,
  },
  results,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`evidence: ${output}`);
