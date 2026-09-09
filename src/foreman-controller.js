import { ForemanQueue } from './foreman-queue.js';

export const FOREMAN_INSTRUCTIONS = `You are Astra, the supervisor of a BANTAM factory.
You own decomposition, context selection, review and integration decisions. Every worker runs INSIDE BANTAM. The optional local lane uses a fast 27B; enabled Codex workers share ONE cloud-worker slot regardless of model. Only workers listed in the configuration are available. You are the other, and only, Codex supervisor. Never spawn native agents or call native tools; return one JSON action for this controller.
Keep useful work in flight: enqueue bounded jobs, then inspect evidence or plan independent work while they run. Dependencies must reference earlier jobs and wait for their actual verified results. Do not manufacture expected outputs or presume a queued job has succeeded. You own completion of the full original task; each worker owns only its assigned milestone and receives the original brief as project context. Include the applicable interfaces, constraints and acceptance cases in that milestone.
Inspect the starter and its checks before assigning work. Scale decomposition to the actual task. A coherent utility, focused bug fix or small module can be ONE complete worker job with its retained behavior tests; do not split it into artificial partial APIs or separate testing jobs. This avoids repeated context setup and tests of temporary behavior that later workers must undo. For a larger product spanning multiple components or substantial UI, start with one runnable vertical slice and its retained behavior assertion, then bounded feature groups, presentation and final review. A whole large product followed by a test-only job delays review until the budget is gone; calling that a core milestone does not make it small. Keep each milestone small enough to review early, and reserve time for repair. Do not forbid a worker from retaining the checks needed to prove its own changes. Temporary console printouts and package/syntax checks do not establish behavior. Test deterministic fixtures, including how fixtures are actually installed, rather than searching random inputs until one looks successful.
For a settled failed or cancelled job, enqueue a repair with resumeFrom set to its ID (empty otherwise). The controller restores its unverified files inside the new worker sandbox; never ask a worker to copy sibling jobs or host paths. Recovery uses the original baseline, cannot also declare dependsOn, and must pass fresh verification and conflict checks before integration. Read result recoveryAvailable before requesting it.
Every job needs its task, context (relevant contracts/files/edge cases, not unsupported conclusions), and a runnable verification command. Verification and check commands run in POSIX /bin/sh, not Bash: use portable syntax (no process substitution). Admission syntax-checks verification before starting workers. A syntax check alone does not exercise behavior; prefer an executable behavioral check. Job IDs start with a lowercase letter, followed by lowercase letters, digits or hyphens; maximum 48 characters, no underscores. Each worker edits its own snapshot. Verified nonconflicting changes are integrated; a conflict is a failed job requiring a fresh job, never a silent overwrite. Independent cloud and local jobs may overlap; do not give them overlapping edits unless dependent. Tests are evidence, not permission to weaken the contract.
Snapshots do NOT update underneath running workers. If another worker fixes a broken test or contract needed by an in-flight job, inspect its live progress. Cancel stale work and submit a fresh job after the prerequisite integrates. Cancellation retains evidence and occupies the slot until cleanup finishes; it cannot merge cancelled work. Use job-focused verification for independently developed components, and the operator's full suite for final integration. Do not require a worker to satisfy a known broken test owned by another in-flight job. Live output is unverified evidence, not a completion receipt.
Treat context and process as your FIRST diagnostic hypothesis, not an infallible explanation. When a worker fails, inspect its actual request/response and test evidence before guessing why. Identify missing contracts, misleading working notes, stale snapshots, inadequate probes or ambiguous acceptance criteria. Give the worker the missing evidence and a bounded repair, rather than repeatedly spending frontier tokens doing all its work yourself.
You can commission factory machinery as jobs: task-local fixtures, deterministic checks, reusable helpers, station contracts and poka-yoke that make mistakes harder to repeat. A proposed jig must reproduce the defect and reject a known wrong result without weakening the original acceptance criteria; check a correct case too. Prefer a reusable improvement when it pays back its construction/review cost. Do not overbuild machinery for a job that is already clear. Record proposed shared-factory improvements in the candidate as proposals with evidence, not as automatic changes to the running BANTAM harness. Never change the benchmark grader, hide a failed attempt, or promote a shared station based solely on the same case that inspired it. Shared-factory promotion requires a separate versioned validation run.
Actions: enqueue (jobs array, up to 8), list (target relative directory), read (target relative file), evidence (target job ID), check (text shell command in read-only/no-network candidate), steer (target running BANTAM job ID, text specific evidence and correction for its next turn), cancel (target queued or running job ID), wait (wait for worker review or completion), finish (text final explanation). Use empty jobs/target/text where unused. Steer a worker promptly when its observations show a bad fixture, repeated probing or untested claims; it retains its files and context. Steering is queued, not proof of delivery or correctness; inspect subsequent worker evidence. Do not repeatedly poll when there is no useful work: wait. Failures and settled jobs wake you immediately; routine progress is reviewed at most every two minutes. Read/check see a stable integrated candidate, never a worker's half-written files. Review the delivered changes and retained behavior assertions against the original task. Use additional checks for a specific coverage gap; do not repeat an identical successful check on unchanged bytes. Finish itself runs the operator's final check on the integrated candidate and returns failures for repair. It is accepted only with no outstanding work, at least one verified job and that final check passing. Never treat your final message as a completion receipt.`;

const strings = { type: 'array', items: { type: 'string' } };
export const FOREMAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['enqueue','list','read','evidence','check','steer','cancel','wait','finish'] },
    jobs: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' }, worker: { type: 'string', enum: ['local','astra','sol','terra'] }, task: { type: 'string' }, context: { type: 'string' }, verify: { type: 'string' }, dependsOn: strings, resumeFrom: { type: 'string' } },
      required: ['id','worker','task','context','verify','dependsOn','resumeFrom'] } },
    target: { type: 'string' }, text: { type: 'string' },
  }, required: ['action','jobs','target','text'],
};
export function summarizeJobs(queue) {
  return queue.snapshot().map(j => ({ id: j.id, worker: j.worker, status: j.status,
    // Settled receipts replace live, unverified output. Replaying both included
    // the same test log twice and kept stale half-written observations current.
    progress: j.status === 'running' ? j.progress ?? null : null, cancelRequested: j.cancelRequested ?? false,
    dependsOn: j.dependsOn, resumeFrom: j.resumeFrom ?? '', queuedAt: j.queuedAt, startedAt: j.startedAt ?? null,
    wallMs: j.wallMs ?? null, result: j.result ? {
      recoveryAvailable: ['failed','cancelled'].includes(j.status) && Boolean(j.finishedAt && j.result.recoverySnapshot),
      pass: j.result.pass, integrated: j.result.integrated ?? false, changedFiles: j.result.changedFiles ?? [],
      error: j.result.error ?? j.result.conflict ?? null, acceptedCompletion: j.result.acceptedCompletion ?? null,
      verification: j.result.verification ? { pass: j.result.verification.pass, code: j.result.verification.code,
        stdoutTail: j.result.verification.stdout?.slice(-2000) ?? '', stdoutTruncated: (j.result.verification.stdout?.length ?? 0) > 2000, stderrTail: j.result.verification.stderr?.slice(-2000) ?? '',
        fullEvidenceAvailable: true } : null,
      usage: j.result.usage ? Object.fromEntries(['inputTokens','outputTokens','cacheHitTokens','freshInputTokens'].map(k => [k,j.result.usage[k] ?? null])) : null,
    } : null }));
}
function settledState(rows) {
  return JSON.stringify(rows.map(({progress, ...job}) => job));
}
function failureEvidence(rows) {
  return JSON.stringify(rows.flatMap(job => {
    const evidence = job.progress?.evidence;
    const observation = evidence?.observation;
    const failed = /(?:^|\n)(?:Shell exit (?!0(?:\n|$))|\[[^\]\n]*(?:fail|error|scope|blocked)[^\]\n]*\])/i.test(observation?.text ?? '');
    let verificationFailed = false;
    try { const v=JSON.parse(evidence?.verification?.text); verificationFailed = v.status === 'fail' || v.status === 'error'; } catch {}
    return failed || verificationFailed ? [{id:job.id, observation:failed ? observation : null,
      verification:verificationFailed ? evidence.verification : null}] : [];
  }));
}
export async function waitForForemanUpdate(queue, signal, {reviewIntervalMs = 120000, now = Date.now} = {}) {
  const rows = queue.snapshot(), before = JSON.stringify(rows), settled = settledState(rows), failures = failureEvidence(rows), started = now();
  do {
    const remaining = reviewIntervalMs - (now() - started);
    await queue.wait(remaining > 0 ? remaining : 30000);
    if (signal?.aborted) throw Error('foreman deadline or cancellation');
    const current = queue.snapshot(), nextFailures = failureEvidence(current);
    // Every action start used to wake Astra, including reads and green checks.
    // Keep recording everything; ask the supervisor to review routine progress
    // at most once per interval. New failures and settled jobs wake immediately.
    if (settledState(current) !== settled || (nextFailures !== '[]' && nextFailures !== failures)) return;
    if (JSON.stringify(current) !== before && now() - started >= reviewIntervalMs) return;
  } while (queue.pending);
}

export async function driveForeman({ task, initial, model, execute, inspect, verify, emit = () => {},
  signal, validateJobs = async () => {}, steer = null, codexWorkers = [], localEnabled = true, maxJobs = 12, maxDecisions = 40, maxSupervisorTokens = 150000 }) {
  const queue = new ForemanQueue({ execute, emit, signal, codexWorkers, localEnabled, maxJobs });
  // The transport binds FOREMAN_INSTRUCTIONS as the thread's base instructions.
  // Sending the same policy in user context doubles its cost on every request.
  let prompt = `OPERATOR TASK:\n${task}\n\nCONFIGURATION AND INITIAL MATERIAL:\n${JSON.stringify(initial)}\nEnabled workers: ${[...queue.workers].join(', ')}\nJob limit: ${maxJobs}; supervisor decision limit: ${maxDecisions}.\n`;
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
      const measured = response.usage?.complete !== false && raw && ['inputTokens','outputTokens','cachedInputTokens'].every(k => Number.isSafeInteger(raw[k]) && raw[k] >= 0) && raw.cachedInputTokens <= raw.inputTokens;
      const usage = measured ? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens,
        cacheHitTokens: raw.cachedInputTokens, freshInputTokens: raw.inputTokens - raw.cachedInputTokens } : null;
      const call = { turn, startedAt: start, wallMs: Date.now() - start, content: response.content, usage, rawUsage: raw ?? null, codexThread: response.codexThread ?? null,
        codexUsageEvidence: response.codexUsageEvidence ?? null, codexPromptDelivery: response.codexPromptDelivery ?? null };
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
        else if (action.action === 'steer') {
          const job = queue.jobs.find(j => j.id === action.target);
          if (!job || job.status !== 'running' || job.cancelRequested) throw Error('steering requires a running BANTAM job');
          if (!steer || !action.text.trim() || action.text.length > 8000) throw Error('steering unavailable or invalid message (1..8000 characters)');
          observation = await steer(job, action.text);
        }
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
