import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { packageFactoryFight } from '../scripts/factory-fight-package.mjs';
import { writeFightCardExport, verifyFightCardAttachments } from '../scripts/factory-fight-export.mjs';
import { writeFactoryReplay } from '../scripts/factory-fight-replay.mjs';

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-package-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'source'), destination = path.join(base, 'package');
  const task = 'Synthetic package test, never a scored model run.\n';
  const row = { card: 'receipt-reducer', arm: 'bantam-local-27b', repeat: 1, outcome: 'PASS', pass: true,
    candidatePass: true, processCompleted: true, acceptedCompletion: true, wallMs: 1000,
    exitCode: 0, timedOut: false, aborted: false, bufferExceeded: false, graderTimedOut: false,
    startedAt: '2026-09-06T12:00:00Z', operatorInterventions: 0, taskSha256: sha(task), materialSeal: {},
    finalFiles: { 'product.js': sha('example') }, tampered: [],
    grade: { schema: 'bantam.factory-card-grade.v1', card: 'receipt-reducer', pass: true, groups: [{ name: 'example', pass: true }] },
    usage: { inputTokens: 10, outputTokens: 2, cacheHitTokens: 7, freshInputTokens: 3 }, publicExit: 0, hiddenExit: 0 };
  const manifest = { schema: 'bantam.factory-fights.v1', startedAt: row.startedAt, finishedAt: '2026-09-06T12:00:02Z', complete: true,
    design: 'Synthetic packaging test.', baseCommit: 'a'.repeat(40), modelId: 'synthetic', endpoint: 'http://localhost:8085',
    limits: {}, configuration: {}, sourceSeal: {}, sourceMismatches: [], kitMismatches: [],
    kitSeal: { 'grader-support.mjs': sha('support'), 'receipt-reducer/grader.mjs': sha('grader'), 'receipt-reducer/card.json': sha('descriptor') },
    plan: [{ card: row.card, arm: row.arm, repeat: 1 }], results: [row] };
  const prefix = path.join(root, 'repeat-1/receipt-reducer/bantam-local-27b');
  write(path.join(root, 'manifest.json'), manifest); write(path.join(prefix, 'result.json'), row);
  write(path.join(prefix, 'task.md'), task); write(path.join(prefix, 'ws/product.js'), 'example');
  write(path.join(prefix, 'ws/.env'), 'EXCLUDED_SECRET');
  writeFightCardExport(root); writeFactoryReplay(root);
  return { root, destination, manifest, refresh: () => { write(path.join(root, 'manifest.json'), manifest); writeFightCardExport(root); writeFactoryReplay(root); } };
}

test('package round-trip preserves exact allowlisted evidence, replay and unknowns without inference', t => {
  const f = fixture(t), result = packageFactoryFight(f.root, f.destination);
  assert.equal(result.results, 1); assert.equal(result.private, true); assert.equal(result.redacted, false);
  const index = JSON.parse(fs.readFileSync(path.join(f.destination, 'fight-card.json')));
  const archive = path.join(f.destination, 'evidence.tar.gz');
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0); assert.deepEqual(listing.stdout.trim().split('\n').sort(), index.attachments.map(x => x.path).sort());
  assert.doesNotMatch(listing.stdout, /\.env/);
  const extracted = path.join(f.destination, 'unpacked'); fs.mkdirSync(extracted);
  assert.equal(spawnSync('tar', ['-xzf', archive, '-C', extracted]).status, 0);
  assert.equal(verifyFightCardAttachments(index, extracted).verifiedAttachments, true);
  assert.equal(fs.readFileSync(path.join(f.destination, 'fight-cards.html'), 'utf8'), fs.readFileSync(path.join(f.root, 'fight-cards.html'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(f.destination, 'package.json')));
  for (const file of metadata.files) assert.equal(sha(fs.readFileSync(path.join(f.destination, file.path))), file.sha256);
  assert.match(fs.readFileSync(path.join(f.destination, 'README.md'), 'utf8'), /not a privacy-redacted public release/);
});

test('packaging never overwrites an existing destination or writes inside source evidence', t => {
  const f = fixture(t); fs.mkdirSync(f.destination); write(path.join(f.destination, 'mine'), 'preserve');
  assert.throws(() => packageFactoryFight(f.root, f.destination), /already exists/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'mine'), 'utf8'), 'preserve');
  assert.throws(() => packageFactoryFight(f.root, path.join(f.root, 'nested')), /outside source/);
  assert.throws(() => packageFactoryFight('relative', f.destination), /absolute/);
});

test('packaging refuses stale HTML and interrupted or incomplete comparisons', t => {
  const f = fixture(t); f.manifest.design = 'changed after rendering';
  write(path.join(f.root, 'manifest.json'), f.manifest); writeFightCardExport(f.root);
  assert.throws(() => packageFactoryFight(f.root, f.destination), /stale/);
  f.manifest.complete = false; f.refresh();
  assert.throws(() => packageFactoryFight(f.root, f.destination), /complete/);
  f.manifest.complete = true; f.refresh();
  write(path.join(f.root, 'INTERRUPTED.md'), 'operator stopped'); writeFightCardExport(f.root); writeFactoryReplay(f.root);
  assert.throws(() => packageFactoryFight(f.root, f.destination), /interrupted/);
});

test('packaging rejects changed or symlinked attachments and a symlinked replay', t => {
  const f = fixture(t), file = path.join(f.root, 'repeat-1/receipt-reducer/bantam-local-27b/ws/product.js');
  write(file, 'changed'); assert.throws(() => packageFactoryFight(f.root, f.destination), /mismatch/);
  write(file, 'example'); fs.unlinkSync(file); fs.symlinkSync('/etc/passwd', file);
  assert.throws(() => packageFactoryFight(f.root, f.destination), /symlink/);
  fs.unlinkSync(file); write(file, 'example');
  fs.unlinkSync(path.join(f.root, 'fight-cards.html')); fs.symlinkSync(file, path.join(f.root, 'fight-cards.html'));
  assert.throws(() => packageFactoryFight(f.root, f.destination), /regular/);
});

test('packaging rejects stale embedded evidence even when manifest and result rows are unchanged', t => {
  const f = fixture(t);
  write(path.join(f.root, 'repeat-1/receipt-reducer/bantam-local-27b/stdout.log'), 'new receipt after rendering');
  writeFightCardExport(f.root);
  assert.throws(() => packageFactoryFight(f.root, f.destination), /embedded exchange/);
  const replay = path.join(f.root, 'fight-cards.html');
  const updatedIndex = fs.readFileSync(path.join(f.root, 'fight-card.json'));
  const updatedHeader = fs.readFileSync(replay, 'utf8').replace(/(<script id="summary-data" type="application\/json">)([\s\S]*?)(<\/script>)/,
    (_, open, text, close) => {
      const summary = JSON.parse(text);
      summary.presentation.exchange = { path: 'fight-card.json', size: updatedIndex.length, sha256: sha(updatedIndex),
        encoding: 'base64', content: updatedIndex.toString('base64') };
      return open + JSON.stringify(summary).replace(/</g, '\\u003c') + close;
    });
  write(replay, updatedHeader);
  assert.throws(() => packageFactoryFight(f.root, f.destination), /embedded replay evidence/);
  writeFactoryReplay(f.root);
  const file = path.join(f.root, 'fight-cards.html');
  const html = fs.readFileSync(file, 'utf8').replace(/(type="application\/octet-stream">)H/, '$1A');
  write(file, html);
  assert.throws(() => packageFactoryFight(f.root, f.destination), /embedded replay evidence/);
});
