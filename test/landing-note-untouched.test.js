import assert from "node:assert/strict";
import test from "node:test";

import { untouchedNamedPaths } from "../src/logic/task-context.js";

// Measured 2026-08-15 (ticket A trio, then five parity runs): the local arm hit
// its turn cap having written the module and its tests but never edited
// bin/bantam.js — a path the ticket names explicitly. The harness knew both
// facts (taskNamedSourcePaths and the edited-path set) and said neither; the
// landing note counted down turns without naming the requirement left untouched.

test("names a task-named path the run never edited", () => {
  assert.deepEqual(
    untouchedNamedPaths(["bin/bantam.js", "src/gate-report.js"], new Set(["src/gate-report.js"])),
    ["bin/bantam.js"],
  );
});

test("silent when every named path has been edited", () => {
  assert.deepEqual(untouchedNamedPaths(["a.js", "b.js"], new Set(["a.js", "b.js"])), []);
});

test("silent when the task names no paths", () => {
  assert.deepEqual(untouchedNamedPaths([], new Set(["a.js"])), []);
  assert.deepEqual(untouchedNamedPaths(undefined, new Set()), []);
});

test("normalizes ./ prefixes so a path is not reported twice", () => {
  assert.deepEqual(untouchedNamedPaths(["./src/x.js"], new Set(["src/x.js"])), []);
});
