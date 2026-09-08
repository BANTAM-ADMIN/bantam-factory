import { ForemanQueue } from './foreman-queue.js';

export const FOREMAN_INSTRUCTIONS = `You are Astra, the supervisor of a BANTAM factory.
You own decomposition, context selection, review and integration decisions. The local worker is a fast 27B INSIDE BANTAM, not a bare completion model. An optional Codex worker shares ONE cloud-worker slot regardless of model. You are the other, and only, Codex supervisor. Never spawn native agents or call native tools; return one JSON action for this controller.
Keep useful work in flight: enqueue several bounded jobs in one action, then inspect evidence or plan independent work while they run. Dependencies must reference earlier jobs and wait for their actual verified results. Do not manufacture expected outputs or presume a queued job has succeeded. The full original task remains binding for every worker.
Every job needs its task, context (relevant contracts/files/edge cases, not unsupported conclusions), and a runnable verification command. Verification and check commands run in POSIX /bin/sh, not Bash: use portable syntax (no process substitution). Admission syntax-checks verification before starting workers. A syntax check alone does not exercise behavior; prefer an executable behavioral check. Job IDs start with a lowercase letter, followed by lowercase letters, digits or hyphens; maximum 48 characters, no underscores. Each worker edits its own snapshot. Verified nonconflicting changes are integrated; a conflict is a failed job requiring a fresh job, never a silent overwrite. Independent cloud and local jobs may overlap; do not give them overlapping edits unless dependent. Tests are evidence, not permission to weaken the contract.
Snapshots do NOT update underneath running workers. If another worker fixes a broken test or contract needed by an in-flight job, inspect its live progress. Cancel stale work and submit a fresh job after the prerequisite integrates. Cancellation retains evidence and occupies the slot until cleanup finishes; it cannot merge cancelled work. Use job-focused verification for independently developed components, and the operator's full suite for final integration. Do not require a worker to satisfy a known broken test owned by another in-flight job. Live output is unverified evidence, not a completion receipt.
Treat context and process as your FIRST diagnostic hypothesis, not an infallible explanation. When a worker fails, inspect its actual request/response and test evidence before guessing why. Identify missing contracts, misleading working notes, stale snapshots, inadequate probes or ambiguous acceptance criteria. Give the worker the missing evidence and a bounded repair, rather than repeatedly spending frontier tokens doing all its work yourself.
You can commission factory machinery as jobs: task-local fixtures, deterministic checks, reusable helpers, station contracts and poka-yoke that make mistakes harder to repeat. A proposed jig must reproduce the defect and reject a known wrong result without weakening the original acceptance criteria; check a correct case too. Prefer a reusable improvement when it pays back its construction/review cost. Do not overbuild machinery for a job that is already clear. Record proposed shared-factory improvements in the candidate as proposals with evidence, not as automatic changes to the running BANTAM harness. Never change the benchmark grader, hide a failed attempt, or promote a shared station based solely on the same case that inspired it. Shared-factory promotion requires a separate versioned validation run.
Actions: enqueue (jobs array, up to 8), list (target relative directory), read (target relative file), evidence (target job ID), check (text shell command in read-only/no-network candidate), cancel (target queued or running job ID), wait (wait for a worker transition, up to 30 seconds), finish (text final explanation). Use empty jobs/target/text where unused. Do not repeatedly poll when there is no useful work: wait. Read/check see a stable integrated candidate, never a worker's half-written files. Finish is accepted only with no outstanding work, at least one verified job and the operator's final check passing. Never treat your final message as a completion receipt.`;

const strings = { type: 'array', items: { type: 'string' } };
export const FOREMAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['enqueue','list','read','evidence','check','cancel','wait','finish'] },
    jobs: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' }, worker: { type: 'string', enum: ['local','astra','sol','terra'] }, task: { type: 'string' }, context: { type: 'string' }, verify: { type: 'string' }, dependsOn: strings },
      required: ['id','worker','task','context','verify','dependsOn'] } },
    target: { type: 'string' }, text: { type: 'string' },
  }, required: ['action','jobs','target','text'],
};
export function summarizeJobs(queue) {
  return queue.snapshot().map(j => ({ id: j.id, worker: j.worker, status: j.status,
    progress: j.progress ?? null, cancelRequested: j.cancelRequested ?? false,
    dependsOn: j.dependsOn, queuedAt: j.queuedAt, startedAt: j.startedAt ?? null,
    wallMs: j.wallMs ?? null, result: j.result ? {
      pass: j.result.pass, integrated: j.result.integrated ?? false, changedFiles: j.result.changedFiles ?? [],
      error: j.result.error ?? j.result.conflict ?? null, acceptedCompletion: j.result.acceptedCompletion ?? null,
      verification: j.result.verification ? { pass: j.result.verification.pass, code: j.result.verification.code,
        stdoutTail: j.result.verification.pass ? '' : j.result.verification.stdout?.slice(-2000) ?? '', stderrTail: j.result.verification.stderr?.slice(-2000) ?? '',
        fullEvidenceAvailable: true } : null,
      usage: j.result.usage ? Object.fromEntries(['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'].map(k => [k,j.result.usage[k] ?? null])) : null,
    } : null }));
}
export async function waitForForemanUpdate(queue, signal) {
  const before = JSON.stringify(queue.snapshot());
  do {
    await queue.wait();
    if (signal?.aborted) throw Error('foreman deadline or cancellation');
  } while (queue.pending && JSON.stringify(queue.snapshot()) === before);
}

export async function driveForeman({ task, initial, model, execute, inspect, verify, emit = () => {},
  signal, validateJobs = async () => {}, codexWorkers = [], maxJobs = 12, maxDecisions = 40, maxSupervisorTokens = 150000 }) {
  const queue = new ForemanQueue({ execute, emit, signal, codexWorkers, maxJobs });
  let prompt = `${FOREMAN_INSTRUCTIONS}\n\nOPERATOR TASK:\n${task}\n\nCONFIGURATION AND INITIAL MATERIAL:\n${JSON.stringify(initial)}\nEnabled workers: ${['local', ...codexWorkers].join(', ')}\nJob limit: ${maxJobs}; supervisor decision limit: ${maxDecisions}.\n`;
  const calls = [], priorQueue = new Map(), started = Date.now(); let final = null, error = null, consumed = 0;
  try {
    for (let turn = 1; turn <= maxDecisions; turn++) {
      if (signal?.aborted) throw Error('foreman deadline or cancellation');
      if (consumed >= maxSupervisorTokens) throw Error('supervisor observed-token admission limit reached');
      const changes = summarizeJobs(queue).filter(row => {
        const serialized = JSON.stringify(row), changed = priorQueue.get(row.id) !== serialized;
        priorQueue.set(row.id, serialized); return changed;
      });
      const budget = { now: Date.now(), decisionsRemaining: maxDecisions - turn + 1,
        observedTokenAllowanceRemaining: maxSupervisorTokens - consumed,
        wallMsRemaining: Number.isFinite(initial?.wallBudgetMs) ? Math.max(0, initial.wallBudgetMs - (Date.now() - started)) : null };
      prompt += `\nQUEUE UPDATES (replace earlier state for these IDs; unlisted jobs unchanged) ${JSON.stringify(changes)}\nCONTROLLER BUDGET ${JSON.stringify(budget)}\nToken allowance includes cached input; reserve room for final review and finish. Choose your next action.\n`;
      emit('supervisor.request', { turn, prompt });
      const start = Date.now();
      let response;
      try { response = await model.complete(prompt, { signal, outputSchema: FOREMAN_SCHEMA, baseInstructions: FOREMAN_INSTRUCTIONS }); }
      catch (error) { const failed = { turn, startedAt: start, wallMs: Date.now() - start, usage: null, error: String(error.message ?? error) }; calls.push(failed); emit('supervisor.response', failed); throw error; }
      const raw = response.rawUsage;
      const measured = raw && ['inputTokens','outputTokens','cachedInputTokens'].every(k => Number.isSafeInteger(raw[k]) && raw[k] >= 0) && raw.cachedInputTokens <= raw.inputTokens;
      const usage = measured ? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens,
        cacheHitTokens: raw.cachedInputTokens, freshInputTokens: raw.inputTokens - raw.cachedInputTokens } : null;
      const call = { turn, startedAt: start, wallMs: Date.now() - start, content: response.content, usage, rawUsage: raw ?? null, codexThread: response.codexThread ?? null };
      calls.push(call); emit('supervisor.response', call);
      // Missing receipts are not zero spend. Preserve the failed trajectory and
      // stop further cloud admission rather than claiming a budget was honored.
      if (!usage) throw Error('supervisor usage receipt missing or invalid');
      consumed += usage.inputTokens + usage.outputTokens;
      let observation;
      try {
        const action = JSON.parse(response.content);
        if (!action || Object.keys(action).some(k => !['action','jobs','target','text'].includes(k)) || !Array.isArray(action.jobs) || typeof action.target !== 'string' || typeof action.text !== 'string') throw Error('invalid supervisor action');
        if (action.action !== 'enqueue' && action.jobs.length) throw Error('only enqueue accepts jobs');
        if (action.action === 'enqueue') { await validateJobs(action.jobs); queue.submit(action.jobs); observation = { admitted: action.jobs.map(j => j.id) }; }
        else if (action.action === 'cancel') { queue.cancel(action.target); observation = { cancellationRequested: action.target }; }
        else if (action.action === 'wait') { await waitForForemanUpdate(queue, signal); observation = { waited: true }; }
        else if (['read','list','evidence','check'].includes(action.action)) observation = await inspect(action, queue);
        else if (action.action === 'finish') {
          if (queue.pending) throw Error('cannot finish with outstanding jobs');
          if (!queue.jobs.some(j => j.status === 'passed')) throw Error('cannot finish without verified worker evidence');
          observation = await verify();
          if (observation.pass === true) { final = { message: action.text, verification: observation }; break; }
        } else throw Error('unknown supervisor action');
      } catch (e) { observation = { error: String(e.message ?? e) }; }
      emit('supervisor.observation', { turn, observation });
      // Codex retains its own response; only append new authoritative input.
      prompt += `\nCONTROLLER OBSERVATION ${JSON.stringify(observation)}\n`;
    }
  } catch (e) { error = String(e.message ?? e); }
  finally { await queue.close(); }
  return { pass: Boolean(final), final, error: error ?? (final ? null : 'supervisor decision limit reached'), jobs: queue.snapshot(), calls };
}
