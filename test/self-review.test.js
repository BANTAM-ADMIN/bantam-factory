import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSelfReview, freezeInspection, inspectionUnits, productHashes, runInspection,
  sameLocalReviewer, selfReviewObservation, validateInspectionReport, INSPECTOR_TASK, inspectionReportJSON } from '../src/self-review.js';
import { runAgent } from '../src/agent.js';
import { trustedReviewEvidenceEnd } from '../src/run-continuation.js';
import { RunCheckpoint } from '../src/run-checkpoint.js';
import { parseArgs } from '../src/cli-args.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-self-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'product'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'main.js'), 'export const answer = 42;\n');
  return { root, workspace, directory: path.join(root, 'evidence') };
}
const summary = 'Executed the independent assertion and checked the required behavior.';
const unit = { id: 'one', text: 'Return 42.', label: 'Value', path: 'DESIGN.md', start: 1, end: 1 };
const report = (status = 'verified', id = unit.id) => ({ units: [{ id, status, summary,
  evidence: [{ turn: 0, quote: 'independent check passed' }] }], nextTask: 'Continue the remaining specification.' });
const turns = [{ observation: 'independent check passed', shellExecution: { exitCode: 0 } }];

test('all nonblank specification lines survive slicing, with stable IDs', () => {
  const text = '# One\nline one\n### Two\n' + 'long line\n'.repeat(10) + 'last';
  const result = inspectionUnits('original assignment', [{ path: 'DESIGN.md', text }], 35);
  assert.equal(result.filter(u => u.path === 'DESIGN.md').map(u => u.text).join('\n'), text);
  assert.deepEqual(result, inspectionUnits('original assignment', [{ path: 'DESIGN.md', text }], 35));
});

test('freezes product bytes separately and refuses replacement', t => {
  const { root, workspace } = setup(t), snapshot = path.join(root, 'snapshot');
  const hashes = freezeInspection(workspace, snapshot);
  assert.deepEqual(hashes, productHashes(snapshot));
  fs.writeFileSync(path.join(snapshot, '.inspection', 'check.js'), 'assert(true)');
  assert.deepEqual(hashes, productHashes(snapshot));
  fs.writeFileSync(path.join(snapshot, 'main.js'), 'changed');
  assert.notDeepEqual(hashes, productHashes(snapshot));
  assert.equal(fs.readFileSync(path.join(workspace, 'main.js'), 'utf8'), 'export const answer = 42;\n');
  assert.throws(() => freezeInspection(workspace, snapshot), /replace/);
});

test('verdicts require actual observation provenance and successful execution', () => {
  const validate = (r, ts = turns, integrity = true) => validateInspectionReport(JSON.stringify(r), { units: [unit], turns: ts, integrity });
  assert.deepEqual(validate(report()), report());
  assert.throws(() => validate(report(), turns, false), /changed frozen/);
  assert.throws(() => validate(report(), [{ observation: turns[0].observation }]), /executed successful/);
  for (const flag of ['blocked', 'timedOut', 'interrupted', 'bufferExceeded', 'error', 'invalidated']) {
    assert.throws(() => validate(report(), [{ ...turns[0], shellExecution: { exitCode: 0, [flag]: true } }]), /executed successful/);
  }
  assert.throws(() => validate(report(), [{ ...turns[0], observation: 'different observation' }]), /not present/);
  assert.throws(() => validate(report('verified', 'substituted')), /omitted or substituted/);
  const empty = report(); empty.units[0].evidence = [];
  assert.throws(() => validate(empty), /observed evidence/);
  empty.units[0].status = 'inconclusive'; assert.equal(validate(empty).units[0].status, 'inconclusive');
});

test('ledger persists unresolved findings, retests repairs, and reopens stale passes', async t => {
  const { workspace, directory } = setup(t); let inspections = 0;
  const options = { workspace, directory, task: 'Return 42.', documents: [], every: 3, modelFactory: () => ({}),
    inspect: async ({ units }) => ({ hashes: productHashes(workspace), report: report(++inspections === 1 ? 'needs-work' : 'verified', units[0].id) }) };
  const first = createSelfReview(options);
  assert.equal((await first.boundary({ turn: 0 })).allowDone, false);
  assert.equal((await first.boundary({ turn: 3, reason: 'completion' })).allowDone, false);
  assert.equal(inspections, 1, 'unchanged broken bytes reuse the recorded failure');
  fs.writeFileSync(path.join(workspace, 'main.js'), 'fixed');
  const resumed = createSelfReview(options);
  assert.equal((await resumed.boundary({ turn: 4, reason: 'completion' })).allowDone, true);
  assert.equal(inspections, 2);
  fs.writeFileSync(path.join(workspace, 'main.js'), 'new change');
  assert.equal((await resumed.boundary({ turn: 5, reason: 'completion' })).allowDone, true);
  assert.equal(inspections, 3, 'changed product is actually reinspected');
  assert.throws(() => createSelfReview({ ...options, task: 'different task' }), /does not match/);
});

test('completion inspects remaining slices without sending the worker back to edit after each pass', async t => {
  const { workspace, directory } = setup(t);
  fs.writeFileSync(path.join(workspace, 'DESIGN.md'), '# One\nReturn 42.\n# Two\nReject invalid input.\n');
  const inspected = [];
  const review = createSelfReview({ workspace, directory, task: 'Implement DESIGN.md.', documents: ['DESIGN.md'],
    modelFactory: () => ({}), inspect: async ({ units }) => {
      inspected.push(units[0].id);
      return { hashes: productHashes(workspace), report: report('verified', units[0].id) };
    } });
  assert.equal((await review.boundary({ turn: 0, reason: 'completion' })).allowDone, true);
  assert.equal(inspected.length, 3);
  assert.equal(new Set(inspected).size, 3);
});

test('declared generated reports do not invalidate review but source and test edits do', async t => {
  const { workspace, directory } = setup(t);
  fs.mkdirSync(path.join(workspace, 'test/reports'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'test/reports/result.json'), '{"time":1}');
  let inspections = 0;
  const review = createSelfReview({ workspace, directory, task: 'Return 42.', documents: [],
    verificationOutputDirs: 'test/reports', modelFactory: () => ({}), inspect: async ({ units }) => {
      inspections++;
      return { hashes: productHashes(workspace), report: report('verified', units[0].id) };
    } });
  assert.equal((await review.boundary({ turn: 0, reason: 'completion' })).allowDone, true);
  fs.writeFileSync(path.join(workspace, 'test/reports/result.json'), '{"time":2}');
  assert.equal((await review.boundary({ turn: 1, reason: 'completion' })).allowDone, true);
  assert.equal(inspections, 1, 'regenerated report timestamps do not require reinspection');
  fs.writeFileSync(path.join(workspace, 'test/reports/check.js'), 'throw Error("regression");');
  assert.equal((await review.boundary({ turn: 2, reason: 'completion' })).allowDone, true);
  assert.equal(inspections, 2, 'executable checks remain review inputs even in report directories');
  fs.writeFileSync(path.join(workspace, 'main.js'), 'export const answer = 43;');
  await review.boundary({ turn: 3, reason: 'completion' });
  assert.equal(inspections, 3);
});

test('review errors and cancellation cannot release work; reviews never overlap', async t => {
  const { workspace, directory } = setup(t); let release;
  const review = createSelfReview({ workspace, directory, task: 'Return 42.', documents: [], modelFactory: () => ({}),
    inspect: () => new Promise(resolve => { release = resolve; }) });
  const controller = new AbortController();
  const pending = review.boundary({ turn: 0, signal: controller.signal });
  await assert.rejects(review.boundary({ turn: 1 }), /overlap/);
  controller.abort(); release({ hashes: productHashes(workspace), report: report('verified', review.state.units[0].id) });
  assert.equal((await pending).allowDone, false);
  assert.equal(await review.boundary({ turn: 2, signal: controller.signal }), null);
  const another = createSelfReview({ workspace, directory: directory + '-error', task: 'Return 42.', documents: [], modelFactory: () => ({}),
    inspect: async () => { throw Error('inspector could not finish'); } });
  assert.equal((await another.boundary({ turn: 0 })).allowDone, false);
  assert.equal(another.state.units[0].status, 'inconclusive');
});

test('evidence cannot be stored in the product; cloud transports cannot be silently substituted', t => {
  const { workspace } = setup(t);
  assert.throws(() => createSelfReview({ workspace, task: 'job', directory: path.join(workspace, 'ledger') }), /outside/);
  for (const flag of ['codex', 'codexBacked', 'apiMode', 'deepseek', 'chatDialect']) assert.throws(() => sameLocalReviewer({ [flag]: true }), /local/);
  assert.deepEqual(parseArgs(['--self-review', 'the', 'task'])._, ['the', 'task']);
});

test('inspector has isolated context, protected files, exact evidence markers and separate recording', async t => {
  const { workspace, directory } = setup(t), events = [];
  const model = { usageSummary: () => ({ inputTokens: 17 }) };
  const result = await runInspection({ workspace, directory, task: 'Return 42.', units: [unit], model,
    onEvent: e => events.push(e), runAgentImpl: async options => {
      assert.notEqual(options.workspace, workspace);
      assert.equal(options.task, INSPECTOR_TASK);
      assert.match(options.supportingContext, /ORIGINAL USER ASSIGNMENT/);
      assert.equal(options.progressAwareness, false);
      assert.equal(options.grounding, true, 'inspection retains query and image-view tools');
      assert.equal(options.autoForceEditAfter, 0);
      assert.equal(options.inspectionBoundary, undefined);
      assert.equal(options.teacherAssist, null);
      assert.ok(options.readOnlyWorkspacePaths.includes('main.js'));
      assert.ok(!options.readOnlyWorkspacePaths.includes('.inspection'));
      assert.match(options.observationTransform('output', { turn: 7 }), /inspection-evidence turn=7/);
      options.onEvent({ type: 'action', action: { a: 'shell', c: 'node .inspection/check.js' } });
      options.onEvent({ type: 'observation', observation: turns[0].observation, shellExecution: turns[0].shellExecution });
      return { summary: JSON.stringify(report()), turns, done: true };
    } });
  assert.equal(result.report.units[0].status, 'verified');
  assert.equal(result.usage.inputTokens, 17);
  assert.ok(events.every(e => e.type === 'self_review_activity'), 'inspector actions cannot enter builder checkpoint');
  assert.ok(fs.existsSync(path.join(directory, 'result.json')));
});

function scripted(outputs, order) {
  return { assistantPrefill: '', actTemperature: null, prompts: [], requestCursor() { return this.prompts.length; },
    async complete(prompt) { order.push('worker'); this.prompts.push(String(prompt)); return { content: JSON.stringify(outputs.shift()), tokens: 1, stoppedEos: true, timings: {} }; } };
}

test('an inspector can record fresh screenshot output without invalidating its executed evidence', async t => {
  const { workspace, directory } = setup(t);
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module"}');
  const verdict = report(); verdict.units[0].evidence[0].turn = 1;
  const model = scripted([
    { a: 'write_file', p: '.inspection/behavior.test.mjs', content: "import fs from 'node:fs'; import assert from 'node:assert/strict'; import {answer} from '../main.js'; assert.equal(answer, 42); fs.writeFileSync('.inspection/shot.png', 'new screenshot'); console.log('independent check passed');" },
    { a: 'shell', c: 'node .inspection/behavior.test.mjs' },
    { a: 'respond', text: JSON.stringify(verdict) },
  ], []);
  const result = await runInspection({ workspace, directory, task: 'Inspect the required behavior.', units: [unit],
    model, shellSandbox: 'host', maxTurns: 6 });
  assert.equal(result.report.units[0].status, 'verified');
  assert.equal(model.prompts.length, 3, 'author one check, execute it and report; no redundant rerun');
  assert.doesNotMatch(model.prompts[2], /This command also changed source files/);
  assert.ok(fs.existsSync(path.join(directory, 'snapshot/.inspection/shot.png')));
  assert.ok(!fs.existsSync(path.join(workspace, '.inspection')));
});

test('worker waits for inspection and cannot finish through unresolved review', async t => {
  const { workspace } = setup(t), order = [], task = 'Explain the value.';
  const model = scripted([{ a: 'respond', text: 'It is 42.' }, { a: 'respond', text: 'It is 42, independently checked.' }], order);
  let completions = 0, pending = null;
  const result = await runAgent({ task, workspace, model, maxTurns: 10, advisoryMode: true, grounding: false,
    inspectionBoundary: async ({ reason }) => {
      order.push(reason);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (reason === 'completion') { pending = { allowDone: ++completions > 1, observation: selfReviewObservation(task, 'Automatic local inspection: run the independent assertion before completing.') }; return pending; }
      const r = pending; pending = null; return r;
    } });
  assert.equal(result.done, true); assert.equal(completions, 2);
  assert.deepEqual(order, ['periodic', 'worker', 'completion', 'periodic', 'worker', 'completion']);
  assert.match(model.prompts[1], /Automatic local inspection: run the independent assertion/);
  const evidence = result.turns.find(t => t.action === null);
  assert.notEqual(trustedReviewEvidenceEnd(evidence), null);
  assert.match(evidence.observation, /authority: automatic model inspection; verify its assessments/);
  assert.doesNotMatch(evidence.observation, /authority: operator-supplied/);
  const checkpoint = new RunCheckpoint(); checkpoint.note({ type: 'trusted_review', observation: evidence.observation });
  assert.equal(checkpoint.turns().length, 1);
});

test('nested same-endpoint inspector borrows the held lock and cannot overlap or reuse a retired lease', async t => {
  const { workspace } = setup(t), endpoint = 'http://127.0.0.1:1'; let lease, reviewerCalls = 0;
  const worker = scripted([{ a: 'respond', text: 'Finished answering.' }], []); worker.endpoint = endpoint;
  await runAgent({ task: 'Explain the value.', workspace, model: worker, maxTurns: 3, advisoryMode: true, grounding: false,
    inspectionBoundary: async ({ reason, inspectionLease }) => {
      if (reason === 'completion') return { allowDone: true };
      lease = inspectionLease;
      const reviewer = scripted([{ a: 'respond', text: 'Reviewed independently.' }], []); reviewer.endpoint = endpoint;
      let release; const complete = reviewer.complete;
      reviewer.complete = async (...args) => { reviewerCalls++; await new Promise(r => { release = r; }); return complete.apply(reviewer, args); };
      const pending = runAgent({ task: 'Inspect the value.', workspace, model: reviewer, maxTurns: 2, advisoryMode: true, grounding: false, inspectionLease });
      while (!release) await new Promise(r => setTimeout(r, 1));
      await assert.rejects(runAgent({ model: reviewer, inspectionLease }), /already borrowed/);
      release(); const result = await pending; assert.equal(result.done, true);
      return null;
    } });
  assert.equal(reviewerCalls, 1);
  await assert.rejects(runAgent({ model: worker, inspectionLease: lease }), /invalid/);
});

test('malformed inspection report is corrected in the same context without repeating tools or losing evidence', async t => {
  const { workspace, directory } = setup(t); let calls = 0;
  const good = JSON.stringify(report());
  const bad = good.slice(0, -1); // a different syntax defect must be returned to the model
  const result = await runInspection({ workspace, directory, task: 'Return 42.', units: [unit], model: {},
    runAgentImpl: async options => {
      calls++;
      if (calls === 1) return { done: true, summary: bad, turns };
      assert.deepEqual(options.resumeTurns, turns);
      assert.ok(options.excludeActions.includes('shell'));
      assert.ok(options.excludeActions.includes('write_file'));
      assert.ok(!options.excludeActions.includes('respond'));
      const messages = options.drainInjections();
      assert.equal(messages.length, 1);
      assert.match(messages[0].text, /report was rejected/);
      assert.notEqual(trustedReviewEvidenceEnd({ action: null, observation: messages[0].text }), null);
      assert.deepEqual(options.drainInjections(), []);
      return { done: true, summary: good, turns };
    } });
  assert.equal(calls, 2);
  assert.equal(result.report.units[0].status, 'verified');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'result-attempt-1.json'))).result.summary, bad);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'result.json'))).result.summary, good);
});

test('repeated report failures remain inconclusive with the rejected findings available and no private-path errand', async t => {
  const { workspace, directory } = setup(t); let calls = 0;
  const broken = 'Malformed report: independent assertion failed for fractional input.';
  const review = createSelfReview({ workspace, directory, task: 'Return 42.', documents: [], modelFactory: () => ({}),
    inspect: options => runInspection({ ...options, runAgentImpl: async () => {
      calls++; return { done: true, summary: broken, turns };
    } }) });
  const result = await review.boundary({ turn: 0 });
  assert.equal(calls, 4);
  assert.equal(result.allowDone, false);
  assert.match(result.text, /independent assertion failed for fractional input/);
  assert.match(result.text, /not a defect in your product/);
  assert.ok(!result.text.includes(directory));
});


test('a missing units delimiter is repaired without altering any report value or relaxing evidence checks', () => {
  const good = JSON.stringify(report());
  const bad = good.replace('}],"nextTask"', '},"nextTask"');
  const normalized = inspectionReportJSON(bad);
  assert.equal(normalized.text, good);
  assert.equal(normalized.text.length, bad.length + 1);
  assert.deepEqual(normalized.value, report());
  assert.equal(normalized.repair.kind, 'close-units-array');
  assert.equal(inspectionReportJSON(good).repair, null);
  assert.deepEqual(validateInspectionReport(bad, { units: [unit], turns, integrity: true }), report());
  assert.throws(() => validateInspectionReport(bad, { units: [unit], turns: [], integrity: true }), /not present/);
  assert.throws(() => inspectionReportJSON(good.slice(0, -1)));
  const quoted = report(); quoted.units[0].summary += ' Quote with \"nextTask\" and braces: }],';
  const literal = JSON.stringify(quoted); assert.equal(inspectionReportJSON(literal).text, literal);
});
