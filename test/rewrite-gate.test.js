import test from "node:test";
import assert from "node:assert/strict";

import { rewriteGate } from "../src/logic/rewrite-gate.js";

const base = {
  action: { a: "write_file", p: "enc.py", content: "x" },
  thinkSevered: true,
  panelPaths: new Set(["enc.py"]),
  refusedOnce: new Set(),
  fileExists: () => true,
};

test("refuses a full rewrite of a panel file proposed by a severed thought", () => {
  const r = rewriteGate(base);
  assert.ok(r);
  assert.equal(r.path, "enc.py");
  assert.match(r.text, /^\[rejected\]/);
  assert.match(r.text, /"replace"/);
});

test("an un-severed thought passes — the gate is about fragments, not rewrites", () => {
  assert.equal(rewriteGate({ ...base, thinkSevered: false }), null);
});

test("a file NOT in the panel passes — there is nothing to replace against", () => {
  assert.equal(rewriteGate({ ...base, panelPaths: new Set() }), null);
});

test("a NEW file passes — creating is not rewriting", () => {
  assert.equal(rewriteGate({ ...base, fileExists: () => false }), null);
});

test("replace and other verbs pass", () => {
  assert.equal(rewriteGate({ ...base, action: { a: "replace", p: "enc.py" } }), null);
  assert.equal(rewriteGate({ ...base, action: { a: "shell", c: "ls" } }), null);
});

test("refuses ONCE per path; the same rewrite re-issued is the model's considered choice", () => {
  const refused = new Set(["enc.py"]);
  assert.equal(rewriteGate({ ...base, refusedOnce: refused }), null);
  assert.ok(rewriteGate({ ...base, action: { a: "write_file", p: "other.py" }, panelPaths: new Set(["other.py"]), refusedOnce: refused }));
});
