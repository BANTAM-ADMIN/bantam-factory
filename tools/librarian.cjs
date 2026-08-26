#!/usr/bin/env node
// librarian.cjs — the bounded research errand, productized from the
// 2026-08-19 study. A disposable codex agent runs in an EMPTY jail with a
// quote-or-omit contract; its stdout is screened and written as a
// provenance-stamped shelf file the local model can read as testimony.
//
// The study's ops lessons are built in: a hard deadline with a partial-haul
// policy (one errand of fourteen ran ~10x its peers), stdout-only return
// (the researcher never touches a workspace), and screening that strips the
// runner's own chrome before anything is shelved.
//
// Usage:
//   node librarian.cjs --question "..." --shelf path/to/reference/notes.md
//     [--model gpt-5.6-terra] [--timeout-sec 600]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : dflt;
}
const question = arg('question');
const shelf = arg('shelf');
const model = arg('model', 'gpt-5.6-terra');
const timeoutSec = Number(arg('timeout-sec', 600));
if (!question || !shelf) {
  console.error('usage: librarian.cjs --question "..." --shelf <file> [--model M] [--timeout-sec N]');
  process.exit(2);
}

const BRIEF = `You are a research librarian. Find authoritative sources and return QUOTED evidence as your final message. Do not write files. Research question: ${question}
FORMAT per claim: VERDICT / QUOTE (verbatim, 2-4 sentences) / URL / DATE ACCESSED. A claim without a verbatim quote and URL is worthless — omit rather than paraphrase. For any ordering, comparison, or derivation rule, ALSO include one WORKED EXAMPLE with concrete values from the source (rules without examples get misapplied). For any configuration default, limit, or threshold, quote the EXACT number — structure without numbers forces the reader to guess. If no authoritative source establishes a claim, say NO-VERDICT for it — that absence is information. Prefer primary sources (specs, official docs, vendor pages).`;


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
await governorGate('librarian');
const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-jail-'));
const started = new Date().toISOString();
const res = spawnSync('codex', [
  'exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
  '-m', model, BRIEF,
], { cwd: jail, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 });
fs.rmSync(jail, { recursive: true, force: true });

const timedOut = res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
const raw = `${res.stdout ?? ''}`;
// Final agent message = text after the last bare "codex" marker; strip chrome.
const parts = raw.split(/\ncodex\n/);
let haul = (parts.length > 1 ? parts[parts.length - 1] : raw)
  .replace(/\[\d{4}-.*?tokens used.*$/s, '')
  .trim();
const status = timedOut ? (haul ? 'PARTIAL (deadline reached; haul as of cutoff)' : 'NO-HAUL (deadline reached with nothing returned)')
  : haul ? 'COMPLETE' : 'NO-HAUL (agent returned nothing)';

const shelfText = `# Research notes (external, verify-as-you-use)
PROVENANCE: fetched ${started} by a ${model} research agent (empty jail,
quote-or-omit contract, ${timeoutSec}s deadline). STATUS: ${status}.
Outside testimony that MAY help — not gospel. Where a source conflicts with
your recollection, say so and state which you adopt and why. A NO-VERDICT
from the researcher is itself information.

QUESTION: ${question}

${haul || '(no evidence returned)'}
`;
fs.mkdirSync(path.dirname(shelf), { recursive: true });
fs.writeFileSync(shelf, shelfText);
console.log(`librarian: ${status} -> ${shelf} (${shelfText.length} bytes)`);
process.exit(haul ? 0 : 1);
})();
