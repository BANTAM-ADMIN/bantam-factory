import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function reduceEvents(text) {
  if (typeof text !== 'string') throw Error('text must be a string');
  const byId = new Map(); let duplicates = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (!e || typeof e !== 'object' || Array.isArray(e)
      || typeof e.id !== 'string' || e.id.length === 0 || typeof e.job !== 'string' || e.job.length === 0
      || !Number.isSafeInteger(e.attempt) || e.attempt < 1 || !Number.isSafeInteger(e.seq) || e.seq < 0
      || !['started','succeeded','failed'].includes(e.type)) throw Error('invalid event');
    const core = [e.id,e.job,e.attempt,e.seq,e.type];
    if (byId.has(e.id)) {
      if (JSON.stringify(byId.get(e.id)) !== JSON.stringify(core)) throw Error('conflicting id');
      duplicates++; continue;
    }
    byId.set(e.id, core);
  }
  const jobs = new Map();
  for (const [id, job, attempt, seq, type] of byId.values()) {
    if (!jobs.has(job)) jobs.set(job, new Map());
    const attempts = jobs.get(job);
    if (!attempts.has(attempt)) attempts.set(attempt, { start:null, terminal:null });
    const state = attempts.get(attempt);
    if (type === 'started') {
      if (state.start !== null) throw Error('repeated start');
      state.start = seq;
    } else {
      if (state.terminal !== null) throw Error('repeated terminal');
      state.terminal = {seq,type};
    }
  }
  return {jobs:[...jobs].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([job, attempts]) => ({
    job, attempts:[...attempts].sort(([a],[b]) => a-b).map(([attempt, state]) => {
      if (state.start === null || (state.terminal && state.terminal.seq <= state.start)) throw Error('invalid lifecycle');
      return {attempt,status:state.terminal?.type ?? 'running',startedSeq:state.start,finishedSeq:state.terminal?.seq ?? null};
    }),
  })),duplicates};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('usage: receipt-report.js LOGFILE');
    process.stdout.write(JSON.stringify(reduceEvents(fs.readFileSync(process.argv[2], 'utf8'))) + '\n');
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 2; }
}
