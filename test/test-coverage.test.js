import test, { after } from 'node:test';
import assert from 'node:assert';
import { scanCoverage, report, suggestions } from '../src/test-coverage.js';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// --- helpers ---
const temporaryDirectories = [];
after(() => {
  for (const dir of temporaryDirectories) cleanup(dir);
});

function makeTmpDir(name) {
  const d = mkdtempSync(join(tmpdir(), `coverage-test-${name}-`));
  temporaryDirectories.push(d);
  return d;
}

function writeFile(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- scanCoverage ---
test('scanCoverage returns covered and uncovered arrays', () => {
  const srcDir = makeTmpDir('src');
  const testDir = makeTmpDir('test');

  writeFile(srcDir, 'foo.js', 'export function foo() {}');
  writeFile(srcDir, 'bar.js', 'export function bar() {}');
  writeFile(testDir, 'foo.test.js', 'import test from "node:test";');

  const cov = scanCoverage(srcDir, testDir);
  assert.ok(cov.covered.includes('foo.js'));
  assert.ok(cov.uncovered.includes('bar.js'));
  assert.strictEqual(cov.total, 2);
  assert.strictEqual(cov.ratio, 0.5);

  cleanup(srcDir);
  cleanup(testDir);
});

test('scanCoverage with all files covered returns ratio 1', () => {
  const srcDir = makeTmpDir('src2');
  const testDir = makeTmpDir('test2');

  writeFile(srcDir, 'a.js', 'export const a = 1;');
  writeFile(srcDir, 'b.js', 'export const b = 2;');
  writeFile(testDir, 'a.test.js', 'import test from "node:test";');
  writeFile(testDir, 'b.test.js', 'import test from "node:test";');

  const cov = scanCoverage(srcDir, testDir);
  assert.strictEqual(cov.ratio, 1);
  assert.strictEqual(cov.uncovered.length, 0);

  cleanup(srcDir);
  cleanup(testDir);
});

test('scanCoverage with no test files returns ratio 0', () => {
  const srcDir = makeTmpDir('src3');
  const testDir = makeTmpDir('test3');

  writeFile(srcDir, 'x.js', 'export const x = 1;');
  writeFile(srcDir, 'y.js', 'export const y = 2;');

  const cov = scanCoverage(srcDir, testDir);
  assert.strictEqual(cov.ratio, 0);
  assert.strictEqual(cov.covered.length, 0);
  assert.strictEqual(cov.uncovered.length, 2);

  cleanup(srcDir);
  cleanup(testDir);
});

test('scanCoverage matches test files with .js extension too', () => {
  const srcDir = makeTmpDir('src4');
  const testDir = makeTmpDir('test4');

  writeFile(srcDir, 'mod.js', 'export const mod = 1;');
  writeFile(testDir, 'mod.js', 'import test from "node:test";');

  const cov = scanCoverage(srcDir, testDir);
  assert.ok(cov.covered.includes('mod.js'));
  assert.strictEqual(cov.ratio, 1);

  cleanup(srcDir);
  cleanup(testDir);
});

// --- report ---
test('report returns a string with percentage', () => {
  const srcDir = makeTmpDir('src5');
  const testDir = makeTmpDir('test5');

  writeFile(srcDir, 'a.js', '');
  writeFile(srcDir, 'b.js', '');
  writeFile(testDir, 'a.test.js', '');

  const cov = scanCoverage(srcDir, testDir);
  const r = report(cov);
  assert.ok(typeof r === 'string');
  assert.ok(r.includes('50%'));
  assert.ok(r.includes('1/2'));

  cleanup(srcDir);
  cleanup(testDir);
});

test('report lists uncovered files', () => {
  const srcDir = makeTmpDir('src6');
  const testDir = makeTmpDir('test6');

  writeFile(srcDir, 'alpha.js', '');
  writeFile(srcDir, 'beta.js', '');

  const cov = scanCoverage(srcDir, testDir);
  const r = report(cov);
  assert.ok(r.includes('alpha.js'));
  assert.ok(r.includes('beta.js'));

  cleanup(srcDir);
  cleanup(testDir);
});

// --- suggestions ---
test('suggestions returns one entry per uncovered file', () => {
  const srcDir = makeTmpDir('src7');
  const testDir = makeTmpDir('test7');

  writeFile(srcDir, 'one.js', '');
  writeFile(srcDir, 'two.js', '');
  writeFile(testDir, 'one.test.js', '');

  const cov = scanCoverage(srcDir, testDir);
  const s = suggestions(cov);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].file, 'two.js');
  assert.strictEqual(s[0].suggestion, 'Create test/two.test.js');
  assert.strictEqual(s[0].priority, 'medium');

  cleanup(srcDir);
  cleanup(testDir);
});

test('suggestions returns empty array when all covered', () => {
  const srcDir = makeTmpDir('src8');
  const testDir = makeTmpDir('test8');

  writeFile(srcDir, 'x.js', '');
  writeFile(testDir, 'x.test.js', '');

  const cov = scanCoverage(srcDir, testDir);
  const s = suggestions(cov);
  assert.strictEqual(s.length, 0);

  cleanup(srcDir);
  cleanup(testDir);
});
