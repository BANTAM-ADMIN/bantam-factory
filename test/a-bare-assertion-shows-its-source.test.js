import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderFailingTests } from "../src/logic/test-focus.js";

// `assert.ok(x)` with no message reports "expected true, got false". The digest
// carried that faithfully and it says nothing: not what was checked, not what
// the code should do differently. 29 of the 77 failing-test lines across the
// stored runs (38%) are exactly this shape.
//
// .bantam/runs/2026-08-17T12-06-25 ended one test short of green, and all three
// of its failures read "expected true, got false". Two were the CONTROL cases
// the ticket demands — "a normal editable list is unaffected" — so the model's
// own tests had caught its regression and told it nothing about what regressed.
//
// The harness knows the file and the line, and holds the workspace. The
// assertion's own source is the missing sentence, and it is one read away.

function repo(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-bare-assert-"));
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test/scope.test.js"), lines.join("\n"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const TAP = [
  "TAP version 13",
  "# Subtest: a normal editable list is unaffected",
  "not ok 1 - a normal editable list is unaffected",
  "  ---",
  "  location: 'test/scope.test.js:4:3'",
  "  failureType: 'testCodeFailure'",
  "  error: 'The expression evaluated to a falsy value'",
  "  code: 'ERR_ASSERTION'",
  "  expected: true",
  "  actual: false",
  "  ...",
  "1..1",
  "# tests 1",
  "# pass 0",
  "# fail 1",
].join("\n");

test("a bare boolean failure carries the asserted expression", (t) => {
  const dir = repo(t, [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "test('a normal editable list is unaffected', () => {",
    "  assert.ok(result.turns.length > 2);",
    "});",
  ]);
  const out = renderFailingTests(TAP, { root: dir });
  assert.match(
    out,
    /result\.turns\.length > 2/,
    `the assertion's source is the missing sentence; got: ${out}`,
  );
});

test("an assertion that already explains itself is not padded", (t) => {
  const dir = repo(t, [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "test('a normal editable list is unaffected', () => {",
    "  assert.equal(runs, 4);",
    "});",
  ]);
  const informative = TAP.replace("  expected: true", "  expected: 4").replace("  actual: false", "  actual: 7");
  const out = renderFailingTests(informative, { root: dir });
  assert.match(out, /expected 4, got 7/, "the real values still lead");
  assert.doesNotMatch(out, /assert\.equal\(runs, 4\)/, `no source needed; got: ${out}`);
});

test("an unreadable file costs nothing", (t) => {
  const dir = repo(t, ["// the test file the TAP names is not this one"]);
  fs.rmSync(path.join(dir, "test/scope.test.js"));
  const out = renderFailingTests(TAP, { root: dir });
  assert.match(out, /a normal editable list is unaffected/, `the row still renders; got: ${out}`);
});

// node omits the `actual:` key entirely when the actual value IS undefined, so
// the parser found `expected` and no `actual`, and the formatter — which needs
// both — printed neither. The single most diagnostic failure a model can get,
// "you expected a value and the field does not exist", was the one case the
// digest rendered as a bare name and line.
//
// tb30 (2026-08-17, .bantam/runs/2026-08-17T13-58-33-820Z.json) is the case.
// Three of its four failing rows carried no assertion at all:
//
//   ✗ impossible scope ends the run early with the diagnosis (test/impossible-scope.test.js:52)
//
// while the raw TAP two lines below held `expected: 'impossible-scope'` and a
// diff reading `+ undefined`. The model was shown that same empty row seven
// times across 60 turns and never learned its field was missing.
//
// The parser already collects the diff lines. Only the reading of them was
// absent.
test("a failure whose actual value is undefined still reports it", () => {
  const tap = [
    "TAP version 13",
    "not ok 567 - impossible scope ends the run early with the diagnosis",
    "  ---",
    "  location: 'test/impossible-scope.test.js:52:1'",
    "  failureType: 'testCodeFailure'",
    "  error: |-",
    "    Expected values to be strictly equal:",
    "    + actual - expected",
    "",
    "    + undefined",
    "    - 'impossible-scope'",
    "  code: 'ERR_ASSERTION'",
    "  expected: 'impossible-scope'",
    "  operator: 'strictEqual'",
    "  ...",
    "1..1",
    "# tests 1",
    "# pass 0",
    "# fail 1",
  ].join("\n");
  const out = renderFailingTests(tap, {});
  assert.match(out, /impossible-scope/, "the expected value must appear");
  assert.match(out, /undefined/, `and that nothing was there; got: ${out}`);
});

test("a failure with neither value still renders its name", () => {
  const tap = [
    "TAP version 13",
    "not ok 1 - something broke",
    "  ---",
    "  location: 'test/x.test.js:9:1'",
    "  error: 'boom'",
    "  ...",
    "1..1",
    "# tests 1",
    "# pass 0",
    "# fail 1",
  ].join("\n");
  const out = renderFailingTests(tap, {});
  assert.match(out, /something broke/);
  assert.doesNotMatch(out, /expected .*, got/, `nothing to report; got: ${out}`);
});

// "expected 'impossible-scope', got undefined" says what value was wanted and
// never which FIELD was read. tb30 and tb31 both ended on that exact sentence —
// a property the test reads and the implementation never sets. The name of that
// property is in the assertion, one line away on disk.
//
// tb32 ended differently, on `expected 1, got 0`, and is untouched by this: when
// both values are real the pair is already the whole diagnosis.
//
// The expected value still leads: it is precise and it is what the test wants.
// The source is appended, not substituted.
test("a value-vs-undefined failure also names the field that was read", () => {
  const tap = [
    "TAP version 13",
    "not ok 1 - the run ends early with a diagnosis",
    "  ---",
    "  location: 'test/scope.test.js:4:3'",
    "  error: |-",
    "    Expected values to be strictly equal:",
    "    + actual - expected",
    "",
    "    + undefined",
    "    - 'impossible-scope'",
    "  code: 'ERR_ASSERTION'",
    "  expected: 'impossible-scope'",
    "  ...",
    "1..1", "# tests 1", "# pass 0", "# fail 1",
  ].join("\n");
  const dir = repo({ after: () => {} }, [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "test('the run ends early with a diagnosis', () => {",
    "  assert.equal(result.terminationReason, 'impossible-scope');",
    "});",
  ]);
  const out = renderFailingTests(tap, { root: dir });
  assert.match(out, /expected 'impossible-scope', got undefined/, `the pair still leads; got: ${out}`);
  assert.match(out, /result\.terminationReason/, `and the field that was read; got: ${out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a real value pair is not padded with source", () => {
  const tap = [
    "TAP version 13",
    "not ok 1 - counts disagree",
    "  ---",
    "  location: 'test/scope.test.js:4:3'",
    "  code: 'ERR_ASSERTION'",
    "  expected: 4",
    "  actual: 7",
    "  ...",
    "1..1", "# tests 1", "# pass 0", "# fail 1",
  ].join("\n");
  const dir = repo({ after: () => {} }, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('counts disagree', () => {",
    "  assert.equal(runs.length, 4);",
    "});",
  ]);
  const out = renderFailingTests(tap, { root: dir });
  assert.match(out, /expected 4, got 7/);
  assert.doesNotMatch(out, /runs\.length/, `both values are known; got: ${out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
