import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { driveForeman, summarizeJobs, waitForForemanUpdate, FOREMAN_SCHEMA, FOREMAN_INSTRUCTIONS } from '../src/foreman-controller.js';
import { foremanPlan, foremanCommand, foremanUsage, validateForemanVerifiers, integrateForemanCandidate, readForemanEvidence, foremanWorkerTask, foremanWorkerContext, foremanWorkerCommand, cleanupForemanContainers, foremanObservation, foremanWorkerReport } from '../src/foreman.js';
import { runProcess } from '../src/process-runner.js';
import { requiredOutputPaths } from '../src/logic/missing-outputs.js';
import { deriveCompletionContext } from '../src/logic/derived-failure-context.js';
import { shellContainerReceiptArgs } from '../src/executor.js';
import { composeInstructionGuards } from '../src/instruction-guard.js';
const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 };
const action = (kind, fields = {}) => ({ action: kind, jobs: [], target: '', text: '', ...fields });
const job = (id, worker = 'local') => ({ id, worker, task: 'build the module', context: 'preserve the API contract', verify: 'npm test', dependsOn: [] });
function model(actions) { const prompts = []; return { prompts, complete: async prompt => { prompts.push(prompt); return { content: JSON.stringify(actions.shift() ?? action('wait')), rawUsage: usage }; } }; }
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-foreman-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('settled worker findings survive progress replacement and reach the supervisor and successor context', async () => {
  const finding='Runtime probe disproved the requested digest repair. Existing validation rejects every tested line terminator.';
  const workerReport=foremanWorkerReport({result:{summary:finding}});
  const m=model([action('dispatch',{jobs:[job('core','sol')]}),action('finish')]);
  const result=await driveForeman({task:'build',initial:{},model:m,localEnabled:false,codexWorkers:['sol'],maxDecisions:2,
    execute:async(j,deps,signal,progress)=>{progress({observation:{text:'Earlier diagnostic still in flight'}});return {pass:true,workerReport,verification:{pass:true,code:0,stdout:'tests pass',stderr:''}};},
    inspect:async()=>({}),verify:async()=>({pass:true})});
  assert.equal(result.pass,true);
  assert.ok(m.prompts[1].includes(finding));
  assert.ok(!m.prompts[1].includes('Earlier diagnostic still in flight'));
  assert.match(m.prompts[1],/"verification":\{"pass":true/);
  assert.ok(foremanWorkerContext(job('next'),result.jobs,'build').includes(finding));
});
test('worker final reports are bounded, labeled and never substitute for failed verification', async () => {
  assert.equal(foremanWorkerReport(null),null);
  assert.equal(foremanWorkerReport({result:{summary:'   '}}),null);
  const report=foremanWorkerReport({result:{summary:'OBSERVED START '+ 'x'.repeat(6000)+' OBSERVED END'}});
  assert.equal(report.source,'worker-final-report');assert.equal(report.truncated,true);
  assert.ok(report.text.length<2100);assert.ok(report.text.startsWith('OBSERVED START'));assert.ok(report.text.endsWith('OBSERVED END'));
  const m=model([action('dispatch',{jobs:[job('core','terra')]}),action('finish')]);let checks=0;
  const result=await driveForeman({task:'build',initial:{},model:m,localEnabled:false,codexWorkers:['terra'],maxDecisions:2,
    execute:async()=>({pass:false,workerReport:foremanWorkerReport({result:{summary:'Everything is complete.'}}),verification:{pass:false,code:1,stdout:'failed',stderr:''}}),
    inspect:async()=>({}),verify:async()=>{checks++;return {pass:true};}});
  assert.equal(result.pass,false);assert.equal(checks,0);assert.match(m.prompts[1],/Everything is complete/);
  assert.match(m.prompts[1],/"verification":\{"pass":false/);
});
test('diagnostic reproduction paths do not become binding worker deliverables', () => {
  const j = { ...job('repair'), task: 'Write test/boundary.test.js with regression assertions.',
    context: "Review: Object.create(Array.prototype); process.argv[1]='/tmp/example-importer.js'; await import(realModuleURL) wrongly runs the CLI." };
  const contract = foremanWorkerTask('Implement a synchronous API.', j);
  const evidence = foremanWorkerContext(j, []);
  assert.ok(requiredOutputPaths(contract + '\n' + evidence).includes('/tmp/example-importer.js'), 'reproduces flat-context false requirement');
  assert.deepEqual(requiredOutputPaths(contract), ['test/boundary.test.js']);
  assert.match(evidence, /example-importer.js/);
});
test('combined source reviews stay whole and oversized observations identify the omitted middle', () => {
  const output = 'IMPLEMENTATION\n' + 'x'.repeat(6000) + '\nRETAINED TESTS\n' + 'y'.repeat(5000);
  const r = {code:0,stdout:output,stderr:''};
  const review = foremanObservation(r,24000);
  assert.equal(review.stdout,output);assert.equal(review.stdoutTruncated,false);
  const bounded = foremanObservation(r);
  assert.match(bounded.stdout,/^IMPLEMENTATION/);assert.match(bounded.stdout,/characters omitted/);
  assert.ok(bounded.stdout.endsWith('y'.repeat(2000)));
  assert.equal(bounded.stdoutChars,output.length);assert.equal(bounded.stdoutTruncated,true);
  assert.equal(r.stdout,output);
});
test('dispatch returns settled worker evidence without spending a model turn to say wait', async () => {
  const m=model([action('dispatch',{jobs:[job('core','terra')]}),action('finish')]);
  const result=await driveForeman({task:'build',initial:{},model:m,localEnabled:false,codexWorkers:['terra'],maxDecisions:2,
    execute:async()=>{await new Promise(r=>setTimeout(r,5));return {pass:true};},
    inspect:async()=>({}),verify:async()=>({pass:true})});
  assert.equal(result.pass,true);assert.equal(result.calls.length,2);
  assert.match(m.prompts[1],/"status":"passed"/);assert.match(m.prompts[1],/"waited":true/);
});
test('dispatch failures remain visible and cannot acquire a completion receipt', async () => {
  const m=model([action('dispatch',{jobs:[job('core','sol')]}),action('finish')]);
  let finalChecks=0;
  const result=await driveForeman({task:'build',initial:{},model:m,localEnabled:false,codexWorkers:['sol'],maxDecisions:2,
    execute:async()=>({pass:false,error:'broken contract'}),inspect:async()=>({}),verify:async()=>{finalChecks++;return {pass:true};}});
  assert.equal(result.pass,false);assert.equal(finalChecks,0);
  assert.match(m.prompts[1],/broken contract/);
});
test('dispatch wakes for a live failure so Astra can steer the same worker', async () => {
  let release, corrections=0;
  const m=model([action('dispatch',{jobs:[job('core','terra')]}),
    action('steer',{target:'core',text:'Repair the demonstrated boundary.'}),action('wait'),action('finish')]);
  const result=await driveForeman({task:'build',initial:{},model:m,localEnabled:false,codexWorkers:['terra'],maxDecisions:4,
    execute:async(j,deps,signal,progress)=>{
      await new Promise(r=>{release=r;progress({observation:{turn:1,text:'Shell exit 1\nboundary failed'}});});
      return {pass:true};
    },steer:async()=>{corrections++;release();return {queued:true};},inspect:async()=>({}),verify:async()=>({pass:true})});
  assert.equal(result.pass,true);assert.equal(corrections,1);
  assert.match(m.prompts[1],/boundary failed/);assert.match(m.prompts[1],/"status":"running"/);
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
test('green verification retains the actual test coverage instead of only a pass flag', () => {
  const stdout = 'ok 1 - HTML packaging\nok 2 - JavaScript parses\n1..2\n# tests 2\n# pass 2\n';
  const summary = summarizeJobs({snapshot:()=>[{result:{pass:true,verification:{pass:true,code:0,stdout,stderr:''}}}]});
  assert.equal(summary[0].result.verification.stdoutTail, stdout);
  assert.equal(summary[0].result.verification.stdoutTruncated, false);
});
test('settled receipts replace stale live output while running failures remain available', () => {
  const progress = {evidence:{observation:{text:'Shell exit 1\nold failure'},verification:{text:'old log'}}};
  const rows = [{id:'live',status:'running',progress}, {id:'settled',status:'passed',progress,
    result:{pass:true,verification:{pass:true,stdout:'ok 1 - actual boundary behavior',stderr:''}}}];
  const summary = summarizeJobs({snapshot:()=>structuredClone(rows)});
  assert.deepEqual(summary[0].progress, progress);
  assert.equal(summary[1].progress, null);
  assert.match(summary[1].result.verification.stdoutTail, /actual boundary behavior/);
  assert.deepEqual(rows[1].progress, progress, 'full evidence is retained in the journal');
});
test('a worker milestone does not inherit other jobs output obligations, while retaining the full project brief as context', () => {
  const original = 'Create arcade.html with an interactive game. Write release-notes.md for the complete product.';
  const j = {...job('core'),task:'Write engine.js and test/engine.test.js with deterministic assertions.'};
  const task = foremanWorkerTask(original,j), context = foremanWorkerContext(j,[],original);
  assert.deepEqual(requiredOutputPaths(task), ['engine.js','test/engine.test.js']);
  assert.ok(context.includes(original));
  assert.match(context,/supervisor owns final integration and full-task acceptance/);
});
test('supervisor can correct a running local worker and still must verify the complete candidate', async () => {
  let release, received = '', checks = 0;
  const m = model([action('enqueue',{jobs:[job('core')]}),action('steer',{target:'core',text:'Keep the files; replace printed booleans with assertions.'}),action('wait'),action('finish')]);
  const result = await driveForeman({task:'complete product',initial:{},model:m,maxDecisions:4,
    execute:async()=>{await new Promise(r=>{release=r;});return {pass:true};},
    steer:async(j,text)=>{assert.equal(j.id,'core');received=text;release();return {queued:true};},
    inspect:async()=>({}),verify:async()=>{checks++;return {pass:false,stderr:'Final product still missing UI.'};}});
  assert.match(received,/assertions/);assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].status,'passed');
  assert.equal(checks,1);assert.equal(result.pass,false);
});
test('supervisor can steer each cloud worker inside BANTAM with the local lane disabled', async () => {
  for (const worker of ['terra', 'sol']) {
    let release, received = '';
    const m = model([action('enqueue', {jobs:[job('core', worker)]}),
      action('steer', {target:'core', text:'Assert the current state after restart, not the replaced instance.'}),
      action('wait'), action('finish')]);
    const result = await driveForeman({task:'complete product', initial:{}, model:m,
      localEnabled:false, codexWorkers:[worker], maxDecisions:4,
      execute:async j => {assert.equal(j.worker, worker); await new Promise(r => {release=r;}); return {pass:true};},
      steer:async (j, text) => {received=text; release(); return {queued:true};},
      inspect:async()=>({}), verify:async()=>({pass:true})});
    assert.match(received, /current state/); assert.equal(result.pass, true);
    assert.match(m.prompts[0], new RegExp(`Enabled workers: ${worker}\\n`));
  }
});
test('worker boilerplate allows generated fixture repairs and keeps explicit test protection', t => {
  const workspace = fixture(t); fs.mkdirSync(path.join(workspace, 'test'));
  for (const name of ['generated', 'acceptance']) fs.writeFileSync(path.join(workspace, `test/${name}.test.js`), '// retained assertions');
  const task = foremanWorkerTask('Improve the game', {...job('repair'),
    task:'Repair the stale generated fixture. Do not modify test/acceptance.test.js.'});
  const guards = composeInstructionGuards({workspace, instruction:task});
  assert.equal(guards.editGuard('test/generated.test.js'), null);
  assert.ok(guards.editGuard('test/acceptance.test.js'));
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
  for (const complete of [async () => ({ content: '{}' }),
    async () => ({ content:'{}',rawUsage:usage,usage:{complete:false},codexUsageEvidence:{gaps:['missing response receipt']} }),
    async () => { throw Error('upstream disconnected'); }]) {
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

test('Codex-only plans require a cloud worker and omit the local endpoint', t => {
  const cwd = fixture(t), args = {task:'build',verify:'npm test',out:'result','no-local':true};
  assert.throws(() => foremanPlan(args, cwd), /requires --with-codex/);
  const plan = foremanPlan({...args,'with-codex':'terra,sol'}, cwd);
  assert.equal(plan.localEnabled, false);
  assert.equal(plan.endpoint, null);
});

test('Terra and Sol jobs execute the BANTAM loop with scoped context, steering and verification', t => {
  const dir = fixture(t);
  for (const worker of ['terra','sol']) {
    const command = foremanWorkerCommand({task:'Complete project',job:job('build',worker),
      workspace:path.join(dir,'ws'),dir,timeoutMs:600000});
    assert.equal(command.exe, process.execPath);
    assert.match(command.args[0], /bin\/bantam\.js$/);
    assert.equal(command.args[1], 'run');
    assert.ok(command.args.includes('--codex'));
    assert.equal(command.args[command.args.indexOf('--model')+1], `gpt-5.6-${worker}`);
    assert.equal(command.args[command.args.indexOf('--codex-effort')+1], 'medium');
    assert.equal(command.args[command.args.indexOf('--verify')+1], 'npm test');
    assert.equal(command.args[command.args.indexOf('--supervisor-control')+1], dir);
    assert.equal(command.args[command.args.indexOf('--supporting-context-file')+1], path.join(dir,'supporting-context.txt'));
    assert.ok(!command.args.includes('--endpoint'));
  }
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

test('idle wait wakeups do not spend another supervisor call until worker state changes', async()=>{
  let waits=0;const queue={pending:true,snapshot:()=>[{status:waits<4?'running':'passed'}],wait:async()=>{waits++;if(waits===4)queue.pending=false;}};
  await waitForForemanUpdate(queue);assert.equal(waits,4);
  const ac=new AbortController();
  await assert.rejects(waitForForemanUpdate({pending:true,snapshot:()=>[],wait:async()=>ac.abort()},ac.signal),/cancellation/);
});

test('routine action traffic is coalesced while a new failure wakes the supervisor immediately', async () => {
  for (const failureAt of [null, 2]) {
    let waits=0, time=0;
    const queue={pending:true, snapshot:()=>[{id:'work',status:'running',progress:{at:time,
      evidence:{action:{turn:waits+1},observation:{turn:waits,text:waits===failureAt?'Shell exit 1\nAssertionError: wrong fixture':'Shell exit 0\nchecks passed'}}}}],
      wait:async()=>{waits++;time+=5000;}};
    await waitForForemanUpdate(queue,null,{now:()=>time});
    assert.equal(waits,failureAt ?? 24);
  }
});

test('settled workers wake immediately even inside the routine review interval', async () => {
  let waits=0;
  const queue={pending:true,snapshot:()=>[{id:'work',status:waits?'passed':'running'}],wait:async()=>{waits++;queue.pending=false;}};
  await waitForForemanUpdate(queue,null,{now:()=>0});assert.equal(waits,1);
});

test('green scope accounting stays in routine review; real scope refusals wake immediately', async () => {
  const advisories = [
    'Shell exit 0\nall 18 tests passed\n[scope] That was a different test command from the one your 2/2 baseline came from, so its numbers are not comparable.',
    'Shell exit 0\n[scope] The exact baseline verifier `npm test` ran as a standalone segment inside this compound check.',
    'wrote 100 bytes\n[scope] Verification invalidated: workspace generation 1 -> 2; changed source.js',
  ];
  const refusals = [
    '[scope] test/public.test.js is immutable. The edit was NOT applied.',
    '[scope] Requested cleanup was not executed. Keep this verification witness.',
    '[scope] Diagnostic command was not executed. It recursively starts itself.',
    '[scope] This shell action changed immutable task evidence: public.test.js.',
    'Shell exit 1\n[scope] That was a different test command from the one your baseline came from.',
  ];
  for (const [text, immediate] of [...advisories.map(text=>[text,false]),...refusals.map(text=>[text,true])]) {
    let waits=0, time=0;
    const queue={pending:true,snapshot:()=>[{id:'work',status:'running',progress:{at:time,
      evidence:{observation:{turn:waits,text:waits?text:'Shell exit 0\nold check passed'}}}}],
      wait:async()=>{waits++;time+=5000;}};
    await waitForForemanUpdate(queue,null,{now:()=>time});
    assert.equal(waits,immediate?1:24,text);
  }
});
