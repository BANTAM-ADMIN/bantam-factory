import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import {buildLaunchData, launchComparison, parseLaunchArgs, writeLaunchPackage} from '../scripts/factory-launch.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const counters = {inputTokens: 100, outputTokens: 10, cacheHitTokens: 75, freshInputTokens: 25};
function row(arm, wallMs = 1000) {
  return {arm, model: arm === 'bantam-local-variant' ? 'Tiel 35B-A3B · IQ4_XS' : 'Qwen 27B · same local weights',
    recorded: true, outcome: 'PASS', accepted: true, completed: true, wallMs,
    groupsPassed: 5, groupsTotal: 5, publicExit: 0, hiddenExit: 0, protectedChanges: 0,
    accounting: {full: {...counters}, subset: null, complete: true, requests: 2, measuredRequests: 2},
    tokenUpdates: [{t: 500, ...counters}]};
}
function fixture() {
  return {schema: 'bantam.factory-showcase.v1', mode: 'public', generatedAt: '2026-09-07T00:00:00.000Z',
    privacy: {redacted: true, rawEvidenceIncluded: false}, series: [
      {kind: 'comparison', complete: true, cards: ['receipt-reducer', 'snapshot-drift', 'job-planner'].map(card =>
        ({card, repeat: 1, rows: [row('bantam-local-27b'), row('deepseek-local-27b', 2000)]}))},
      {kind: 'variant', complete: true, cards: [{card: 'snapshot-drift', repeat: 1, rows: [row('bantam-local-variant', 3000)]}]},
    ]};
}
const build = raw => buildLaunchData(JSON.stringify(raw));

test('same-model headline is computed from every frozen task, not the fastest selected row', () => {
  const result = build(fixture());
  assert.deepEqual(result.comparison, {seriesId: 'series-1', lessTimePercent: 50,
    bantamWallMs: 3000, deepseekWallMs: 6000, cards: 3, repeatCount: 1});
  assert.deepEqual(result.spotlight, {seriesId: 'series-2', cardId: 's2-snapshot-drift-r1'});
  assert.equal(result.series.length, 2);
  assert.equal(result.source.sha256, sha(JSON.stringify(fixture())));
});

test('headline is withheld for incomplete, failed, ambiguous or different-model cohorts', () => {
  const mutations = [
    data => { data.series[0].complete = false; },
    data => { data.series[0].cards.pop(); },
    data => { data.series[0].cards[0].repeat = 2; },
    data => { data.series[0].cards[0].rows[1].outcome = 'OUTPUT_ONLY'; },
    data => { data.series[0].cards[0].rows[1].completed = false; },
    data => { data.series[0].cards[0].rows[1].accepted = false; },
    data => { data.series[0].cards[0].rows[1].protectedChanges = 1; },
    data => { data.series[0].cards[0].rows[1].publicExit = 1; },
    data => { data.series[0].cards[0].rows[1].wallMs = 0; },
    data => { data.series[0].cards[0].rows[1].groupsPassed = 4; },
  ];
  for (const mutate of mutations) { const raw = fixture(); mutate(raw); assert.equal(build(raw).comparison, null); }
  const projected = build(fixture());
  projected.series[0].cards[0].rows[1].model = 'different weights';
  assert.equal(launchComparison(projected.series), null);
});

test('a slower BANTAM does not acquire a positive speed claim', () => {
  const raw = fixture();
  for (const card of raw.series[0].cards) card.rows[0].wallMs = 3000;
  assert.equal(build(raw).comparison.lessTimePercent, -50);
});

test('contradictory source model identity cannot be erased by public reprojection', () => {
  const raw = fixture();
  raw.series[0].cards[0].rows[1].model = 'Actually different local weights';
  assert.throws(() => build(raw), /contradictory public model identity/);
});

test('the latest local attempt is retained even when it failed; no best-run fallback', () => {
  const raw = fixture(), later = structuredClone(raw.series[1]);
  later.cards[0].rows[0].outcome = 'FAIL';
  later.cards[0].rows[0].accepted = false;
  later.cards[0].rows[0].groupsPassed = 4;
  raw.series.push(later);
  const result = build(raw);
  assert.deepEqual(result.spotlight, {seriesId: 'series-3', cardId: 's3-snapshot-drift-r1'});
  assert.equal(result.series[2].cards[0].rows[0].outcome, 'FAIL');
  assert.equal(result.series[1].cards[0].rows[0].outcome, 'PASS');
});

test('private inputs are refused, and injected strings in nominally public inputs are stripped', () => {
  for (const mutation of [raw => {raw.mode = 'private';}, raw => {raw.privacy.redacted = false;},
    raw => {raw.privacy.rawEvidenceIncluded = true;}]) {
    const raw = fixture(); mutation(raw); assert.throws(() => build(raw), /redacted public showcase/);
  }
  const raw = fixture(), secret = 'PRIVATE_SENTINEL</script><img src=https://secret.invalid>';
  raw.provenance = secret; raw.series[0].title = secret;
  const first = raw.series[0].cards[0].rows[0];
  first.label = secret; first.events = [{detail: secret}]; first.inventory = [{path: secret}];
  first.accounting.full.secret = secret; first.tokenUpdates[0].prompt = secret;
  assert.ok(!JSON.stringify(build(raw)).includes('PRIVATE_SENTINEL'));
});

test('incomplete accounting remains unknown with an explicitly separate measured subset', () => {
  const raw = fixture(), first = raw.series[0].cards[0].rows[0];
  first.accounting.full = Object.fromEntries(Object.keys(counters).map(key => [key, null]));
  first.accounting.subset = {...counters}; first.accounting.complete = false;
  first.accounting.measuredRequests = 1;
  const projected = build(raw).series[0].cards[0].rows[0].accounting;
  assert.deepEqual(projected.full, first.accounting.full);
  assert.deepEqual(projected.subset, counters);
  assert.equal(projected.complete, false);
  assert.equal(projected.measuredRequests, 1);
  assert.equal(projected.requests, 2);
});

test('malformed counts, duplicate rows and unordered receipt clocks fail closed', () => {
  const mutations = [
    raw => raw.series[0].cards.push(structuredClone(raw.series[0].cards[0])),
    raw => raw.series[0].cards[0].rows.push(structuredClone(raw.series[0].cards[0].rows[0])),
    raw => {raw.series[0].cards[0].rows[0].groupsPassed = 6;},
    raw => {raw.series[0].cards[0].rows[0].accounting.full.inputTokens = -1;},
    raw => {raw.series[0].cards[0].rows[0].accounting.full.inputTokens = 1.5;},
    raw => raw.series[0].cards[0].rows[0].tokenUpdates.push({t: 100, ...counters}),
  ];
  for (const mutate of mutations) {const raw = fixture(); mutate(raw); assert.throws(() => build(raw));}
  assert.throws(() => buildLaunchData(' '.repeat(4 * 1024 * 1024 + 1)), /4 MiB/);
});

test('CLI accepts only explicit input/fresh output and rejects duplicates or missing values', () => {
  assert.deepEqual(parseLaunchArgs(['--input', '/a.json', '--output', '/fresh']), {input: '/a.json', output: '/fresh'});
  for (const args of [[], ['--input'], ['--input', '/a', '--input', '/b'], ['--private', '/a'], ['--output', '/a']])
    assert.throws(() => parseLaunchArgs(args));
});

test('publication is self-contained, hashed, refuses overwrite and never changes source', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-launch-package-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const input = path.join(root, 'source.json'), output = path.join(root, 'public');
  const original = JSON.stringify(fixture()); fs.writeFileSync(input, original);
  const result = await writeLaunchPackage({input, output});
  assert.equal(result.public, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(output, 'package.json')));
  assert.equal(receipt.redacted, true); assert.equal(receipt.rawEvidenceIncluded, false);
  for (const file of receipt.files) {
    const bytes = fs.readFileSync(path.join(output, file.path));
    assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256);
  }
  assert.equal(fs.readFileSync(input, 'utf8'), original);
  await assert.rejects(writeLaunchPackage({input, output}), /fresh output/);
  assert.equal(fs.readFileSync(input, 'utf8'), original);
  const link = path.join(root, 'linked.json'); fs.symlinkSync(input, link);
  await assert.rejects(writeLaunchPackage({input: link, output: path.join(root, 'other')}), /regular public JSON/);
});
