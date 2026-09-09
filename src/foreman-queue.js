// One local worker and, only when enabled, ONE shared Codex worker slot.
// The supervisor may keep submitting while the worker executes; never spin up
// a second local inference lane to make the utilization chart look better.
export class ForemanQueue {
  constructor({ execute, maxJobs = 12, codexWorkers = [], signal, emit = () => {} }) {
    if (typeof execute !== 'function') throw Error('queue requires an executor');
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 50) throw Error('invalid job limit');
    if (!Array.isArray(codexWorkers) || codexWorkers.some(w => !['astra','sol','terra'].includes(w)) || new Set(codexWorkers).size !== codexWorkers.length) throw Error('invalid Codex worker allowlist');
    this.execute = execute; this.maxJobs = maxJobs; this.signal = signal; this.emit = emit;
    this.workers = new Set(['local', ...codexWorkers]);
    this.jobs = []; this.active = new Map(); this.controls = new Map(); this.waiters = new Set(); this.closed = false;
  }
  submit(batch) {
    if (this.closed || this.signal?.aborted) throw Error('queue closed');
    if (!Array.isArray(batch) || !batch.length || batch.length > 8 || this.jobs.length + batch.length > this.maxJobs) throw Error('job admission limit exceeded');
    const known = new Set(this.jobs.map(j => j.id));
    const rows = batch.map(input => {
      if (!input || Object.keys(input).some(k => !['id','worker','task','context','verify','dependsOn','resumeFrom'].includes(k))) throw Error('invalid job fields');
      const worker = input.worker ?? 'local';
      if (!this.workers.has(worker)) throw Error('worker not enabled by operator');
      if (typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(input.id) || known.has(input.id)) throw Error('job ID must be unique: lowercase initial letter, then lowercase letters/digits/hyphens, 1..48 characters (no underscores)');
      for (const key of ['task','context','verify']) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > (key === 'verify' ? 2000 : 16000)) throw Error(`invalid job ${key}`);
      if (!Array.isArray(input.dependsOn) || new Set(input.dependsOn).size !== input.dependsOn.length || input.dependsOn.some(id => !known.has(id))) throw Error('dependencies must name earlier jobs; cycles and forward references are rejected');
      const resumeFrom = input.resumeFrom ?? '';
      if (typeof resumeFrom !== 'string') throw Error('resumeFrom must be a job ID or empty');
      if (resumeFrom) {
        const source = this.jobs.find(j => j.id === resumeFrom);
        if (!source || !['failed','cancelled'].includes(source.status) || !source.finishedAt || !source.result?.recoverySnapshot) throw Error('resumeFrom requires a settled failed/cancelled job with a retained snapshot');
        if (input.dependsOn.length) throw Error('a recovery resumes its original snapshot; use a subsequent job for new dependencies');
      }
      known.add(input.id);
      return { ...structuredClone(input), resumeFrom, worker, lane: worker === 'local' ? 'local' : 'codex', status: 'queued', queuedAt: Date.now() };
    });
    this.jobs.push(...rows); // Validate the WHOLE batch before accepting any job.
    for (const row of rows) this.emit('job.queued', structuredClone(row));
    this.pump(); return this.snapshot();
  }
  snapshot() { return structuredClone(this.jobs); }
  cancel(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || !['queued','running'].includes(job.status)) throw Error('only queued or running jobs can be cancelled');
    if (job.status === 'running') {
      job.cancelRequested = true; this.emit('job.cancel-requested', { id }); this.controls.get(id)?.abort(); return;
    }
    job.status = 'cancelled'; job.finishedAt = Date.now(); this.emit('job.cancelled', { id }); this.pump();
  }
  pump() {
    if (this.closed || this.signal?.aborted) return;
    for (const job of this.jobs.filter(j => j.status === 'queued')) {
      const deps = job.dependsOn.map(id => this.jobs.find(j => j.id === id));
      if (deps.some(j => ['failed','blocked','cancelled'].includes(j.status))) {
        job.status = 'blocked'; job.finishedAt = Date.now(); this.emit('job.blocked', { id: job.id }); continue;
      }
      if (deps.some(j => j.status !== 'passed')) continue;
      if (this.active.has(job.lane)) continue;
      job.status = 'running'; job.startedAt = Date.now(); this.emit('job.started', { id: job.id, worker: job.worker, lane: job.lane, startedAt: job.startedAt });
      const control = new AbortController(), abort = () => control.abort();
      this.controls.set(job.id, control); this.signal?.addEventListener('abort', abort, { once: true });
      if (this.signal?.aborted) abort();
      const progress = value => {
        if (job.status !== 'running' || control.signal.aborted) return;
        job.progress = { at: Date.now(), source: 'unverified-worker-output', ...(typeof value === 'string' ? {text: value.slice(-2000)} : {evidence: structuredClone(value)}) };
        this.emit('job.progress', { id: job.id, ...job.progress });
        this.changed();
      };
      // Defer execution so active is installed even for a synchronous test executor.
      const running = Promise.resolve().then(() => {
        if (control.signal.aborted) throw Error('job cancelled before execution');
        const recovery = job.resumeFrom ? this.jobs.find(j => j.id === job.resumeFrom) : null;
        return this.execute(structuredClone(job), structuredClone(deps), control.signal, progress, structuredClone(recovery));
      })
        .then(result => { job.result = result; job.status = control.signal.aborted ? 'cancelled' : result?.pass === true ? 'passed' : 'failed'; },
          error => { job.status = control.signal.aborted ? 'cancelled' : 'failed'; job.result = { pass: false, error: String(error?.message ?? error) }; })
        .finally(() => {
          this.signal?.removeEventListener('abort', abort); this.controls.delete(job.id);
          job.finishedAt = Date.now(); job.wallMs = job.finishedAt - job.startedAt;
          this.emit('job.finished', structuredClone(job)); this.active.delete(job.lane);
          this.changed(); this.pump();
        });
      this.active.set(job.lane, running);
    }
    this.changed();
  }
  get pending() { return this.jobs.some(j => ['queued','running'].includes(j.status)); }
  changed() { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  async wait(ms = 30000) {
    if (!this.pending || this.closed) return this.snapshot();
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); this.signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.min(30000, Math.max(1, ms)));
      this.waiters.add(done); this.signal?.addEventListener('abort', done, { once: true });
      if (this.signal?.aborted) done();
    });
    return this.snapshot();
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.filter(j => j.status === 'queued')) { job.status = 'cancelled'; job.finishedAt = Date.now(); this.emit('job.cancelled', { id: job.id }); }
    this.changed(); await Promise.all([...this.active.values()]);
  }
}
