#!/usr/bin/env node
// quote-verify.cjs — the second poisoned-shelf countermeasure: turn [S] ink
// into a checkable property. Extracts (QUOTE, URL) pairs from a shelf file
// and dispatches ONE bounded verification errand: fetch each URL, report
// whether the exact quote appears. Appends a VERIFICATION section to the
// shelf. A fabricated citation dies at this gate (2026-08-19 falsifier:
// the planted quote's URL never contained it).
//
// Usage: node quote-verify.cjs --shelf path/to/notes.md [--model gpt-5.6-terra] [--timeout-sec 420]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : dflt;
}
const shelf = arg('shelf');
const model = arg('model', 'gpt-5.6-terra');
const timeoutSec = Number(arg('timeout-sec', 420));
if (!shelf || !fs.existsSync(shelf)) { console.error('usage: quote-verify.cjs --shelf <existing file>'); process.exit(2); }

const text = fs.readFileSync(shelf, 'utf8');
// Pair each block-quoted line run with the nearest following URL line.
const pairs = [];
const blocks = text.split(/\n\s*\n/);
let pendingQuote = null;
for (const b of blocks) {
  const q = b.match(/^\s*>\s?([\s\S]+)/m);
  const u = b.match(/https?:\/\/\S+/);
  if (q) pendingQuote = q[0].replace(/^\s*>\s?/gm, '').trim();
  if (u && pendingQuote) { pairs.push({ quote: pendingQuote.slice(0, 400), url: u[0].replace(/[)\]]$/, '') }); pendingQuote = null; }
}
if (!pairs.length) { console.log('quote-verify: no (quote, URL) pairs found — nothing to verify'); process.exit(1); }

const BRIEF = `You are a citation checker. For EACH numbered pair below: fetch the URL and report whether the EXACT quoted text (allowing whitespace differences) appears on that page.
Reply with one line per pair: "N: VERIFIED" | "N: NOT-FOUND (page loaded, quote absent)" | "N: URL-DEAD (could not load)". Nothing else. Do not write files.
${pairs.map((p, i) => `${i + 1}. URL: ${p.url}\n   QUOTE: "${p.quote}"`).join('\n')}`;


// Spend governor gate (P1): every codex errand is metered quota. The gate
// consults the kill switch, the operator's reserve envelopes, and the live
// fuel gauge before anything is spawned. Exit 3 = governed refusal.
async function governorGate(kind) {
  const { pathToFileURL } = require('url');
  const load = (p) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'logic', p)).href);
  const { loadPolicy, haltState, governorVerdict, renderGovernorLine } = await load('governor.js');
  const root = process.env.BANTAM_GOVERNOR_ROOT || process.cwd();
  let reading = null;
  try { reading = (await load('fuel.js')).latestCodexReading(); } catch { reading = null; }
  const v = governorVerdict({ policy: loadPolicy(root), reading, halt: haltState(root), force: process.env.BANTAM_GOVERNOR_FORCE === '1' });
  console.error(renderGovernorLine(v));
  if (!v.allow) {
    console.log(`governor refused the ${kind} errand — \`bantam governor\` explains; \`bantam governor resume\` or BANTAM_GOVERNOR_FORCE=1 overrides (the kill switch does not yield to force).`);
    process.exit(3);
  }
}

(async () => {
await governorGate('citation-check');
const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'qverify-jail-'));
const res = spawnSync('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-m', model, BRIEF],
  { cwd: jail, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 });
fs.rmSync(jail, { recursive: true, force: true });
const raw = String(res.stdout ?? '');
const parts = raw.split(/\ncodex\n/);
const report = (parts.length > 1 ? parts[parts.length - 1] : raw).replace(/\[\d{4}-.*?tokens used.*$/s, '').trim();
const verdicts = pairs.map((p, i) => {
  const m = report.match(new RegExp(`^\\s*${i + 1}\\s*[:.]\\s*(VERIFIED|NOT-FOUND[^\\n]*|URL-DEAD[^\\n]*)`, 'mi'));
  return { ...p, verdict: m ? m[1].trim() : 'UNCHECKED (verifier gave no ruling)' };
});
const failed = verdicts.filter((v) => !/^VERIFIED/i.test(v.verdict));
const section = `\n\n## VERIFICATION (${new Date().toISOString()}, ${model} citation checker)\n` +
  verdicts.map((v, i) => `${i + 1}. ${v.verdict} — ${v.url}`).join('\n') +
  (failed.length ? `\n\n⚠ ${failed.length} citation(s) did NOT verify. Treat their claims as UNSOURCED regardless of [S] ink.` : '\n\nAll citations verified.');
fs.appendFileSync(shelf, section);
console.log(`quote-verify: ${verdicts.length - failed.length}/${verdicts.length} verified${failed.length ? ` — ${failed.length} FAILED` : ''}`);
process.exit(failed.length ? 1 : 0);
})();
