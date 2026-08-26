#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = { cmd: null, queue: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cmd') args.cmd = argv[++i];
    else if (a === '--queue') args.queue = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else { args.unknown = (args.unknown || []).concat(a); }
  }
  return args;
}

function printHelp() {
  console.log(`runqueue.js — run one job at a time from a JSONL queue

Usage: node runqueue.js --queue <queue.jsonl> --cmd '<agent command>'

Queue file: one job per line (JSON):
  {"id": "name", "cwd": "/path", "stdin": "/path/requests.txt", "log": "/path/out.log"}

State is kept in queue-status.json next to the queue file.
Reruns skip done jobs and resume at the first pending one; jobs left
'running' by a crash are retried. Ctrl-C marks the current job failed.`);
}

function loadQueue(queuePath) {
  const raw = fs.readFileSync(queuePath, 'utf8');
  const jobs = [];
  raw.split(/\r?\n/).forEach((line, idx) => {
    const t = line.trim();
    if (!t) return;
    let job;
    try {
      job = JSON.parse(t);
    } catch (e) {
      throw new Error(`queue line ${idx + 1} is not valid JSON: ${e.message}`);
    }
    if (!job.id) throw new Error(`queue line ${idx + 1} missing "id"`);
    if (!job.cwd) throw new Error(`queue line ${idx + 1} (${job.id}) missing "cwd"`);
    if (!job.stdin) throw new Error(`queue line ${idx + 1} (${job.id}) missing "stdin"`);
    if (!job.log) throw new Error(`queue line ${idx + 1} (${job.id}) missing "log"`);
    jobs.push(job);
  });
  return jobs;
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

function ensureStatusEntry(status, job) {
  let e = status.jobs.find((j) => j.id === job.id);
  if (!e) {
    e = { id: job.id, status: 'pending', exitCode: null, startedAt: null, endedAt: null, durationMs: null };
    status.jobs.push(e);
  }
  return e;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.queue || !args.cmd) {
    console.error('error: --queue <file.jsonl> and --cmd <command> are both required');
    printHelp();
    process.exit(2);
  }
  const queuePath = path.resolve(args.queue);
  const statusPath = path.join(path.dirname(queuePath), 'queue-status.json');
  const jobs = loadQueue(queuePath);
  const status = loadStatus(statusPath);

  // Reconcile: jobs left 'running' by a crash become pending (retry).
  let reset = 0;
  for (const e of status.jobs) {
    if (e.status === 'running') { e.status = 'pending'; e.startedAt = null; e.endedAt = null; e.durationMs = null; reset++; }
  }
  if (reset) {
    console.log(`[runqueue] retrying ${reset} job(s) left running by a previous crash`);
    saveStatus(statusPath, status);
  }

  // Make sure every queue job has a status entry.
  for (const job of jobs) ensureStatusEntry(status, job);
  saveStatus(statusPath, status);

  const entryFor = (id) => status.jobs.find((j) => j.id === id);

  let interrupted = false;
  let current = null; // { entry, child, logStream }

  function onSignal(sig) {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n[runqueue] ${sig} received`);
    if (current) {
      const { entry, child, logStream } = current;
      entry.status = 'failed';
      entry.exitCode = child.exitCode != null ? child.exitCode : null;
      entry.endedAt = new Date().toISOString();
      entry.durationMs = entry.startedAt ? Date.now() - new Date(entry.startedAt).getTime() : null;
      try { child.kill('SIGTERM'); } catch (e) {}
      try { logStream.end(); } catch (e) {}
      saveStatus(statusPath, status);
      console.error(`[runqueue] marked "${entry.id}" failed (interrupted by ${sig})`);
    } else {
      saveStatus(statusPath, status);
      console.error(`[runqueue] no job running; exiting`);
    }
    process.exit(130);
  }
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  function runNext() {
    if (interrupted) return;
    const job = jobs.find((j) => {
      const e = entryFor(j.id);
      return e && e.status === 'pending';
    });
    if (!job) {
      const done = status.jobs.filter((e) => e.status === 'done').length;
      const failed = status.jobs.filter((e) => e.status === 'failed').length;
      console.log(`[runqueue] all jobs finished: ${done} done, ${failed} failed, ${status.jobs.length - done - failed} pending`);
      return;
    }

    const entry = entryFor(job.id);
    entry.status = 'running';
    entry.startedAt = new Date().toISOString();
    entry.endedAt = null;
    entry.durationMs = null;
    entry.exitCode = null;
    saveStatus(statusPath, status);
    console.log(`[runqueue] starting "${job.id}" (cwd=${job.cwd})`);

    // Prepare log dir
    fs.mkdirSync(path.dirname(path.resolve(job.log)), { recursive: true });
    const logStream = fs.createWriteStream(path.resolve(job.log), { flags: 'a' });

    const child = spawn(args.cmd, { cwd: path.resolve(job.cwd), stdio: ['pipe', 'pipe', 'pipe'], shell: true });
    current = { entry, child, logStream };

    child.stdout.on('data', (d) => logStream.write(d));
    child.stderr.on('data', (d) => logStream.write(d));

    const stdinPath = path.resolve(job.stdin);
    let stdinStream;
    try {
      stdinStream = fs.createReadStream(stdinPath);
    } catch (e) {
      stdinStream = null;
    }
    if (stdinStream) {
      stdinStream.on('error', (e) => {
        console.error(`[runqueue] "${job.id}" stdin read error: ${e.message}`);
      });
      stdinStream.pipe(child.stdin);
    } else {
      child.stdin.end();
    }

    child.on('error', (e) => {
      console.error(`[runqueue] "${job.id}" spawn error: ${e.message}`);
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
      entry.status = code === 0 ? 'done' : 'failed';
      current = null;
      saveStatus(statusPath, status);
      console.log(`[runqueue] "${job.id}" ${entry.status} (exit=${entry.exitCode}, ${entry.durationMs}ms)`);
      runNext();
    });
  }

  runNext();
}

main();
