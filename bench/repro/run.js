#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cards } from './cards.js';
import { solvers } from './solvers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { solver: 'baseline', label: '', out: path.join(__dirname, 'results.jsonl') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--solver') args.solver = argv[++i];
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node run.js [--solver NAME] [--label LABEL] [--out FILE]

Solvers: ${Object.keys(solvers).join(', ')}
Runs all cards through the named solver, records results, appends to --out.`);
}

function main() {
  const args = parseArgs(process.argv);
  const solver = solvers[args.solver];
  if (!solver) {
    console.error(`Unknown solver "${args.solver}". Available: ${Object.keys(solvers).join(', ')}`);
    process.exit(1);
  }

  const results = [];
  for (const card of cards) {
    const output = solver(card);
    const pass = card.check(output);
    results.push({
      card: card.id,
      name: card.name,
      pass,
      output,
      expected: card.answer,
    });
  }

  const passed = results.filter(r => r.pass).length;
  const score = passed / results.length;

  const record = {
    ts: new Date().toISOString(),
    solver: args.solver,
    label: args.label || args.solver,
    score,
    passed,
    total: results.length,
    results,
  };

  fs.appendFileSync(args.out, JSON.stringify(record) + '\n');

  console.log(`\n${args.label || args.solver} — ${passed}/${results.length} (${(score * 100).toFixed(1)}%)`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.card} ${r.name}: got "${r.output}"${r.pass ? '' : ` (expected "${r.expected}")`}`);
  }
  console.log(`\nRecorded to ${args.out}\n`);
}

main();
