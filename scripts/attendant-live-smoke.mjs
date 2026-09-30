// Opt-in live smoke: node scripts/attendant-live-smoke.mjs [http://localhost:8085]
// Uses the CLI's actual attendant function and ModelClient, not a full terminal UI.
// Requires an idle native llama.cpp server with at least two slots. No agent tools run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {ModelClient} from '../src/model.js';
import {buildAttendantPrompt, makeAttendantState, frameInjection, pendingOperatorRequests} from '../src/logic/attendant.js';

const endpoint = process.argv[2] || 'http://localhost:8085';
const signal = AbortSignal.timeout(120000);
async function slots() {
  const r = await fetch(`${endpoint}/slots`, {signal});
  assert.equal(r.status, 200);
  return r.json();
}
const initial = await slots();
assert.ok(initial.length >= 2, 'needs two slots');
assert.ok(initial.every(s => !s.is_processing), 'server must be idle before smoke');
console.log('Slots:', initial.map(s => ({id:s.id, n_ctx:s.n_ctx})));
const client = new ModelClient({endpoint, apiUrl:null});
let calls = 0;
const output = [];
const question = 'While you work, what have you verified so far?';
const context = vm.createContext({
  model: {endpoint, complete: (p, o) => { calls++; return client.complete(p, {...o, signal, retries:0}); }},
  running:true, aborted:false, attendantRun:makeAttendantState(),
  attendantBusy:false, attendantSlots:null, attendantPersona:null,
  lastUserQuestion:'List the integers from 1 to 1000, one per line.',
  injections:[question], buildAttendantPrompt, emit:s => output.push(s),
  fetch, AbortSignal,
});
const source = fs.readFileSync(new URL('../bin/bantam.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function maybeAttendantReply(question) {');
const end = source.indexOf('\n  // Session-persistent code KB.', start);
assert.ok(start >= 0 && end > start, 'CLI extraction markers must exist');
vm.runInContext(source.slice(start, end), context);
let workerDone = false;
const worker = client.complete('im_startuser\nList the integers from 1 to 1000, one per line. Do not abbreviate.im_end\nim_startassistant\nthink\n\nthink\n\n', {nPredict:800, temperature:0.2, signal, retries:0});
// Attach rejection handling immediately while observing concurrent server work.
const settledWorker = worker.then(r => {workerDone=true; return {r};}, e => {workerDone=true; return {e};});
try {
  while (!(await slots()).some(s => s.is_processing)) {
    assert.ok(!workerDone, 'worker must still be generating');
    await delay(25, undefined, {signal});
  }
  const reply = context.maybeAttendantReply(question);
  await context.maybeAttendantReply('Duplicate concurrent invocation must be suppressed');
  let bothBusy = false;
  let replyDone = false;
  const settledReply = reply.finally(() => {replyDone=true;});
  while (!replyDone) {
    if ((await slots()).filter(s => s.is_processing).length >= 2) bothBusy=true;
    await delay(25, undefined, {signal});
  }
  await settledReply;
  assert.ok(bothBusy, 'must observe both slots processing simultaneously');
  assert.equal(calls, 1, 'single-flight includes asynchronous slot probe');
  assert.ok(output.length > 0, 'live reply must be emitted');
  assert.equal(context.injections.length, 2);
  assert.equal(context.injections[1].kind, 'attendant');
  const framed = context.injections.map(frameInjection).join('\n');
  assert.doesNotMatch(framed, /\[object Object\]/);
  assert.match(framed, /Your own live voice/);
  assert.deepEqual(pendingOperatorRequests(Array.from(context.injections)), [question]);
  assert.deepEqual(pendingOperatorRequests([context.injections[1]]), []);
  console.log('Attendant:', output.join('\n'));
  console.log('PASS: overlapping slots; single-flight; typed handoff; only operator text survives run cleanup.');
  const before = output.length;
  context.injections = [];
  const late = context.maybeAttendantReply('Give me a brief status update.');
  context.attendantRun = makeAttendantState();
  await late;
  assert.equal(calls, 2);
  assert.equal(output.length, before, 'late reply must not reach the operator');
  assert.equal(context.injections.length, 0, 'late reply must not reach another run');
  assert.equal(context.attendantBusy, false);
  console.log('PASS: late reply discarded after run replacement.');
} finally {
  const result = await settledWorker;
  if (result.e) throw result.e;
  assert.ok(result.r.content?.trim(), 'worker must also return real text');
  console.log('Worker response characters:', result.r.content.length);
}
