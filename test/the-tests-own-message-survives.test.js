import assert from "node:assert/strict";
import test from "node:test";

import { renderFailingTests, parseTestFailures } from "../src/logic/test-focus.js";

// A well-written assertion carries its own explanation:
//   assert.ok(report.gates.includes(g), `missing detector gate ${g}`)
// node reports that as `error: 'missing detector gate type_contract'` with
// `expected: true` and NO `actual:` key. The parser read only expected/actual/
// location/diff, so the sentence the test author wrote specifically to explain
// the failure was dropped and the row rendered as a bare name and line.
//
// It is the largest category by a distance. Of the failing-test rows in the
// stored runs that carried no assertion at all, **676 had exactly this** — an
// `error:` message sitting unread in the TAP block. 65 more had a multi-line
// one. The messages are the model's own words, written a few turns earlier.

const tap = (name, body) => [
  "TAP version 13",
  `not ok 1 - ${name}`,
  "  ---",
  "  location: 'test/gate-report.test.js:24:1'",
  "  failureType: 'testCodeFailure'",
  ...body,
  "  ...",
  "1..1",
  "# tests 1",
  "# pass 0",
  "# fail 1",
].join("\n");

test("a custom assertion message reaches the digest", () => {
  const out = renderFailingTests(tap("detector-driven gates are labeled", [
    "  error: 'missing detector gate type_contract'",
    "  code: 'ERR_ASSERTION'",
    "  expected: true",
    "  operator: '=='",
  ]), {});
  assert.match(out, /missing detector gate type_contract/, `got: ${out}`);
});

test("a multi-line message is carried too, first line first", () => {
  const out = renderFailingTests(tap("values disagree", [
    "  error: |-",
    "    the ledger must record every edited path",
    "    (this one recorded none)",
    "  code: 'ERR_ASSERTION'",
  ]), {});
  assert.match(out, /the ledger must record every edited path/, `got: ${out}`);
});

test("real expected/actual values still lead over a message", () => {
  // Values are precise; a message is prose. When both are available and the
  // values say something, they are the better sentence.
  const out = renderFailingTests(tap("counts disagree", [
    "  error: 'the ledger is wrong'",
    "  code: 'ERR_ASSERTION'",
    "  expected: 4",
    "  actual: 7",
  ]), {});
  assert.match(out, /expected 4, got 7/, `got: ${out}`);
});

test("node's own generic phrasing is not treated as a message", () => {
  // "test failed" and "The expression evaluated to a falsy value" are what node
  // says when the author said nothing. Echoing them adds a clause and no fact.
  for (const generic of ["test failed", "The expression evaluated to a falsy value", "1 subtest failed"]) {
    const out = renderFailingTests(tap("something", [
      `  error: '${generic}'`,
      "  code: 'ERR_ASSERTION'",
    ]), {});
    assert.doesNotMatch(out, new RegExp(generic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `got: ${out}`);
  }
});

test("the message is exposed on the parsed record", () => {
  const [f] = parseTestFailures(tap("x", ["  error: 'a real explanation'", "  expected: true"]));
  assert.equal(f.message, "a real explanation");
});

// pytest prints its reason on the FAILED line:
//   FAILED tests/test_utils.py::test_annotation - AttributeError: 'NoneType' …
// The parser captured that string and used it only when it matched `assert x ==
// y`; every other shape — an exception type, a custom message — went into the
// diff array, which the row does not render. Same defect as the node path.
//
// NOTE: there is no corpus evidence for this one. Zero pytest FAILED lines
// appear in the stored runs, because SWE-bench withholds its graders and the
// local tickets are all node. This is a symmetry fix on data already parsed,
// and Python is the language of every benchmark instance run so far.
test("a pytest reason that is not an equality reaches the digest", () => {
  const out = renderFailingTests([
    "=================================== FAILURES ===================================",
    "____________________________ test_get_annotation _____________________________",
    "tests/unittest_pyreverse.py:42: AttributeError",
    "=========================== short test summary info ============================",
    "FAILED tests/unittest_pyreverse.py::test_get_annotation - AttributeError: 'NoneType' object has no attribute 'name'",
    "1 failed, 12 passed",
  ].join("\n"), {});
  assert.match(out, /AttributeError/, `the reason is the whole diagnosis; got: ${out}`);
});

test("a pytest equality still renders as expected/actual", () => {
  const out = renderFailingTests([
    "=========================== short test summary info ============================",
    "FAILED tests/test_x.py::test_y - assert 3 == 4",
    "1 failed",
  ].join("\n"), {});
  assert.match(out, /expected 4, got 3/, `got: ${out}`);
});
