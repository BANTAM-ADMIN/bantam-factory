import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";

// A line-anchored replace that misses used to end "Read the file and copy the
// exact text" — advice the model had already taken. Across the stored runs
// every one of the 12 "old text not found" failures had copied text that was
// verbatim somewhere in its own prompt; what it got wrong was WHERE.
//
// Two of the twelve had copied from a frozen fixture carrying the same basename
// in the same panel — gauntlet/fixtures/retry-consolidation-haystack/repo/src/
// platform/agent.js — and issued the edit against the real src/agent.js at the
// fixture's line number. 8.7% of rendered panels hold a same-basename twin.
// Repeating "read the file" resolves neither that nor a merely stale line.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-misplaced-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const exec = (dir) => new Executor(dir);

test("a stale line anchor is told where the text actually is", (t) => {
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, "a.js"), "const a = 1;\nconst b = 2;\nconst target = 3;\n");
  const out = exec(dir).replace({ p: "a.js", old: "const target = 3;", new: "const target = 4;", line: 2 });
  assert.match(String(out), /not found starting on line 2/);
  assert.match(String(out), /That text is at line 3 of a\.js; retry with that line\./);
});

test("text that is nowhere in the file names the same-name hazard", (t) => {
  // The twin-file case: the model copied a line that lives in another entry.
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, "a.js"), "const a = 1;\nconst b = 2;\n");
  const out = exec(dir).replace({ p: "a.js", old: "let interrupted = false;", new: "let interrupted = true;", line: 1 });
  const text = String(out);
  assert.match(text, /does not appear anywhere in a\.js/);
  assert.match(text, /another file with the same name may also be in the panel/);
  assert.doesNotMatch(text, /Read the file and copy the exact text/, "the advice it already followed is not advice");
});

test("a repeated line lists the candidates rather than one guess", (t) => {
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, "a.js"), "x();\ny();\nx();\nz();\n");
  const out = exec(dir).replace({ p: "a.js", old: "x();", new: "w();", line: 2 });
  assert.match(String(out), /occurs at lines 1, 3 of a\.js/);
});

test("a hit on the named line is unaffected", (t) => {
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, "a.js"), "const a = 1;\nconst b = 2;\n");
  const out = exec(dir).replace({ p: "a.js", old: "const b = 2;", new: "const b = 3;", line: 2 });
  assert.match(String(out), /replaced 1 occurrence/);
  assert.equal(fs.readFileSync(path.join(dir, "a.js"), "utf8"), "const a = 1;\nconst b = 3;\n");
});
