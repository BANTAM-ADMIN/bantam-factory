#!/usr/bin/env node
import fs from 'fs';

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    args.files.push(a);
  }
  return args;
}

function printHelp() {
  console.log('Usage: node compare.js FILE1 [FILE2 ...]');
  console.log('');
  console.log('Reads result files (JSONL) and prints a side-by-side comparison table.');
}

function loadRecords(file) {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.files.length < 2) {
    console.error('Provide at least two result files to compare.');
    process.exit(1);
  }

  const all = args.files.map(f => ({ file: f, records: loadRecords(f) }));

  // Use the latest record from each file for the comparison table.
  const latest = all.map(({ file, records }) => ({ file, record: records[records.length - 1] }));

  // Collect all card IDs across all records.
  const cardIds = new Set();
  for (const { record } of latest) {
    for (const r of record.results) cardIds.add(r.card);
  }

  // Print header.
  const labels = latest.map(({ record }) => record.label || record.solver);
  console.log('');
  console.log('Card'.padEnd(8) + labels.map(l => l.padEnd(16)).join(''));
  console.log('-'.repeat(8 + labels.length * 16));

  for (const cardId of [...cardIds].sort()) {
    const row = [cardId.padEnd(8)];
    for (const { record } of latest) {
      const r = record.results.find(x => x.card === cardId);
      row.push((r ? (r.pass ? 'PASS' : 'FAIL') : '—').padEnd(16));
    }
    console.log(row.join(''));
  }

  console.log('-'.repeat(8 + labels.length * 16));
  const scoreRow = ['Score'.padEnd(8)];
  for (const { record } of latest) {
    scoreRow.push(`${record.passed}/${record.total} (${(record.score * 100).toFixed(1)}%)`.padEnd(16));
  }
  console.log(scoreRow.join(''));

  // Print delta if exactly two files.
  if (latest.length === 2) {
    const [a, b] = latest;
    const delta = b.record.score - a.record.score;
    console.log(`\nDelta: ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}% (${a.record.label} → ${b.record.label})`);
  }

  console.log('');
}

main();
