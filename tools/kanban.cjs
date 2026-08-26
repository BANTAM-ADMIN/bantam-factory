#!/usr/bin/env node
'use strict';

// kanban.cjs — pull-system sibling of runqueue.cjs.
//
// runqueue pushes a fixed queue in file order. kanban PULLS: the BACKLOG file
// is a jsonl of cards (same shape: {id, cwd, stdin, log} plus optional {kind}),
// and the belt pulls one card at a time (WIP=1), top card first — file order IS
// the priority order, except cards with kind "continuation" always jump the
// queue: finishing beats starting.
//
// ANDON: after each card, its log is inspected. If the process exited nonzero
// AND the log has no recognizable receipt line (a line starting with ✓, ⚠, ⏸,
// or "blocked"), the belt HALTS immediately with a loud message naming the job
// and log — an abnormal death stops the line. A nonzero exit WITH a receipt is
// a normal, recorded failure and the belt continues.
//
// State lives in <backlog>-status.json (e.g. backlog.jsonl-status.json): done
// cards are skipped on restart; a card left "running" by a crash is retried.
//
// Usage: node kanban.cjs --backlog <cards.jsonl> --cmd '<agent command>' [--drain-once]

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = { cmd: null, backlog: null, drainOnce: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cmd') args.cmd = argv[++i];
    else if (a === '--backlog') args.backlog = argv[++i];
    else if (a === '--drain-once') args.drainOnce = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else { args.unknown = (args.unknown || []).concat(a); }
  }
  return args;
}

// A card whose log lives INSIDE its own cwd makes the workspace-coherence
// guard see the belt's tee as foreign edits (2026-08-19: nineteen swallowed
// done attempts in one run). Refuse the foot-gun up front.
function assertLogOutsideCwd(card) {
  if (!card.log || !card.cwd) return;
  const path = require('path');
  const rel = path.relative(path.resolve(card.cwd), path.resolve(card.log));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    console.error(`[kanban] WARNING card "${card.id}": log is inside cwd — an agent with workspace-coherence will read the belt's own tee as foreign edits (2026-08-19: nineteen swallowed dones). Put logs outside the workspace.`);
  }
}

function printHelp() {
  console.log(`kanban.cjs — pull cards one at a time from a JSONL backlog

Usage: node kanban.cjs --backlog <cards.jsonl> --cmd '<agent command>' [--drain-once]

Backlog file: one card per line (JSON):
  {"id": "name", "cwd": "/path", "stdin": "/path/requests.txt", "log": "/path/out.log", "kind": "continuation"}

Rules:
  - WIP is one: never two cards at once.
  - File order is priority order; kind "continuation" cards are pulled before
    any other kind regardless of position (finishing beats starting).
  - ANDON: a nonzero exit with no receipt line in the log HALTS the belt with
    a loud message naming the job and log. A nonzero exit WITH a receipt line
    (starting with ✓, ⚠, ⏸, or "blocked") is recorded as failed and the belt
    continues.
  - State lives in <backlog>-status.json: done cards are skipped on restart;
    a card left "running" by a crash is retried.
  - --drain-once pulls exactly one card, then exits.

Ctrl-C marks the current card failed.`);
}

function loadBacklog(backlogPath) {
  const raw = fs.readFileSync(backlogPath, 'utf8');
  const cards = [];
  raw.split(/\r?\n/).forEach((line, idx) => {
    const t = line.trim();
    if (!t) return;
    let card;
    try {
      card = JSON.parse(t);
    } catch (e) {
      throw new Error(`backlog line ${idx + 1} is not valid JSON: ${e.message}`);
    }
    if (!card.id) throw new Error(`backlog line ${idx + 1} missing "id"`);
    if (!card.cwd) throw new Error(`backlog line ${idx + 1} (${card.id}) missing "cwd"`);
    if (!card.stdin) throw new Error(`backlog line ${idx + 1} (${card.id}) missing "stdin"`);
    if (!card.log) throw new Error(`backlog line ${idx + 1} (${card.id}) missing "log"`);
    assertLogOutsideCwd(card);
    cards.push(card);
  });
  return cards;
}

function loadStatus(statusPath) {
  try {
    const raw = fs.readFileSync(statusPath, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && Array.isArray(obj.jobs)) return obj;
  } catch (e) { /* no status yet */ }
  return { jobs: [] };
}

function saveStatus(statusPath, status) {
  const tmp = statusPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  fs.renameSync(tmp, statusPath);
}

function ensureStatusEntry(status, card) {
  let e = status.jobs.find((j) => j.id === card.id);
  if (!e) {
    e = { id: card.id, status: 'pending', exitCode: null, startedAt: null, endedAt: null, durationMs: null };
    status.jobs.push(e);
  }
  return e;
}

// A receipt line is a line starting with a checkmark, warning sign, pause
// sign, or the word "blocked" (case-insensitive). These are how a job reports
// "I died, but here is why, and it is expected."
function hasReceipt(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    return false;
  }
  return raw.split(/\r?\n/).some((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith('✓') || t.startsWith('✔')) return true;
    if (t.startsWith('⚠') || t.startsWith('⚡')) return true;
    if (t.startsWith('⏸') || t.startsWith('⏹')) return true;
    return /^blocked/i.test(t);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.backlog || !args.cmd) {
    console.error('error: --backlog <file.jsonl> and --cmd <command> are both required');
    printHelp();
    process.exit(2);
  }
  const backlogPath = path.resolve(args.backlog);
  const statusPath = backlogPath + '-status.json';
  const cards = loadBacklog(backlogPath);
  const status = loadStatus(statusPath);

  // Reconcile: cards left 'running' by a crash become pending (retry).
  let reset = 0;
  for (const e of status.jobs) {
    if (e.status === 'running') { e.status = 'pending'; e.startedAt = null; e.endedAt = null; e.durationMs = null; reset++; }
  }
  if (reset) {
    console.log(`[kanban] retrying ${reset} card(s) left running by a previous crash`);
    saveStatus(statusPath, status);
  }

  // Make sure every backlog card has a status entry.
  for (const card of cards) ensureStatusEntry(status, card);
  saveStatus(statusPath, status);

  const entryFor = (id) => status.jobs.find((j) => j.id === id);

  let interrupted = false;
  let halted = false;
  let current = null; // { entry, child, logStream }

  function onSignal(sig) {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n[kanban] ${sig} received`);
    if (current) {
      const { entry, child, logStream } = current;
      entry.status = 'failed';
      entry.exitCode = child.exitCode != null ? child.exitCode : null;
      entry.endedAt = new Date().toISOString();
      entry.durationMs = entry.startedAt ? Date.now() - new Date(entry.startedAt).getTime() : null;
      try { child.kill('SIGTERM'); } catch (e) {}
      try { logStream.end(); } catch (e) {}
      saveStatus(statusPath, status);
      console.error(`[kanban] marked "${entry.id}" failed (interrupted by ${sig})`);
    } else {
      saveStatus(statusPath, status);
      console.error(`[kanban] no card running; exiting`);
    }
    process.exit(130);
  }
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  // Pull the next card: pending only, continuation kind first, then file order.
  function pullNext() {
    const pending = cards.filter((c) => {
      const e = entryFor(c.id);
      return e && e.status === 'pending';
    });
    if (!pending.length) return null;
    const cont = pending.find((c) => c.kind === 'continuation');
    return cont || pending[0];
  }

  function runNext() {
    if (interrupted || halted) return;
    const card = pullNext();
    if (!card) {
      const done = status.jobs.filter((e) => e.status === 'done').length;
      const failed = status.jobs.filter((e) => e.status === 'failed').length;
      console.log(`[kanban] backlog drained: ${done} done, ${failed} failed, ${status.jobs.length - done - failed} pending`);
      return;
    }

    const entry = entryFor(card.id);
    entry.status = 'running';
    entry.startedAt = new Date().toISOString();
    entry.endedAt = null;
    entry.durationMs = null;
    entry.exitCode = null;
    saveStatus(statusPath, status);
    const tag = card.kind === 'continuation' ? ' (continuation)' : '';
    console.log(`[kanban] pulling "${card.id}"${tag} (cwd=${card.cwd})`);

    // Prepare log dir
    fs.mkdirSync(path.dirname(path.resolve(card.log)), { recursive: true });
    const logStream = fs.createWriteStream(path.resolve(card.log), { flags: 'a' });

    // The command template may contain {id}, {cwd}, {stdin}, {log} placeholders.
    const cmd = args.cmd
      .replace(/\{id\}/g, card.id)
      .replace(/\{cwd\}/g, card.cwd)
      .replace(/\{stdin\}/g, card.stdin)
      .replace(/\{log\}/g, card.log);
    const child = spawn(cmd, { cwd: path.resolve(card.cwd), stdio: ['pipe', 'pipe', 'pipe'], shell: true });
    current = { entry, child, logStream };

    child.stdout.on('data', (d) => logStream.write(d));
    child.stderr.on('data', (d) => logStream.write(d));

    const stdinPath = path.resolve(card.stdin);
    let stdinStream;
    try {
      stdinStream = fs.createReadStream(stdinPath);
    } catch (e) {
      stdinStream = null;
    }
    if (stdinStream) {
      stdinStream.on('error', (e) => {
        console.error(`[kanban] "${card.id}" stdin read error: ${e.message}`);
      });
      stdinStream.pipe(child.stdin);
    } else {
      child.stdin.end();
    }

    child.on('error', (e) => {
      console.error(`[kanban] "${card.id}" spawn error: ${e.message}`);
      entry.status = 'failed';
      entry.exitCode = null;
      entry.endedAt = new Date().toISOString();
      entry.durationMs = entry.startedAt ? Date.now() - new Date(entry.startedAt).getTime() : null;
      try { logStream.end(); } catch (err) {}
      current = null;
      saveStatus(statusPath, status);
      runNext();
    });

    child.on('close', (code, signal) => {
      const wasInterrupted = interrupted;
      entry.endedAt = new Date().toISOString();
      entry.durationMs = entry.startedAt ? Date.now() - new Date(entry.startedAt).getTime() : null;
      entry.exitCode = code != null ? code : (signal ? null : 0);
      if (wasInterrupted) {
        // onSignal already handled state; just clean up.
        current = null;
        return;
      }
      const exitCode = entry.exitCode;
      const logPath = path.resolve(card.log);
      const receipt = hasReceipt(logPath);

      if (exitCode !== 0 && !receipt) {
        // ANDON: abnormal death — nonzero with no receipt. Stop the line.
        entry.status = 'failed';
        current = null;
        saveStatus(statusPath, status);
        halted = true;
        console.error(`\n[kanban] *** ANDON HALT ***`);
        console.error(`[kanban] card "${card.id}" died abnormally: exit=${exitCode}, no receipt line in log`);
        console.error(`[kanban] job:  ${card.id}`);
        console.error(`[kanban] log:  ${logPath}`);
        console.error(`[kanban] the belt is stopped. Fix the card, then re-run to resume.`);
        process.exitCode = 3;
        return;
      }

      entry.status = exitCode === 0 ? 'done' : 'failed';
      current = null;
      saveStatus(statusPath, status);
      const note = exitCode !== 0 ? ' (receipted failure)' : '';
      console.log(`[kanban] "${card.id}" ${entry.status}${note} (exit=${exitCode}, ${entry.durationMs}ms)`);

      if (args.drainOnce) {
        console.log(`[kanban] --drain-once: stopping after one card`);
        return;
      }
      runNext();
    });
  }

  runNext();
}

main();
