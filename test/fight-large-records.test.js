import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cornerUsage, readCornerUsage} from '../src/fight.js';
import {runFactoryFights} from '../scripts/factory-fights.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-large-fight-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}

function recordedRun() {
  const usage = {inputTokens:100, outputTokens:20, cacheHitTokens:80};
  return {result:{reachedDone:true, pass:true}, metrics:{turns:1, modelRequests:1, usage},
    turns:[{parsedAction:{a:'done'}, doneAccepted:true}],
    modelCalls:[{status:'ok', response:{normalized:{usage}}}]};
}

// Reproduce the actual ERR_STRING_TOO_LONG read boundary without requiring a
// multi-gigabyte fixture in every test run. Streaming fs reads remain available.
function disallowWholeReads(t, files) {
  const original = fs.readFileSync;
  return t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (files.has(String(file))) {
      const error = new Error('Cannot create a string longer than 0x1fffffe8 characters');
      error.code = 'ERR_STRING_TOO_LONG';
      throw error;
    }
    return Reflect.apply(original, this, [file, ...args]);
  });
}

test('file-backed fight usage streams complete records and keeps missing evidence unknown', async t => {
  const armDir = fixture(t), file = path.join(armDir, 'run.json'), run = recordedRun();
  run.modelCalls[0].request = {body:'雪🐔\n"\\'.repeat(180000)};
  fs.writeFileSync(file, JSON.stringify(run));
  disallowWholeReads(t, new Set([file]));
  assert.equal(cornerUsage('bantam-codex-astra', {armDir}), null, 'reproduce the old whole-file failure');
  const usage = await readCornerUsage('bantam-codex-astra', {armDir});
  assert.equal(usage.complete, true);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cacheHitTokens, 80);
  assert.deepEqual(cornerUsage('bantam-codex-astra', {run}), usage);
  assert.equal(cornerUsage('bantam-codex-astra', {armDir, run:null}), null);
  fs.writeFileSync(file, JSON.stringify({partial:true, modelCalls:[{}]}));
  assert.equal(await readCornerUsage('bantam-codex-astra', {armDir}), null);
  fs.writeFileSync(file, '{"metrics":{"usage":{"inputTokens":100}}');
  assert.equal(await readCornerUsage('bantam-codex-astra', {armDir}), null, 'unclosed JSON cannot become evidence');
  fs.unlinkSync(file);
  assert.equal(await readCornerUsage('bantam-codex-astra', {armDir}), null);
});

test('streaming usage retains native CLI accounting without requiring a run file', async () => {
  const options = {rawLines:['tokens used', '16,416']};
  assert.deepEqual(await readCornerUsage('codex-astra', options), cornerUsage('codex-astra', options));
});

test('fight adjudication uses streamed completion and usage, while a partial run remains output-only', async t => {
  const root = fixture(t), output = path.join(root, 'fight'), files = new Set();
  disallowWholeReads(t, files);
  let attempt = 0;
  const manifest = await runFactoryFights({output, arms:['bantam-codex-astra'],
    cards:['context-packet'], kitId:'factory-2026-09-07', repetitions:2}, {
    inspect:async () => {throw Error('No local model is needed');},
    contender:async (command, {dir}) => {
      const file = path.join(dir, 'run.json'); files.add(file);
      fs.writeFileSync(file, JSON.stringify(attempt++ === 0 ? recordedRun() : {partial:true, turns:[], modelCalls:[]}));
      return {code:0, stdout:'', stderr:'', wallMs:10, startedAt:new Date().toISOString(),
        timedOut:false, aborted:false, bufferExceeded:false};
    },
    grade:async () => ({publicResult:{code:0, stdout:'', stderr:''}, hidden:{code:0, stdout:'', stderr:''},
      record:{schema:'bantam.factory-card-grade.v1', card:'context-packet', pass:true, groups:[{name:'synthetic', pass:true}]},
      timing:{publicWallMs:0, hiddenWallMs:0, totalWallMs:0}}),
  });
  assert.equal(manifest.results[0].outcome, 'PASS');
  assert.equal(manifest.results[0].acceptedCompletion, true);
  assert.equal(manifest.results[0].usage.complete, true);
  assert.equal(manifest.results[0].usage.freshInputTokens, 20);
  assert.equal(manifest.results[1].outcome, 'OUTPUT_ONLY');
  assert.equal(manifest.results[1].acceptedCompletion, false);
  assert.equal(manifest.results[1].usage, null);
});
