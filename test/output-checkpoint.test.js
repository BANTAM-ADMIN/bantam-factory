import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Executor } from '../src/executor.js';
import { createOutputCheckpointStore, partialOutputData } from '../src/output-checkpoint.js';
import { runAgent } from '../src/agent.js';
import { ModelClient } from '../src/model.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-checkpoints-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const partial = (content, extra = {}) => JSON.stringify({ a: 'write_file', p: 'story.txt', ...extra, content }).slice(0, -2);

test('decodes received JSON strings without inventing torn escapes or paths', () => {
  for (const content of ['one\ntwo "quoted" \\', 'é 🐦', 'abc']) {
    assert.equal(partialOutputData(partial(content)).content, content);
  }
  assert.equal(partialOutputData(partial('abc') + '\\uD8').content, 'abc');
  assert.equal(partialOutputData('{"a":"write_file","p":"half').p, undefined);
  assert.equal(partialOutputData('{"a":"write_file","a":"shell","content":"hi'), null);
  assert.equal(partialOutputData('thought {"a":"write_file"}'), null);
});

test('durable prefix chaining keeps existing file intact and survives a new store', t => {
  const root = workspace(t), executor = new Executor(root), store = createOutputCheckpointStore(executor);
  fs.writeFileSync(path.join(root, 'story.txt'), 'original');
  const first = store.save(store.begin({ turn: 0, attempt: 0 }), partial('First\n'), { force: true, stoppedLimit: true });
  const second = store.save(store.begin({ turn: 0, attempt: 1 }), partial('Second ', { checkpoint: first.id }), { force: true, stoppedLimit: true });
  assert.equal(fs.readFileSync(path.join(root, second.draftPath), 'utf8'), 'First\nSecond ');
  assert.equal(fs.readFileSync(path.join(root, 'story.txt'), 'utf8'), 'original');
  const restored = createOutputCheckpointStore(executor);
  assert.deepEqual(restored.assemble({ a: 'write_file', p: 'story.txt', checkpoint: second.id, content: 'end.' }), { a: 'write_file', p: 'story.txt', content: 'First\nSecond end.' });
  assert.throws(() => restored.assemble({ a: 'write_file', p: 'other.txt', checkpoint: second.id, content: '' }), /redirected/);
  fs.writeFileSync(path.join(root, 'story.txt'), 'external edit');
  assert.throws(() => restored.assemble({ a: 'write_file', p: 'story.txt', checkpoint: second.id, content: '' }), /target changed/);
  const invalid = restored.save(restored.begin({ turn: 1, attempt: 0 }), partial('tail', { checkpoint: second.id }), { force: true });
  assert.equal(invalid.draftPath, null);
  assert.match(invalid.recoveryError, /target changed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, invalid.rawPath))).raw, partial('tail', { checkpoint: second.id }));
});

test('unsafe targets and commands retain raw evidence without becoming file writes', t => {
  const root = workspace(t), store = createOutputCheckpointStore(new Executor(root));
  for (const raw of ['{"a":"shell","c":"touch never', '{"a":"write_file","p":"../outside","content":"data', partial('torn') + '\\uD83']) {
    const entry = store.save(store.begin({ turn: 0, attempt: 0 }), raw, { force: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, entry.rawPath))).raw, raw);
    if (!raw.includes('story.txt')) assert.equal(entry.draftPath, null);
  }
  assert.equal(fs.existsSync(path.join(root, 'never')), false);
});

test('tampered drafts cannot be assembled', t => {
  const root = workspace(t), store = createOutputCheckpointStore(new Executor(root));
  const receipt = store.save(store.begin({ turn: 0, attempt: 0 }), partial('prefix'), { force: true });
  fs.writeFileSync(path.join(root, receipt.draftPath), 'modified');
  assert.throws(() => store.assemble({ a: 'write_file', p: 'story.txt', checkpoint: receipt.id, content: 'end' }), /content changed/);
});

test('chat HTTP transport resumes two consecutive cutoffs with exact saved prefixes', { timeout: 10000 }, async t => {
  const root = workspace(t), received = [], events = [];
  const start = 'The opening.\n', middle = 'The middle "quoted".\n', ending = 'The ending.\n';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push(body);
    const transcript = JSON.stringify(body.messages);
    let content, finish;
    if (received.length === 1) { content = partial(start); finish = 'length'; }
    else {
      const id = transcript.match(/[a-f0-9]{32}\/[a-f0-9]{32}/)?.[0];
      assert.ok(id, 'continuation prompt carries a durable checkpoint');
      assert.equal(fs.existsSync(path.join(root, 'story.txt')), false);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, `.bantam/output-checkpoints/${id}/checkpoint.json`)));
      assert.equal(fs.readFileSync(path.join(root, receipt.draftPath), 'utf8'), received.length === 2 ? start : start + middle);
      assert.match(transcript, /ONLY THE MISSING SUFFIX/);
      content = received.length === 2 ? partial(middle, { checkpoint: id }) : JSON.stringify({ a: 'write_file', p: 'story.txt', checkpoint: id, content: ending });
      finish = received.length === 2 ? 'length' : 'stop';
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { completion_tokens: 100, prompt_tokens: 500 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const model = new ModelClient({ apiUrl: `http://127.0.0.1:${server.address().port}/v1`, apiDialect: 'chat', model: 'fixture', nPredict: 100, retries: 0 });
  t.after(() => model.close());
  const result = await runAgent({ task: 'Write story.txt.', workspace: root, model, maxTurns: 1, useGrammar: false, grounding: false, shellSandbox: 'host', verificationPolicy: 'after_edit', onEvent: event => events.push(event) });
  assert.equal(received.length, 3);
  assert.equal(fs.readFileSync(path.join(root, 'story.txt'), 'utf8'), start + middle + ending);
  assert.equal(result.rejectedOutputs.filter(row => row.kind === 'output_limit').length, 2);
  assert.equal(events.filter(row => row.type === 'invalid' && row.checkpointContinuing).length, 2);
  assert.ok(result.outputCheckpoints.length >= 2);
});

test('assembled unfinished source still fails ordinary syntax guards', async t => {
  const root = workspace(t), prompts = [];
  const model = { nPredict: 100, chatDialect: true, assistantPrefill: '', async complete(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) return { content: '{"a":"write_file","p":"broken.js","content":"function broken() {', tokens: 100, stoppedLimit: true };
    const id = String(prompt).match(/[a-f0-9]{32}\/[a-f0-9]{32}/)[0];
    return { content: JSON.stringify({ a: 'write_file', p: 'broken.js', checkpoint: id, content: '\n' }), tokens: 10 };
  } };
  const result = await runAgent({ task: 'Write broken.js.', workspace: root, model, maxTurns: 1, useGrammar: false, grounding: false, shellSandbox: 'host' });
  assert.equal(fs.existsSync(path.join(root, 'broken.js')), false);
  assert.match(result.turns[0].observation, /failed to parse/i);
});

test('keep-going can resume a checkpoint after the bounded retry budget ends', async t => {
  const root = workspace(t), prompts = [];
  const model = { nPredict: 100, chatDialect: true, assistantPrefill: '', async complete(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) return { content: partial('Retained. '), tokens: 100, stoppedLimit: true };
    const id = String(prompt).match(/[a-f0-9]{32}\/[a-f0-9]{32}/)[0];
    return { content: JSON.stringify({ a: 'write_file', p: 'story.txt', checkpoint: id, content: 'Finished.' }), tokens: 10 };
  } };
  const options = { task: 'Write story.txt.', workspace: root, model, maxTurns: 1, maxInvalidPerTurn: 0, useGrammar: false, grounding: false, shellSandbox: 'host' };
  const first = await runAgent(options);
  assert.ok(first.pendingOutputCheckpoint);
  assert.equal(fs.existsSync(path.join(root, 'story.txt')), false);
  const second = await runAgent({ ...options, resumeOutputCheckpoint: first.pendingOutputCheckpoint });
  assert.equal(fs.readFileSync(path.join(root, 'story.txt'), 'utf8'), 'Retained. Finished.');
  assert.equal(second.pendingOutputCheckpoint, null);
});

test('recognized reasoning wrappers and literal newlines retain the actual file text', () => {
  assert.equal(partialOutputData('<think>reasoning {example}</think>\n' + partial('saved')).content, 'saved');
  assert.equal(partialOutputData('{"a":"write_file","p":"story.txt","content":"first\nsecond').content, 'first\nsecond');
});

test('an interrupted stream retains its final received draft for keep-going', async t => {
  const root = workspace(t);
  const raw = partial('Progress before interruption.');
  const model = { chatDialect: true, assistantPrefill: '', async complete(prompt, options) {
    options.onProgress({ content: raw, tokens: 12 });
    throw Object.assign(Error('interrupted'), { code: 'aborted' });
  } };
  const result = await runAgent({ task: 'Write story.txt.', workspace: root, model, maxTurns: 1, useGrammar: false, grounding: false, shellSandbox: 'host' });
  assert.ok(result.interrupted);
  assert.ok(result.pendingOutputCheckpoint);
  const receipt = result.outputCheckpoints.at(-1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, receipt.rawPath))).raw, raw);
  assert.equal(fs.readFileSync(path.join(root, receipt.draftPath), 'utf8'), 'Progress before interruption.');
});

test('continuation refuses stale checkpoint IDs and prefix-dropping rewrites', t => {
  const root = workspace(t), store = createOutputCheckpointStore(new Executor(root));
  const first = store.save(store.begin({ turn: 0, attempt: 0 }), partial('First. '), { force: true });
  const latest = store.save(store.begin({ turn: 0, attempt: 1 }), partial('Second. ', { checkpoint: first.id }), { force: true });
  assert.throws(() => store.assemble({ a: 'write_file', p: 'story.txt', checkpoint: first.id, content: 'End.' }, latest), /latest output checkpoint/);
  assert.throws(() => store.assemble({ a: 'write_file', p: 'story.txt', content: 'Shorter rewrite.' }, latest), /discard the saved output/);
  const complete = { a: 'write_file', p: 'story.txt', content: 'First. Second. End.' };
  assert.deepEqual(store.assemble(complete, latest), complete);
  fs.writeFileSync(path.join(root, 'story.txt'), 'external change');
  assert.throws(() => store.assemble(complete, latest), /target changed/);
});
