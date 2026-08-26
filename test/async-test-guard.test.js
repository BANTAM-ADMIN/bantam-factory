import assert from "node:assert/strict";
import test from "node:test";

import { asyncAssertionGuard } from "../src/async-test-guard.js";

test("async assertion guard warns after a successful assert.throws test edit", () => {
  const hint = asyncAssertionGuard({
    a: "replace",
    p: "test/map.test.js",
    new: "assert.throws(() => map.get('missing'));",
  }, "Updated test/map.test.js");
  assert.match(hint, /await assert\.rejects/);
  assert.match(hint, /preserve the API's rejection timing/);
});

test("async assertion guard ignores production edits, rejects, and failed edits", () => {
  assert.equal(asyncAssertionGuard({
    a: "write_file",
    p: "src/map.js",
    content: "assert.throws(() => work())",
  }, "Wrote src/map.js"), "");
  assert.equal(asyncAssertionGuard({
    a: "write_file",
    p: "test/map.test.js",
    content: "await assert.rejects(work())",
  }, "Wrote test/map.test.js"), "");
  assert.equal(asyncAssertionGuard({
    a: "write_file",
    p: "test/map.test.js",
    content: "assert.throws(() => work())",
  }, "ERROR: write failed"), "");
});

