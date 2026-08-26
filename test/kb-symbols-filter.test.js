import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Datalog } from "../src/logic/datalog.js";
import { extractCodeFacts } from "../src/logic/codefacts.js";
import { codeTool } from "../src/logic/tools.js";

// Measured 2026-08-16 (ticket B rerun): the model asked `symbols src/agent.js`
// and got 663 definitions capped to the first 60 by line — an arbitrary slice
// of a wall. A file that large needs a filter, and when the list must be cut,
// the exported surface is what a caller is looking for.

function ground(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-filter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "big.js"), source);
  const db = new Datalog();
  const { index, ...stats } = extractCodeFacts(db, dir);
  return { db, workspace: dir, stats, factIndex: index, staleFiles: new Set() };
}

const SOURCE = [
  "export function scopeGuardCheck(p) { return p; }",
  "function internalHelper() { return 1; }",
  "export const SCOPE_LIMIT = 4;",
  "function unrelatedThing() { return 2; }",
  "export function anotherScopeThing() { return 3; }",
].join("\n");

test("symbols takes a filter and returns only matches", (t) => {
  const answer = String(codeTool(ground(t, SOURCE)).answer("symbols big.js scope"));
  assert.match(answer, /scopeGuardCheck/);
  assert.match(answer, /SCOPE_LIMIT/i);
  assert.match(answer, /anotherScopeThing/);
  assert.ok(!/unrelatedThing/.test(answer), "non-matching symbols are excluded");
  assert.ok(!/internalHelper/.test(answer), "non-matching symbols are excluded");
});

test("the exported surface is recorded and marked", (t) => {
  const g = ground(t, SOURCE);
  const exported = g.db.query("exported", "big.js", "?").map((r) => r[1]);
  assert.ok(exported.includes("scopeGuardCheck"), "exported function recorded");
  assert.ok(exported.includes("SCOPE_LIMIT"), "exported const recorded");
  assert.ok(!exported.includes("internalHelper"), "internal symbol not marked exported");
  const answer = String(codeTool(g).answer("symbols big.js"));
  assert.match(answer, /scopeGuardCheck \(L1, export\)/);
});

test("a filter that matches nothing says so and does not dump the file", (t) => {
  const answer = String(codeTool(ground(t, SOURCE)).answer("symbols big.js zzzz"));
  assert.match(answer, /no definitions? in big\.js match/i);
  assert.ok(!/internalHelper/.test(answer));
});
