import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, BOOLEAN_FLAGS, OPTIONAL_VALUE_FLAGS } from "../src/cli-args.js";

// The help says `--save-run [path]` and bin/bantam.js resolves a string value —
// but "save-run" sits in BOOLEAN_FLAGS, so `--save-run x.json` set `true` and
// pushed x.json into positionals, and `--save-run=x.json` THREW. The header
// comment still says optional-value flags stay on the next-token heuristic: the
// set and the comment drifted apart, leaving the documented form broken and the
// string branch in bin/bantam.js dead.
//
// Hit live twice on 2026-08-17: `--save-run $SP/difftest.json` (read as my own
// path confusion at the time) and `--save-run $SP/py2-artifact.json` — both
// silently landed in .bantam/runs while the named file never appeared.
//
// The boolean-flag rule exists so `--save-run` can never eat the next token
// (`bantam eval --save-run dir1` must not swallow dir1). That property stays.
// The equals form carries the value instead: unambiguous by construction.

test("--save-run alone is boolean, and never eats the next token", () => {
  assert.equal(parseArgs(["--save-run"])["save-run"], true);
  const eaten = parseArgs(["--save-run", "fixtures/a"]);
  assert.equal(eaten["save-run"], true);
  assert.deepEqual(eaten._, ["fixtures/a"], "the next token stays positional");
});

test("--save-run=path carries the path", () => {
  assert.equal(parseArgs(["--save-run=/tmp/x.json"])["save-run"], "/tmp/x.json");
});

test("a plain boolean flag still refuses a value", () => {
  assert.throws(() => parseArgs(["--tui=yes"]), /takes no value/);
});

test("every optional-value flag is also a boolean flag", () => {
  // The =form only makes sense for flags the next-token heuristic skips.
  for (const f of OPTIONAL_VALUE_FLAGS) assert.ok(BOOLEAN_FLAGS.has(f), f);
});
