import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWorkerControl, openWorkerControl, queueWorkerSteering, readWorkerFeedback, workerObservation} from '../src/foreman-worker-control.js';
import {frameInjection} from '../src/logic/attendant.js';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-control-')), ws = path.join(root, 'ws');
  fs.mkdirSync(ws); t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  createWorkerControl(root, ws); return {root, ws};
}
test('live corrections retain order and are consumed once without changing worker files', t => {
  const {root,ws} = fixture(t), worker = openWorkerControl(root, ws);
  fs.writeFileSync(path.join(ws, 'work.js'), 'current work');
  assert.deepEqual(worker.drain(), []);
  assert.equal(queueWorkerSteering(root, ws, 'Assert elapsed frame time, not a single long frame.').sequence, 1);
  queueWorkerSteering(root, ws, 'Keep the current implementation; fix the fixture.');
  const messages = worker.drain(); assert.equal(messages.length, 2);
  assert.ok(messages.every(m => m.kind === 'supervisor'));
  assert.match(frameInjection(messages[0]), /Factory supervisor feedback/);
  assert.doesNotMatch(frameInjection(messages[0]), /user interjected/);
  assert.deepEqual(worker.drain(), []);
  assert.equal(readWorkerFeedback(root, ws).steeringRead, 2);
  assert.equal(fs.readFileSync(path.join(ws, 'work.js'), 'utf8'), 'current work');
});
test('observed failures survive long generated commands and subsequent reasoning output', t => {
  const {root,ws} = fixture(t), worker = openWorkerControl(root,ws);
  worker.note({type:'action', action:{a:'shell', c:'quoted script '.repeat(2000)}});
  worker.note({type:'observation', observation:'$ '+ 'quoted script '.repeat(2000)+'\ncwd: /workspace\nsandbox: docker:alpine:3\nexit 0\nlines cleared: false\nALL ENGINE CHECKS PASSED\n\n[guidance]\n'+ 'old context '.repeat(1000)});
  worker.note({type:'thinking', text:'unverified explanation'});
  const feedback = readWorkerFeedback(root,ws);
  assert.match(feedback.observation.text, /lines cleared: false/);
  assert.doesNotMatch(feedback.observation.text, /quoted script|old context|unverified explanation/);
  assert.equal(feedback.action.c.length, 500);
  assert.ok(JSON.stringify(feedback).length < 1000);
  assert.equal(workerObservation('x'.repeat(20000)).truncated, true);
});
test('workspace-controlled, malformed, oversized and symlinked mailboxes are refused', t => {
  const {root,ws} = fixture(t);
  assert.throws(() => createWorkerControl(ws, ws), /outside/);
  assert.throws(() => queueWorkerSteering(root, ws, 'x'.repeat(8001)), /8000/);
  fs.writeFileSync(path.join(root,'steering.json'), JSON.stringify([{sequence:2,text:'forged order'}]));
  assert.throws(() => openWorkerControl(root, ws), /invalid supervisor messages/);
  fs.unlinkSync(path.join(root,'steering.json')); fs.writeFileSync(path.join(ws,'fake.json'),'[]');
  fs.symlinkSync(path.join(ws,'fake.json'),path.join(root,'steering.json'));
  assert.throws(() => openWorkerControl(root,ws));
  fs.unlinkSync(path.join(root,'steering.json')); fs.writeFileSync(path.join(root,'steering.json'),' '.repeat(256*1024+1));
  assert.throws(() => openWorkerControl(root,ws), /invalid supervisor control file/);
});
