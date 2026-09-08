import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {CONTEXT_DEMO, contextBrowserAPI, readFightDemo} from '../scripts/fight-demo.mjs';
import {packContext as recorded} from '../docs/fights/launch-2026-09-07/context-packet/demo/context-packet.js';
import {packContext as browser} from '../docs/fights/launch-2026-09-07/context-packet/demo/api.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {renderLaunchPage} from '../scripts/factory-launch-page.mjs';

const root = path.resolve(import.meta.dirname, '../docs/fights/launch-2026-09-07/context-packet');
const data = buildLaunchData(fs.readFileSync(path.join(root, 'showcase.json')));
const rows = data.series[0].cards[0].rows;
const result = (fn, ...args) => {try {return {value: fn(...args)};} catch (error) {return {error: error.message};}};

test('the demo is bound to the actual passing candidate and preserves its API function bodies', () => {
  const demo = readFightDemo(root, rows);
  assert.equal(demo.receipt.candidateSha256, CONTEXT_DEMO.candidateSha256);
  const bytes = fs.readFileSync(path.join(root, 'demo/context-packet.js'));
  assert.equal(contextBrowserAPI(bytes), fs.readFileSync(path.join(root, 'demo/api.mjs'), 'utf8'));
  assert.throws(() => contextBrowserAPI(Buffer.concat([bytes, Buffer.from('\n')])), /not been reviewed/);
  const changed = structuredClone(rows); changed.find(r => r.arm === 'bantam-local-27b').wallMs++;
  assert.throws(() => readFightDemo(root, changed), /unbound/);
  assert.throws(() => renderLaunchPage({...data, series: [{...data.series[0], cards: [{...data.series[0].cards[0], card: 'job-planner'}]}]}, {demo: demo.receipt}), /does not match/);
});

test('browser byte counting matches the recorded Node API across budgets, priorities, Unicode and validation errors', () => {
  const sections = [
    {id: 'required', text: '🐓 café 漢字\n', priority: 0, required: true},
    {id: 'long', text: 'longer notes '.repeat(8), priority: 9, required: false},
    {id: 'small', text: '\ud800\u0000\n', priority: 6, required: false},
    {id: 'tie', text: 'same priority', priority: 6, required: false},
  ];
  for (let budget = 0; budget <= 500; budget += 7)
    assert.deepEqual(result(browser, sections, budget), result(recorded, sections, budget));
  for (const input of [[], [null], Array(1), [sections[0], sections[0]], [{...sections[0], priority: 1.5}]])
    assert.deepEqual(result(browser, input, 100), result(recorded, input, 100));
  for (const budget of [null, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])
    assert.deepEqual(result(browser, sections, budget), result(recorded, sections, budget));
});

test('rehashing a changed worker does not make arbitrary browser code a reviewed demo', t => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-demo-check-'));
  t.after(() => fs.rmSync(copy, {recursive: true, force: true}));
  fs.cpSync(path.join(root, 'demo'), path.join(copy, 'demo'), {recursive: true});
  const file = path.join(copy, 'demo/worker.mjs'), bytes = Buffer.from("fetch('https://example.invalid');\n");
  fs.writeFileSync(file, bytes);
  const manifest = path.join(copy, 'demo/package.json'), receipt = JSON.parse(fs.readFileSync(manifest));
  Object.assign(receipt.files.find(f => f.path === 'worker.mjs'), {bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
  fs.writeFileSync(manifest, JSON.stringify(receipt));
  assert.throws(() => readFightDemo(copy, rows), /adapter changed/);
});
