#!/usr/bin/env node
// Offline, public-only publication packaging. Never runs contenders or judges.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {publicShowcaseData} from './factory-showcase.mjs';
import {PUBLIC_FACTORY_CARDS} from './factory-card-catalog.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const CARD_IDS = ['receipt-reducer', 'snapshot-drift', 'job-planner'];
const COUNTERS = ['inputTokens', 'outputTokens', 'cacheHitTokens', 'freshInputTokens'];
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const PUBLIC_MODELS = {
  'bantam-local-27b': 'Qwen 27B · same local weights',
  'deepseek-local-27b': 'Qwen 27B · same local weights',
  opencode: 'Qwen 27B · same local weights',
  hermes: 'Qwen 27B · same local weights',
  'codex-astra': 'GPT-6 Astra · native CLI',
  'bantam-codex-astra': 'GPT-6 Astra · wrapped CLI',
};
const LOCAL_ARMS = new Set(['bantam-local-27b', 'deepseek-local-27b', 'opencode', 'hermes']);
const LOCAL_MODELS = new Set(['Qwen 27B · same local weights', 'Qwen 27B · same local model',
  'Tiel 35B-A3B · same local model', 'Selected local model · same endpoint']);

function validateShape(raw) {
  if (!record(raw) || raw.schema !== 'bantam.factory-showcase.v1' || raw.mode !== 'public'
      || raw.privacy?.redacted !== true || raw.privacy?.rawEvidenceIncluded !== false)
    throw Error('input must be the explicitly redacted public showcase, never a private evidence package');
  if (!Array.isArray(raw.series) || raw.series.length < 1 || raw.series.length > 12)
    throw Error('invalid public series count');
  for (const series of raw.series) {
    if (!record(series) || !['comparison', 'variant'].includes(series.kind)
        || !Array.isArray(series.cards) || !series.cards.length || series.cards.length > 200)
      throw Error('invalid public series');
    const identities = new Set();
    for (const card of series.cards) {
      if (!record(card) || !Object.hasOwn(PUBLIC_FACTORY_CARDS,card.card) || !Number.isSafeInteger(card.repeat)
          || card.repeat < 1 || card.repeat > 100 || !Array.isArray(card.rows)
          || !card.rows.length || card.rows.length > 12)
        throw Error('invalid public work order');
      const identity = `${card.card}/${card.repeat}`;
      if (identities.has(identity)) throw Error('duplicate public work order');
      identities.add(identity);
      const arms = new Set();
      for (const row of card.rows) {
        if (!record(row) || typeof row.arm !== 'string' || arms.has(row.arm))
          throw Error('invalid or duplicate public contender');
        arms.add(row.arm);
        // The projection replaces display labels. Check the actual input
        // identity first so that replacement cannot erase a contradiction and
        // manufacture a same-model claim from different recorded weights.
        if (Object.hasOwn(PUBLIC_MODELS, row.arm) && (LOCAL_ARMS.has(row.arm)
          ? !LOCAL_MODELS.has(row.model) : row.model !== PUBLIC_MODELS[row.arm]))
          throw Error('contradictory public model identity');
        if (!record(row.accounting) || !record(row.accounting.full)
            || !Array.isArray(row.tokenUpdates) || row.tokenUpdates.length > 10000)
          throw Error('invalid public accounting');
        for (const field of COUNTERS) {
          if (row.accounting.full[field] !== null && !safeCount(row.accounting.full[field]))
            throw Error('token counts must be nonnegative integers or explicit unknowns');
        }
        if (row.wallMs !== null && (!Number.isFinite(row.wallMs) || row.wallMs < 0))
          throw Error('invalid recorded wall time');
        for (const field of ['groupsPassed', 'groupsTotal', 'protectedChanges']) {
          if (row[field] !== null && !safeCount(row[field])) throw Error('invalid acceptance count');
        }
        if (row.groupsPassed !== null && row.groupsTotal !== null && row.groupsPassed > row.groupsTotal)
          throw Error('acceptance count exceeds total');
        let previous = -1;
        for (const update of row.tokenUpdates) {
          if (!record(update) || !Number.isFinite(update.t) || update.t < 0 || update.t < previous)
            throw Error('receipt clocks must be nonnegative and ordered');
          previous = update.t;
          for (const field of COUNTERS) {
            if (update[field] != null && !safeCount(update[field])) throw Error('invalid receipt counter');
          }
        }
      }
    }
  }
}

function strictPass(row) {
  return row?.recorded === true && row.outcome === 'PASS'
    && row.accepted === true && row.completed === true
    && Number.isFinite(row.wallMs) && row.wallMs > 0
    && row.publicExit === 0 && row.hiddenExit === 0 && row.protectedChanges === 0
    && row.groupsTotal > 0 && row.groupsPassed === row.groupsTotal;
}

// Compute a cohort claim, not a fastest-row selection. Each task must have one
// recorded repeat and successful completion by BOTH same-model systems.
export function launchComparison(series) {
  const cohort = series.find(item => item.kind === 'comparison');
  if (!cohort || cohort.complete !== true || cohort.cards.length !== CARD_IDS.length
      || !CARD_IDS.every(id => cohort.cards.some(card => card.card === id && card.repeat === 1))) return null;
  let bantamWallMs = 0, deepseekWallMs = 0;
  for (const card of cohort.cards) {
    const bantam = card.rows.find(row => row.arm === 'bantam-local-27b');
    const deepseek = card.rows.find(row => row.arm === 'deepseek-local-27b');
    if (!strictPass(bantam) || !strictPass(deepseek) || bantam.model !== deepseek.model) return null;
    bantamWallMs += bantam.wallMs;
    deepseekWallMs += deepseek.wallMs;
  }
  if (!Number.isFinite(bantamWallMs) || !Number.isFinite(deepseekWallMs)) return null;
  return {seriesId: cohort.id, lessTimePercent: 100 * (1 - bantamWallMs / deepseekWallMs),
    bantamWallMs, deepseekWallMs, cards: cohort.cards.length, repeatCount: 1};
}

export function buildLaunchData(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (source.length > MAX_SOURCE_BYTES) throw Error('public source exceeds the 4 MiB limit');
  const raw = JSON.parse(source.toString('utf8'));
  validateShape(raw);
  // Re-project independently even though this source claims to be public.
  // No arbitrary labels, injected properties, paths or evidence are copied.
  const clean = publicShowcaseData(raw);
  const latest = [...clean.series].reverse().find(series => series.kind === 'variant');
  const latestCard = latest?.cards.find(card => card.rows.some(row => row.recorded));
  return {schema: 'bantam.launch-fight-card.v1', generatedAt: clean.generatedAt,
    source: {sha256: digest(source), schema: clean.schema}, comparison: launchComparison(clean.series),
    spotlight: latestCard ? {seriesId: latest.id, cardId: latestCard.id} : null,
    series: clean.series};
}

export async function writeLaunchPackage({input, output, browser = null, presentation = 'comparison'}) {
  if (!['comparison','qualification'].includes(presentation)) throw Error('presentation must be comparison or qualification');
  if (!path.isAbsolute(input ?? '') || !path.isAbsolute(output ?? '') || fs.existsSync(output))
    throw Error('input and a fresh output directory must be absolute paths');
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES)
    throw Error('input must be a bounded regular public JSON file');
  const data = buildLaunchData(fs.readFileSync(input));
  if (browser !== null && !path.isAbsolute(browser)) throw Error('browser executable must be an absolute path');
  const {renderLaunchPage, renderShareCard} = await import('./factory-launch-page.mjs');
  const files = new Map([
    ['index.html', renderLaunchPage(data, {previewImage: browser ? 'share-card.png' : 'share-card.svg', presentation})],
    ['fight-card.json', JSON.stringify(data, null, 2) + '\n'],
    ['share-card.svg', renderShareCard(data, {presentation})],
  ]);
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.mkdirSync(output);
  for (const [file, content] of files) fs.writeFileSync(path.join(output, file), content, {flag: 'wx'});
  if (browser) {
    // Render our code-native vector preview, not an arbitrary URL or private
    // page. Own profile only; no shared browser or GPU acceleration is used.
    const {captureLaunchImage} = await import('./factory-launch-browser.mjs');
    await captureLaunchImage({browser, file: path.join(output, 'share-card.svg'), output: path.join(output, 'share-card.png')});
    const png = fs.readFileSync(path.join(output, 'share-card.png'));
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        || png.readUInt32BE(16) !== 1200 || png.readUInt32BE(20) !== 630)
      throw Error('browser did not render the required 1200×630 PNG');
    files.set('share-card.png', png);
  }
  const manifest = {schema: 'bantam.launch-package.v1', public: true, redacted: true, presentation,
    rawEvidenceIncluded: false, source: data.source,
    files: [...files].map(([file, content]) => ({path: file, bytes: Buffer.byteLength(content), sha256: digest(content)}))};
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  return {output: path.join(output, 'index.html'), files: manifest.files, public: true};
}

export function parseLaunchArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const key = {'--input': 'input', '--output': 'output', '--browser': 'browser', '--presentation':'presentation'}[args[i]];
    if (!key || Object.hasOwn(parsed, key) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw Error('usage: factory-launch.mjs --input ABS_PUBLIC_SHOWCASE_JSON --output ABS_FRESH_DIRECTORY [--browser ABS_CHROMIUM] [--presentation comparison|qualification]');
    parsed[key] = args[++i];
  }
  if (!parsed.input || !parsed.output) throw Error('both --input and --output are required');
  if (parsed.presentation && !['comparison','qualification'].includes(parsed.presentation)) throw Error('invalid presentation');
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await writeLaunchPackage(parseLaunchArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
