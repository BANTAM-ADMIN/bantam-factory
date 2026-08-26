import test from 'node:test';
import assert from 'node:assert';
import { hashText, changedFilesFromDiff } from '../src/diff.js';

// --- hashText ---
test('hashText returns a 64-char hex string', () => {
  const h = hashText('hello');
  assert.strictEqual(h.length, 64);
  assert.match(h, /^[0-9a-f]+$/);
});

test('hashText is deterministic', () => {
  assert.strictEqual(hashText('same'), hashText('same'));
});

test('hashText differs for different inputs', () => {
  assert.notStrictEqual(hashText('a'), hashText('b'));
});

test('hashText handles empty string', () => {
  assert.ok(hashText(''));
  assert.strictEqual(hashText('').length, 64);
});

test('hashText handles unicode', () => {
  const h = hashText('café ☕');
  assert.strictEqual(h.length, 64);
});

// --- changedFilesFromDiff ---
test('changedFilesFromDiff extracts file paths from a unified diff', () => {
  const diff = `diff --git a/src/foo.js b/src/foo.js
index 1234567..abcdef 100644
--- a/src/foo.js
+++ b/src/foo.js
@@ -1 +1 @@
-old
+new
`;
  const files = changedFilesFromDiff(diff);
  assert.deepStrictEqual(files, ['src/foo.js']);
});

test('changedFilesFromDiff handles multiple files', () => {
  const diff = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1 +1 @@
-x
+y
diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1 +1 @@
-x
+y
`;
  const files = changedFilesFromDiff(diff);
  assert.deepStrictEqual(files, ['a.js', 'b.js']);
});

test('changedFilesFromDiff returns empty array for empty diff', () => {
  assert.deepStrictEqual(changedFilesFromDiff(''), []);
});

test('changedFilesFromDiff returns empty array for null input', () => {
  assert.deepStrictEqual(changedFilesFromDiff(null), []);
});

test('changedFilesFromDiff deduplicates files', () => {
  const diff = `diff --git a/x.js b/x.js
--- a/x.js
+++ b/x.js
@@ -1 +1 @@
-a
+b
diff --git a/x.js b/x.js
--- a/x.js
+++ b/x.js
@@ -2 +2 @@
-c
+d
`;
  const files = changedFilesFromDiff(diff);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0], 'x.js');
});

test('changedFilesFromDiff handles quoted paths', () => {
  const diff = 'diff --git "a/src/file with spaces.js" "b/src/file with spaces.js"\n';
  const files = changedFilesFromDiff(diff);
  assert.deepStrictEqual(files, ['src/file with spaces.js']);
});

test('changedFilesFromDiff ignores non-diff lines', () => {
  const diff = `some random text

diff --git a/mod.js b/mod.js
--- a/mod.js
+++ b/mod.js
@@ -1 +1 @@
-old
+new
`;
  const files = changedFilesFromDiff(diff);
  assert.deepStrictEqual(files, ['mod.js']);
});
