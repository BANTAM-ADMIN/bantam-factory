#!/usr/bin/env node

/** DiffusionGemma capability lab: rotary cache, semantic group testing, and output dies. */

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
const handlePath = resolve(option('handles', '.bantam/factory-benchmarks/diffusiongemma-handles.json'));
const output = resolve(option('output', '.bantam/factory-benchmarks/diffusiongemma-capability-lab.json'));
const rack = JSON.parse(await readFile(handlePath, 'utf8'));
const nativeHandles = rack.handles.map((item) => item.handle);
if (nativeHandles.length < 160) throw new Error('handle rack requires at least 160 handles');

const pointSchema = { type: 'object', properties: { points: { type: 'array', items: { type: 'string' } } }, required: ['points'], additionalProperties: false };
const presentSchema = { type: 'object', properties: { present: { type: 'boolean' } }, required: ['present'], additionalProperties: false };

function parseJson(content) {
  try { return JSON.parse(content); } catch { /* bounded recovery */ }
  for (const candidate of [content.match(/(\{[\s\S]*?\})/)?.[1], content.match(/(\{[\s\S]*\})/)?.[1]].filter(Boolean)) {
    try { return JSON.parse(candidate); } catch { /* continue */ }
  }
  return null;
}

// The sparse-column die has one observed, repeated press defect: after the
// first property DiffusionGemma may emit a doubled opening quote before a
// known key. Repair only that exact surface defect. The repaired object still
// has to pass the complete semantic gauge; this function never invents a key,
// handle, or decision.
function repairColumnJson(content) {
  const keyAlternation = flagNames.join('|');
  const defect = new RegExp(`([,{])\\s*""(${keyAlternation})"\\s*:`, 'g');
  if (!defect.test(content)) return null;
  const repairedRaw = content.replace(new RegExp(`([,{])\\s*""(${keyAlternation})"\\s*:`, 'g'), '$1"$2":');
  const parsed = parseJson(repairedRaw);
  if (!parsed || Object.keys(parsed).sort().join(',') !== [...flagNames].sort().join(',')) return null;
  return { parsed, repairedRaw, repair: 'remove-duplicated-opening-quote-before-issued-column-key' };
}

async function ask(prompt, schema, maxTokens = 512) {
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
      guided_json: schema,
    }),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const envelope = JSON.parse(raw);
  const content = envelope.choices?.[0]?.message?.content ?? '';
  return {
    elapsedMs: Number(elapsedMs.toFixed(2)),
    promptTokens: envelope.usage?.prompt_tokens ?? 0,
    completionTokens: envelope.usage?.completion_tokens ?? 0,
    parsed: parseJson(content),
    raw: content,
  };
}

const setEqual = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);
const mean = (values) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));

// -------------------------------------------------------------------------
// Experiment 1: rotary cached inspection
// -------------------------------------------------------------------------

const rotaryNeedles = [
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

function rotaryRecords(handles) {
  const records = Array.from({ length: 72 }, (_, i) => ({
    handle: handles[i],
    text: `Routine observation ${i + 1}: process readings are stable, evidence is attached, instructions agree, and no customer-bound material is exposed.`,
  }));
  rotaryNeedles.forEach(([, phrase], i) => {
    const index = i * 5 + 2;
    records[index].text = `Exception observation ${index + 1}: ${phrase}. The rest of the record is routine.`;
  });
  return records;
}

const render = (records) => records.map((record) => `[${record.handle}] ${record.text}`).join('\n');

async function rotaryExperiment(label, handles) {
  const records = rotaryRecords(handles);
  const stableCorpus = render(records);
  const expected = rotaryNeedles.map((_, i) => records[i * 5 + 2].handle);
  const churned = [];
  const stable = [];

  // Churned controls deliberately rotate record order, defeating one shared
  // long prefix while preserving identical semantic material.
  for (let i = 0; i < rotaryNeedles.length; i += 1) {
    const rotated = [...records.slice(i + 1), ...records.slice(0, i + 1)];
    const prompt = `Read the registry and return the ONE handle whose record reports ${rotaryNeedles[i][0]}. Return {"points":["..."]}.\n\n${render(rotated)}`;
    const response = await ask(prompt, pointSchema, 96);
    churned.push({ query: rotaryNeedles[i][0], expected: expected[i], actual: response.parsed?.points ?? null, pass: setEqual(response.parsed?.points, [expected[i]]), ...response });
  }
  // Put the complete material before the changing question so requests share
  // the largest possible exact prefix.
  const prefix = `MATERIAL REGISTRY — use bracketed handles only.\n${stableCorpus}\n\nINSPECTION QUESTION: `;
  for (let i = 0; i < rotaryNeedles.length; i += 1) {
    const prompt = `${prefix}Return the ONE handle whose record reports ${rotaryNeedles[i][0]}. Return {"points":["..."]}.`;
    const response = await ask(prompt, pointSchema, 96);
    stable.push({ query: rotaryNeedles[i][0], expected: expected[i], actual: response.parsed?.points ?? null, pass: setEqual(response.parsed?.points, [expected[i]]), ...response });
  }
  return {
    label,
    records: records.length,
    queries: rotaryNeedles.length,
    churned,
    stable,
    summary: {
      churnedPassed: churned.filter((row) => row.pass).length,
      stablePassed: stable.filter((row) => row.pass).length,
      meanChurnedMs: mean(churned.map((row) => row.elapsedMs)),
      meanStableMs: mean(stable.map((row) => row.elapsedMs)),
      stableSpeedup: Number((mean(churned.map((row) => row.elapsedMs)) / mean(stable.map((row) => row.elapsedMs))).toFixed(2)),
      firstStableMs: stable[0].elapsedMs,
      meanWarmStableMs: mean(stable.slice(1).map((row) => row.elapsedMs)),
    },
  };
}

// -------------------------------------------------------------------------
// Experiment 2: sparse semantic group testing + handle A/B
// -------------------------------------------------------------------------

function groupRecords(handles) {
  const targets = new Set([7, 39, 76, 113]);
  const records = Array.from({ length: 128 }, (_, i) => ({
    handle: handles[i],
    target: targets.has(i + 1),
    text: targets.has(i + 1)
      ? `Audit item ${i + 1}: a concealed fatigue crack crosses the load-bearing ceramic collar; quarantine this article.`
      : `Audit item ${i + 1}: the ceramic collar is intact. Inspection found no crack, fracture, or load-bearing defect.`,
  }));
  return { records, expected: records.filter((record) => record.target).map((record) => record.handle) };
}

async function groupVariant(name, handles) {
  const { records, expected } = groupRecords(handles);
  const fullPrompt = `Return ALL handles whose record reports an actual fatigue crack crossing the load-bearing ceramic collar. Explicit statements that no crack exists do not qualify. Return {"points":[...]}.\n\n${render(records)}`;
  const flat = await ask(fullPrompt, pointSchema, 192);
  const blocks = [];
  const candidates = [];
  for (let i = 0; i < records.length; i += 32) {
    const block = records.slice(i, i + 32);
    const screen = await ask(`Does this block contain at least one ACTUAL fatigue crack crossing a load-bearing ceramic collar? Negated "no crack" records do not count. Return {"present":true|false}.\n\n${render(block)}`, presentSchema, 48);
    const row = { block: `${i + 1}-${i + block.length}`, expected: block.some((record) => record.target), actual: screen.parsed?.present ?? null, pass: screen.parsed?.present === block.some((record) => record.target), ...screen };
    blocks.push(row);
    if (row.actual === true) {
      for (let j = 0; j < block.length; j += 8) {
        const lot = block.slice(j, j + 8);
        const locate = await ask(`Return ALL handles in this lot reporting an ACTUAL fatigue crack crossing the load-bearing ceramic collar. Negated records do not qualify. Return {"points":[...]}.\n\n${render(lot)}`, pointSchema, 96);
        if (Array.isArray(locate.parsed?.points)) candidates.push(...locate.parsed.points);
        blocks.push({ block: `${i + j + 1}-${i + j + lot.length}`, stage: 'locate', expected: lot.filter((record) => record.target).map((record) => record.handle), actual: locate.parsed?.points ?? null, pass: setEqual(locate.parsed?.points, lot.filter((record) => record.target).map((record) => record.handle)), ...locate });
      }
    }
  }
  const adaptive = [...new Set(candidates)];
  return {
    name,
    handleTokens: name === 'native-one-token' ? 1 : 6,
    expected,
    flat: { pass: setEqual(flat.parsed?.points, expected), actual: flat.parsed?.points ?? null, ...flat },
    adaptive: {
      pass: setEqual(adaptive, expected),
      actual: adaptive,
      calls: blocks.length,
      elapsedMs: Number(blocks.reduce((sum, row) => sum + row.elapsedMs, 0).toFixed(2)),
      promptTokens: blocks.reduce((sum, row) => sum + row.promptTokens, 0),
      stages: blocks,
    },
  };
}

async function groupTestingExperiment() {
  const gpHandles = Array.from({ length: 128 }, (_, i) => `GP-${String(i + 1).padStart(4, '0')}`);
  const native = await groupVariant('native-one-token', nativeHandles.slice(0, 128));
  const gp = await groupVariant('gp-six-token', gpHandles);
  return { native, gp };
}

// -------------------------------------------------------------------------
// Experiment 3: output-die shape
// -------------------------------------------------------------------------

const flagNames = ['mandatory', 'anomaly', 'missing', 'shutdown', 'impact', 'dependency', 'conflict'];
function dieRecords() {
  return Array.from({ length: 16 }, (_, i) => {
    const flags = Object.fromEntries(flagNames.map((name, j) => [name, (i + j * 3) % (j + 3) === 0]));
    const clauses = flagNames.map((name) => flags[name] ? `${name}=YES` : `${name}=NO`).join(' ');
    return { handle: nativeHandles[140 + i], flags, text: `Inspection ${i + 1}: ${clauses}.` };
  });
}

async function outputDieExperiment() {
  const records = dieRecords();
  const verboseSchema = {
    type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: {
      point: { type: 'string' }, ...Object.fromEntries(flagNames.map((name) => [name, { type: 'boolean' }])),
    }, required: ['point', ...flagNames], additionalProperties: false } } }, required: ['rows'], additionalProperties: false,
  };
  const columnSchema = {
    type: 'object', properties: Object.fromEntries(flagNames.map((name) => [name, { type: 'array', items: { type: 'string' } }])), required: flagNames, additionalProperties: false,
  };
  const bitSchema = {
    type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { point: { type: 'string' }, bits: { type: 'string' } }, required: ['point', 'bits'], additionalProperties: false } } }, required: ['rows'], additionalProperties: false,
  };
  const material = render(records);
  const definitions = `Flags in order: ${flagNames.join(', ')}. Read explicit YES/NO values only.`;
  const verbose = await ask(`${definitions} Return ONLY a JSON object with this shape and no markdown: {"rows":[{"point":"HANDLE","mandatory":true,"anomaly":false,"missing":false,"shutdown":false,"impact":false,"dependency":false,"conflict":false}]}. Include exactly one row for every point.\n\n${material}`, verboseSchema, 1536);
  const columns = await ask(`${definitions} Return ONLY a JSON object with no markdown. It must have exactly seven keys, each mapped to an array of handles whose flag is YES: {"mandatory":[],"anomaly":[],"missing":[],"shutdown":[],"impact":[],"dependency":[],"conflict":[]}.\n\n${material}`, columnSchema, 768);
  const bits = await ask(`${definitions} Return ONLY a JSON object with this shape and no markdown: {"rows":[{"point":"HANDLE","bits":"1000001"}]}. Include exactly one point and seven-character bit string per source record.\n\n${material}`, bitSchema, 768);
  const expectedColumns = Object.fromEntries(flagNames.map((name) => [name, records.filter((record) => record.flags[name]).map((record) => record.handle)]));
  const verbosePass = Array.isArray(verbose.parsed?.rows) && verbose.parsed.rows.length === records.length && verbose.parsed.rows.every((row) => {
    const record = records.find((item) => item.handle === row.point);
    return record && flagNames.every((name) => row[name] === record.flags[name]);
  });
  const columnFirstPass = columns.parsed && flagNames.every((name) => setEqual(columns.parsed[name], expectedColumns[name]));
  const columnRepair = columns.parsed ? null : repairColumnJson(columns.raw);
  const canonicalColumns = columns.parsed ?? columnRepair?.parsed ?? null;
  const columnPass = canonicalColumns && flagNames.every((name) => setEqual(canonicalColumns[name], expectedColumns[name]));
  const bitPass = Array.isArray(bits.parsed?.rows) && bits.parsed.rows.length === records.length && bits.parsed.rows.every((row) => {
    const record = records.find((item) => item.handle === row.point);
    return record && row.bits === flagNames.map((name) => record.flags[name] ? '1' : '0').join('');
  });
  return {
    records: records.length,
    decisions: records.length * flagNames.length,
    verbose: { pass: verbosePass, ...verbose },
    columns: {
      pass: columnPass,
      firstPass: Boolean(columnFirstPass),
      repaired: Boolean(columnRepair && columnPass),
      repair: columnRepair?.repair ?? null,
      canonical: canonicalColumns,
      ...columns,
    },
    bits: { pass: bitPass, ...bits },
  };
}

const startedAt = new Date().toISOString();
const gpRotaryHandles = Array.from({ length: 72 }, (_, i) => `GP-${String(i + 1).padStart(4, '0')}`);
const rotary = {
  native: await rotaryExperiment('native-one-token', nativeHandles.slice(0, 72)),
  gp: await rotaryExperiment('gp-six-token', gpRotaryHandles),
};
const groupTesting = await groupTestingExperiment();
const outputDies = await outputDieExperiment();
const report = {
  schema: 'bantam.factory.diffusiongemma-capability-lab.v1',
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint,
  model,
  handleRack: { path: handlePath, selected: rack.selected, gpTokens: rack.comparison['GP-0001'], nativeTokens: 1 },
  summary: {
    rotary: { native: rotary.native.summary, gp: rotary.gp.summary },
    groupTesting: {
      nativeFlat: groupTesting.native.flat.pass,
      nativeAdaptive: groupTesting.native.adaptive.pass,
      gpFlat: groupTesting.gp.flat.pass,
      gpAdaptive: groupTesting.gp.adaptive.pass,
    },
    outputDies: {
      verbose: outputDies.verbose.pass,
      columns: outputDies.columns.pass,
      columnsFirstPass: outputDies.columns.firstPass,
      columnsRepaired: outputDies.columns.repaired,
      bits: outputDies.bits.pass,
    },
  },
  rotary,
  groupTesting,
  outputDies,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`capability evidence: ${output}`);
