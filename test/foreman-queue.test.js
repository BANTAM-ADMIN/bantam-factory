import test from 'node:test';
import assert from 'node:assert/strict';
import { ForemanQueue } from '../src/foreman-queue.js';
const job = (id, dependsOn = []) => ({ id, task: 'implement', context: 'contract', verify: 'npm test', dependsOn });
test('supervisor can enqueue while local worker runs; execution is serial and receives actual dependency receipts', async () => {
  const releases = [], seen = []; let active = 0, peak = 0;
  const q = new ForemanQueue({ execute: async (j, deps) => {
    active++; peak = Math.max(peak, active); seen.push({ j, deps });
    await new Promise(resolve => releases.push(resolve)); active--; return { pass: true, evidence: j.id };
  } });
  q.submit([job('a')]); await Promise.resolve(); await Promise.resolve();
  q.submit([job('b', ['a']), job('c', ['b'])]);
  assert.equal(q.snapshot()[1].status, 'queued');
  for (let i = 0; i < 3; i++) {
    releases.shift()(); await q.wait(1000); await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(peak, 1); assert.equal(seen[1].deps[0].result.evidence, 'a');
  assert.ok(q.snapshot().every(j => j.status === 'passed')); await q.close();
});
test('admission is atomic, bounded, and rejects cycles, unknown deps and duplicate ids', () => {
  const q = new ForemanQueue({ execute: () => ({ pass: true }), maxJobs: 2 });
  for (const batch of [[job('a'),job('a')], [job('a',['b']),job('b',['a'])], [job('a'),job('b'),job('c')]]) {
    assert.throws(() => q.submit(batch)); assert.equal(q.jobs.length, 0);
  }
});
test('failed dependencies block descendants but not independent work', async () => {
  const seen = []; const q = new ForemanQueue({ execute: j => { seen.push(j.id); return { pass: j.id !== 'a' }; } });
  q.submit([job('a'),job('b',['a']),job('c',['b']),job('repair')]);
  while (q.pending) await q.wait(1000);
  assert.deepEqual(seen, ['a','repair']); assert.deepEqual(q.snapshot().map(j => j.status), ['failed','blocked','blocked','passed']);
});
test('abort prevents queued dispatch and closes running work before returning', async () => {
  const ac = new AbortController(); let started = 0;
  const q = new ForemanQueue({ signal: ac.signal, execute: async () => { started++; await new Promise(r => ac.signal.addEventListener('abort', r, { once: true })); return { pass: false }; } });
  q.submit([job('a'),job('b')]); await Promise.resolve(); await Promise.resolve();
  ac.abort(); await q.close(); assert.equal(started, 1); assert.equal(q.jobs[1].status, 'cancelled'); assert.throws(() => q.submit([job('c')]));
});
test('Astra, Sol and Terra share ONE Codex worker slot while the local lane stays busy', async () => {
  const active = { local: 0, codex: 0 }, peak = { local: 0, codex: 0 }, releases = new Map(), started = [];
  const q = new ForemanQueue({ codexWorkers: ['astra','sol','terra'], execute: async j => {
    started.push(j.id); active[j.lane]++; peak[j.lane] = Math.max(peak[j.lane], active[j.lane]);
    await new Promise(r => releases.set(j.id, r)); active[j.lane]--; return { pass: true };
  } });
  q.submit([{ ...job('cloud-a'), worker: 'astra' }, { ...job('cloud-b'), worker: 'sol' }, job('local-a'), { ...job('cloud-c'), worker: 'terra' }, job('local-b')]);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(started, ['cloud-a','local-a']);
  releases.get('local-a')(); await q.wait(1000); await Promise.resolve();
  assert.ok(started.includes('local-b')); assert.ok(!started.includes('cloud-b'));
  for (const id of ['cloud-a','cloud-b','cloud-c','local-b']) {
    releases.get(id)(); await q.wait(1000); await Promise.resolve();
  }
  assert.deepEqual(peak, { local: 1, codex: 1 }); assert.ok(q.jobs.every(j => j.status === 'passed'));
});
test('cloud workers require an operator allowlist; model-authored limits cannot expand capacity', () => {
  const q = new ForemanQueue({ execute: () => ({ pass: true }) });
  assert.throws(() => q.submit([{ ...job('cloud'), worker: 'astra' }]), /not enabled/);
  assert.throws(() => q.submit([{ ...job('local'), concurrency: 10 }]), /fields/);
  assert.equal(q.jobs.length, 0);
});
test('cross-lane dependencies wait for actual completion before dispatch', async () => {
  let release; const started = [];
  const q = new ForemanQueue({ codexWorkers: ['terra'], execute: async j => {
    started.push(j.id); if (j.id === 'implementation') await new Promise(r => { release = r; }); return { pass: true };
  } });
  q.submit([job('implementation'), { ...job('review', ['implementation']), worker: 'terra' }]);
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(started, ['implementation']);
  release(); while (q.pending) await q.wait(1000);
  assert.deepEqual(started, ['implementation','review']);
});
