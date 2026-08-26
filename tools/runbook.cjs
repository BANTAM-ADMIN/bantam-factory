#!/usr/bin/env node
// runbook.js — turn a Bantam run artifact (JSON) into a skimmable Markdown story.
// Usage:
//   node runbook.js <artifact.json>   → writes <artifact>.md next to it.
//   node runbook.js <dir>             → renders every <dir>/*.json plus <dir>/index.md
// Zero dependencies.

'use strict';
const fs = require('fs');
const path = require('path');

const MAX_RESULT_CHARS = 120; // hard cap on any inline result snippet

function fail(msg) {
  console.error('runbook: ' + msg);
  process.exit(1);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

// Strip ANSI escape sequences (shell output often carries them).
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function clip(s, n = MAX_RESULT_CHARS) {
  s = String(s == null ? '' : s).trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// First meaningful line of a big observation, with a size note.
function firstLine(obs) {
  const lines = String(obs).split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] || '';
  return head ? clip(head) : '';
}

// Shell observations carry an "exit N" line; pull it out.
function shellExit(obs) {
  const m = String(obs).match(/^exit (\d+)$/m);
  return m ? Number(m[1]) : null;
}

// Summarize a turn into { verb, target, result, isEdit }.
function summarizeTurn(t) {
  const pa = t.parsedAction || {};
  const a = pa.a || 'unknown';
  const obs = t.observation || '';
  const obsBytes = Buffer.byteLength(obs, 'utf8');
  let verb = a, target = '', result = '';
  let isEdit = false;

  switch (a) {
    case 'read_file': {
      target = pa.p || '';
      const m = obs.match(/\((\d+) lines, showing (\d+)-(\d+)\)/);
      if (m) result = `lines ${m[2]}–${m[3]} of ${m[1]}`;
      else if (obsBytes) result = firstLine(obs) || bytes(obsBytes);
      break;
    }
    case 'list_dir': {
      target = pa.p || '.';
      const n = String(obs).split('\n').filter(Boolean).length;
      result = obsBytes ? (n + ' entries, ' + bytes(obsBytes)) : 'empty';
      break;
    }
    case 'replace':
    case 'write_file': {
      isEdit = true;
      target = pa.p || '';
      if (a === 'write_file') {
        const n = Buffer.byteLength(pa.content || '', 'utf8');
        result = obs.trim() ? clip(obs.trim()) : `wrote ${bytes(n)}`;
      } else {
        const m = obs.match(/^replaced (\d+) occurrence(s)? in (\S+?)( at line \d+)?/);
        if (m) result = `replaced ${m[1]} occurrence${m[2] === 's' ? 's' : ''}${m[4] ? m[4] : ''}`;
        else result = obs.trim() ? firstLine(obs) : 'edited';
      }
      break;
    }
    case 'shell': {
      target = pa.c ? '`' + pa.c + '`' : '';
      const exit = shellExit(obs);
      const bits = [];
      if (exit !== null) bits.push('exit ' + exit + (exit === 0 ? '' : ' ⚠'));
      if (obsBytes) bits.push(bytes(obsBytes) + ' output');
      const noise = (h) => h.startsWith('$ ') || h.startsWith('cwd:') || h.startsWith('sandbox:') || h.startsWith('exit ') || h.startsWith('[') || /\x1b/.test(h) || /^\d+\s/.test(h);
      const lines = String(obs).split('\n').map((l) => stripAnsi(l).trim()).filter((l) => l && !noise(l));
      const sig = lines.find((l) => !l.startsWith('---') && !l.startsWith('...') && !/^\d+\s/.test(l));
      if (sig) bits.push('“' + clip(sig, 80) + '”');
      result = bits.join(', ');
      break;
    }
    case 'search': {
      target = (pa.p ? pa.p + ': ' : '') + '“' + (pa.q || '') + '”';
      result = obsBytes ? (firstLine(obs) || bytes(obsBytes)) : 'no results';
      break;
    }
    case 'inspect': {
      const ops = Array.isArray(pa.ops) ? pa.ops.map((o) => o.a).join(', ') : '';
      target = ops ? `(${ops})` : '';
      result = obsBytes ? (firstLine(obs) || bytes(obsBytes)) : '';
      break;
    }
    case 'query': {
      target = '“' + (pa.q || '') + '”';
      result = obsBytes ? (firstLine(obs) || bytes(obsBytes)) : '';
      break;
    }
    case 'done': {
      verb = 'done';
      result = 'finished';
      break;
    }
    case 'respond': {
      result = pa.text ? clip(pa.text, 200) : '';
      break;
    }
    default: {
      const bits = [];
      if (pa.p) bits.push(pa.p);
      if (pa.c) bits.push('`' + clip(pa.c, 60) + '`');
      if (pa.q) bits.push('“' + pa.q + '”');
      target = bits.join(' ');
      result = obsBytes ? (firstLine(obs) || bytes(obsBytes)) : '';
    }
  }
  return { verb, target, result, isEdit };
}

// Files touched by edits (replace/write_file), first-seen order, with counts.
function changedFiles(turns) {
  const order = [];
  const count = new Map();
  for (const t of turns) {
    const pa = t.parsedAction || {};
    if ((pa.a === 'replace' || pa.a === 'write_file') && pa.p) {
      if (!count.has(pa.p)) { count.set(pa.p, 0); order.push(pa.p); }
      count.set(pa.p, count.get(pa.p) + 1);
    }
  }
  return order.map((p) => ({ p, n: count.get(p) }));
}

function fmtDuration(ms) {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

// Duration in ms. Chat runs carry durationMs; headless runner artifacts carry
// metrics.totalMs (or metrics.durationMs); last resort: span of modelCalls.
function runDurationMs(art) {
  if (art.durationMs) return art.durationMs;
  const m = art.metrics;
  if (m && (m.totalMs || m.durationMs)) return m.totalMs || m.durationMs;
  const calls = Array.isArray(art.modelCalls) ? art.modelCalls : [];
  if (calls.length >= 2) {
    const first = calls[0].startedAt || (calls[0].attempts && calls[0].attempts[0] && calls[0].attempts[0].startedAt);
    const last = calls[calls.length - 1].completedAt || (calls[calls.length - 1].attempts && calls[calls.length - 1].attempts[calls[calls.length - 1].attempts.length - 1] && calls[calls.length - 1].attempts[calls[calls.length - 1].attempts.length - 1].completedAt);
    if (first && last) {
      const ms = Date.parse(last) - Date.parse(first);
      if (ms > 0) return ms;
    }
  }
  return null;
}

// The authoritative prefix-cache metric, replicated from src/logic/runlens.js
// (which is ESM and must not be imported here): llama's streamed
// `tokens_evaluated` is the request's TOTAL prompt tokens; only
// `timings.prompt_n` is what the slot actually processed. Reading the former
// as the latter declares a working cache dead.
function cacheReuseOf(art) {
  let processed = 0, total = 0, calls = 0;
  for (const call of art.modelCalls ?? []) {
    const raw = call?.response?.rawBody;
    if (typeof raw !== 'string') continue;
    const p = /"timings":\{[^}]*"prompt_n":(\d+)/.exec(raw);
    const t = /"tokens_evaluated":(\d+)/.exec(raw);
    if (!p || !t) continue;
    processed += Number(p[1]);
    total += Number(t[1]);
    calls += 1;
  }
  if (calls < 3 || total === 0) return null;
  return { calls, processed, total, reusePct: Math.round(100 * (1 - processed / total)) };
}

// Outcome. Chat runs carry disposition; headless runner artifacts carry a
// top-level result object (reachedDone / interrupted / status / blocked).
// 8-wastes ledger (lean read, 2026-08-18): classify what the artifact already
// records. Mirrors runlens's categories; mechanically-certain only.
function wasteLedger(art) {
  const turns = art.turns || [];
  if (!turns.length) return null;
  const events = art.events || [];
  const count = (type) => events.filter((e) => e && e.type === type).length;
  const act = (t) => ((t.parsedAction || t.action || {}).a);
  const value = turns.filter((t) => ["replace", "write_file", "patch", "edit_lines", "move_file", "shell"].includes(act(t))).length;
  const recon = turns.filter((t) => ["read_file", "search", "inspect", "list_dir", "query"].includes(act(t))).length;
  const motion = count("duplicate_action") + count("ledger_replay") + count("paging_steer") + count("inspect_shuffle_steer");
  const waiting = count("model_lock_wait");
  const defects = (art.rejectedOutputs || []).length + count("done_rejected") + count("protocol_violation");
  return { value, recon, motion, waiting, defects };
}

function runOutcome(art) {
  // A crash checkpoint has no verdict to report — its truth IS the partiality.
  if (art.partial === true) return 'partial(' + (art.truncatedBy || '?') + ')';
  if (art.disposition) return art.disposition;
  if (art.error) return 'error';
  const r = art.result;
  if (r && typeof r === 'object') {
    if (r.interrupted) return 'interrupted';
    if (r.blocked) return 'blocked';
    if (r.reachedDone || r.status === 'pass') return 'done';
    if (r.status) return String(r.status);
  }
  return 'unknown';
}

function render(art) {
  const turns = Array.isArray(art.turns) ? art.turns : [];
  const out = [];
  const name = path.basename(art.__file || '', '.json');

  const req = String(art.request || art.task || '(no request recorded)').trim();
  const reqLines = req.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  out.push('# Runbook: ' + (name || 'untitled run'));
  out.push('');
  out.push('## The ask');
  out.push('');
  if (reqLines.length === 1) {
    out.push('> ' + esc(req));
  } else {
    out.push(reqLines.map((l) => '> ' + esc(l)).join('\n'));
  }
  out.push('');

  const meta = [];
  if (art.startedAt) meta.push('started ' + art.startedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'));
  const dur = fmtDuration(runDurationMs(art));
  if (dur) meta.push('ran ' + dur);
  const ws = art.workspace ? path.basename(String(art.workspace)) : '';
  if (ws) meta.push('workspace `' + ws + '`');
  meta.push(turns.length + ' turns');
  out.push('_' + meta.join(' · ') + '_');
  out.push('');

  // Files changed: right under the ask, so blast radius is visible without
  // scanning the run for bold lines.
  const changed = changedFiles(turns);
  if (changed.length) {
    out.push('## Files changed');
    out.push('');
    changed.forEach((c) => out.push('- `' + c.p + '`' + (c.n > 1 ? ' (' + c.n + ' edits)' : '')));
    out.push('');
  }

  out.push('## The run');
  out.push('');
  // Collapse runs of consecutive recon (read_file/search/list_dir) on the same
  // target into one line; edits and shells always keep their own line.
  const isRecon = (s) => s.verb === 'read_file' || s.verb === 'search' || s.verb === 'list_dir';
  const items = turns.map((t, idx) => ({ t, idx, n: t.i != null ? t.i : idx, s: summarizeTurn(t) }));
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (isRecon(it.s) && it.s.target) {
      let j = i + 1;
      while (j < items.length && isRecon(items[j].s) && items[j].s.target === it.s.target) j++;
      const run = items.slice(i, j);
      const first = run[0], last = run[run.length - 1];
      const nLabel = run.length === 1 ? String(first.n) : first.n + '–' + last.n;
      let line = nLabel + '. ' + it.s.verb + ' ' + it.s.target;
      if (run.length > 1) {
        line += ' ×' + run.length;
        const ranges = run.map((r) => {
          const m = String(r.t.observation || '').match(/showing (\d+)-(\d+)/);
          return m ? m[1] + '–' + m[2] : null;
        }).filter(Boolean);
        if (ranges.length) line += ' (ranges ' + ranges.join(', ') + ')';
      } else if (it.s.result) {
        line += ' — ' + it.s.result;
      }
      if (run.some((r) => r.t.protocolViolation)) line += ' _(protocol violation)_';
      out.push(line);
      i = j;
    } else {
      let line = it.n + '. ';
      const what = it.s.verb + (it.s.target ? ' ' + it.s.target : '');
      line += it.s.isEdit ? '**' + what + '**' : what;
      if (it.s.result) line += ' — ' + it.s.result;
      if (it.t.protocolViolation) line += ' _(protocol violation)_';
      out.push(line);
      i++;
    }
  }
  out.push('');

  out.push('## How it ended');
  out.push('');
  const outcome = runOutcome(art);
  const partial = art.partial ? ' _(partial artifact)_' : '';
  out.push('- **Outcome:** ' + outcome + partial);
  out.push('- **Turns:** ' + (art.turnCount != null ? art.turnCount : turns.length));
  if (dur) out.push('- **Duration:** ' + dur);
  const cache = cacheReuseOf(art);
  if (cache) out.push('- **Cache:** ' + cache.reusePct + '% prefix reuse (' + cache.processed + ' of ' + cache.total + ' prompt tokens processed across ' + cache.calls + ' calls)');
  const waste = wasteLedger(art);
  if (waste) out.push('- **Ledger:** ' + waste.value + ' value · ' + waste.recon + ' recon · ' + waste.motion + ' motion-refused · ' + waste.waiting + ' waiting · ' + waste.defects + ' defect-rework');
  if (art.error) out.push('- **Error:** ' + esc(art.error));
  out.push('');
  if (art.summary) {
    out.push('### Summary');
    out.push('');
    const sum = String(art.summary).trim();
    out.push(sum.split(/\r?\n/).map((l) => (l.trim() ? l : '')).join('\n'));
    out.push('');
  }
  out.push('');
  out.push('---');
  out.push('');
  out.push('_Generated by runbook.js from ' + (name || 'artifact') + '.json — ' + turns.length + ' turns._');
  if (art.verification && typeof art.verification === 'object') {
    const v = art.verification;
    const bits = [];
    if (v.status) bits.push('**' + v.status + '**');
    if (v.command) bits.push('`' + v.command + '`');
    if (v.detail) bits.push(clip(v.detail, 160));
    if (bits.length) {
      out.push('### Verification');
      out.push('');
      out.push(bits.join(' · '));
      out.push('');
    }
  }
  return out.join('\n');
}

function loadArtifact(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail('cannot read ' + file + ': ' + e.message);
  }
  let art;
  try {
    art = JSON.parse(raw);
  } catch (e) {
    fail('not valid JSON: ' + file + ': ' + e.message);
  }
  if (!art || !Array.isArray(art.turns)) fail('no turns[] array found in ' + file + ' — not a run artifact?');
  art.__file = file;
  return art;
}

function renderIndex(dir, arts) {
  const out = [];
  out.push('# Run index: ' + path.basename(dir));
  out.push('');
  out.push(arts.length + ' run' + (arts.length === 1 ? '' : 's') + ' in `' + dir + '`');
  out.push('');
  out.push('| Run | Outcome | Turns | Duration | Files changed | Waste |');
  out.push('| --- | --- | ---: | ---: | --- | --- |');
  for (const art of arts) {
    const name = path.basename(art.__file, '.json');
    const turns = art.turns.length;
    const dur = fmtDuration(runDurationMs(art)) || '—';
    const outcome = runOutcome(art);
    const changed = changedFiles(art.turns);
    const files = changed.length
      ? changed.map((c) => c.p + (c.n > 1 ? ' ×' + c.n : '')).join(', ')
      : '—';
    const w = wasteLedger(art);
    const wasteCell = w ? (w.value + 'v/' + w.recon + 'r/' + w.motion + 'm/' + w.waiting + 'w/' + w.defects + 'd') : '—';
    out.push('| [' + name + '](./' + name + '.md) | ' + esc(outcome) + ' | ' + turns + ' | ' + esc(dur) + ' | ' + esc(files) + ' | ' + wasteCell + ' |');
  }
  out.push('');
  out.push('_Generated by runbook.js._');
  return out.join('\n');
}

function main() {
  const arg = process.argv[2];
  if (!arg) fail('usage: node runbook.js <artifact.json> | <dir>');
  const p = path.resolve(arg);
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    fail('cannot stat ' + p + ': ' + e.message);
  }
  if (st.isDirectory()) {
    const files = fs.readdirSync(p)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .sort()
      .map((f) => path.join(p, f));
    if (!files.length) fail('no .json files in ' + p);
    const arts = files.map(loadArtifact);
    for (const art of arts) {
      const md = render(art);
      const outFile = art.__file.replace(/\.json$/i, '') + '.md';
      fs.writeFileSync(outFile, md);
      console.log('wrote ' + outFile + ' (' + art.turns.length + ' turns)');
    }
    const index = renderIndex(p, arts);
    const indexFile = path.join(p, 'index.md');
    fs.writeFileSync(indexFile, index);
    console.log('wrote ' + indexFile + ' (' + arts.length + ' runs)');
    return;
  }
  const art = loadArtifact(p);
  const md = render(art);
  const outFile = p.replace(/\.json$/i, '') + '.md';
  fs.writeFileSync(outFile, md);
  console.log('wrote ' + outFile + ' (' + art.turns.length + ' turns)');
}

main();
