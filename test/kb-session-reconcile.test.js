// The chat request loop rebuilt the ENTIRE code KB per request (operator
// taste report, 2026-08-18). The session now keeps one KB and reconciles by
// stat-diff: unchanged trees cost a stat sweep, edits refresh only their
// files, deletions drop out, new files join.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGrounding, reconcileGrounding } from "../src/logic/grounding.js";

function ws(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-reconcile-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, "a.js"), "export function alpha() {}");
  fs.writeFileSync(path.join(d, "b.js"), "export function beta() {}");
  return d;
}

test("an unchanged tree reconciles with zero refreshes", (t) => {
  const d = ws(t);
  const g = buildGrounding(d);
  reconcileGrounding(g); // seed stamps
  const r = reconcileGrounding(g);
  assert.deepEqual(r.changed, []);
});

test("an edited file refreshes alone; its new symbol appears", (t) => {
  const d = ws(t);
  const g = buildGrounding(d);
  reconcileGrounding(g);
  fs.writeFileSync(path.join(d, "a.js"), "export function alphaPrime() {}");
  fs.utimesSync(path.join(d, "a.js"), new Date(), new Date(Date.now() + 5000));
  const r = reconcileGrounding(g);
  assert.deepEqual(r.changed, ["a.js"]);
  const defs = g.factIndex.records.get("a.js").defines;
  assert.ok([...defs].includes("alphaPrime"), `refreshed symbols: ${[...defs]}`);
});

test("deletions drop out and new files join", (t) => {
  const d = ws(t);
  const g = buildGrounding(d);
  reconcileGrounding(g);
  fs.rmSync(path.join(d, "b.js"));
  fs.writeFileSync(path.join(d, "c.js"), "export function gamma() {}");
  const r = reconcileGrounding(g);
  assert.deepEqual([...r.changed].sort(), ["b.js", "c.js"]);
  assert.ok(!g.factIndex.records.has("b.js"));
  assert.ok(g.factIndex.records.has("c.js"));
});
