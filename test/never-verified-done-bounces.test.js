// Card 22, BANTAM×SOL: turn 0 respond (bounced), turn 1 write bucket.js,
// turn 2 done — npm test never ran ONCE, and premature_done's untestable-task
// escape ("if it never ran a recognizable test, allow done") waved it
// through onto a workspace that visibly ships a suite. Sealed MISS 0/2.
// A done with edits, test infrastructure present, and zero verification runs
// now bounces once.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prematureDoneObjection } from "../src/done-guard.js";

const EDIT_TURN = { action: { a: "write_file", p: "src/bucket.js" }, observation: "wrote 930 bytes to src/bucket.js" };

function wsWith(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-neverver-"));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, p)), { recursive: true });
    fs.writeFileSync(path.join(ws, p), c);
  }
  return ws;
}

test("edits + a visible suite + zero test runs draws the objection", (t) => {
  const ws = wsWith({ "package.json": '{"scripts":{"test":"node --test test/"}}', "test/bucket.test.js": "x" });
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const objection = prematureDoneObjection([EDIT_TURN], 0, { workspace: ws });
  assert.ok(objection, "a never-verified done on a testable workspace must bounce");
  assert.match(objection, /never run|no verification|have not run/i);
  assert.match(objection, /npm test|test suite|run the suite/i);
});

test("a workspace with no test infrastructure keeps the untestable escape", (t) => {
  const ws = wsWith({ "notes.md": "just a doc task" });
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.equal(prematureDoneObjection([EDIT_TURN], 0, { workspace: ws }), null);
});

test("no edits means nothing to verify — quiet", (t) => {
  const ws = wsWith({ "package.json": '{"scripts":{"test":"node --test"}}' });
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.equal(prematureDoneObjection([{ action: { a: "read_file", p: "a.js" }, observation: "…" }], 0, { workspace: ws }), null);
});
