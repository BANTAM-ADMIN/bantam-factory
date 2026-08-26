#!/usr/bin/env node

/**
 * DiffusionGemma semantic coprocessor for Codex.
 *
 * Reads exact local source chunks, asks the fast model only which chunks are
 * materially useful for a stated task, validates issued handles, and emits a
 * provenance-preserving evidence kit. It never summarizes or rewrites source.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const option = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const query = option('query');
if (!query) throw new Error('--query is required');
const sourceRoot = resolve(option('root', 'docs/BANTAMFACTORY'));
const inputKit = option('input-kit') ? resolve(option('input-kit')) : null;
const safetyRegexSource = option('safety-regex');
const output = resolve(option('output', '.bantam/factory-benchmarks/diffusiongemma-codex-kit.json'));
const endpoint = option('endpoint', 'http://127.0.0.1:8001/v1/chat/completions');
const model = option('model', 'dg-awq');
const die = option('die', 'bits');
const rubricPath = option('rubric') ? resolve(option('rubric')) : null;
const rubric = rubricPath ? JSON.parse(await readFile(rubricPath, 'utf8')) : null;
if (die === 'matrix' && (!Array.isArray(rubric?.lanes) || rubric.lanes.length < 2)) {
  throw new Error('--die matrix requires --rubric JSON with at least two lanes');
}
const linesPerChunk = Number(option('lines-per-chunk', '20'));
const lotCharLimit = Number(option('lot-chars', '42000'));
const allowedExtensions = new Set(option('extensions', '.md,.js,.mjs,.json').split(',').map((value) => value.trim()));
const handleEvidence = JSON.parse(await readFile(resolve(option('handles', '.bantam/factory-benchmarks/diffusiongemma-handles.json')), 'utf8'));
const handles = handleEvidence.handles.map((row) => row.handle);
const lotChunkLimit = Number(option('lot-chunks', die === 'bits' || die === 'matrix' ? '8' : String(handles.length)));
const maxAttempts = Number(option('max-attempts', '3'));
const allowIncomplete = argv.includes('--allow-incomplete');
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
  throw new Error('--max-attempts must be an integer from 1 through 10');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.bantam') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.isFile() && allowedExtensions.has(extname(entry.name))) found.push(path);
  }
  return found.sort();
}

function chunkFile(path, content) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  for (let start = 0; start < lines.length; start += linesPerChunk) {
    const slice = lines.slice(start, start + linesPerChunk);
    const text = slice.join('\n').trim();
    if (!text) continue;
    chunks.push({
      chunkId: `SRC-${String(chunks.length + 1).padStart(4, '0')}`,
      path: relative(process.cwd(), path),
      startLine: start + 1,
      endLine: Math.min(start + linesPerChunk, lines.length),
      text,
      sha256: sha256(text),
    });
  }
  return chunks;
}

async function loadRootChunks(root) {
  const rootFiles = await walk(root);
  const rootChunks = [];
  for (const path of rootFiles) {
    const content = await readFile(path, 'utf8');
    const fileChunks = chunkFile(path, content);
    const prefix = relative(root, path).replaceAll('/', '-');
    fileChunks.forEach((chunk, i) => rootChunks.push({ ...chunk, chunkId: `${prefix}:${String(i + 1).padStart(4, '0')}` }));
  }
  return { files: rootFiles, chunks: rootChunks };
}

function makeLots(chunks) {
  const lots = [];
  let current = [];
  let chars = 0;
  for (const chunk of chunks) {
    const cost = chunk.text.length + chunk.path.length + 80;
    if (current.length && (chars + cost > lotCharLimit || current.length >= lotChunkLimit)) {
      lots.push(current);
      current = [];
      chars = 0;
    }
    current.push(chunk);
    chars += cost;
  }
  if (current.length) lots.push(current);
  return lots;
}

const pointSchema = {
  type: 'object',
  properties: { points: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
  required: ['points'],
  additionalProperties: false,
};

function parseJson(content) {
  try { return JSON.parse(content); } catch { /* continue */ }
  const candidate = content.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function repairBitJson(content, width) {
  const match = content.match(/^bits":"([01]+)"}?$/);
  if (!match || match[1].length !== width) return null;
  return {
    parsed: { bits: match[1] },
    repair: 'restore-missing-object-prefix-before-exact-width-bit-die',
    canonicalRaw: `{"bits":"${match[1]}"}`,
  };
}

function repairMatrixJson(content, rows, width) {
  if (!content.startsWith('rows":')) return null;
  for (const suffix of ['}', '']) {
    const canonicalRaw = `{"${content}${suffix}`;
    const parsed = parseJson(canonicalRaw);
    if (Array.isArray(parsed?.rows)
      && parsed.rows.length === rows
      && parsed.rows.every((row) => typeof row === 'string' && row.length === width && /^[01]+$/.test(row))) {
      return { parsed, repair: 'restore-missing-object-envelope-before-fixed-matrix-die', canonicalRaw };
    }
  }
  return null;
}

function canonicalHandle(value, issued) {
  if (typeof value !== 'string') return null;
  if (issued.has(value)) return value;
  const stripped = value.replace(/^[\[\]"'`\s]+|[\[\]"'`\s]+$/g, '');
  return issued.has(stripped) ? stripped : null;
}

async function inspectLot(lot, lotIndex, attempt = 1) {
  const registry = lot.map((chunk, i) => ({ ...chunk, handle: handles[i] }));
  const issued = new Set(registry.map((row) => row.handle));
  const material = registry.map((row, i) => `${die === 'bits' || die === 'matrix' ? `[SLOT ${String(i + 1).padStart(2, '0')}]` : `[${row.handle}]`} SOURCE ${row.path}:${row.startLine}-${row.endLine}\n${row.text}`).join('\n\n');
  const bitSchema = {
    type: 'object',
    properties: { bits: { type: 'string', pattern: `^[01]{${lot.length}}$` } },
    required: ['bits'],
    additionalProperties: false,
  };
  const matrixWidth = rubric?.lanes?.length ?? 0;
  const matrixSchema = {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        minItems: lot.length,
        maxItems: lot.length,
        items: { type: 'string', pattern: `^[01]{${matrixWidth}}$` },
      },
    },
    required: ['rows'],
    additionalProperties: false,
  };
  const pointPrompt = `Select every issued handle whose source chunk contains evidence materially useful for performing or checking that task. Include uncertain-but-plausibly-relevant chunks; exclude merely topical mentions without useful evidence. Do not answer the task, summarize, quote, or invent handles. Return only {"points":[...]}.`;
  const bitPrompt = `Classify every slot in order. Write 1 when the source chunk contains evidence materially useful for performing or checking the task; otherwise write 0. Favor recall for uncertain-but-plausibly-relevant evidence, but exclude merely topical mentions. Do not answer, summarize, quote, copy source identities, or skip slots. Return only {"bits":"${'0'.repeat(lot.length)}"} with exactly ${lot.length} bits, one per slot.`;
  const matrixDefinitions = rubric?.lanes?.map((lane, i) => `${i + 1}. ${lane.key}: ${lane.description}`).join('\n');
  const matrixPrompt = `Classify every slot independently against every lane below. Return one ${matrixWidth}-bit string per slot in source order; bit position follows lane order. Multiple bits may be 1. Use 1 only when the chunk performs, directly wraps, or immediately guards that lane; use 0 for mere mentions, local-variable changes, examples, and unrelated projections. Do not skip slots, copy identities, summarize, or explain.\n\nLANES:\n${matrixDefinitions}\n\nReturn only {"rows":[${Array.from({ length: lot.length }, () => `"${'0'.repeat(matrixWidth)}"`).join(',')}]} with exactly ${lot.length} rows.`;
  const workPrompt = die === 'bits' ? bitPrompt : die === 'matrix' ? matrixPrompt : pointPrompt;
  const prompt = `You are a high-recall semantic source inspector operated by a Codex agent.\n\nCODEX TASK:\n${query}\n\n${workPrompt}\n\nSOURCE RACK ${lotIndex + 1}:\n${material}`;
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 512,
      chat_template_kwargs: { enable_thinking: false },
      guided_json: die === 'bits' ? bitSchema : die === 'matrix' ? matrixSchema : pointSchema,
    }),
  });
  const rawEnvelope = await response.text();
  const elapsedMs = Number((performance.now() - started).toFixed(2));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawEnvelope.slice(0, 500)}`);
  const envelope = JSON.parse(rawEnvelope);
  const raw = envelope.choices?.[0]?.message?.content ?? '';
  const firstPassParsed = parseJson(raw);
  const repair = firstPassParsed === null
    ? die === 'bits'
      ? repairBitJson(raw, lot.length)
      : die === 'matrix'
        ? repairMatrixJson(raw, lot.length, matrixWidth)
        : null
    : null;
  const parsed = firstPassParsed ?? repair?.parsed ?? null;
  const emitted = die === 'bits'
    ? parsed?.bits ?? null
    : die === 'matrix'
      ? parsed?.rows ?? null
      : Array.isArray(parsed?.points) ? parsed.points : [];
  const bitPass = die === 'bits' && typeof emitted === 'string' && emitted.length === lot.length && /^[01]+$/.test(emitted);
  const matrixPass = die === 'matrix'
    && Array.isArray(emitted)
    && emitted.length === lot.length
    && emitted.every((row) => typeof row === 'string' && row.length === matrixWidth && /^[01]+$/.test(row));
  const canonical = die === 'points' ? emitted.map((value) => canonicalHandle(value, issued)) : [];
  const unknown = die === 'points' ? emitted.filter((_, i) => canonical[i] === null) : [];
  const diePass = die === 'bits' ? bitPass : die === 'matrix' ? matrixPass : parsed !== null && unknown.length === 0;
  if (!diePass && attempt < maxAttempts) {
    const retried = await inspectLot(lot, lotIndex, attempt + 1);
    return {
      ...retried,
      attempts: retried.attempts + 1,
      retries: retried.retries + 1,
      firstPassParse: firstPassParsed !== null,
      elapsedMs: Number((elapsedMs + retried.elapsedMs).toFixed(2)),
      promptTokens: (envelope.usage?.prompt_tokens ?? 0) + retried.promptTokens,
      completionTokens: (envelope.usage?.completion_tokens ?? 0) + retried.completionTokens,
      initialAttempt: { raw, parsed: firstPassParsed, repair: repair?.repair ?? null, diePass },
    };
  }
  const selectedRows = die === 'bits'
    ? bitPass ? registry.filter((_, i) => emitted[i] === '1') : []
    : die === 'matrix'
      ? matrixPass ? registry.filter((_, i) => emitted[i].includes('1')) : []
    : [...new Set(canonical.filter(Boolean))].map((handle) => registry.find((candidate) => candidate.handle === handle));
  const selected = selectedRows.map((row) => ({
    ...lot.find((chunk) => chunk.sha256 === row.sha256),
    point: `LOT-${String(lotIndex + 1).padStart(3, '0')}:${die === 'bits' ? `SLOT-${String(registry.indexOf(row) + 1).padStart(2, '0')}` : row.handle}`,
    emittedHandle: die === 'points' ? row.handle : null,
    lanes: die === 'matrix'
      ? Object.fromEntries(rubric.lanes.map((lane, laneIndex) => [lane.key, emitted[registry.indexOf(row)][laneIndex] === '1']))
      : null,
  }));
  const classified = die === 'matrix' && matrixPass
    ? registry.map((row, rowIndex) => ({
      ...lot.find((chunk) => chunk.sha256 === row.sha256),
      point: `LOT-${String(lotIndex + 1).padStart(3, '0')}:SLOT-${String(rowIndex + 1).padStart(2, '0')}`,
      emittedHandle: null,
      lanes: Object.fromEntries(rubric.lanes.map((lane, laneIndex) => [lane.key, emitted[rowIndex][laneIndex] === '1'])),
    }))
    : selected;
  return {
    lot: lotIndex + 1,
    chunks: lot.length,
    sourceChars: lot.reduce((sum, chunk) => sum + chunk.text.length, 0),
    selected,
    classified,
    emitted,
    unknown,
    parsePass: parsed !== null,
    firstPassParse: firstPassParsed !== null,
    repaired: repair !== null,
    repair: repair?.repair ?? null,
    canonicalRaw: repair?.canonicalRaw ?? raw,
    diePass,
    membershipPass: unknown.length === 0,
    elapsedMs,
    promptTokens: envelope.usage?.prompt_tokens ?? 0,
    completionTokens: envelope.usage?.completion_tokens ?? 0,
    attempts: 1,
    retries: 0,
    raw,
  };
}

const startedAt = new Date().toISOString();
let files;
let chunks;
if (inputKit) {
  const upstream = JSON.parse(await readFile(inputKit, 'utf8'));
  if (!Array.isArray(upstream.selected)) throw new Error('--input-kit must contain a selected array');
  const unique = new Map(upstream.selected.map((chunk) => [`${chunk.path}:${chunk.startLine}-${chunk.endLine}:${chunk.sha256}`, chunk]));
  chunks = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  files = [...new Set(chunks.map((chunk) => chunk.path))];
} else {
  ({ files, chunks } = await loadRootChunks(sourceRoot));
}
const lots = makeLots(chunks);
const inspections = [];
for (let i = 0; i < lots.length; i += 1) inspections.push(await inspectLot(lots[i], i));
const failedInspections = inspections.filter((inspection) => !inspection.diePass);
if (failedInspections.length && !allowIncomplete) {
  const failedLots = failedInspections.map((inspection) => inspection.lot).join(', ');
  throw new Error(`semantic die failed after ${maxAttempts} attempts for lot(s) ${failedLots}; no incomplete evidence kit was written (pass --allow-incomplete only for diagnostic work)`);
}
const modelSelected = inspections.flatMap((inspection) => inspection.selected);
const classified = die === 'matrix' ? inspections.flatMap((inspection) => inspection.classified) : modelSelected;
let safetySelected = [];
if (safetyRegexSource) {
  const safetyRegex = new RegExp(safetyRegexSource, 'i');
  const safetyCorpus = inputKit ? (await loadRootChunks(sourceRoot)).chunks : chunks;
  safetySelected = safetyCorpus.filter((chunk) => safetyRegex.test(chunk.text)).map((chunk) => ({
    point: `LEXICAL:${chunk.chunkId}`,
    emittedHandle: null,
    ...chunk,
  }));
}
const selectedMap = new Map([...modelSelected, ...safetySelected].map((chunk) => [`${chunk.path}:${chunk.startLine}-${chunk.endLine}:${chunk.sha256}`, chunk]));
const selected = [...selectedMap.values()].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
const totalChars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
const selectedChars = selected.reduce((sum, chunk) => sum + chunk.text.length, 0);
const report = {
  schema: 'bantam.factory.diffusiongemma-codex-coprocessor.v1',
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint,
  model,
  query,
  sourceRoot,
  inputKit,
  sourceFingerprint: sha256(chunks.map((chunk) => `${chunk.path}:${chunk.startLine}:${chunk.endLine}:${chunk.sha256}`).join('\n')),
  fixture: { die, rubricPath, rubric, linesPerChunk, lotCharLimit, lotChunkLimit, maxAttempts, allowIncomplete, extensions: [...allowedExtensions], safetyRegex: safetyRegexSource },
  summary: {
    files: files.length,
    chunks: chunks.length,
    lots: lots.length,
    modelSelectedChunks: modelSelected.length,
    safetySelectedChunks: safetySelected.length,
    selectedChunks: selected.length,
    classifiedChunks: classified.length,
    totalChars,
    selectedChars,
    materialReduction: Number((1 - selectedChars / totalChars).toFixed(4)),
    elapsedMs: Number(inspections.reduce((sum, row) => sum + row.elapsedMs, 0).toFixed(2)),
    promptTokens: inspections.reduce((sum, row) => sum + row.promptTokens, 0),
    completionTokens: inspections.reduce((sum, row) => sum + row.completionTokens, 0),
    parseFailures: inspections.filter((row) => !row.parsePass).length,
    firstPassParseFailures: inspections.filter((row) => !row.firstPassParse).length,
    repairedLots: inspections.filter((row) => row.repaired).length,
    retries: inspections.reduce((sum, row) => sum + row.retries, 0),
    dieFailures: inspections.filter((row) => !row.diePass).length,
    unknownHandles: inspections.reduce((sum, row) => sum + row.unknown.length, 0),
    laneCounts: die === 'matrix'
      ? Object.fromEntries(rubric.lanes.map((lane) => [lane.key, selected.filter((chunk) => chunk.lanes?.[lane.key]).length]))
      : null,
  },
  selected,
  classified,
  inspections,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Codex evidence kit: ${output}`);
