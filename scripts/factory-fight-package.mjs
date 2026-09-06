#!/usr/bin/env node
// Local-only packaging of already-recorded evidence. No inference, candidate
// execution, upload, redaction claim, or admission of foreign factory rules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { LIMITS, verifyFightCardAttachments } from './factory-fight-export.mjs';
import { buildReplayLane } from './factory-fight-replay.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`fight-card package: ${message}`); };
function readRegular(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('expected bounded regular input file');
  return fs.readFileSync(file);
}

export function packageFactoryFight(sourceRoot, destination) {
  if (!path.isAbsolute(sourceRoot || '') || !path.isAbsolute(destination || '')) fail('use absolute source and destination paths');
  const source = fs.realpathSync(sourceRoot);
  const parent = fs.realpathSync(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const relative = path.relative(source, target);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('destination must be outside source evidence');
  try { fs.lstatSync(target); fail('destination already exists; choose a new package directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const indexBytes = readRegular(path.join(source, 'fight-card.json'), LIMITS.jsonBytes);
  const index = JSON.parse(indexBytes);
  const verified = verifyFightCardAttachments(index, source);
  if (!index.run.complete || index.run.sourceMismatches.length || index.run.kitMismatches.length) fail('launch package requires a complete, unchanged series');
  const html = readRegular(path.join(source, 'fight-cards.html'), 64 * 1024 * 1024);
  const embedded = html.toString('utf8').match(/<script id="summary-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!embedded) fail('missing replay manifest');
  const summary = JSON.parse(embedded[1]);
  const exchange = summary.presentation?.exchange;
  if (!exchange || exchange.path !== 'fight-card.json' || exchange.size !== indexBytes.length
      || exchange.sha256 !== digest(indexBytes) || exchange.encoding !== 'base64'
      || exchange.content !== indexBytes.toString('base64')) fail('stale embedded exchange download');
  const manifest = JSON.parse(readRegular(path.join(source, 'manifest.json'), LIMITS.jsonBytes));
  if (JSON.stringify(summary.manifest) !== JSON.stringify(manifest) || summary.presentation?.interruption) fail('stale or interrupted replay');
  const replayRows = summary.cards?.flatMap(card => card.lanes.map(lane => lane.result).filter(Boolean));
  const rowKey = row => `${row.repeat}/${row.card}/${row.arm}`;
  if (!Array.isArray(replayRows) || replayRows.length !== manifest.results.length
      || new Set(replayRows.map(rowKey)).size !== replayRows.length
      || replayRows.some(row => JSON.stringify(row) !== JSON.stringify(manifest.results.find(item => rowKey(item) === rowKey(row))))) fail('replay/result mismatch');
  const payloads = new Map([...html.toString('utf8').matchAll(/<script id="payload-([a-z0-9-]+)" type="application\/octet-stream">([A-Za-z0-9+/=]*)<\/script>/g)]
    .map(match => [match[1], match[2]]));
  let laneCount = 0;
  for (const card of summary.cards) for (const lane of card.lanes) {
    const directory = path.join(source, `repeat-${lane.repeat}`, lane.card);
    let outer = '';
    try { outer = readRegular(path.join(directory, 'events.ndjson'), LIMITS.attachmentBytes).toString('utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const expected = buildReplayLane({ directory: path.join(directory, lane.arm), result: lane.result,
      arm: lane.arm, card: lane.card, repeat: lane.repeat, outer, kitSeal: manifest.kitSeal });
    if (JSON.stringify(expected.lane) !== JSON.stringify(lane)
        || gzipSync(Buffer.from(JSON.stringify(expected.payload)), { level: 9 }).toString('base64') !== payloads.get(lane.id)) fail('stale or corrupt embedded replay evidence');
    laneCount++;
  }
  if (laneCount !== payloads.size) fail('unexpected replay payloads');
  const stage = fs.mkdtempSync(path.join(parent, '.factory-package-'));
  const evidence = path.join(stage, 'evidence');
  fs.mkdirSync(evidence, { mode: 0o700 });
  let finished = false;
  try {
    for (const item of index.attachments) {
      const output = path.join(evidence, item.path);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(source, item.path), output, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(output, 0o600);
    }
    // Validate the copied snapshot, not just the source before copying it.
    verifyFightCardAttachments(index, evidence);
    const members = index.attachments.map(item => item.path).sort();
    const archive = spawnSync('tar', ['--create', '--gzip', '--file', path.join(stage, 'evidence.tar.gz'),
      '--format=posix', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0',
      '--pax-option=delete=atime,delete=ctime', '--no-recursion', '--null', '--verbatim-files-from', '--files-from=-'], {
      cwd: evidence, input: members.join('\0') + '\0', encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', TZ: 'UTC' },
    });
    if (archive.error || archive.status !== 0) fail(`GNU tar failed: ${archive.error?.message || archive.stderr || archive.status}`);
    fs.writeFileSync(path.join(stage, 'fight-card.json'), indexBytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(stage, 'fight-cards.html'), html, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(stage, 'README.md'), `# BANTAM factory fight cards — recorded evidence\n\nOpen [the offline replay](fight-cards.html). It uses recorded clocks, preserves every result, and embeds its inspectable evidence. The [machine-readable index](fight-card.json) is an unsigned observation, not executable machinery.\n\n## Privacy\n\nThis package is **private evidence, not a privacy-redacted public release**. It contains model context, candidate code, transcripts and machine paths. Review before posting, screen recording, or publishing. No package command uploads anything. Keep the source repository private.\n\n## Full evidence\n\n[Download the compressed evidence](evidence.tar.gz). Its ${members.length} regular-file members are exactly the index's allowlisted attachments; credentials, native databases and caches are not included by filename policy. That policy is not content redaction.\n\nExtract only this trusted, locally generated archive into a new empty directory (never execute an untrusted candidate):\n\n\`\`\`sh\nmkdir evidence\ntar -xzf evidence.tar.gz -C evidence\nnode /path/to/bantam/scripts/factory-fight-export.mjs validate "$PWD/fight-card.json" --verify-root "$PWD/evidence"\n\`\`\`\n\nRun those commands from this package directory. The validator checks all attachment hashes and sizes without executing code. Matching hashes establish byte consistency, not authenticity or semantic correctness. The exact starter/contracts/judges and runner source are versioned in the private BANTAM repository and bound by the index's source and kit seals.\n\n## Rebuild\n\nWith settled original evidence and the matching kit available, run the exporter, then replay generator, then package command. Packaging refuses an existing destination and never modifies original evidence. It requires Node.js 20+ and GNU tar.\n\n\`\`\`sh\nnode scripts/factory-fight-export.mjs export /absolute/settled-run\nnode scripts/factory-fight-replay.mjs /absolute/settled-run\nnode scripts/factory-fight-package.mjs /absolute/settled-run /absolute/new-package\n\`\`\`\n\nSee the repository's launch plan, final results and context audit for limitations, the separate Sol/Terra follow-up, and the distinction between checks passed and a completed accepted run.\n`, { flag: 'wx', mode: 0o600 });
    const files = ['fight-card.json', 'fight-cards.html', 'evidence.tar.gz', 'README.md'];
    const checksums = files.map(file => ({ path: file, bytes: fs.statSync(path.join(stage, file)).size,
      sha256: digest(fs.readFileSync(path.join(stage, file))) }));
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ schema: 'bantam.fight-card-package.v1',
      private: true, redacted: false, trust: index.trust, manifestSha256: index.run.manifestSha256,
      results: index.results.length, attachments: members.length, files: checksums }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.rmSync(evidence, { recursive: true }); // only our validated temporary copy
    fs.renameSync(stage, target);
    finished = true;
    return { directory: target, results: index.results.length, attachments: members.length,
      evidenceBytes: verified.declaredBytes, files: checksums, private: true, redacted: false };
  } finally {
    if (!finished) fs.rmSync(stage, { recursive: true, force: true }); // exact mkdtemp owned by this call
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) fail('usage: ABSOLUTE_EVIDENCE_ROOT ABSOLUTE_NEW_PACKAGE_DIRECTORY');
    process.stdout.write(JSON.stringify(packageFactoryFight(process.argv[2], process.argv[3])) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
