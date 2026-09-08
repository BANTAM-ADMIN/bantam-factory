import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { driveForeman, summarizeJobs, FOREMAN_SCHEMA, FOREMAN_INSTRUCTIONS } from '../src/foreman-controller.js';
import { foremanPlan, foremanCommand, foremanUsage, validateForemanVerifiers, integrateForemanCandidate, readForemanEvidence, foremanWorkerTask, foremanWorkerContext, cleanupForemanContainers } from '../src/foreman.js';
import { runProcess } from '../src/process-runner.js';
import { requiredOutputPaths } from '../src/logic/missing-outputs.js';
import { deriveCompletionContext } from '../src/logic/derived-failure-context.js';
import { shellContainerReceiptArgs } from '../src/executor.js';
const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 };
const action = (kind, fields = {}) => ({ action: kind, jobs: [], target: '', text: '', ...fields });
const job = (id, worker = 'local') => ({ id, worker, task: 'build the module', context: 'preserve the API contract', verify: 'npm test', dependsOn: [] });
function model(actions) { const prompts = []; return { prompts, complete: async prompt => { prompts.push(prompt); return { content: JSON.stringify(actions.shift() ?? action('wait')), rawUsage: usage }; } }; }
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-foreman-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('diagnostic reproduction paths do not become binding worker deliverables', () => {
  const j = { ...job('repair'), task: 'Write test/boundary.test.js with regression assertions.',
    context: "Review: Object.create(Array.prototype); process.argv[1]='/tmp/example-importer.js'; await import(realModuleURL) wrongly runs the CLI." };
  const contract = foremanWorkerTask('Implement a synchronous API.', j);
  const evidence = foremanWorkerContext(j, []);
  assert.ok(requiredOutputPaths(contract + '\n' + evidence).includes('/tmp/example-importer.js'), 'reproduces flat-context false requirement');
  assert.deepEqual(requiredOutputPaths(contract), ['test/boundary.test.js']);
  assert.match(evidence, /example-importer.js/);
});
test('owned cleanup resolves wrapper removal races using exact-ID absence evidence', async t => {
  const dir = fixture(t), id = 'a'.repeat(64), receipt = path.join(dir,'astra-codex-test.cid');
  fs.writeFileSync(receipt,id);
  let calls = 0;
  await cleanupForemanContainers(dir, { run: async (exe,args) => {
    assert.equal(exe,'docker'); assert.equal(args.at(-1),id);
    calls++;
    if (args[0] === 'rm') return {code:1,stderr:'removal already in progress',stdout:''};
    return calls < 4 ? {code:0,stderr:'',stdout:'[]'} : {code:1,stderr:`Error: No such object: ${id}`,stdout:''};
  } });
  assert.equal(calls,4);
  assert.equal(JSON.parse(fs.readFileSync(receipt + '.cleanup.json')).absent,true);
});
test('Docker unavailability cannot be mistaken for successful cleanup', async t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir,'bantam-shell-test.cid'),'b'.repeat(64));
  await assert.rejects(cleanupForemanContainers(dir,{run:async()=>({code:1,stderr:'Cannot connect to Docker daemon',stdout:''})}),/cannot confirm/);
});
test('the model sees the same job ID rule as the queue validates', () => {
  const pattern = new RegExp(FOREMAN_SCHEMA.properties.jobs.items.properties.id.pattern);
  assert.equal(pattern.test('edge_tests'), false); assert.equal(pattern.test('edge-tests'), true);
  assert.match(FOREMAN_INSTRUCTIONS, /no underscores/);
});
test('routine queue context omits detailed usage receipts and full verification logs without deleting evidence', () => {
  const row = { id:'j1',worker:'local',status:'failed',dependsOn:[],queuedAt:1,result:{pass:false,usage:{inputTokens:20,calls:[{privateReceipt:'do not replay'}]},verification:{pass:false,code:1,stdout:'x'.repeat(20000),stderr:''}} };
  const summary = summarizeJobs({ snapshot: () => structuredClone([row]) });
  assert.equal(summary[0].result.usage.inputTokens,20); assert.equal(summary[0].result.usage.calls,undefined);
  assert.equal(summary[0].result.verification.stdoutTail.length,2000); assert.equal(row.result.verification.stdout.length,20000);
});
test('dependency process metadata cannot manufacture product lifecycle obligations', () => {
  const task = 'Implement synchronous packContext. Include required sections in original input order. Invalid input throws an Error.';
  const dependency = { id:'previous',status:'passed',result:{verification:{pass:true},integrated:true,changedFiles:['context-packet.js'],process:{aborted:false},usage:{calls:[{receipt:'retain privately'}]}} };
  assert.ok(deriveCompletionContext({ task: task + JSON.stringify(dependency) }), 'reproduces the observed metadata contamination');
  const prompt = foremanWorkerTask(task,job('repair'),[dependency]);
  assert.equal(deriveCompletionContext({ task: prompt }),null);
  assert.doesNotMatch(prompt,/"aborted"|retain privately/); assert.match(prompt,/"integrated":true/);
  assert.equal(dependency.result.process.aborted,false);
  const genuine = foremanWorkerTask('Run an abortable batch with one result per input. Each worker may throw. Stop starting work when the AbortSignal aborts and remove the abort listener before resolving.',job('batch'),[]);
  assert.ok(deriveCompletionContext({task:genuine}), 'genuine lifecycle requirements remain active');
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
test('supervisor sees remaining decision, token and wall allowances before spending', async () => {
  const m = model([action('list'),action('list')]);
  await driveForeman({task:'build',initial:{wallBudgetMs:600000},model:m,maxDecisions:2,maxSupervisorTokens:1000,
    execute:()=>({pass:true}),inspect:async()=>[],verify:async()=>({pass:false})});
  assert.match(m.prompts[0],/"observedTokenAllowanceRemaining":1000/);
  assert.match(m.prompts[1],/"observedTokenAllowanceRemaining":890/);
  assert.match(m.prompts[1],/"decisionsRemaining":1/);
  assert.match(m.prompts[1],/"wallMsRemaining":\d+/);
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
test('worker shell receipts identify exact owned containers outside model-writable workspaces', t => {
  const root = fixture(t), ws = path.join(root,'ws'), receipts = path.join(root,'receipts');
  fs.mkdirSync(ws); fs.mkdirSync(receipts,{mode:0o700});
  assert.deepEqual(shellContainerReceiptArgs(ws,'bantam-shell-123',{}),[]);
  assert.deepEqual(shellContainerReceiptArgs(ws,'bantam-shell-123',{BANTAM_SHELL_CID_DIR:receipts}),['--cidfile',path.join(receipts,'bantam-shell-123.cid')]);
  assert.throws(()=>shellContainerReceiptArgs(ws,'bantam-shell-123',{BANTAM_SHELL_CID_DIR:ws}));
  fs.writeFileSync(path.join(receipts,'bantam-shell-123.cid'),'owned');
  assert.throws(()=>shellContainerReceiptArgs(ws,'bantam-shell-123',{BANTAM_SHELL_CID_DIR:receipts}));
  assert.throws(()=>shellContainerReceiptArgs(ws,'../not-owned',{BANTAM_SHELL_CID_DIR:receipts}));
});

test('verifier admission rejects Bash syntax before any worker starts and accepts a corrected batch', async t => {
  const cwd = fixture(t), marker = path.join(cwd, 'must-not-execute');
  const shell = command => runProcess('/bin/sh', ['-c', command], { cwd, timeoutMs: 5000 });
  await assert.rejects(validateForemanVerifiers([{...job('bad'), verify: 'node --check <(cat arcade.html)'}], shell), /cannot parse in POSIX/);
  await validateForemanVerifiers([{...job('quoted'), verify: `printf '%s' "$(touch ${marker})"`}], shell);
  assert.equal(fs.existsSync(marker), false, 'syntax checking must not execute command substitutions');
  const m = model([action('enqueue', {jobs: [job('first'), {...job('bad'), verify: 'cat <(printf broken)'}]}), action('enqueue', {jobs: [job('corrected')]}), action('wait'), action('finish')]);
  const executed = [];
  const result = await driveForeman({task:'build', initial:{}, model:m, maxDecisions:5,
    validateJobs: jobs => validateForemanVerifiers(jobs, shell),
    execute: async j => {executed.push(j.id);return {pass:true};}, inspect:async()=>({}), verify:async()=>({pass:true})});
  assert.deepEqual(executed, ['corrected']);assert.equal(result.pass, true);
  assert.match(m.prompts[1], /cannot parse in POSIX/);
});
