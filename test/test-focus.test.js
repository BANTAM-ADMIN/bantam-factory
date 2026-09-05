import assert from "node:assert/strict";
import test from "node:test";

import { formatFailingTestFocus } from "../src/logic/test-focus.js";

test("focused test context offers a conditional timing hypothesis for an empty side effect", () => {
  const output = `TAP version 13
not ok 7 - coalesces a queued key, not just a running one
  ---
  location: '/workspace/test/public.test.js:1:1'
  error: |-
    the queued task must not have started yet
    + actual - expected

    + []
    - [
    -   'busy'
    - ]
  code: 'ERR_ASSERTION'
  ...
1..1
# tests 1
# pass 0
# fail 1`;
  const source = `test("coalesces a queued key, not just a running one", async () => {
  const started = [];
  const running = pool.run("busy", () => { started.push("busy"); });
  assert.deepEqual(started, ["busy"]);
});\n`;

  const focus = formatFailingTestFocus(output, () => source);

  assert.match(focus, /your code produced \{ \[\] \}/);
  assert.match(focus, /TIMING HYPOTHESIS/);
  assert.match(focus, /Promise\.then\(task\).*can defer/i);
  assert.match(focus, /If synchronous admission is required/);
  assert.match(focus, /published Promise and its rejection behavior/i);
});

test("focused test context does not invent a timing cause for ordinary value mismatches", () => {
  const output = `not ok 1 - returns the configured value
  ---
  location: '/workspace/test/public.test.js:1:1'
  + 2
  - 3
  ...
1..1`;
  const source = `test("returns the configured value", () => { assert.equal(subject(), 3); });\n`;

  const focus = formatFailingTestFocus(output, () => source);
  assert.doesNotMatch(focus, /TIMING (?:CAUSE|HYPOTHESIS)/);
});
