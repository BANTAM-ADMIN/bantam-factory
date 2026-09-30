import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCopySpec, buildCopyProbe, copyProbeInput, COPY_SPEC_SCHEMA, COPY_SPEC_GRAMMAR, COPY_PROBE_CASE_COUNT } from '../src/copy-preservation-probe.js';

const spec = { module: 'api.mjs', calls: [
  { export: 'create', args: [] },
  { export: 'put', args: [{ $result: 0 }, { metadata: { $input: true } }] },
  { export: 'read', args: [{ $result: 1 }] },
], observePath: ['metadata'] };
const source = `export function create(){return {};}
export function put(state,value){return {...state,metadata:structuredClone(value.metadata)};}
export function read(state){return state;}`;
function fixture(t, code = source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-jig-'));
  fs.mkdirSync(path.join(root, 'subject'));
  fs.writeFileSync(path.join(root, 'subject/api.mjs'), code);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function execute(root, obligation, fixtureSpec = spec) {
  const action = buildCopyProbe(fixtureSpec, obligation, [{ p: 'api.mjs' }]);
  return spawnSync('/bin/sh', ['-c', action.check], { cwd: root, encoding: 'utf8', timeout: 7000 });
}

test('bounded declarative parser accepts call composition and one nested input envelope', () => {
  assert.deepEqual(parseCopySpec(JSON.stringify(spec), ['api.mjs']), spec);
  assert.deepEqual(parseCopySpec(JSON.stringify(spec), [{ path: 'api.mjs' }]), spec);
  assert.ok(parseCopySpec(JSON.stringify({ module: 'src/api.js', calls: [{ export: '$copy', args: [{ $input: true }] }], observePath: [] }), ['src/api.js']));
});

test('optional input templates are literal bounded objects, never reference or oracle capabilities', () => {
  const withTemplate = { ...spec, inputTemplate: { tags: ['seed'], count: 2 } };
  assert.deepEqual(parseCopySpec(JSON.stringify(withTemplate), ['api.mjs']), withTemplate);
  for (const inputTemplate of [null, [], 3, 'literal', { $input: true }, { $result: 0 },
    { child: { $input: true } }, { values: [{ $result: 0 }] }, { $unknown: 'x' },
    JSON.parse('{"__proto__":{}}'), { child: { constructor: 'x' } }, { text: 'x'.repeat(8200) }]) {
    assert.equal(parseCopySpec(JSON.stringify({ ...spec, inputTemplate }), ['api.mjs']), null, JSON.stringify(inputTemplate));
  }
  let nested = {};
  for (let i = 0; i < 14; i++) nested = { child: nested };
  assert.equal(parseCopySpec(JSON.stringify({ ...spec, inputTemplate: nested }), ['api.mjs']), null);
  assert.equal(parseCopySpec(JSON.stringify({ ...spec, inputTemplate: {}, corpus: [] }), ['api.mjs']), null);
});

test('shared input construction preserves template fields, avoids collisions and clones each case', () => {
  const inputTemplate = { tags: ['seed'], count: 2, copyProbeValue: 'reserved', copyProbeValue1: 'also reserved',
    expected: 'not an oracle', corpus: ['not the corpus'] };
  const fixtureSpec = { ...spec, inputTemplate }, value = [[{ flag: true }]];
  const input = copyProbeInput(fixtureSpec, value);
  assert.deepEqual(input, { ...inputTemplate, copyProbeValue2: value });
  input.tags.push('mutated'); input.copyProbeValue2[0][0].flag = false;
  assert.deepEqual(inputTemplate.tags, ['seed']);
  assert.deepEqual(value, [[{ flag: true }]]);
  assert.deepEqual(copyProbeInput(fixtureSpec, value), { ...inputTemplate, copyProbeValue2: value });
  assert.deepEqual(copyProbeInput(spec, value), { value });
  assert.notEqual(copyProbeInput(spec, value).value, value);
});

test('parser rejects unsafe paths, prototype access, duplicate keys, forward references and unbounded fixture data', () => {
  const parse = value => parseCopySpec(JSON.stringify(value), [{ path: value.module }]);
  for (const module of ['../api.mjs', './api.mjs', '/api.mjs', 'src/../api.mjs', 'src\\api.mjs', 'file:api.mjs', 'api.ts']) assert.equal(parse({ ...spec, module }), null, module);
  assert.equal(parseCopySpec(JSON.stringify(spec), ['elsewhere.mjs']), null);
  assert.equal(parseCopySpec(JSON.stringify(spec).replace('"module":', '"module":"extra.mjs","module":'), ['api.mjs']), null);
  for (const call of [
    { export: 'constructor', args: [{ $input: true }] },
    { export: 'default', args: [{ $input: true }] },
    { export: 'call()', args: [{ $input: true }] },
    { export: 'copy', args: [{ $input: true }, { $input: true }] },
    { export: 'copy', args: [{ $input: true, extra: 1 }] },
    { export: 'copy', args: [{ $input: true }, { $result: 0 }] },
    { export: 'copy', args: [{ $input: true }, { $result: -1 }] },
    { export: 'copy', args: [{ $input: true }, { $unknown: 'x' }] },
    { export: 'copy', args: [{ $input: true }, JSON.parse('{"__proto__":{}}')] },
    { export: 'copy', args: Array.from({ length: 9 }, (_, i) => i ? null : { $input: true }) },
  ]) assert.equal(parse({ ...spec, calls: [call] }), null, JSON.stringify(call));
  for (const observePath of [['__proto__'], ['prototype'], ['constructor'], [-1], [1.1], [1000001], Array(9).fill('x')]) assert.equal(parse({ ...spec, observePath }), null);
  assert.equal(parse({ ...spec, calls: [] }), null);
  assert.equal(parse({ ...spec, calls: Array(5).fill(spec.calls[0]) }), null);
  assert.equal(parse({ ...spec, extra: true }), null);
  assert.equal(parse({ ...spec, calls: [{ export: 'copy', args: ['x'.repeat(8200), { $input: true }] }] }), null);
  assert.equal(parse({ ...spec, calls: [{ export: 'copy', args: [{ $input: true }, Array(65).fill(null)] }] }), null);
  let nested = 0; for (let i = 0; i < 14; i++) nested = { child: nested };
  assert.equal(parse({ ...spec, calls: [{ export: 'copy', args: [{ $input: true }, nested] }] }), null);
});

test('real isolated child accepts a correct copy with composed public calls', t => {
  const root = fixture(t);
  for (const obligation of ['shape-preservation', 'input-detachment']) {
    const result = execute(root, obligation);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.cases, COPY_PROBE_CASE_COUNT);
    assert.equal(receipt.calls, COPY_PROBE_CASE_COUNT * spec.calls.length);
  }
});

test('nested-array objectification is a measured shape failure with a small reproducible case', t => {
  const broken = source.replace('structuredClone(value.metadata)', 'badCopy(value.metadata)')
    + '\nfunction badCopy(v){if(v===null||typeof v!=="object")return v;if(Array.isArray(v))return v.map(x=>Array.isArray(x)?Object.fromEntries(x.map((y,i)=>[i,badCopy(y)])):badCopy(x));return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,badCopy(x)]));}';
  const result = execute(fixture(t, broken), 'shape-preservation');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(receipt.input, { value: [[]] });
  assert.deepEqual(receipt.actual, { value: [{}] });
  assert.deepEqual(receipt.differencePath, ['value', 0]);
});

test('a constrained record template stays valid while generic nested metadata exposes copying defects', t => {
  const fixtureSpec = { module: 'api.mjs', inputTemplate: { tags: ['seed'], count: 2 },
    calls: [{ export: 'preserve', args: [{ $input: true }] }], observePath: [] };
  const recordSource = `export function preserve(record){
    if(!Array.isArray(record.tags)||record.tags.length!==1||record.tags[0]!=="seed"||record.count!==2)throw Error("required record fields changed");
    return structuredClone(record);
  }`;
  const root = fixture(t, recordSource);
  for (const id of ['shape-preservation', 'input-detachment']) {
    const result = execute(root, id, fixtureSpec);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).cases, COPY_PROBE_CASE_COUNT);
  }
  const broken = recordSource.replace('structuredClone(record)', 'badCopy(record)')
    + '\nfunction badCopy(v){if(v===null||typeof v!=="object")return v;if(Array.isArray(v))return v.map(x=>Array.isArray(x)?Object.fromEntries(x.map((y,i)=>[i,badCopy(y)])):badCopy(x));return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,badCopy(x)]));}';
  const failed = execute(fixture(t, broken), 'shape-preservation', fixtureSpec);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const receipt = JSON.parse(failed.stdout);
  assert.deepEqual(receipt.input, { tags: ['seed'], count: 2, copyProbeValue: [[]] });
  assert.deepEqual(receipt.actual, { tags: ['seed'], count: 2, copyProbeValue: [{}] });
  assert.deepEqual(receipt.differencePath, ['copyProbeValue', 0]);
});

test('template-shaped oracle and corpus names remain ordinary subject data', t => {
  const fixtureSpec = { module: 'api.mjs', inputTemplate: {
    expected: { anything: true }, corpus: [], cases: 0, status: 'passed', copyProbeValue: 'keep', copyProbeValue1: 'keep also',
  }, calls: [{ export: 'preserve', args: [{ $input: true }] }], observePath: [] };
  const good = execute(fixture(t, 'export function preserve(value){return structuredClone(value);}'), 'shape-preservation', fixtureSpec);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(JSON.parse(good.stdout).cases, COPY_PROBE_CASE_COUNT);
  const bad = execute(fixture(t, 'export function preserve(value){const out=structuredClone(value);out.copyProbeValue2="overwritten";return out;}'), 'shape-preservation', fixtureSpec);
  assert.equal(bad.status, 125, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /positive-control/);
  assert.match(bad.stderr, /"copyProbeValue2":"baseline"/);
});

test('input detachment distinguishes deep copies from shallow copies and direct aliases', t => {
  for (const [replacement, expectedInput] of [['{...value.metadata}', { value: {} }], ['value.metadata', { value: 'baseline' }]]) {
    const root = fixture(t, source.replace('structuredClone(value.metadata)', replacement));
    const shape = execute(root, 'shape-preservation');
    assert.equal(shape.status, 0, shape.stdout + shape.stderr);
    const detached = execute(root, 'input-detachment');
    assert.equal(detached.status, 1, detached.stdout + detached.stderr);
    const receipt = JSON.parse(detached.stdout);
    assert.deepEqual(receipt.input, expectedInput);
    assert.match(receipt.message, /mutating the original input changed/i);
  }
});

test('bad setup, bad observation and unsupported data remain unverified rather than implementation failures', t => {
  const variants = [
    source.replace('return {};', 'throw Error("fixture needs a missing argument");'),
    source.replace('return state;', 'return {};'),
    source.replace('return state;', 'return undefined;'),
    source.replace('return state;', 'return {metadata:Promise.resolve(1)};'),
    source.replace('return state;', 'return {get metadata(){throw Error("getter must not run");}};'),
    source.replace('return state;', 'return {metadata:NaN};'),
    source.replace('export function read', 'export async function read'),
  ];
  for (const code of variants) {
    const result = execute(fixture(t, code), 'shape-preservation');
    assert.equal(result.status, 125, result.stdout + result.stderr);
    assert.match(result.stderr, /UNAVAILABLE/);
    assert.doesNotMatch(result.stdout, /"status":"failed"/);
  }
  const missing = execute(fixture(t), 'shape-preservation', { ...spec, observePath: ['missing'] });
  assert.equal(missing.status, 125);
});

test('initial identity mismatch is an unverified positive control, never an implementation failure', t => {
  const root = fixture(t, source.replace('structuredClone(value.metadata)', '{}'));
  assert.equal(execute(root, 'shape-preservation').status, 125);
  const detached = execute(root, 'input-detachment');
  assert.equal(detached.status, 125);
  assert.match(detached.stderr, /baseline positive control/);
  const later = fixture(t, source.replace('structuredClone(value.metadata)', 'value.metadata.value === "baseline" ? structuredClone(value.metadata) : {}'));
  assert.equal(execute(later, 'shape-preservation').status, 1);
  assert.equal(execute(later, 'input-detachment').status, 125);
});

test('transforming APIs and dropped unknown metadata invalidate the baseline fixture rather than the candidate', t => {
  const fixtureSpec = { module: 'api.mjs', inputTemplate: { tags: ['seed'], count: 2 },
    calls: [{ export: 'migrate', args: [{ $input: true }] }], observePath: [] };
  for (const code of [
    'export function migrate(input){return {...structuredClone(input),state:[]};}',
    'export function migrate(input){return {tags:structuredClone(input.tags),count:input.count};}',
  ]) for (const obligation of ['shape-preservation', 'input-detachment']) {
    const result = execute(fixture(t, code), obligation, fixtureSpec);
    assert.equal(result.status, 125, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /"status":"unavailable"/);
    assert.match(result.stderr, /"phase":"positive-control"/);
    assert.match(result.stderr, /"cases":0/);
    assert.match(result.stderr, /baseline positive control/);
  }
});

test('an established observation path disappearing for supported recursive data is a measured failure', t => {
  const root = fixture(t, source.replace('return state;', 'return state.metadata.value === "baseline" ? state : {};'));
  const result = execute(root, 'shape-preservation');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.cases, 1);
  assert.deepEqual(receipt.input, { value: null });
  assert.match(receipt.message, /observation path is missing/);
});

test('a later supported nested-input exception is a measured failure after the baseline succeeds', t => {
  const fixtureSpec = { module: 'api.mjs', calls: [{ export: 'duplicate', args: [{ $input: true }] }], observePath: [] };
  const code = `export function duplicate(input){if(nested(input))throw Error("nested layout rejected");return structuredClone(input);}
    function nested(value){return value!==null&&typeof value==="object"&&((Array.isArray(value)&&value.some(Array.isArray))||Object.values(value).some(nested));}`;
  const root = fixture(t, code);
  for (const obligation of ['shape-preservation', 'input-detachment']) {
    const result = execute(root, obligation, fixtureSpec);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.phase, 'checking');
    assert.equal(receipt.cases, 10);
    assert.equal(receipt.calls, 11);
    assert.deepEqual(receipt.input, { value: [[]] });
    assert.match(receipt.caseContext, /call 0 export duplicate/);
    assert.match(receipt.message, /nested layout rejected/);
  }
});

test('a mid-sequence supported-input exception retains partial call evidence instead of becoming unavailable', t => {
  const code = source.replace('return {...state,metadata:structuredClone(value.metadata)};',
    'if(nested(value.metadata))throw Error("nested layout rejected in put");return {...state,metadata:structuredClone(value.metadata)};')
    + '\nfunction nested(value){return value!==null&&typeof value==="object"&&((Array.isArray(value)&&value.some(Array.isArray))||Object.values(value).some(nested));}';
  const root = fixture(t, code);
  for (const obligation of ['shape-preservation', 'input-detachment']) {
    const result = execute(root, obligation);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.cases, 10);
    assert.equal(receipt.calls, 10 * spec.calls.length + 2);
    assert.deepEqual(receipt.input, { value: [[]] });
    assert.match(receipt.caseContext, /call 1 export put/);
    assert.match(receipt.message, /nested layout rejected in put/);
  }
});

test('unsupported asynchronous results remain unverified even after a synchronous baseline', t => {
  const code = source.replace('return state;', 'return state.metadata.value === "baseline" ? state : Promise.resolve(state);');
  const result = execute(fixture(t, code), 'shape-preservation');
  assert.equal(result.status, 125, result.stdout + result.stderr);
  assert.match(result.stderr, /"phase":"unsupported"/);
  assert.match(result.stderr, /"cases":1/);
  assert.match(result.stderr, /only synchronous public APIs/);
});

test('detachment re-reads the declared output path after input mutation', t => {
  const code = source.replace('structuredClone(value.metadata)', 'install(value.metadata)')
    .replace('return state;', 'current = state; return state;')
    + '\nlet current;function install(input){const copy=structuredClone(input);if(input.value&&typeof input.value==="object")input.value=new Proxy(input.value,{defineProperty(target,key,d){Object.defineProperty(target,key,d);current.metadata={value:"changed"};return true;}});return copy;}';
  // A mutation hook replaces the property holding the copied observation. The
  // old detached object stays unchanged, so checking only that reference misses it.
  const result = execute(fixture(t, code), 'input-detachment');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).actual, { value: 'changed' });
});

test('unsupported mutation mechanics cannot supply accidental detachment passes', t => {
  const code = source.replace('structuredClone(value.metadata)', 'install(value.metadata)')
    + '\nfunction install(input){const copy=structuredClone(input);Object.defineProperty(input,"value",{get(){return copy.value;},enumerable:true,configurable:true});return copy;}';
  const result = execute(fixture(t, code), 'input-detachment');
  assert.equal(result.status, 125, result.stdout + result.stderr);
  assert.match(result.stderr, /input mutation requires ordinary data/);
});

test('candidate changes to JSON and descriptor globals cannot rewrite the captured observation primitives', t => {
  const code = source.replace('structuredClone(value.metadata)', 'value.metadata')
    + '\nJSON.stringify=()=>"same";JSON.parse=()=>({});Object.keys=()=>[];Object.getOwnPropertyDescriptor=()=>({value:null});';
  const result = execute(fixture(t, code), 'input-detachment');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'failed');
});

test('missing fd3 completion and synchronous hangs cannot be counted as passes', t => {
  for (const code of ['process.exit(0);', source.replace('return {};', 'while(true){}')]) {
    const result = execute(fixture(t, code), 'shape-preservation');
    assert.equal(result.status, 125, result.stdout + result.stderr);
    assert.match(result.stderr, /UNAVAILABLE/);
  }
});

test('premature zero-check or impossible fd3 counts cannot claim a complete measurement', t => {
  for (const receipt of [
    { status: 'passed', cases: 0, calls: 0 },
    { status: 'passed', cases: COPY_PROBE_CASE_COUNT, calls: 0 },
    { status: 'failed', cases: -1, calls: 0 },
    { status: 'failed', cases: 0, calls: 0 },
    { status: 'failed', cases: 0, calls: 1 },
    { status: 'failed', cases: 1, calls: 3 },
    { status: 'failed', cases: 1, calls: 7 },
    { status: 'failed', cases: COPY_PROBE_CASE_COUNT, calls: COPY_PROBE_CASE_COUNT * spec.calls.length },
  ]) {
    const code = `import fs from 'node:fs';fs.writeSync(3,${JSON.stringify(JSON.stringify(receipt))});process.exit(0);`;
    const result = execute(fixture(t, code), 'shape-preservation');
    assert.equal(result.status, 125, result.stdout + result.stderr);
    assert.match(result.stderr, /UNAVAILABLE/);
  }
});

test('builder remains bounded, deterministic, and uses existing three-stage probe contract', () => {
  assert.deepEqual(COPY_SPEC_SCHEMA.required, ['module', 'inputTemplate', 'calls', 'observePath']);
  assert.match(COPY_SPEC_GRAMMAR, /ws ::= \[ \\t\\r\\n\]\{0,8\}/);
  const action = buildCopyProbe(spec, 'shape-preservation', [{ p: 'api.mjs', bytes: 'not propagated' }]);
  assert.deepEqual(action.inputs, [{ p: 'api.mjs' }]);
  assert.equal(action.a, 'probe');
  assert.ok(action.setup && action.witness && action.check.length <= 24000);
  assert.deepEqual(action, buildCopyProbe(spec, 'shape-preservation', [{ p: 'api.mjs' }]));
  assert.throws(() => buildCopyProbe(spec, 'invented-law', [{ p: 'api.mjs' }]), /invalid copy-preservation/);
  assert.throws(() => buildCopyProbe(spec, 'shape-preservation', []), /invalid copy-preservation/);
});
