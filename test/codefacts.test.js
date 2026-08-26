import test, { after } from 'node:test';
import assert from 'node:assert';
import { Datalog } from '../src/logic/datalog.js';
import {
  createCodeFactIndex,
  refreshCodeFactIndex,
  materializeCodeFacts,
  affectedTests,
  extractCodeFacts,
  resolvePyImport,
  nearestFiles,
} from '../src/logic/codefacts.js';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// --- helpers ---
const temporaryDirectories = [];
after(() => {
  for (const dir of temporaryDirectories) cleanup(dir);
});

function makeTmpDir(name) {
  const d = mkdtempSync(join(tmpdir(), `codefacts-test-${name}-`));
  temporaryDirectories.push(d);
  return d;
}
function writeFile(dir, rel, content) {
  mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(join(dir, rel), content, 'utf8');
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- createCodeFactIndex ---
test('createCodeFactIndex returns records for JS files', () => {
  const dir = makeTmpDir('index');
  writeFile(dir, 'a.js', 'export function foo() {}');
  writeFile(dir, 'b.ts', 'export class Bar {}');
  writeFile(dir, 'readme.md', '# hi');
  const idx = createCodeFactIndex(dir);
  assert.ok(idx.records.has('a.js'));
  assert.ok(idx.records.has('b.ts'));
  assert.ok(!idx.records.has('readme.md'));
  cleanup(dir);
});

test('createCodeFactIndex extracts defines', () => {
  const dir = makeTmpDir('defines');
  writeFile(dir, 'x.js', 'export function hello() {}\nexport const pi = 3.14;');
  const idx = createCodeFactIndex(dir);
  const rec = idx.records.get('x.js');
  assert.ok(rec.defines.includes('hello'));
  assert.ok(rec.defines.includes('pi'));
  cleanup(dir);
});

test('createCodeFactIndex extracts imports', () => {
  const dir = makeTmpDir('imports');
  writeFile(dir, 'x.js', "import { foo } from './a.js';\nimport bar from './b';");
  const idx = createCodeFactIndex(dir);
  const rec = idx.records.get('x.js');
  assert.ok(rec.imports.includes('./a.js'));
  assert.ok(rec.imports.includes('./b'));
  cleanup(dir);
});

test('createCodeFactIndex handles custom exts', () => {
  const dir = makeTmpDir('exts');
  writeFile(dir, 'x.mjs', 'export const x = 1;');
  writeFile(dir, 'y.cjs', 'module.exports = 2;');
  const idx = createCodeFactIndex(dir, { exts: ['.mjs'] });
  assert.ok(idx.records.has('x.mjs'));
  assert.ok(!idx.records.has('y.cjs'));
  cleanup(dir);
});

// --- refreshCodeFactIndex ---
test('refreshCodeFactIndex refreshes a changed file', () => {
  const dir = makeTmpDir('refresh');
  writeFile(dir, 'a.js', 'export function foo() {}');
  const idx = createCodeFactIndex(dir);
  writeFile(dir, 'a.js', 'export function bar() {}');
  const result = refreshCodeFactIndex(idx, ['a.js']);
  assert.strictEqual(result.ok, true);
  assert.ok(result.refreshed.includes('a.js'));
  const rec = result.index.records.get('a.js');
  assert.ok(rec.defines.includes('bar'));
  assert.ok(!rec.defines.includes('foo'));
  cleanup(dir);
});

test('refreshCodeFactIndex removes deleted files', () => {
  const dir = makeTmpDir('remove');
  writeFile(dir, 'a.js', 'export const a = 1;');
  writeFile(dir, 'b.js', 'export const b = 2;');
  const idx = createCodeFactIndex(dir);
  rmSync(join(dir, 'a.js'));
  const result = refreshCodeFactIndex(idx, ['a.js']);
  assert.strictEqual(result.ok, true);
  assert.ok(result.removed.includes('a.js'));
  assert.ok(result.index.records.has('b.js'));
  assert.ok(!result.index.records.has('a.js'));
  cleanup(dir);
});

test('refreshCodeFactIndex ignores non-matching extensions', () => {
  const dir = makeTmpDir('ignore');
  writeFile(dir, 'a.js', 'export const a = 1;');
  writeFile(dir, 'b.md', '# hi');
  const idx = createCodeFactIndex(dir);
  const result = refreshCodeFactIndex(idx, ['b.md']);
  assert.strictEqual(result.ok, true);
  assert.ok(result.ignored.includes('b.md'));
  cleanup(dir);
});

test('refreshCodeFactIndex returns error on bad index', () => {
  const result = refreshCodeFactIndex(null, ['a.js']);
  assert.strictEqual(result.ok, false);
});

// --- materializeCodeFacts ---
test('materializeCodeFacts populates file and defines relations', () => {
  const dir = makeTmpDir('materialize');
  writeFile(dir, 'a.js', 'export function foo() {}');
  writeFile(dir, 'b.js', 'export class Bar {}');
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  assert.strictEqual(db.count('file'), 2);
  assert.strictEqual(db.count('defines'), 2);
  assert.ok(db.has('defines', 'a.js', 'foo'));
  assert.ok(db.has('defines', 'b.js', 'Bar'));
  cleanup(dir);
});

test('materializeCodeFacts classifies test files', () => {
  const dir = makeTmpDir('testfiles');
  writeFile(dir, 'src/util.js', 'export const u = 1;');
  writeFile(dir, 'test/util.test.js', 'import { u } from "../src/util.js";');
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  assert.ok(db.has('test', 'test/util.test.js'));
  assert.ok(!db.has('test', 'src/util.js'));
  cleanup(dir);
});

test('materializeCodeFacts resolves depends edges', () => {
  const dir = makeTmpDir('depends');
  writeFile(dir, 'a.js', 'export const a = 1;');
  writeFile(dir, 'b.js', "import { a } from './a.js';");
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  assert.ok(db.has('depends', 'b.js', 'a.js'));
  cleanup(dir);
});

test('materializeCodeFacts computes reaches via transitive closure', () => {
  const dir = makeTmpDir('reaches');
  writeFile(dir, 'a.js', 'export const a = 1;');
  writeFile(dir, 'b.js', "import { a } from './a.js';");
  writeFile(dir, 'c.js', "import { a } from './b.js';");
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  assert.ok(db.has('reaches', 'c.js', 'a.js'));
  cleanup(dir);
});

test('materializeCodeFacts returns stats object', () => {
  const dir = makeTmpDir('stats');
  writeFile(dir, 'a.js', 'export const a = 1;');
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  const stats = materializeCodeFacts(db, idx);
  assert.ok(typeof stats.files === 'number');
  assert.ok(typeof stats.symbols === 'number');
  assert.ok(typeof stats.depends === 'number');
  assert.ok(Array.isArray(stats.filePaths));
  cleanup(dir);
});

test('materializeCodeFacts marks unresolved relative imports', () => {
  const dir = makeTmpDir('unresolved');
  writeFile(dir, 'a.js', "import x from './missing.js';");
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  assert.ok(db.has('unresolved', 'a.js', './missing.js'));
  cleanup(dir);
});

// --- affectedTests ---
test('affectedTests returns tests that import changed files', () => {
  const dir = makeTmpDir('affected');
  writeFile(dir, 'src/util.js', 'export const u = 1;');
  writeFile(dir, 'test/util.test.js', "import { u } from '../src/util.js';");
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  const affected = affectedTests(db, ['src/util.js']);
  assert.ok(affected.includes('test/util.test.js'));
  cleanup(dir);
});

test('affectedTests includes the test itself when changed', () => {
  const dir = makeTmpDir('self');
  writeFile(dir, 'test/a.test.js', 'export const a = 1;');
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  const affected = affectedTests(db, ['test/a.test.js']);
  assert.ok(affected.includes('test/a.test.js'));
  cleanup(dir);
});

test('affectedTests handles empty changedRels', () => {
  const dir = makeTmpDir('empty');
  writeFile(dir, 'test/a.test.js', 'export const a = 1;');
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  const affected = affectedTests(db, []);
  assert.strictEqual(affected.length, 0);
  cleanup(dir);
});

// --- resolvePyImport ---
test('resolvePyImport resolves absolute imports', () => {
  const fileRels = new Set(['utils.py', 'math/core.py']);
  const result = resolvePyImport('app.py', 'utils', fileRels);
  assert.strictEqual(result, 'utils.py');
});

test('resolvePyImport resolves dotted imports', () => {
  const fileRels = new Set(['math/core.py', 'app.py']);
  const result = resolvePyImport('app.py', 'math.core', fileRels);
  assert.strictEqual(result, 'math/core.py');
});

test('resolvePyImport resolves relative imports', () => {
  const fileRels = new Set(['pkg/__init__.py', 'pkg/sub.py', 'app.py']);
  const result = resolvePyImport('pkg/__init__.py', '.sub', fileRels);
  assert.strictEqual(result, 'pkg/sub.py');
});

test('resolvePyImport returns null for external packages', () => {
  const fileRels = new Set(['app.py']);
  const result = resolvePyImport('app.py', 'numpy', fileRels);
  assert.strictEqual(result, null);
});

test('resolvePyImport resolves package __init__ via src root', () => {
  const fileRels = new Set(['src/pkg/__init__.py', 'app.py']);
  const result = resolvePyImport('app.py', 'pkg', fileRels);
  assert.strictEqual(result, 'src/pkg/__init__.py');
});

// --- nearestFiles ---
test('nearestFiles returns files with similar basenames', () => {
  const db = new Datalog();
  db.fact('file', 'src/util.js');
  db.fact('file', 'src/utils.js');
  db.fact('file', 'src/other.js');
  const result = nearestFiles(db, 'util.js', 2);
  assert.ok(result.includes('src/util.js'));
});

test('nearestFiles returns empty for no match', () => {
  const db = new Datalog();
  db.fact('file', 'src/alpha.js');
  const result = nearestFiles(db, 'xyz.js', 3);
  assert.ok(Array.isArray(result));
});

// --- extractCodeFacts (full pipeline) ---
test('extractCodeFacts returns index and stats', () => {
  const dir = makeTmpDir('pipeline');
  writeFile(dir, 'a.js', 'export function foo() {}');
  writeFile(dir, 'b.js', "import { foo } from './a.js';");
  const db = new Datalog();
  const result = extractCodeFacts(db, dir);
  assert.ok(result.index);
  assert.ok(typeof result.files === 'number');
  cleanup(dir);
});

// --- broken import detection ---
test('materializeCodeFacts tracks broken relative imports', () => {
  const dir = makeTmpDir('broken');
  writeFile(dir, 'main.js', "import x from './missing';\nimport y from './helper.js';");
  writeFile(dir, 'helper.js', 'export const y = 1;');
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  assert.ok(db.has('unresolved', 'main.js', './missing'));
  assert.ok(!db.has('unresolved', 'main.js', './helper.js'));
  cleanup(dir);
});

test('materializeCodeFacts handles re-export barrel imports', () => {
  const dir = makeTmpDir('reexport');
  writeFile(dir, 'a.js', 'export const a = 1;');
  writeFile(dir, 'index.js', "export * from './a.js';");
  writeFile(dir, 'b.js', "import { a } from './index.js';");
  const idx = createCodeFactIndex(dir);
  const db = new Datalog();
  materializeCodeFacts(db, idx);
  assert.ok(db.has('depends', 'index.js', 'a.js'));
  assert.ok(db.has('depends', 'b.js', 'index.js'));
  cleanup(dir);
});
