import test from 'node:test';
import assert from 'node:assert';
import {
  hasShellControlOutsideQuotes,
  shellContainsExactCommandSegment,
  splitShellWords,
  shellSegments,
} from '../src/shell-lex.js';

// --- hasShellControlOutsideQuotes ---
test('hasShellControlOutsideQuotes returns false for plain text', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('hello world'), false);
});

test('hasShellControlOutsideQuotes detects semicolons', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('echo hi; echo bye'), true);
});

test('hasShellControlOutsideQuotes detects pipes', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('cat file | grep foo'), true);
});

test('hasShellControlOutsideQuotes detects &&', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('ls && cat a'), true);
});

test('hasShellControlOutsideQuotes detects $()', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('echo $(date)'), true);
});

test('hasShellControlOutsideQuotes respects single quotes', () => {
  assert.strictEqual(hasShellControlOutsideQuotes("echo 'hello; world'"), false);
});

test('hasShellControlOutsideQuotes respects double quotes', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('echo "hello; world"'), false);
});

test('hasShellControlOutsideQuotes handles null/undefined', () => {
  assert.strictEqual(hasShellControlOutsideQuotes(null), false);
  assert.strictEqual(hasShellControlOutsideQuotes(undefined), false);
});

test('hasShellControlOutsideQuotes detects backticks', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('echo `date`'), true);
});

test('hasShellControlOutsideQuotes detects newlines', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('echo hi\necho bye'), true);
});

test('hasShellControlOutsideQuotes detects redirections', () => {
  assert.strictEqual(hasShellControlOutsideQuotes('echo hi > file'), true);
  assert.strictEqual(hasShellControlOutsideQuotes('cat < file'), true);
});

// --- splitShellWords ---
test('splitShellWords splits on spaces', () => {
  assert.deepStrictEqual(splitShellWords('hello world'), ['hello', 'world']);
});

test('splitShellWords handles empty string', () => {
  assert.deepStrictEqual(splitShellWords(''), []);
});

test('splitShellWords respects single quotes', () => {
  assert.deepStrictEqual(splitShellWords("hello 'world foo'"), ['hello', 'world foo']);
});

test('splitShellWords respects double quotes', () => {
  assert.deepStrictEqual(splitShellWords('hello "world foo"'), ['hello', 'world foo']);
});

test('splitShellWords handles escape sequences', () => {
  assert.deepStrictEqual(splitShellWords('hello\\ world'), ['hello world']);
});

test('splitShellWords handles multiple spaces', () => {
  assert.deepStrictEqual(splitShellWords('a   b   c'), ['a', 'b', 'c']);
});

test('splitShellWords handles tabs', () => {
  assert.deepStrictEqual(splitShellWords('a\tb\tc'), ['a', 'b', 'c']);
});

test('splitShellWords handles null/undefined', () => {
  assert.deepStrictEqual(splitShellWords(null), []);
  assert.deepStrictEqual(splitShellWords(undefined), []);
});

test('exact command segments recognize a verifier embedded after a heredoc', () => {
  const command = [
    "node --input-type=module - <<'EOF'",
    "console.log('focused probe');",
    "EOF",
    "npm test",
  ].join("\n");
  assert.equal(shellContainsExactCommandSegment(command, "npm test"), true);
});

test('exact command segments reject substrings, added arguments, and compound baselines', () => {
  assert.equal(shellContainsExactCommandSegment("echo npm test", "npm test"), false);
  assert.equal(shellContainsExactCommandSegment("npm test -- --changed", "npm test"), false);
  assert.equal(shellContainsExactCommandSegment("npm test\nnode smoke.js", "npm test && node smoke.js"), false);
  assert.equal(shellContainsExactCommandSegment("", "npm test"), false);
});

// --- shellSegments ---
test('shellSegments splits on semicolons', () => {
  assert.deepStrictEqual(shellSegments('echo hi; echo bye'), ['echo hi', 'echo bye']);
});

test('shellSegments splits on pipes', () => {
  assert.deepStrictEqual(shellSegments('cat file | grep foo'), ['cat file', 'grep foo']);
});

test('shellSegments splits on &&', () => {
  assert.deepStrictEqual(shellSegments('ls && cat a'), ['ls', 'cat a']);
});

test('shellSegments splits on ||', () => {
  assert.deepStrictEqual(shellSegments('ls || cat a'), ['ls', 'cat a']);
});

test('shellSegments splits on newlines', () => {
  assert.deepStrictEqual(shellSegments('echo hi\necho bye'), ['echo hi', 'echo bye']);
});

test('shellSegments handles empty string', () => {
  assert.deepStrictEqual(shellSegments(''), []);
});

test('shellSegments handles single command', () => {
  assert.deepStrictEqual(shellSegments('echo hello'), ['echo hello']);
});

test('shellSegments handles null/undefined', () => {
  assert.deepStrictEqual(shellSegments(null), []);
  assert.deepStrictEqual(shellSegments(undefined), []);
});

test('shellSegments respects quotes in splitting', () => {
  assert.deepStrictEqual(shellSegments('echo "hi; there"; echo bye'), ['echo "hi; there"', 'echo bye']);
});

test('shellSegments handles chained pipes', () => {
  assert.deepStrictEqual(shellSegments('cat a | grep b | sort'), ['cat a', 'grep b', 'sort']);
});
