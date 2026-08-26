import assert from "node:assert/strict";
import test from "node:test";

import { panelRedirectReadTargets } from "../src/panel-read-redirect.js";

test("redirects an inspect only when every operation is a resident broad read", () => {
  const complete = new Map([["src/a.js", 20], ["src/b.js", 30]]);
  assert.deepEqual(panelRedirectReadTargets({
    a: "inspect",
    ops: [
      { a: "read_file", p: "src/a.js" },
      { a: "read_file", p: "src/b.js" },
    ],
  }, complete), ["src/a.js", "src/b.js"]);
});

test("does not discard useful non-read work from a mixed inspect", () => {
  const complete = new Map([["src/a.js", 20]]);
  assert.deepEqual(panelRedirectReadTargets({
    a: "inspect",
    ops: [
      { a: "read_file", p: "src/a.js" },
      { a: "list_dir", p: "test" },
    ],
  }, complete), []);
});

test("serves narrow focus reads even when the file is resident", () => {
  const complete = new Map([["src/a.js", 200]]);
  assert.deepEqual(panelRedirectReadTargets({
    a: "read_file",
    p: "src/a.js",
    start: 90,
    limit: 20,
  }, complete), []);
});
