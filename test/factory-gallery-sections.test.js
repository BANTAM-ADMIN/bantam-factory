import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {publicShowcaseData} from '../scripts/factory-showcase.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {buildFightGallery, renderFightGallery, LAUNCH_CARDS, LAUNCH_SECTIONS} from '../scripts/factory-fight-gallery.mjs';

// One flat grid was legible at eight work orders. Past that the page needs the
// same structure the kits already have, so a reader can find a card by the kind
// of work it is rather than scrolling a wall of equal-weight tiles.
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function writeCard(dir, id) {
  const share = path.join(dir, 'share');
  fs.mkdirSync(share, {recursive: true});
  const row = arm => ({arm, model: 'Qwen 27B · same local weights', recorded: true, outcome: 'PASS',
    accepted: true, completed: true, wallMs: 1000, groupsPassed: 5, groupsTotal: 5,
    publicExit: 0, hiddenExit: 0, protectedChanges: 0, tokenUpdates: [],
    accounting: {complete: true, full: {inputTokens: null, outputTokens: null, cacheHitTokens: null, freshInputTokens: null}}});
  const source = JSON.stringify(publicShowcaseData({generatedAt: '2026-09-08T12:00:00Z',
    series: [{kind: 'comparison', complete: true, cards: [{card: id, repeat: 1, rows: [row('bantam-local-27b')]}]}]}));
  fs.writeFileSync(path.join(dir, 'showcase.json'), source);
  fs.writeFileSync(path.join(dir, 'README.md'), 'notes');
  fs.writeFileSync(path.join(dir, 'index.html'), 'replay');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({schema: 'bantam.factory-showcase-package.v1', private: false, redacted: true,
    files: [['showcase.json', source], ['index.html', 'replay']].map(([p, b]) => ({path: p, bytes: Buffer.byteLength(b), sha256: sha(b)}))}));
  const files = [['index.html', '<!doctype html><title>t</title>'], ['share-card.png', Buffer.from('png')],
    ['share-card.svg', '<svg/>'], ['fight-card.json', JSON.stringify(buildLaunchData(source))]];
  for (const [name, bytes] of files) fs.writeFileSync(path.join(share, name), bytes);
  fs.writeFileSync(path.join(share, 'package.json'), JSON.stringify({schema: 'bantam.launch-package.v1', public: true, redacted: true,
    rawEvidenceIncluded: false, source: {sha256: sha(source)},
    files: files.map(([n, b]) => ({path: n, bytes: Buffer.byteLength(b), sha256: sha(b)}))}));
}

function fullGallery(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-sections-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const id of LAUNCH_CARDS) writeCard(path.join(root, id), id);
  return root;
}

test('every published card belongs to exactly one declared section', () => {
  assert.ok(Array.isArray(LAUNCH_SECTIONS) && LAUNCH_SECTIONS.length >= 2, 'sections are declared');
  const claimed = LAUNCH_SECTIONS.flatMap(section => section.cards);
  assert.deepEqual([...claimed].sort(), [...LAUNCH_CARDS].sort(), 'sections cover the published list exactly');
  assert.equal(new Set(claimed).size, claimed.length, 'no card appears twice');
  for (const section of LAUNCH_SECTIONS) {
    assert.ok(section.title && typeof section.title === 'string', 'each section is titled');
    assert.ok(section.blurb && typeof section.blurb === 'string', 'each section says what it is for');
  }
});

test('the page renders one titled grid per section, in section order', t => {
  const html = renderFightGallery(buildFightGallery(fullGallery(t)));
  let cursor = -1;
  for (const section of LAUNCH_SECTIONS) {
    const at = html.indexOf(section.title);
    assert.ok(at > cursor, `${section.title} appears after the previous section`);
    cursor = at;
  }
  assert.equal((html.match(/<section class="grid"/g) || []).length, LAUNCH_SECTIONS.length,
    'one grid per section rather than a single flat grid');
});

test('card numbering restarts inside each section', t => {
  const html = renderFightGallery(buildFightGallery(fullGallery(t)));
  for (const section of LAUNCH_SECTIONS) {
    assert.ok(html.includes(`01 / ${String(section.cards.length).padStart(2, '0')}`),
      `${section.title} numbers its own cards`);
  }
});

test('a section with nothing recorded is still announced', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-sections-empty-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  writeCard(path.join(root, LAUNCH_CARDS[0]), LAUNCH_CARDS[0]);
  const html = renderFightGallery(buildFightGallery(root));
  for (const section of LAUNCH_SECTIONS) assert.ok(html.includes(section.title), section.title);
  assert.match(html, /Not published yet/);
});
