// Workday pass 3, request 6: "behaviour must not change AT ALL" — stdout was
// preserved byte-for-byte while exit codes flipped in both directions. The
// run's one baseline capture was a single happy-path invocation. The standing
// prompt rule now teaches the full call surface; words steer sometimes, gates
// always. For refactor-shaped requests with no configured verifier, done now
// requires post-edit verification of at least two distinct invocation shapes
// with exit-code capture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { refactorSurfaceObjection } from "../src/done-guard.js";

const edit = { parsedAction: { a: "replace", p: "src/cli.js", old: "x", new: "y" }, observation: "ok" };
const runShape = (cmd) => ({ parsedAction: { a: "shell", c: cmd }, observation: "table...\nexit=0" });

const REFACTOR_TASK = "split it into modules, behaviour must not change AT ALL, add tests";

test("one happy-path capture is not a surface — objection", () => {
  const turns = [edit, runShape('node joblog.js logs; echo "exit=$?"')];
  const o = refactorSurfaceObjection(turns, 0, { task: REFACTOR_TASK, verifierConfigured: false });
  assert.match(o, /call surface|invocation/i);
  assert.match(o, /exit/i);
});

test("two distinct shapes with exit capture satisfy the gate", () => {
  const turns = [
    edit,
    runShape('node joblog.js logs; echo "exit=$?"'),
    runShape('node joblog.js --bogus; echo "exit=$?"'),
  ];
  assert.equal(refactorSurfaceObjection(turns, 0, { task: REFACTOR_TASK, verifierConfigured: false }), null);
});

test("exit capture is required, not just running twice", () => {
  const turns = [
    edit,
    runShape("node joblog.js logs"),
    runShape("node joblog.js --bogus"),
  ];
  assert.match(
    refactorSurfaceObjection(turns, 0, { task: REFACTOR_TASK, verifierConfigured: false }),
    /exit/i,
  );
});

test("shapes before the last edit prove nothing about it", () => {
  const turns = [
    runShape('node joblog.js logs; echo "exit=$?"'),
    runShape('node joblog.js --bogus; echo "exit=$?"'),
    edit,
  ];
  assert.match(
    refactorSurfaceObjection(turns, 0, { task: REFACTOR_TASK, verifierConfigured: false }),
    /invocation|surface/i,
  );
});

test("non-refactor tasks and verifier-backed refactors are out of scope", () => {
  const turns = [edit, runShape('node joblog.js logs; echo "exit=$?"')];
  assert.equal(refactorSurfaceObjection(turns, 0, { task: "add a --json flag", verifierConfigured: false }), null);
  assert.equal(refactorSurfaceObjection(turns, 0, { task: REFACTOR_TASK, verifierConfigured: true }), null,
    "where a real suite exists, suite-green is the contract");
});

test("the objection is bounded — one bounce, then done proceeds", () => {
  const turns = [edit, runShape('node joblog.js logs; echo "exit=$?"')];
  assert.equal(refactorSurfaceObjection(turns, 1, { task: REFACTOR_TASK, verifierConfigured: false }), null);
});
