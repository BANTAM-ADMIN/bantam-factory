import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { walk, WorkspaceTooLargeError } from "../src/logic/codefacts.js";
import { buildGrounding, describeTooLarge, kbMaxFilesFromEnv, DEFAULT_KB_MAX_FILES } from "../src/logic/grounding.js";

// 2026-09-05. `bantam` launched from ~/Desktop/PROJECTAI — a directory of
// projects, 5,010,396 files — walked 672,891 source files and indexed them
// until the heap hit 4 GB:
//
//   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
//
// The KB had a 600-file "cap" that set a flag and extracted everything anyway.
// Measured cost is ~44 KB of heap per indexed file (1,139 files → 49 MB), so
// that tree needed ~28 GB. These pin the real ceiling: the walk stops at it,
// the KB is off, and the person is told why.

function tree(n, { depth = 3 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ceiling-"));
  for (let i = 0; i < n; i++) {
    const dir = path.join(root, ...Array.from({ length: i % depth }, (_, d) => `d${d}-${i % 7}`));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.js`), `export function f${i}() { return ${i}; }\n`);
  }
  return root;
}
const cleanup = [];
test.after(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

test("the walk stops at the ceiling and throws a named error — it does not count the rest", () => {
  const root = tree(60); cleanup.push(root);
  assert.equal(walk(root, [".js"]).length, 60, "unbounded walk sees everything");
  let err = null;
  try { walk(root, [".js"], { maxFiles: 10 }); } catch (e) { err = e; }
  assert.ok(err instanceof WorkspaceTooLargeError, "a typed error, not a generic throw");
  assert.equal(err.files, 11, "stopped at the first file past the ceiling");
  assert.equal(err.maxFiles, 10);
  assert.equal(err.root, root);
});

test("buildGrounding over the ceiling returns an EMPTY KB that says why — never a crash, never silent", () => {
  const root = tree(40); cleanup.push(root);
  const g = buildGrounding(root, { hardMaxFiles: 25 });
  assert.deepEqual(g.stats.tooLarge, { files: 26, maxFiles: 25 });
  assert.equal(g.stats.files, 0);
  assert.equal(g.factIndex, null, "no records were retained");
  const under = buildGrounding(root, { hardMaxFiles: 100 });
  assert.equal(under.stats.tooLarge, undefined);
  assert.equal(under.stats.files, 40, "under the ceiling nothing changes");
});

test("the ceiling comes from BANTAM_KB_MAX_FILES, with a sane default", () => {
  assert.equal(kbMaxFilesFromEnv({}), DEFAULT_KB_MAX_FILES);
  assert.equal(kbMaxFilesFromEnv({ BANTAM_KB_MAX_FILES: "250" }), 250);
  assert.equal(kbMaxFilesFromEnv({ BANTAM_KB_MAX_FILES: "0" }), DEFAULT_KB_MAX_FILES);
  assert.equal(kbMaxFilesFromEnv({ BANTAM_KB_MAX_FILES: "lots" }), DEFAULT_KB_MAX_FILES);
  assert.ok(DEFAULT_KB_MAX_FILES >= 5000 && DEFAULT_KB_MAX_FILES <= 25000,
    "high enough for any single real project, low enough to stay far under the 4 GB heap at ~44 KB/file");
});

test("the note wraps to the terminal with a hanging indent — never hard-wrapped wider than the screen", () => {
  for (const cols of [80, 85, 120]) {
    const lines = describeTooLarge({ files: 10001, maxFiles: 10000 }, "/x/PROJECTAI", { cols }).trimEnd().split("\n");
    assert.match(lines[0], /^ {2}\u{1F9ED} code KB: off/u);
    for (const l of lines.slice(1)) assert.match(l, /^ {5}\S/, `hanging indent: ${JSON.stringify(l)}`);
    // the emoji is two columns wide on screen; count it as such
    for (const l of lines) assert.ok(l.length + 1 <= cols, `${cols}: ${l.length + 1} > ${cols}: ${l}`);
    assert.ok(lines.length >= (cols < 100 ? 4 : 3), `${cols} cols: ${lines.length} lines`);
  }
});

test("the message names the count, the diagnosis, and every remedy", () => {
  // The note is wrapped to the terminal, so match phrases on the collapsed text.
  const text = describeTooLarge({ files: 10001, maxFiles: 10000 }, "/home/someone/Desktop/PROJECTAI").replace(/\s+/g, " ");
  assert.match(text, /code KB: off/);
  assert.match(text, /PROJECTAI has more than 10,000 source files/);
  assert.match(text, /stopped counting at 10,001/);
  assert.match(text, /directory of projects, not a project/, "say what the workspace actually is");
  assert.match(text, /--workspace <dir>/);
  assert.match(text, /\.bantamignore/);
  assert.match(text, /BANTAM_KB_MAX_FILES/);
  assert.match(text, /inside the project you mean/);
});
