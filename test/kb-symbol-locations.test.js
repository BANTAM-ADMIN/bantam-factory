import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Datalog } from "../src/logic/datalog.js";
import { extractCodeFacts } from "../src/logic/codefacts.js";
import { codeTool } from "../src/logic/tools.js";

// The KB stored `defines(file, symbol)` with no location, so `symbols <file>`
// answered with a bare name list and `defines <symbol>` named a file the model
// then had to page through. Measured 2026-08-15/16: a run hunting a dispatch
// site in a 4,718-line CLI read it 54 times; the `flow` verb had to re-read and
// re-parse the source because the KB could not say where anything was.

function workspace(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-loc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const db = new Datalog();
  const { index, ...stats } = extractCodeFacts(db, dir);
  return { dir, ground: { db, workspace: dir, stats, factIndex: index, staleFiles: new Set() } };
}

const POLICY = [
  "// header",                       // 1
  "import fs from 'node:fs';",       // 2
  "",                                // 3
  "export function deliveryFor(gate) {", // 4
  "  return BLOCK;",                 // 5
  "}",                               // 6
  "",                                // 7
  "export function defaultPolicy(env) {", // 8
  "  return {};",                    // 9
  "}",                               // 10
  "",                                // 11
  "const CONTEXT_MAX_BYTES = 16000;",// 12
].join("\n");

test("defined_at records the line of every symbol", (t) => {
  const { ground } = workspace(t, { "src/policy.js": POLICY });
  const rows = ground.db.query("defined_at", "src/policy.js", "?", "?");
  // datalog atoms are strings; the tool renders them.
  const byName = Object.fromEntries(rows.map((r) => [r[1], Number(r[2])]));
  assert.equal(byName.deliveryFor, 4, "function line");
  assert.equal(byName.defaultPolicy, 8);
  assert.equal(byName.CONTEXT_MAX_BYTES, 12, "const line");
});

test("symbols answers with jump targets, not bare names", (t) => {
  const { ground } = workspace(t, { "src/policy.js": POLICY });
  const answer = String(codeTool(ground).answer("symbols src/policy.js"));
  // The marker set grew on 2026-08-16 (exports are flagged when known).
  assert.match(answer, /deliveryFor \(L4(?:, export)?\)/);
  assert.match(answer, /defaultPolicy \(L8(?:, export)?\)/);
});

test("defines answers with file:line", (t) => {
  const { ground } = workspace(t, { "src/policy.js": POLICY });
  const answer = String(codeTool(ground).answer("defines deliveryFor"));
  assert.match(answer, /src\/policy\.js:4/);
});

test("defines(file, symbol) keeps its arity for existing callers", (t) => {
  const { ground } = workspace(t, { "src/policy.js": POLICY });
  const rows = ground.db.query("defines", "src/policy.js", "?");
  assert.ok(rows.some((r) => r[1] === "deliveryFor"), "two-arg defines still works");
});
