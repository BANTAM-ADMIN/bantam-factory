import { buildIndex, findSymbol, findDependents, findLeaves, report, listJs, extractSymbols, extractDeps } from '../src/codebase-index.js';
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');

test('buildIndex returns files, symbols, deps, and timestamp', () => {
  const idx = buildIndex();
  assert.ok(Array.isArray(idx.files));
  assert.ok(typeof idx.symbols === 'object');
  assert.ok(typeof idx.deps === 'object');
  assert.ok(typeof idx.stats.ts === 'number');
});

test('findSymbol returns files containing a symbol', () => {
  const idx = buildIndex();
  const result = findSymbol(idx, 'buildIndex');
  assert.ok(Array.isArray(result));
});

test('findDependents returns files that depend on a given file', () => {
  const idx = buildIndex();
  const result = findDependents(idx, 'test-coverage.js');
  assert.ok(Array.isArray(result));
});

test('findLeaves returns leaf modules with no internal dependents', () => {
  const idx = buildIndex();
  const result = findLeaves(idx);
  assert.ok(Array.isArray(result));
});

test('report returns a non-empty string', () => {
  const idx = buildIndex();
  const r = report(idx);
  assert.ok(typeof r === 'string' && r.length > 0);
});

test('listJs returns array of .js files', () => {
  const files = listJs(SRC_DIR);
  assert.ok(Array.isArray(files));
  assert.ok(files.every(f => f.endsWith('.js')));
});

test('extractSymbols finds exported symbols', () => {
  const syms = extractSymbols('export const foo = 1; export class Bar {}');
  assert.ok(syms.includes('foo'));
  assert.ok(syms.includes('Bar'));
});

test('extractDeps finds import dependencies', () => {
  const deps = extractDeps(`import x from 'node:fs'; import y from '../src/foo.js';`);
  assert.ok(deps.includes('node:fs'));
  assert.ok(deps.includes('../src/foo.js'));
});
