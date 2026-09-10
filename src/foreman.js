// Optional, consent-first Astra supervisor; private candidate and evidence.
import fs from 'node:fs';
import {readJsonFile} from './json-file.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServer } from './codex-transport.js';
import { driveForeman } from './foreman-controller.js';
import { WorkspaceStore } from './workspace-store.js';
import { WorkspaceTransaction, planWorkspaceTransaction } from './workspace-transaction.js';
import { LaneJournal } from './journal.js';
import { runProcess } from './process-runner.js';
import { runShellProcess } from './executor.js';
import { freshCommand, cleanFightEnv, inspectLocalModel } from '../scripts/factory-fights.mjs';
import { acceptedBantamCompletion } from '../scripts/repobrief-astra-fights.mjs';
import { startModelRecorder } from '../scripts/fight-model-proxy.mjs';
import { settleServerCounters } from '../scripts/fight-usage.mjs';
import { cornerUsage } from './fight.js';
import { normalizeCardEndpoint } from './factory-cards-command.js';
import { createWorkerControl, queueWorkerSteering, readWorkerFeedback } from './foreman-worker-control.js';
import { captureInstructionScope } from './instruction-guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = { astra: 'gpt-6-astra', sol: 'gpt-5.6-sol', terra: 'gpt-5.6-terra' };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const clean = r => r?.code === 0 && !r.timedOut && !r.aborted && !r.bufferExceeded;
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export function foremanObservation(r, stdoutLimit = 8000) {
  const excerpt = (text, limit) => text.length <= limit ? text
    : text.slice(0, Math.floor(limit * .75)) + `\n[${text.length - limit} characters omitted; full output retained in the check record]\n` + text.slice(-Math.ceil(limit * .25));
  return {pass: clean(r), code: r.code, timedOut: Boolean(r.timedOut),
    stdout: excerpt(r.stdout, stdoutLimit), stderr: excerpt(r.stderr, 4000),
    stdoutChars: r.stdout.length, stderrChars: r.stderr.length,
    stdoutTruncated: r.stdout.length > stdoutLimit, stderrTruncated: r.stderr.length > 4000};
}
const brief = foremanObservation;

export function foremanWorkerReport(artifact) {
  const text = artifact?.result?.summary;
  if (typeof text !== 'string' || !text.trim()) return null;
  const limit = 2000, truncated = text.length > limit;
  return { source: 'worker-final-report', text: truncated
    ? text.slice(0, 1400) + '\n[excerpt; complete report in run.json]\n' + text.slice(-600) : text,
    truncated };
}

export const FOREMAN_HELP = `BANTAM FACTORY · experimental Astra supervisor

bantamfactory foreman --task "..." --verify "npm test" --endpoint http://127.0.0.1:8085
  [--with-codex terra|sol|astra|terra,sol,astra] [--no-local] [--out NEW-DIRECTORY] [--workspace DIR]
  [--timeout-seconds 600] [--max-jobs 12] [--max-decisions 40]
  [--max-supervisor-tokens 500000] [--dry-run] [--yes]

Opt-in cloud use: Astra receives the task, selected candidate files and worker
evidence using your installed Codex account. A requested Codex worker shares ONE
slot across all enabled models. Every worker runs inside BANTAM. Use --no-local
with --with-codex terra (or sol) to run entirely on Codex without a local server.
Docker is required; a loopback llama.cpp server is needed only for the local lane.
No downloads, Claude requests or global settings changes. All work is in a
private candidate; your source checkout is NOT modified. Review the candidate
and evidence before applying anything. Evidence is private, never auto-uploaded.
Token admission limit counts observed supervisor input+output after each turn;
it is NOT a hard provider spending cap. Worker usage is separately recorded.
`;

export function foremanPlan(args, cwd = process.cwd()) {
  if (typeof args.task !== 'string' || !args.task.trim() || typeof args.verify !== 'string' || !args.verify.trim()) throw Error('--task and --verify are required');
  const workspace = fs.realpathSync(path.resolve(cwd, args.workspace ?? '.'));
  if (!fs.statSync(workspace).isDirectory()) throw Error('workspace must be a directory');
  const output = path.resolve(cwd, args.out ?? path.join('.bantam', 'foreman', new Date().toISOString().replace(/[:.]/g, '-')));
  if (fs.existsSync(output)) throw Error('choose a NEW output directory');
  const codexWorkers = args['with-codex'] === undefined ? [] : String(args['with-codex']).split(',');
  if (codexWorkers.some(w => !Object.hasOwn(MODELS, w)) || new Set(codexWorkers).size !== codexWorkers.length) throw Error('--with-codex must name astra, sol or terra without duplicates');
  const localEnabled = args['no-local'] !== true;
  if (!localEnabled && !codexWorkers.length) throw Error('--no-local requires --with-codex');
  const integer = (key, fallback, max) => { const n = Number(args[key] ?? fallback); if (!Number.isInteger(n) || n < 1 || n > max) throw Error(`invalid --${key}`); return n; };
  return { workspace, output, task: args.task, verify: args.verify, endpoint: localEnabled ? normalizeCardEndpoint(args.endpoint ?? 'http://127.0.0.1:8085') : null, codexWorkers, localEnabled,
    timeoutMs: integer('timeout-seconds', 600, 1800) * 1000, maxJobs: integer('max-jobs', 12, 50), maxDecisions: integer('max-decisions', 40, 100), maxSupervisorTokens: integer('max-supervisor-tokens', 500000, 2000000) };
}

export async function foremanCommand(args, { cwd = process.cwd(), ask = null, log = console.log, run = runForeman } = {}) {
  if (args.help || !args.task) { log(FOREMAN_HELP); return 0; }
  const plan = foremanPlan(args, cwd);
  log(`Astra supervisor${plan.localEnabled ? ' + local BANTAM' : ''}${plan.codexWorkers.length ? ` + ONE BANTAM Codex worker slot (${plan.codexWorkers.join(', ')})` : ''}\nTask: ${plan.task}\nFinal check: ${plan.verify}\nSource unchanged: ${plan.workspace}\nPrivate output: ${plan.output}\nDeadline: ${plan.timeoutMs / 1000}s. Cloud context and account/quota use require consent.`);
  if (args['dry-run']) return 0;
  if (!args.yes && (!ask || !/^y(es)?$/i.test(String(await ask('Authorize this supervised run? [y/N] ')).trim()))) return 1;
  const result = await run(plan, { log });
  log(`${result.pass ? 'VERIFIED' : 'INCOMPLETE'} · ${(result.wallMs / 1000).toFixed(1)}s · evidence ${plan.output}`);
  return result.pass ? 0 : 1;
}

export async function cleanupForemanContainers(directory, { run = runProcess } = {}) {
  if (!fs.existsSync(directory)) return;
  for (const file of fs.readdirSync(directory)) {
    if (!/^(astra-codex|bantam-shell)-[a-z0-9-]+\.cid$/.test(file)) continue;
    const receipt = path.join(directory, file), stat = fs.lstatSync(receipt);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('unsafe container receipt');
    const id = fs.readFileSync(receipt, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('invalid owned container receipt');
    // A killed Docker client can leave a container in Created rather than
    // Running. `stop` succeeds without removing that state. Remove only this
    // exact receipt-owned container; candidate bytes live in retained binds.
    const attempts = [];
    let absent = false;
    for (let n = 0; n < 3 && !absent; n++) {
      const removed = await run('docker', ['rm','--force',id], { timeoutMs: 10000 });
      const inspected = await run('docker', ['container','inspect',id], { timeoutMs: 10000 });
      // The wrapper and Docker --rm may remove the same owned container at
      // once. Removal-in-progress is not proof of a leak OR proof of absence.
      absent = inspected.code !== 0 && !inspected.timedOut && !inspected.aborted
        && new RegExp(`No such (?:container|object):?\\s*${id}`, 'i').test(inspected.stderr);
      attempts.push({ removed, inspected });
      write(receipt + '.cleanup.json', { id, absent, attempts });
    }
    if (!absent) throw Error(`cannot confirm owned container absent; evidence: ${receipt}.cleanup.json`);
  }
}
export function foremanUsage(result) {
  const groups = { supervisor: result.calls.map(c => c.usage), local: result.jobs.filter(j => j.worker === 'local' && j.startedAt).map(j => j.result?.usage), codexWorker: result.jobs.filter(j => j.worker !== 'local' && j.startedAt).map(j => j.result?.usage) };
  const sum = rows => Object.fromEntries(['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'].map(k => [k, rows.every(r => r?.complete !== false && Number.isSafeInteger(r?.[k]) && r[k] >= 0) ? rows.reduce((n,r) => n + r[k], 0) : null]));
  return { ...Object.fromEntries(Object.entries(groups).map(([k,rows]) => [k, sum(rows)])), total: sum(Object.values(groups).flat()), costUsd: null };
}

export function integrateForemanCandidate({ candidate, before, sealed, transactionRoot, id, verification }) {
  const changes = planWorkspaceTransaction(before, sealed).changes;
  if (changes.length) {
    const tx = new WorkspaceTransaction({ workspace: candidate, baselineRoot: before, candidateRoot: sealed, transactionRoot, id });
    tx.prepare(); tx.apply(); tx.markVerified({ scope: 'worker snapshot only', verification });
    tx.markPromoted({ scope: 'candidate integration; final verification still required' }); tx.commit();
  }
  return changes.map(c => c.path);
}

export function readForemanEvidence(output, id, selector) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw Error('invalid evidence job');
  const request = JSON.parse(selector);
  if (!request || Object.keys(request).some(k => !['file','offset'].includes(k))) throw Error('evidence selector accepts file and byte offset');
  const file = request.file, offset = request.offset ?? 0;
  if (typeof file !== 'string' || !/^(run\.json|stdout\.log|stderr\.log|verification\.json|task\.md|feedback\.json|wire\/(exchanges\.jsonl|[0-9]{5}\.(request|response)\.body))$/.test(file)) throw Error('unsupported evidence file');
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('invalid evidence byte offset');
  const root = path.join(output, 'jobs', id), full = path.join(root, file);
  const realRoot = fs.realpathSync(root), real = fs.realpathSync(full);
  if (!real.startsWith(realRoot + path.sep) || fs.lstatSync(full).isSymbolicLink()) throw Error('evidence path escapes job');
  const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || offset > stat.size) throw Error('invalid evidence range');
    const buffer = Buffer.alloc(12004), count = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (count && (buffer[0] & 0xc0) === 0x80) throw Error('offset is inside a UTF-8 character; use previous nextOffset');
    let length = Math.min(12000, count);
    while (length < count && length > 0 && (buffer[length] & 0xc0) === 0x80) length--;
    return { file, offset, nextOffset: offset + length, totalBytes: stat.size, eof: offset + length >= stat.size, text: buffer.subarray(0, length).toString('utf8') };
  } finally { fs.closeSync(fd); }
}

// Parse in the worker's actual shell without executing the proposed command.
// A Bash-only verifier otherwise burns a complete job before it can ever pass.
export async function validateForemanVerifiers(jobs, check) {
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 8) throw Error('invalid job batch');
  for (const job of jobs) {
    if (typeof job?.verify !== 'string' || !job.verify.trim() || job.verify.length > 2000) throw Error('invalid job verify');
    const quoted = "'" + job.verify.replaceAll("'", "'\\''") + "'";
    const result = await check(`sh -n -c ${quoted}`);
    if (!clean(result)) throw Error(`Job verifier cannot parse in POSIX /bin/sh: ${String(job.id).slice(0, 48)}. Correct the command before enqueueing. ${result.stderr?.slice(-1200) ?? ''}`);
  }
}

export function foremanWorkerContext(job, dependencies, task = '') {
  // Do not flatten transport diagnostics into the product contract. In the
  // first live trial, `process.aborted:false` in a successful dependency's raw
  // receipt triggered an unrelated abort-lifecycle audit in a synchronous API.
  // Full receipts stay in the job evidence; the worker needs completion state
  // and integrated paths, not token coverage arrays or process-control keys.
  const outcomes = dependencies.map(j => ({ id: j.id, status: j.status,
    verified: j.result?.verification?.pass === true, integrated: j.result?.integrated === true,
    changedFiles: j.result?.changedFiles ?? [], snapshot: j.result?.snapshot ?? null,
    ...(j.result?.workerReport ? { workerReport: j.result.workerReport } : {}) }));
  return `${task ? `OVERALL OPERATOR BRIEF (project context):\n${task}\n\nYour assigned milestone contributes to this full goal. Preserve its applicable constraints; do not deliver unrelated milestones or claim the whole project is done. The supervisor owns final integration and full-task acceptance.\n\n` : ''}${job.resumeFrom ? `RECOVERY: Your workspace already contains the retained, UNVERIFIED work from ${job.resumeFrom}. Inspect it here; no sibling-job or host paths are accessible. Repair and verify it before completion. Other jobs may have integrated since this snapshot; conflicts are checked at integration.\n\n` : ''}SUPERVISOR DIAGNOSTIC CONTEXT (evidence, not additional deliverables):\n${job.context}\n\nACTUAL DEPENDENCY OUTCOMES (not additional API requirements):\n${JSON.stringify(outcomes)}`;
}
export function foremanWorkerTask(task, job, dependencies = null) {
  const contract = `YOUR ASSIGNED MILESTONE:\n${job.task}\n\nVerify this job with: ${job.verify}\nPreserve existing test coverage and the operator's acceptance criteria. A demonstrably incorrect generated fixture may be repaired without weakening its assertions; honor all files explicitly protected by the operator. Do not spawn other agents. Complete only this job; other jobs may own remaining features. Preserve applicable constraints from the overall brief supplied as project context. Retain executable assertions for behavior you change; printing a status is not an assertion.`;
  return dependencies === null ? contract : `${contract}\n\n${foremanWorkerContext(job, dependencies, task)}`;
}

export function foremanWorkerCommand({task, job, workspace, dir, endpoint, model, contextTokens, timeoutMs}) {
  const local = job.worker === 'local';
  if (!local && !Object.hasOwn(MODELS, job.worker)) throw Error('unknown worker model');
  const command = freshCommand({arm: local ? 'bantam-local-27b' : 'bantam-codex-astra',
    task: foremanWorkerTask(task, job), workspace, dir, endpoint, model, contextTokens, timeoutMs,
    verificationWorkspaceReadOnly: true});
  command.exe = process.execPath;
  if (!local) {
    command.args[command.args.indexOf('--model') + 1] = MODELS[job.worker];
    // Match the direct factory worker. Supervision should not silently raise
    // Sol's reasoning effort on top of Astra's planning and review.
    command.args[command.args.indexOf('--codex-effort') + 1] = 'medium';
  }
  command.args.push('--supporting-context-file', path.join(dir, 'supporting-context.txt'), '--supervisor-control', dir);
  command.args[command.args.indexOf('--verify') + 1] = job.verify;
  return command;
}

// Recovery is a new private worker on retained bytes, never a promotion. Its
// original baseline makes the normal integration transaction detect newer,
// overlapping candidate edits while preserving independent integrations.
export function materializeForemanWorker({store, candidate, job, recovery, ws, before}) {
  if (job.resumeFrom) {
    if (recovery?.id !== job.resumeFrom || !['failed','cancelled'].includes(recovery.status)
        || !recovery.finishedAt || !recovery.result?.recoverySnapshot || !recovery.result?.snapshot) throw Error('invalid recovery source');
    store.materialize(recovery.result.recoverySnapshot, ws);
    store.materialize(recovery.result.snapshot, before);
    return {commit: recovery.result.snapshot, recoveredFrom: recovery.id, recoverySnapshot: recovery.result.recoverySnapshot};
  }
  const snapshot = store.capture(candidate, {message: `dispatch ${job.id}`});
  store.materialize(snapshot.commit, ws); store.materialize(snapshot.commit, before);
  return snapshot;
}

export async function runForeman(plan, { log = () => {} } = {}) {
  const startedAt = new Date().toISOString(), started = Date.now(), ac = new AbortController();
  const modelIdentity = plan.localEnabled === false ? null : await inspectLocalModel(plan.endpoint);
  fs.mkdirSync(plan.output, { recursive: true, mode: 0o700 });
  const journal = new LaneJournal({ root: plan.output, laneId: 'foreman' });
  const emit = (type, payload) => { journal.append(type, payload); if (['job.started','job.finished'].includes(type)) log(`${type}: ${payload.id} ${payload.status ?? ''}`); };
  write(path.join(plan.output, 'plan.json'), { ...plan, startedAt, modelIdentity, supervisor: 'gpt-6-astra', supervisorEffort: 'medium', codexWorkerEffort: 'medium', workerSlots: { local: plan.localEnabled === false ? 0 : 1, codex: plan.codexWorkers.length ? 1 : 0 } });
  const store = new WorkspaceStore(path.join(plan.output, 'store'));
  const baseline = store.capture(plan.workspace, { excludePaths: [plan.output], message: 'foreman original source' });
  const candidate = path.join(plan.output, 'candidate'); store.materialize(baseline.commit, candidate);
  const instructionScope = captureInstructionScope(candidate, plan.task);
  const controlRoom = path.join(plan.output, 'control-room'), supervisorCids = path.join(plan.output, 'supervisor-containers');
  fs.mkdirSync(controlRoom); fs.mkdirSync(supervisorCids);
  const supervisor = new CodexAppServer({ command: path.join(ROOT, 'scripts/astra-container-cli.mjs'), cwd: controlRoom,
    model: 'gpt-6-astra', effort: 'medium', timeoutMs: plan.timeoutMs, threadMode: 'run', promptMode: 'delta',
    threadConfig: { 'features.multi_agent': false, web_search: 'disabled' },
    env: cleanFightEnv({ ASTRA_CONTAINER_CID_DIR: supervisorCids, ASTRA_CONTAINER_TIMEOUT_SECONDS: String(plan.timeoutMs / 1000) }) });
  const runToken = supervisor.beginRun(), timer = setTimeout(() => ac.abort(), Math.max(1, plan.timeoutMs - (Date.now() - started)));
  const stop = () => ac.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const remaining = () => Math.max(1, plan.timeoutMs - (Date.now() - started));
  const check = async (ws, command, signal = ac.signal) => runShellProcess(ws, command, { shellSandbox: 'docker', shellNetwork: false, workspaceReadOnly: true, timeoutMs: Math.min(60000, remaining()), signal });
  const execute = async (job, dependencies, signal, progress, recovery) => {
    const dir = path.join(plan.output, 'jobs', job.id); fs.mkdirSync(dir, { recursive: true });
    const ws = path.join(dir, 'ws'), before = path.join(dir, 'baseline');
    const snapshot = materializeForemanWorker({store, candidate, job, recovery, ws, before});
    const task = foremanWorkerTask(plan.task, job, dependencies);
    fs.writeFileSync(path.join(dir, 'task.md'), task, { mode: 0o600 });
    const cids = path.join(dir, 'containers'), sessions = path.join(dir, 'sessions'); fs.mkdirSync(cids, { mode: 0o700 }); fs.mkdirSync(sessions, { mode: 0o700 });
    createWorkerControl(dir, ws, {instructionScope, task: foremanWorkerTask(plan.task, job)});
    let recorder = null, result, usage = null, settlement = null, lastProgress = 0, lastFeedback = '';
    try {
      let command;
      if (job.worker === 'local') {
        if (plan.localEnabled === false) throw Error('local worker disabled');
        const current = await inspectLocalModel(plan.endpoint);
        if (current.id !== modelIdentity.id) throw Error('local model changed');
        recorder = await startModelRecorder({ upstream: plan.endpoint, output: path.join(dir, 'wire') });
        command = foremanWorkerCommand({ task: plan.task, job, workspace: ws, dir, endpoint: recorder.endpoint, model: current.id, contextTokens: current.props?.default_generation_settings?.n_ctx, timeoutMs: remaining() });
      } else {
        command = foremanWorkerCommand({ task: plan.task, job, workspace: ws, dir, timeoutMs: remaining() });
      }
      fs.writeFileSync(path.join(dir, 'supporting-context.txt'), foremanWorkerContext(job, dependencies, plan.task), { mode: 0o600 });
      write(path.join(dir, 'command.json'), command);
      result = await runProcess(command.exe, command.args, { cwd: ws, env: cleanFightEnv({ ...command.env,
        BANTAM_CONFIG_DIR: path.join(dir, 'config'), BANTAM_SHELL_CID_DIR: cids, ASTRA_CONTAINER_CID_DIR: cids, ASTRA_CONTAINER_SESSION_DIR: sessions,
        ASTRA_CONTAINER_TIMEOUT_SECONDS: String(Math.max(1, Math.ceil(remaining() / 1000))) }), timeoutMs: remaining(), signal, maxBuffer: 32 * 1024 * 1024,
        onOutput: ({ stream, text }) => {
          fs.appendFileSync(path.join(dir, `${stream}.log`), text, { mode: 0o600 });
          if (Date.now() - lastProgress >= 1000) {
            const feedback = readWorkerFeedback(dir, ws), serialized = JSON.stringify(feedback);
            if (feedback && serialized !== lastFeedback) { progress(feedback); lastFeedback = serialized; }
            lastProgress = Date.now();
          }
        } });
    } finally {
      if (recorder) { usage = await recorder.close(); settlement = await settleServerCounters(plan.endpoint); write(path.join(dir, 'settlement.json'), settlement); if (settlement.observedBusy && !settlement.settled) ac.abort(); }
      try { await cleanupForemanContainers(cids); } catch (error) { ac.abort(); throw error; }
    }
    const workerArtifact = await readJsonFile(path.join(dir, 'run.json')).catch(() => null);
    if (job.worker !== 'local') {
      usage = cornerUsage('bantam-codex', {armDir: dir, run: workerArtifact});
      if (usage) usage = {...usage, freshInputTokens: usage.inputTokens - usage.cacheHitTokens};
      if (!clean(result) && usage) usage = { ...usage, complete: false, reason: 'worker process did not complete; recorded responses may omit in-flight usage' };
    }
    const accepted = acceptedBantamCompletion(workerArtifact);
    const after = store.capture(ws, {message: `settled ${job.id}`});
    const checked = await check(ws, job.verify, signal); write(path.join(dir, 'verification.json'), checked);
    const verification = brief(checked);
    const record = { pass: clean(result) && accepted && verification.pass, acceptedCompletion: accepted,
      workerReport: foremanWorkerReport(workerArtifact), verification, usage, integrated: false, snapshot: snapshot.commit,
      recoverySnapshot: after.commit, recoveredFrom: snapshot.recoveredFrom ?? null,
      process: { code: result.code, timedOut: Boolean(result.timedOut), aborted: Boolean(result.aborted), bufferExceeded: Boolean(result.bufferExceeded) } };
    if (record.pass && !signal.aborted && !ac.signal.aborted) {
      // Capture immutable candidate bytes before transaction planning. Every
      // integration below is synchronous, so the two worker completions cannot
      // interleave their shared-candidate writes.
      const sealed = path.join(dir, 'sealed'); store.materialize(after.commit, sealed);
      try {
        record.changedFiles = integrateForemanCandidate({ candidate, before, sealed, transactionRoot: path.join(plan.output, 'integrations'), id: job.id, verification });
        record.integrated = true;
      } catch (error) { record.pass = false; record.conflict = error.message; }
    }
    if (signal.aborted || ac.signal.aborted) record.pass = false;
    write(path.join(dir, 'result.json'), record); return record;
  };
  const safeFile = relative => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || (p !== '.' && p.startsWith('.')))) throw Error('only nonhidden candidate paths are readable');
    const file = fs.realpathSync(path.join(candidate, relative || '.'));
    if (file !== candidate && !file.startsWith(candidate + path.sep)) throw Error('path leaves candidate'); return file;
  };
  const inspect = async (action, queue) => {
    if (action.action === 'list') return fs.readdirSync(safeFile(action.target), { withFileTypes: true }).filter(e => !e.name.startsWith('.')).slice(0,300).map(e => ({ name: e.name, directory: e.isDirectory() }));
    if (action.action === 'read') { const file = safeFile(action.target); if (!fs.statSync(file).isFile() || fs.statSync(file).size > 48000) throw Error('read requires a file no larger than 48KB'); return fs.readFileSync(file, 'utf8'); }
    if (action.action === 'evidence') { const j = queue.jobs.find(j => j.id === action.target); if (!j) throw Error('unknown job');
      if (action.text) return readForemanEvidence(plan.output, j.id, action.text);
      const dir = path.join(plan.output, 'jobs', j.id), wire = path.join(dir, 'wire');
      return { status: j.status, result: j.result ?? null, files: ['run.json','stdout.log','stderr.log','verification.json','task.md','feedback.json'].filter(f => fs.existsSync(path.join(dir,f))),
        wireFiles: fs.existsSync(wire) ? fs.readdirSync(wire).filter(f => /^[0-9]{5}\.(request|response)\.body$/.test(f)).map(f => `wire/${f}`) : [],
        read: 'Use evidence with the same target and text as JSON: {"file":"run.json","offset":0}. Pages retain byte offsets; use nextOffset until eof.' };
    }
    // Verify a snapshot: workers may integrate while this check is running.
    const snap = store.capture(candidate), checkDir = fs.mkdtempSync(path.join(plan.output, 'check-')); store.materialize(snap.commit, path.join(checkDir, 'ws'));
    // Review commands commonly read implementation + tests together. The old
    // unmarked 8K tail silently removed the implementation, causing another
    // full read. Keep small reviews whole; mark any remaining excerpt explicitly.
    const r = await check(path.join(checkDir, 'ws'), action.text); write(path.join(checkDir, 'result.json'), r); return { snapshot: snap.commit, ...brief(r, 24000) };
  };
  let result;
  let cleanup = { pass: false, status: 'pending' };
  try {
    const baselineCheck = await check(candidate, plan.verify);
    write(path.join(plan.output, 'baseline-verification.json'), baselineCheck);
    result = await driveForeman({ ...plan, initial: { files: fs.readdirSync(candidate), finalVerify: plan.verify, baselineVerification: brief(baselineCheck), wallBudgetMs: remaining(), isolation: 'separate snapshots; integrated candidate is read-only to supervisor', liveSteering: 'BANTAM workers receive supervisor corrections between actions. Worker feedback includes actual tool observations; read feedback.json for the current snapshot.' }, model: supervisor, execute, inspect,
      validateJobs: jobs => validateForemanVerifiers(jobs, command => check(candidate, command)),
      steer: (job, text) => queueWorkerSteering(path.join(plan.output, 'jobs', job.id), path.join(plan.output, 'jobs', job.id, 'ws'), text),
      verify: async () => { const r = await check(candidate, plan.verify); write(path.join(plan.output, 'final-verification.json'), r); return brief(r); }, emit, signal: ac.signal });
    // Never let teardown erase completed work, usage or the supervisor finish.
    write(path.join(plan.output, 'completion-checkpoint.json'), result);
  } finally {
    ac.abort(); clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try {
      supervisor.endRun(runToken); supervisor.close(); await cleanupForemanContainers(supervisorCids);
      cleanup = { pass: true, status: 'confirmed-absent' };
    } catch (error) { cleanup = { pass: false, status: 'unconfirmed', error: String(error.message ?? error) }; }
    write(path.join(plan.output, 'cleanup.json'), cleanup);
  }
  const sourceUnchanged = store.treeForWorkspace(plan.workspace, { excludePaths: [plan.output] }).tree === baseline.tree;
  const wallMs = Date.now() - started;
  const lanes = Object.fromEntries(['local','codex'].map(lane => {
    const jobs = result.jobs.filter(j => j.lane === lane && j.startedAt), occupiedMs = jobs.reduce((n,j) => n + (j.wallMs ?? 0), 0);
    return [lane, { jobs: jobs.length, occupiedMs, utilization: occupiedMs / wallMs, queueWaitMs: jobs.reduce((n,j) => n + j.startedAt - j.queuedAt, 0) }];
  }));
  result = { ...result, acceptedBeforeCleanup: result.pass, cleanup, pass: result.pass && sourceUnchanged && cleanup.pass, sourceUnchanged, schema: 'bantam.foreman-run.v1', startedAt, wallMs, baseline, candidate, usage: foremanUsage(result),
    timing: { scope: 'end-to-end including setup, verification, integration and cleanup; lane occupation is not pure GPU generation time', lanes, supervisorCallMs: result.calls.reduce((n,c) => n + c.wallMs, 0) } };
  write(path.join(plan.output, 'result.json'), result); emit('foreman.finished', { pass: result.pass, wallMs: result.wallMs, usage: result.usage }); return result;
}
