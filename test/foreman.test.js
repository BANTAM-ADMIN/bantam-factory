import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { driveForeman, summarizeJobs, FOREMAN_SCHEMA, FOREMAN_INSTRUCTIONS } from '../src/foreman-controller.js';
import { foremanPlan, foremanCommand, foremanUsage, integrateForemanCandidate, readForemanEvidence } from '../src/foreman.js';
const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 };
const action = (kind, fields = {}) => ({ action: kind, jobs: [], target: '', text: '', ...fields });
const job = (id, worker = 'local') => ({ id, worker, task: 'build the module', context: 'preserve the API contract', verify: 'npm test', dependsOn: [] });
function model(actions) { const prompts = []; return { prompts, complete: async prompt => { prompts.push(prompt); return { content: JSON.stringify(actions.shift() ?? action('wait')), rawUsage: usage }; } }; }
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-foreman-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('the model sees the same job ID rule as the queue validates', () => {
  const pattern = new RegExp(FOREMAN_SCHEMA.properties.jobs.items.properties.id.pattern);
  assert.equal(pattern.test('edge_tests'), false); assert.equal(pattern.test('edge-tests'), true);
  assert.match(FOREMAN_INSTRUCTIONS, /no underscores/);
});
test('routine queue context omits detailed usage receipts and full verification logs without deleting evidence', () => {
  const row = { id:'j1',worker:'local',status:'passed',dependsOn:[],queuedAt:1,result:{pass:true,usage:{inputTokens:20,calls:[{privateReceipt:'do not replay'}]},verification:{pass:true,code:0,stdout:'x'.repeat(20000),stderr:''}} };
  const summary = summarizeJobs({ snapshot: () => structuredClone([row]) });
  assert.equal(summary[0].result.usage.inputTokens,20); assert.equal(summary[0].result.usage.calls,undefined);
  assert.equal(summary[0].result.verification.stdoutTail.length,2000); assert.equal(row.result.verification.stdout.length,20000);
});
test('two-lane supervisor drives real queue, retains evidence, and cannot finish while workers run', async () => {
  const m = model([action('enqueue', { jobs: [job('local'), job('cloud','terra')] }), action('finish'), action('wait'), action('wait'), action('finish')]);
  let active = 0, peak = 0, checks = 0;
  const result = await driveForeman({ task: 'build', initial: {}, model: m, codexWorkers: ['terra'], maxDecisions: 6,
    execute: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return { pass: true }; },
    inspect: async () => ({}), verify: async () => { checks++; return { pass: true }; } });
  assert.equal(peak, 2); assert.ok(m.prompts.some(p => p.includes('cannot finish with outstanding jobs')));
  assert.equal(result.jobs.length, 2); assert.equal(checks, 1); assert.equal(result.pass, true);
});
test('final check failure is fed back, repair is verified before accepted completion', async () => {
  let queueRuns = 0, checks = 0;
  const m = { complete: async prompt => {
    let a;
    if (!queueRuns) a = action('enqueue', { jobs: [job('build')] });
    else if (prompt.includes('"status":"running"') && !prompt.includes('"status":"passed"')) a = action('wait');
    else if (checks === 1 && queueRuns === 1) a = action('enqueue', { jobs: [job('repair')] });
    else a = action('finish');
    return { content: JSON.stringify(a), rawUsage: usage };
  } };
  const result = await driveForeman({ task: 'build', initial: {}, model: m, maxDecisions: 15,
    execute: async () => { queueRuns++; return { pass: true }; }, inspect: async () => ({}), verify: async () => ({ pass: ++checks > 1, stderr: checks === 1 ? 'boundary defect' : '' }) });
  assert.equal(result.pass, true); assert.equal(queueRuns, 2); assert.equal(checks, 2);
});
test('missing and failed model receipts remain unknown and stop cloud admission', async () => {
  for (const complete of [async () => ({ content: '{}' }), async () => { throw Error('upstream disconnected'); }]) {
    let n = 0; const result = await driveForeman({ task: 'x', initial: {}, model: { complete: () => { n++; return complete(); } }, execute: () => {}, verify: () => {}, inspect: () => {} });
    assert.equal(result.pass, false); assert.equal(n, 1); assert.equal(result.calls.length, 1); assert.equal(foremanUsage(result).total.inputTokens, null);
  }
});
test('usage totals count every lane, preserve unknowns, and do not invent dollar prices', () => {
  const u = { inputTokens: 100, outputTokens: 10, cacheHitTokens: 80, freshInputTokens: 20 };
  const r = { calls: [{ usage: u }], jobs: [{ worker: 'local', startedAt: 1, result: { usage: u } }, { worker: 'terra', startedAt: 1, result: { usage: u } }] };
  assert.equal(foremanUsage(r).total.inputTokens, 300); assert.equal(foremanUsage(r).costUsd, null);
  r.jobs[1].result.usage = { ...u, complete: false }; assert.equal(foremanUsage(r).total.inputTokens, null);
});
test('planning and declined consent never invoke a model or create output', async t => {
  const cwd = fixture(t); let runs = 0;
  const args = { task: 'build', verify: 'npm test', out: 'result', 'with-codex': 'terra' };
  const run = async () => { runs++; throw Error('must not run'); };
  assert.equal(await foremanCommand({ ...args, 'dry-run': true }, { cwd, log: () => {}, run }), 0);
  assert.equal(await foremanCommand(args, { cwd, log: () => {}, ask: async () => 'no', run }), 1);
  assert.equal(runs, 0); assert.equal(fs.existsSync(path.join(cwd,'result')), false);
  assert.throws(() => foremanPlan({ ...args, 'with-codex': 'claude' }, cwd));
  assert.throws(() => foremanPlan({ ...args, 'timeout-seconds': -1 }, cwd));
});
test('independent snapshot edits integrate; stale overlapping edits fail without overwriting', t => {
  const dir = fixture(t); const roots = {};
  for (const name of ['before','candidate','local','cloud','conflict']) {
    roots[name] = path.join(dir,name); fs.mkdirSync(roots[name]); fs.writeFileSync(path.join(roots[name],'a.txt'),'a'); fs.writeFileSync(path.join(roots[name],'b.txt'),'b');
  }
  fs.writeFileSync(path.join(roots.local,'a.txt'),'local'); fs.writeFileSync(path.join(roots.cloud,'b.txt'),'cloud'); fs.writeFileSync(path.join(roots.conflict,'a.txt'),'stale');
  const integrate = (name) => integrateForemanCandidate({ candidate: roots.candidate, before: roots.before, sealed: roots[name], transactionRoot: path.join(dir,'transactions'), id: name, verification: { pass: true } });
  assert.deepEqual(integrate('local'), ['a.txt']); assert.deepEqual(integrate('cloud'), ['b.txt']);
  assert.throws(() => integrate('conflict')); assert.equal(fs.readFileSync(path.join(roots.candidate,'a.txt'),'utf8'), 'local');
  assert.equal(fs.readFileSync(path.join(roots.before,'a.txt'),'utf8'), 'a');
});
test('worker context evidence is paginated without losing Unicode, and cannot escape its job', t => {
  const output = fixture(t), dir = path.join(output,'jobs','example'); fs.mkdirSync(dir, { recursive: true });
  const original = 'a'.repeat(11999) + '🦊漢字'.repeat(3000); fs.writeFileSync(path.join(dir,'stdout.log'), original);
  let offset = 0, text = '';
  for (;;) { const page = readForemanEvidence(output,'example', JSON.stringify({ file:'stdout.log',offset })); text += page.text; offset = page.nextOffset; if (page.eof) break; }
  assert.equal(text, original);
  assert.throws(() => readForemanEvidence(output,'example', '{"file":"../../secret"}'));
  fs.symlinkSync(path.join(output,'secret'),path.join(dir,'run.json')); fs.writeFileSync(path.join(output,'secret'),'private');
  assert.throws(() => readForemanEvidence(output,'example','{"file":"run.json"}'));
});
