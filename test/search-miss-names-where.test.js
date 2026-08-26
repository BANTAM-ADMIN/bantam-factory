import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";

// 332 of the 1,302 search operations in the stored runs (25.5%) returned "no
// matches for /X/" and nothing else. The model's next turn was usually another
// guess: tb22 probed `impossibleScopeResult\(\)` and then
// `impossibleScopeResult\(\{`, both empty, for a symbol it had located two
// turns earlier.
//
// The [cross-file] footer exists for exactly this and fired ONCE in those 332.
// It requires a bare identifier that the KB knows as a defined symbol, which
// excludes every regex, property name, string and phrase. The two questions
// here need no KB: 210 of the misses were scoped to a single file, where "it is
// in another file" is both the likeliest and the most useful answer, and 111
// carried regex metacharacters, where the pattern is usually over-specified.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-search-miss-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src/agent.js"),
    "export function impossibleScopeResult(options) {\n  return null;\n}\nconst editableMatchesNothing = true;\n",
  );
  fs.writeFileSync(path.join(dir, "src/scope-guard.js"), "export const guard = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Executor(dir);
}

test("a miss in the wrong file names the right one", (t) => {
  const out = String(workspace(t).search({ q: "editableMatchesNothing", p: "src/scope-guard.js" }));
  assert.match(out, /no matches for \/editableMatchesNothing\/ in src\/scope-guard\.js/);
  assert.match(out, /It DOES match outside that scope: src\/agent\.js:4/);
});

test("an over-specified pattern is told which part of it works", (t) => {
  const out = String(workspace(t).search({ q: "impossibleScopeResult\\(\\)", p: "src/agent.js" }));
  assert.match(out, /over-specified/);
  assert.match(out, /`impossibleScopeResult` matches src\/agent\.js:1/);
});

test("a name that is genuinely absent says so", (t) => {
  // The dead end must stay legible as a dead end — inventing a near-miss here
  // would send the model chasing something that does not exist.
  const out = String(workspace(t).search({ q: "neverAppearsAnywhere", p: "src" }));
  assert.match(out, /appears nowhere in the workspace/);
  assert.doesNotMatch(out, /DOES match|over-specified/);
});

test("a search that finds something is unchanged", (t) => {
  const out = String(workspace(t).search({ q: "impossibleScopeResult", p: "src" }));
  assert.match(out, /^src\/agent\.js:1: export function impossibleScopeResult/);
  assert.doesNotMatch(out, /no matches/);
});

test("an unscoped miss does not claim a scope it never had", (t) => {
  const out = String(workspace(t).search({ q: "neverAppearsAnywhere" }));
  assert.match(out, /no matches for \/neverAppearsAnywhere\//);
  assert.doesNotMatch(out, / in \./, "there was no scope to name");
});
